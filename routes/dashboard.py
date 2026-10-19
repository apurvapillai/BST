from __future__ import annotations

import copy
import json
import math
import os
import time
from collections import Counter, defaultdict, namedtuple
from bisect import bisect_left
from datetime import datetime, timedelta
from decimal import Decimal
from typing import Any, Dict, Iterable, List, Optional, Set, Tuple

import numpy as np
from flask import Blueprint, current_app, jsonify, render_template, request
from PIL import Image, ImageOps
from sqlalchemy import and_, case, collate, exists, false, func, literal, or_, text
from sqlalchemy.orm import Session, joinedload, selectinload

from db.connection import SessionLocal
from db.models import (
    Defect,
    InspectionPhase,
    Machine,
    Mask,
    Reel,
    ReferenceImage,
    RLMConfig,
    RLMMonitoring,
    RLMPhase,
    SensitivitySet,
    ReelReview,
)
from db.rlm_connection import RLMSessionLocal
from db.rlm_models import RLMMachine as RLMDbMachine, RLMMonitoring as RLMDbMonitoring, RLMReel as RLMDbReel
from services.rlm_reel_footage import compute_reel_feet_from_range
from services.rlm_reel_footage import MM_PER_FOOT
from routes.assistant import build_assistant_chat_response
from services.rlm_assistant_service import RLMAssistantService


DAYS_DEFAULT_RANGE = 2
MAX_PAGE_SIZE = 500
SENTINEL_NONE = "__NONE__"
SIZE_BUCKET_SENTINEL_NONE = "__none__"
MASK_EVENT_GROUP_SECONDS = 5

HEATMAP_BUCKETS = [
    {"key": "A1", "min": 0.0, "max": 100.0},
    {"key": "A2", "min": 100.0, "max": 500.0},
    {"key": "A3", "min": 500.0, "max": 1000.0},
    {"key": "A4", "min": 1000.0, "max": 10000.0},
    {"key": "A5", "min": 10000.0, "max": 50000.0},
    {"key": "A6", "min": 50000.0, "max": 100000.0},
    {"key": "A7", "min": 100000.0, "max": 250000.0},
    {"key": "A8", "min": 250000.0, "max": 500000.0},
    {"key": "A9", "min": 500000.0, "max": 1000000.0},
    {"key": "A10", "min": 1000000.0, "max": math.inf},
]
HEATMAP_BUCKET_MAP = {entry["key"]: entry for entry in HEATMAP_BUCKETS}
DEFAULT_SIZE_RANGE = (0.0, math.inf)
VALID_REEL_CLASSIFICATIONS = {
    "active",
    "inspection_deactivated",
    "make_ready",
    "splice",
    "scrap",
}
REFERENCE_CHECK_IMAGE_SIZE = (128, 128)
REFERENCE_CHECK_CHANGE_THRESHOLD = 80.0
REFERENCE_CHECK_MINOR_THRESHOLD = 90.0
REFERENCE_CHECK_STRONG_THRESHOLD = 95.0
REFERENCE_CHECK_ALIGNMENT_MAX_SHIFT_RATIO = 0.18
REFERENCE_CHECK_OVERALL_WEIGHT = 0.5
REFERENCE_CHECK_COLOR_WEIGHT = 0.3
REFERENCE_CHECK_ALIGNMENT_WEIGHT = 0.2
REFERENCE_CHECK_MAX_HORIZONTAL_SHIFT_PX = 6
REFERENCE_CHECK_CONTENT_WEIGHT = 0.72
REFERENCE_CHECK_COLOR_DOMINANT_WEIGHT = 0.22
REFERENCE_CHECK_ALIGNMENT_LIGHT_WEIGHT = 0.06

dashboard_bp = Blueprint("dashboard", __name__)
rlm_assistant_service = RLMAssistantService()


# --------------------------------------------------------------------------- #
# Utility helpers
# --------------------------------------------------------------------------- #


def _to_float(value: Optional[Decimal]) -> Optional[float]:
    if value is None:
        return None
    if isinstance(value, (int, float)):
        return float(value)
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _iso(dt: Optional[datetime]) -> Optional[str]:
    return dt.isoformat() if dt else None


def _serialize_coords(coords_data) -> List[Dict[str, List[float]]]:
    return _parse_coords_shapes(coords_data).get("shapes") or []


def _parse_coords_shapes(coords_data) -> Dict[str, object]:
    if not coords_data:
        return {"shapes": [], "total_entries": 0, "malformed_entries": 0}
    if isinstance(coords_data, str):
        try:
            coords = json.loads(coords_data)
        except (TypeError, ValueError):
            return {"shapes": [], "total_entries": 0, "malformed_entries": 1}
    else:
        coords = coords_data
    if not isinstance(coords, (list, tuple)):
        return {"shapes": [], "total_entries": 0, "malformed_entries": 1}
    normalized: List[Dict[str, List[float]]] = []
    malformed_entries = 0
    for shape in coords:
        if not isinstance(shape, dict):
            malformed_entries += 1
            continue
        xs_raw = shape.get("x")
        ys_raw = shape.get("y")
        if not isinstance(xs_raw, (list, tuple)) or not isinstance(ys_raw, (list, tuple)):
            malformed_entries += 1
            continue
        xs: List[float] = []
        ys: List[float] = []
        for val in xs_raw:
            try:
                xs.append(float(val))
            except (TypeError, ValueError):
                continue
        for val in ys_raw:
            try:
                ys.append(float(val))
            except (TypeError, ValueError):
                continue
        count = min(len(xs), len(ys))
        if count < 3:
            malformed_entries += 1
            continue
        normalized.append({"x": xs[:count], "y": ys[:count]})
    return {
        "shapes": normalized,
        "total_entries": len(coords),
        "malformed_entries": malformed_entries,
    }


def _normalize_classification(value: Optional[str]) -> Optional[str]:
    if value is None:
        return None
    normalized = str(value).strip().lower().replace(" ", "_")
    if normalized in VALID_REEL_CLASSIFICATIONS:
        return normalized
    return None


def _normalize_decision(value: Optional[str]) -> Optional[str]:
    if not value:
        return None
    normalized = str(value).strip().lower()
    if normalized in {"pass", "fail", "uncertain"}:
        return normalized
    return None




SEVERITY_LABELS = {
    0: "0 · Perfect",
    1: "1 · Tiny cosmetic, ship",
    2: "2 · Noticeable but ship",
    3: "3 · Borderline / spec dependent",
    4: "4 · Reject",
    5: "5 · Severe reject",
}

SENSITIVITY_CLASS_CANONICAL = {
    "flaw": "flaw",
    "sporadicflaw": "sporadicflaw",
    "streak": "streak",
    "sporadicstreak": "sporadicstreak",
    "colour": "colour",
    "color": "colour",
    "register": "register",
}


def _normalize_int(value: Optional[object]) -> Optional[int]:
    if value is None:
        return None
    try:
        number = int(value)
    except (TypeError, ValueError):
        return None
    return number


def _qc_decision_from_severity(score: Optional[int]) -> Optional[str]:
    if score is None:
        return None
    if score <= 2:
        return "pass"
    if score >= 3:
        return "fail"
    return None


def _severity_label(score: Optional[int], uncertain: bool = False) -> str:
    if uncertain and score is None:
        return "Uncertain"
    label = SEVERITY_LABELS.get(score)
    if label:
        return label
    return "Unlabeled"


def _serialize_review(review: Optional[ReelReview]) -> Optional[Dict[str, object]]:
    if not review:
        return None
    extra = review.extra_data if isinstance(review.extra_data, dict) else review.extra_data
    reviewer_value = review.reviewer_id
    return {
        "review_id": review.review_id,
        "reel_code": review.reel_code,
        "decision": review.decision,
        "reviewer_id": reviewer_value,
        "reviewer_name": reviewer_value,
        "comments": review.comments or "",
        "extra_data": extra or {},
        "created_at": _iso(review.created_at),
        "updated_at": _iso(review.updated_at),
    }


def _parse_datetime(raw: Optional[str]) -> Optional[datetime]:
    if not raw:
        return None
    try:
        # Accept datetime-local strings without seconds
        if len(raw) == 16:
            raw = f"{raw}:00"
        return datetime.fromisoformat(raw)
    except ValueError:
        return None


def _default_window() -> Tuple[datetime, datetime]:
    end = datetime.utcnow()
    start = end - timedelta(days=DAYS_DEFAULT_RANGE)
    return start, end


def _polygon_area(xs: List[float], ys: List[float]) -> float:
    count = min(len(xs), len(ys))
    if count < 3:
        return 0.0
    area = 0.0
    last_index = count - 1
    for idx in range(count):
        area += (xs[last_index] + xs[idx]) * (ys[last_index] - ys[idx])
        last_index = idx
    return abs(area) / 2.0


def _defect_polygon_areas(coords_data) -> List[float]:
    if coords_data is None:
        return []
    if isinstance(coords_data, str):
        try:
            coords = json.loads(coords_data)
        except (TypeError, ValueError):
            return []
    else:
        coords = coords_data
    if not isinstance(coords, (list, tuple)):
        return []
    areas: List[float] = []
    for shape in coords:
        if not isinstance(shape, dict):
            continue
        xs_raw = shape.get("x")
        ys_raw = shape.get("y")
        if not isinstance(xs_raw, (list, tuple)) or not isinstance(ys_raw, (list, tuple)):
            continue
        xs: List[float] = []
        ys: List[float] = []
        for value in xs_raw:
            try:
                xs.append(float(value))
            except (TypeError, ValueError):
                continue
        for value in ys_raw:
            try:
                ys.append(float(value))
            except (TypeError, ValueError):
                continue
        count = min(len(xs), len(ys))
        if count < 3:
            continue
        areas.append(_polygon_area(xs[:count], ys[:count]))
    return areas


def _defect_coordinate_summary(coords_data) -> Dict[str, Optional[float]]:
    serialized = _serialize_coords(coords_data)
    if not serialized:
        return {
            "centroid_x": None,
            "centroid_y": None,
            "min_x": None,
            "max_x": None,
            "min_y": None,
            "max_y": None,
        }
    xs: List[float] = []
    ys: List[float] = []
    for shape in serialized:
        xs.extend(shape.get("x") or [])
        ys.extend(shape.get("y") or [])
    if not xs or not ys:
        return {
            "centroid_x": None,
            "centroid_y": None,
            "min_x": None,
            "max_x": None,
            "min_y": None,
            "max_y": None,
        }
    count = min(len(xs), len(ys))
    xs = xs[:count]
    ys = ys[:count]
    return {
        "centroid_x": round(sum(xs) / count, 3) if count else None,
        "centroid_y": round(sum(ys) / count, 3) if count else None,
        "min_x": round(min(xs), 3) if xs else None,
        "max_x": round(max(xs), 3) if xs else None,
        "min_y": round(min(ys), 3) if ys else None,
        "max_y": round(max(ys), 3) if ys else None,
    }


def _resolve_size_ranges(
    bucket_keys: List[str],
    size_min: Optional[float],
    size_max: Optional[float],
) -> List[Tuple[float, float]]:
    if bucket_keys:
        base_ranges = [
            (HEATMAP_BUCKET_MAP[key]["min"], HEATMAP_BUCKET_MAP[key]["max"])
            for key in bucket_keys
            if key in HEATMAP_BUCKET_MAP
        ]
    else:
        base_ranges = [DEFAULT_SIZE_RANGE]
    ranges: List[Tuple[float, float]] = []
    for lower, upper in base_ranges:
        low = lower
        high = upper
        if size_min is not None:
            low = max(low, size_min)
        if size_max is not None:
            high = min(high, size_max)
        if high <= low:
            continue
        ranges.append((low, high))
    if not bucket_keys and not ranges and (size_min is not None or size_max is not None):
        low = size_min if size_min is not None else DEFAULT_SIZE_RANGE[0]
        high = size_max if size_max is not None else DEFAULT_SIZE_RANGE[1]
        if high > low:
            ranges.append((low, high))
    return ranges


def _matches_size_ranges(coords_data, ranges: List[Tuple[float, float]]) -> bool:
    if not ranges:
        return False
    areas = _defect_polygon_areas(coords_data)
    target_area = max(areas) if areas else 0.0
    for lower, upper in ranges:
        if target_area < lower:
            continue
        if math.isinf(upper):
            return True
        if target_area < upper:
            return True
    return False


def _defect_within_window(
    defect: Defect,
    window_start: Optional[datetime],
    window_end: Optional[datetime],
) -> bool:
    timestamp = getattr(defect, "defect_time", None)
    if timestamp is None:
        return True
    if window_start and timestamp < window_start:
        return False
    if window_end and timestamp > window_end:
        return False
    return True


def _validate_filters(session: Session) -> Dict[str, Any]:
    args = request.args

    machine_id = args.get("machine_id", type=int)
    if not machine_id:
        first_machine = session.query(Machine).order_by(Machine.machine_id.asc()).first()
        if first_machine:
            machine_id = first_machine.machine_id

    machine_exists = None
    if machine_id:
        machine_exists = (
            session.query(Machine.machine_id)
            .filter(Machine.machine_id == machine_id)
            .scalar()
        )
    if not machine_exists:
        raise ValueError("machine_id is required")

    start = _parse_datetime(args.get("start"))
    end = _parse_datetime(args.get("end"))
    if not (start and end and start < end):
        start, end = _default_window()

    order_arg = args.get("order")
    if order_arg == SENTINEL_NONE:
        order_value = SENTINEL_NONE
    elif order_arg:
        order_value = order_arg
    else:
        order_value = None

    filters: Dict[str, Any] = {
        "machine_id": machine_id,
        "start": start,
        "end": end,
        "job": args.get("job") or None,
        "order": order_value,
        "reel_code": args.get("reel_code") or None,
    }
    reel_codes = args.getlist("reel_code")
    if len(reel_codes) == 1 and "," in reel_codes[0]:
        reel_codes = [code.strip() for code in reel_codes[0].split(",") if code.strip()]
    reel_codes = [code for code in reel_codes if code]
    if filters["reel_code"] and filters["reel_code"] not in reel_codes:
        reel_codes.append(filters["reel_code"])
    filters["reel_codes"] = reel_codes
    if reel_codes:
        filters["reel_code"] = reel_codes[0]
    else:
        filters["reel_code"] = None

    raw_reel_ids = args.getlist("reel_id")
    reel_ids: List[int] = []
    for raw in raw_reel_ids:
        try:
            value = int(raw)
        except (TypeError, ValueError):
            continue
        if value not in reel_ids:
            reel_ids.append(value)
    filters["reel_ids"] = reel_ids
    min_reel_length = args.get("min_reel_length", type=float)
    if min_reel_length is not None:
        min_reel_length = max(float(min_reel_length), 0.0)
    filters["min_reel_length"] = min_reel_length if min_reel_length else None

    return filters


def _apply_reel_filters(query, filters: Dict[str, Any], include_reel_code: bool = True):
    start = filters["start"]
    end = filters["end"]

    query = query.filter(Reel.machine_id == filters["machine_id"])
    query = query.filter(Reel.time_start <= end).filter(Reel.time_end >= start)

    reel_ids: Iterable[int] = filters.get("reel_ids") or []
    if reel_ids:
        query = query.filter(Reel.reel_id.in_(reel_ids))
    elif include_reel_code:
        reel_codes: Iterable[str] = filters.get("reel_codes") or []
        if not reel_codes and filters.get("reel_code"):
            reel_codes = [filters["reel_code"]]
        reel_codes = [code for code in reel_codes if code]
        if reel_codes:
            query = query.filter(Reel.reel_code.in_(reel_codes))
    if filters.get("job"):
        if filters["job"] == SENTINEL_NONE:
            query = query.filter(or_(Reel.job_name.is_(None), Reel.job_name == ""))
        else:
            query = query.filter(Reel.job_name == filters["job"])
    order_filter = filters.get("order")
    if order_filter:
        if order_filter == SENTINEL_NONE:
            query = query.filter(or_(Reel.order_number.is_(None), Reel.order_number == ""))
        else:
            query = query.filter(Reel.order_number == order_filter)
    min_length = filters.get("min_reel_length")
    if min_length:
        start_expr = func.coalesce(Reel.reel_start, 0.0)
        end_expr = func.coalesce(Reel.reel_end, 0.0)
        format_length_expr = func.coalesce(Reel.format_length, 0.0)
        query = query.filter(((end_expr - start_expr) * format_length_expr) / MM_PER_FOOT >= min_length)
    return query


def _clip_interval(
    start: Optional[datetime],
    end: Optional[datetime],
    window_start: datetime,
    window_end: datetime,
) -> Optional[Tuple[datetime, datetime]]:
    if start is None:
        start = window_start
    if end is None:
        end = window_end
    clipped_start = max(start, window_start)
    clipped_end = min(end, window_end)
    if clipped_end <= clipped_start:
        return None
    return clipped_start, clipped_end


def _phase_mix_for_reel(
    reel: Reel,
    window_start: datetime,
    window_end: datetime,
) -> Dict[str, Dict[str, float]]:
    totals: Dict[str, Dict[str, float]] = defaultdict(lambda: {"seconds": 0.0, "length": 0.0})

    reel_duration = None
    if reel.time_start and reel.time_end:
        reel_duration = max((reel.time_end - reel.time_start).total_seconds(), 0.0)
    reel_meters = None
    if reel.reel_start is not None and reel.reel_end is not None:
        start_val = _to_float(reel.reel_start) or 0.0
        end_val = _to_float(reel.reel_end) or 0.0
        reel_meters = max(end_val - start_val, 0.0)

    phases = sorted(reel.inspection_phases or [], key=lambda p: p.start_time or datetime.min)
    for phase in phases:
        clipped = _clip_interval(phase.start_time, phase.end_time, window_start, window_end)
        if not clipped:
            continue
        clipped_start, clipped_end = clipped
        original_end = phase.end_time or window_end
        original_start = phase.start_time or window_start
        interval_seconds = max((original_end - original_start).total_seconds(), 0.0)
        clipped_seconds = max((clipped_end - clipped_start).total_seconds(), 0.0)
        if clipped_seconds <= 0:
            continue

        length_delta = None
        if phase.start_format is not None and phase.end_format is not None and interval_seconds > 0:
            start_fmt = _to_float(phase.start_format) or 0.0
            end_fmt = _to_float(phase.end_format) or 0.0
            length_delta = (end_fmt - start_fmt) * (clipped_seconds / interval_seconds)

        if length_delta is None and reel_meters is not None and reel_duration:
            length_delta = reel_meters * (clipped_seconds / reel_duration)

        phase_key = phase.phase or "unknown"
        totals[phase_key]["seconds"] += clipped_seconds
        totals[phase_key]["length"] += length_delta or 0.0

    return totals


def _accumulate_phase_buckets(
    accumulator: Dict[datetime, Dict[str, float]],
    phases: Iterable[InspectionPhase],
    window_start: datetime,
    window_end: datetime,
    bucket_minutes: int = 60,
) -> Dict[datetime, Dict[str, float]]:
    bucket_delta = timedelta(minutes=bucket_minutes)
    for phase in phases or []:
        clipped = _clip_interval(phase.start_time, phase.end_time, window_start, window_end)
        if not clipped:
            continue
        segment_start, segment_end = clipped
        current = segment_start
        while current < segment_end:
            bucket_minute = (current.minute // bucket_minutes) * bucket_minutes
            bucket_start = current.replace(
                minute=bucket_minute,
                second=0,
                microsecond=0,
            )
            bucket_end = bucket_start + bucket_delta
            slice_end = min(segment_end, bucket_end)
            seconds = max((slice_end - current).total_seconds(), 0.0)
            if seconds <= 0:
                current = slice_end
                continue
            bucket = accumulator.setdefault(bucket_start, defaultdict(float))
            bucket[phase.phase or "unknown"] += seconds
            current = slice_end
    return accumulator


def _phase_seconds(
    phases: Iterable[InspectionPhase],
    window_start: datetime,
    window_end: datetime,
) -> Dict[str, float]:
    totals: Dict[str, float] = defaultdict(float)
    for phase in phases:
        clipped = _clip_interval(phase.start_time, phase.end_time, window_start, window_end)
        if not clipped:
            continue
        start, end = clipped
        totals[phase.phase or "unknown"] += max((end - start).total_seconds(), 0.0)
    return totals


OverviewDefectRow = namedtuple(
    "OverviewDefectRow",
    ["reel_id", "class_name", "defect_time", "job_name", "order_number", "reel_code"],
)


def _tracking_key_for_values(job_value: str, reel_id: Optional[int], reel_code: Optional[str]) -> str:
    if reel_id is not None:
        return f"id::{reel_id}"
    code = (reel_code or "").strip()
    return f"code::{code}::{job_value or ''}"


def _fetch_overview_defects(
    session: Session,
    reel_ids: List[int],
    window_start: datetime,
    window_end: datetime,
) -> Tuple[List[OverviewDefectRow], Dict[int, List[OverviewDefectRow]]]:
    if not reel_ids:
        return [], {}
    query = (
        session.query(
            Defect.reel_id,
            Defect.class_name,
            Defect.defect_time,
            Reel.job_name,
            Reel.order_number,
            Reel.reel_code,
        )
        .join(Reel, Defect.reel_id == Reel.reel_id)
        .filter(Defect.reel_id.in_(set(reel_ids)))
    )
    if window_start:
        query = query.filter(Defect.defect_time >= window_start)
    if window_end:
        query = query.filter(Defect.defect_time <= window_end)
    rows = [
        OverviewDefectRow(
            reel_id=row.reel_id,
            class_name=row.class_name,
            defect_time=row.defect_time,
            job_name=row.job_name,
            order_number=row.order_number,
            reel_code=row.reel_code,
        )
        for row in query.all()
    ]
    grouped: Dict[int, List[OverviewDefectRow]] = defaultdict(list)
    for row in rows:
        if row.reel_id is not None:
            grouped[row.reel_id].append(row)
    return rows, grouped


def _fetch_rlm_monitor_counts(
    session: Session,
    reel_ids: List[int],
    window_start: Optional[datetime],
    window_end: Optional[datetime],
):
    if not reel_ids:
        return {}, {}
    count_rows = (
        session.query(
            RLMMonitoring.reel_id,
            func.count(RLMMonitoring.monitor_id).label("monitor_count"),
        )
        .filter(RLMMonitoring.reel_id.in_(set(reel_ids)))
    )
    if window_start:
        count_rows = count_rows.filter(RLMMonitoring.timestamp >= window_start)
    if window_end:
        count_rows = count_rows.filter(RLMMonitoring.timestamp <= window_end)
    count_rows = count_rows.group_by(RLMMonitoring.reel_id).all()
    reel_counts = {row.reel_id: int(row.monitor_count) for row in count_rows}

    job_rows = (
        session.query(
            Reel.job_name,
            func.count(RLMMonitoring.monitor_id).label("monitor_count"),
        )
        .join(Reel, RLMMonitoring.reel_id == Reel.reel_id)
        .filter(RLMMonitoring.reel_id.in_(set(reel_ids)))
    )
    if window_start:
        job_rows = job_rows.filter(RLMMonitoring.timestamp >= window_start)
    if window_end:
        job_rows = job_rows.filter(RLMMonitoring.timestamp <= window_end)
    job_rows = job_rows.group_by(Reel.job_name).all()
    job_counts = {(row.job_name or SENTINEL_NONE): int(row.monitor_count) for row in job_rows}

    return reel_counts, job_counts


def _defect_buckets(
    defects: Iterable[object],
    window_start: datetime,
    window_end: datetime,
) -> Tuple[List[Dict[str, object]], List[Dict[str, object]], int, int]:
    by_type = defaultdict(int)
    trend_by_job: Dict[str, Dict[datetime, int]] = defaultdict(lambda: defaultdict(int))
    trend_totals = defaultdict(int)
    unique_classes = set()
    total = 0

    for defect in defects:
        if not _defect_within_window(defect, window_start, window_end):
            continue
        total += 1
        if defect.class_name:
            by_type[defect.class_name] += 1
            unique_classes.add(defect.class_name)
        if defect.defect_time:
            bucket = defect.defect_time.replace(minute=0, second=0, microsecond=0)
            job_display = (defect.job_name or "Unassigned") if hasattr(defect, "job_name") else "Unassigned"
            trend_totals[bucket] += 1
            trend_by_job[job_display][bucket] += 1

    defects_by_type = [
        {"class": cls, "count": count}
        for cls, count in sorted(by_type.items(), key=lambda item: item[1], reverse=True)
    ]
    defects_trend = []
    for job_name, bucket_map in trend_by_job.items():
        for ts, count in sorted(bucket_map.items()):
            defects_trend.append({"time": _iso(ts), "count": count, "job": job_name})
    if not defects_trend and trend_totals:
        for ts, count in sorted(trend_totals.items()):
            defects_trend.append({"time": _iso(ts), "count": count, "job": "Unassigned"})
    return defects_by_type, defects_trend, len(unique_classes), total


def _empty_review_summary() -> Dict[str, Dict[str, Dict[str, int]]]:
    return {
        "summary": {
            "rows": [],
            "totals": {
                "images_reviewed": 0,
                "reels_reviewed": 0,
                "reviewers": 0,
            },
        }
    }


def _build_review_summary_payload(
    session: Session,
    target_reel_ids: Optional[List[int]],
) -> Dict[str, Any]:
    if target_reel_ids is not None and not target_reel_ids:
        return _empty_review_summary()

    latest_review_subq = (
        session.query(
            ReelReview.reel_id.label("reel_id"),
            func.max(ReelReview.review_id).label("max_id"),
        )
        .filter(ReelReview.reel_id.isnot(None))
        .group_by(ReelReview.reel_id)
        .subquery()
    )
    review_query = (
        session.query(
            Reel.reel_id,
            Reel.job_name,
            ReelReview.reviewer_id,
            ReelReview.decision,
            ReelReview.created_at,
        )
        .join(
            latest_review_subq,
            Reel.reel_id == latest_review_subq.c.reel_id,
        )
        .join(ReelReview, ReelReview.review_id == latest_review_subq.c.max_id)
        .filter(ReelReview.decision.in_(("pass", "fail")))
    )
    if target_reel_ids is not None:
        review_query = review_query.filter(Reel.reel_id.in_(target_reel_ids))
    review_rows = review_query.all()
    if not review_rows:
        return _empty_review_summary()

    reviewed_reel_ids = [row.reel_id for row in review_rows if row.reel_id]
    reviewed_defects: Dict[int, int] = {}
    if reviewed_reel_ids:
        reviewed_defects = {
            reel_id: count
            for reel_id, count in (
                session.query(Defect.reel_id, func.count(Defect.defect_id))
                .filter(Defect.reel_id.in_(reviewed_reel_ids))
                .filter(and_(Defect.qc_decision.isnot(None), Defect.qc_decision != ""))
                .group_by(Defect.reel_id)
                .all()
            )
        }

    summary_groups: Dict[Tuple[str, str], Dict[str, Any]] = {}
    unique_reviewers: Set[str] = set()
    total_images = 0
    total_reels = 0

    for row in review_rows:
        if not row.reel_id:
            continue
        reviewer_value = (row.reviewer_id or "").strip()
        reviewer_name = reviewer_value or "Unassigned Reviewer"
        job_name = row.job_name or "Unassigned Job"
        key = (job_name, reviewer_name)
        entry = summary_groups.get(key)
        if not entry:
            entry = {
                "job_name": job_name,
                "reviewer": reviewer_name,
                "reels_reviewed": 0,
                "images_reviewed": 0,
                "last_reviewed_at": None,
            }
        entry["reels_reviewed"] += 1
        total_reels += 1
        images_for_reel = reviewed_defects.get(row.reel_id, 0)
        entry["images_reviewed"] += images_for_reel
        total_images += images_for_reel
        if row.created_at and (
            not entry["last_reviewed_at"] or row.created_at > entry["last_reviewed_at"]
        ):
            entry["last_reviewed_at"] = row.created_at
        summary_groups[key] = entry
        unique_reviewers.add(reviewer_name)

    if not summary_groups:
        return _empty_review_summary()

    rows_payload: List[Dict[str, Any]] = []
    for entry in summary_groups.values():
        rows_payload.append(
            {
                "job_name": entry.get("job_name"),
                "reviewer": entry.get("reviewer"),
                "reels_reviewed": int(entry.get("reels_reviewed") or 0),
                "images_reviewed": int(entry.get("images_reviewed") or 0),
                "last_reviewed_at": _iso(entry.get("last_reviewed_at")),
            }
        )
    rows_payload.sort(
        key=lambda item: (
            -int(item.get("images_reviewed") or 0),
            item.get("job_name") or "",
            item.get("reviewer") or "",
        )
    )
    totals = {
        "images_reviewed": total_images,
        "reels_reviewed": total_reels,
        "reviewers": len(unique_reviewers),
    }
    return {"summary": {"rows": rows_payload, "totals": totals}}


def _build_review_history_summary(session: Session) -> Dict[str, Any]:
    total_reel_reviews = (
        session.execute(text("SELECT COUNT(*) FROM pressbst.reel_reviews")).scalar()
        or 0
    )
    review_rows_raw = (
        session.query(
            ReelReview.review_id,
            ReelReview.reviewer_id,
            ReelReview.reel_id,
            ReelReview.reel_code,
            ReelReview.created_at,
        )
        .order_by(ReelReview.created_at.desc(), ReelReview.review_id.desc())
        .all()
    )

    review_rows: List[Dict[str, Any]] = []
    missing_codes: Set[str] = set()
    for row in review_rows_raw:
        reel_code = (row.reel_code or "").strip()
        normalized_code = reel_code.lower()
        if not row.reel_id and normalized_code:
            missing_codes.add(normalized_code)
        review_rows.append(
            {
                "reviewer_id": (row.reviewer_id or "").strip(),
                "reel_id": row.reel_id,
                "reel_code": normalized_code,
                "created_at": row.created_at,
            }
        )

    code_lookup: Dict[str, Optional[int]] = {}
    if missing_codes:
        code_rows = (
            session.query(Reel.reel_code, Reel.reel_id)
            .filter(Reel.reel_code.isnot(None))
            .filter(Reel.reel_code != "")
            .filter(func.lower(Reel.reel_code).in_(missing_codes))
            .all()
        )
        code_lookup = {str(code).strip().lower(): reel_id for code, reel_id in code_rows}

    for row in review_rows:
        if not row["reel_id"] and row["reel_code"]:
            row["reel_id"] = code_lookup.get(row["reel_code"])

    reel_defect_counts: Dict[int, int] = {
        reel_id: count
        for reel_id, count in (
            session.query(Defect.reel_id, func.count(Defect.defect_id))
            .filter(Defect.qc_decision.isnot(None))
            .filter(Defect.qc_decision != "")
            .group_by(Defect.reel_id)
            .all()
        )
    }

    def _aggregate_reviews(
        rows: List[Dict[str, Any]],
        since: Optional[datetime],
        label: str,
        override_total: Optional[int] = None,
    ) -> Dict[str, Any]:
        reviewer_map: Dict[str, Dict[str, Any]] = {}
        total_reviews = 0
        aggregate_reel_ids: Set[int] = set()

        for entry in rows:
            created_at = entry.get("created_at")
            if since and (created_at is None or created_at < since):
                continue
            total_reviews += 1
            reviewer_value = entry.get("reviewer_id") or ""
            reviewer_name = reviewer_value.strip() or "Unassigned Reviewer"
            record = reviewer_map.get(reviewer_name)
            if not record:
                record = {
                    "reviewer": reviewer_name,
                    "reels_reviewed": 0,
                    "last_reviewed_at": None,
                    "_reel_ids": set(),
                }
                reviewer_map[reviewer_name] = record
            record["reels_reviewed"] += 1
            if created_at and (
                record["last_reviewed_at"] is None or created_at > record["last_reviewed_at"]
            ):
                record["last_reviewed_at"] = created_at
            reel_id = entry.get("reel_id")
            if reel_id:
                record["_reel_ids"].add(reel_id)
                aggregate_reel_ids.add(reel_id)

        rows_payload: List[Dict[str, Any]] = []
        for record in reviewer_map.values():
            reel_ids = record.pop("_reel_ids", set())
            images_reviewed = sum(reel_defect_counts.get(reel_id, 0) for reel_id in reel_ids)
            last_dt = record.get("last_reviewed_at")
            rows_payload.append(
                {
                    "reviewer": record.get("reviewer"),
                    "images_reviewed": int(images_reviewed),
                    "reels_reviewed": int(record.get("reels_reviewed") or 0),
                    "last_reviewed_at": _iso(last_dt),
                    "_last_dt": last_dt,
                }
            )
        rows_payload.sort(key=lambda item: item.get("_last_dt") or datetime.min, reverse=True)
        for row in rows_payload:
            row.pop("_last_dt", None)

        total_images = sum(reel_defect_counts.get(reel_id, 0) for reel_id in aggregate_reel_ids)
        total_review_count = override_total if override_total is not None else total_reviews

        return {
            "label": label,
            "rows": rows_payload,
            "totals": {
                "images_reviewed": int(total_images),
                "reels_reviewed": int(total_review_count),
                "reviewers": len(reviewer_map),
            },
        }

    now = datetime.utcnow()
    windows = {
        "all": _aggregate_reviews(review_rows, None, "All time", override_total=total_reel_reviews),
        "last_7_days": _aggregate_reviews(review_rows, now - timedelta(days=7), "Last 7 days"),
        "last_30_days": _aggregate_reviews(review_rows, now - timedelta(days=30), "Last 30 days"),
    }
    return {
        "history": {
            "windows": windows,
            "default_window": "all",
        }
    }


def _paginate() -> Tuple[int, int]:
    page = max(1, request.args.get("page", type=int, default=1) or 1)
    page_size = request.args.get("page_size", type=int, default=200) or 200
    page_size = max(1, min(page_size, MAX_PAGE_SIZE))
    return page, page_size


def _phase_for_timestamp(phases: List[InspectionPhase], ts: datetime) -> Optional[str]:
    for phase in phases:
        start = phase.start_time
        end = phase.end_time
        if start and ts < start:
            continue
        if end and ts > end:
            continue
        if (start is None or ts >= start) and (end is None or ts <= end):
            return phase.phase
    return None


def _flatten_config(config_obj: Optional[dict]) -> Dict[str, float]:
    flat: Dict[str, float] = {}

    def _walk(prefix: str, value):
        if isinstance(value, dict):
            for key, val in value.items():
                next_prefix = f"{prefix}.{key}" if prefix else key
                _walk(next_prefix, val)
        elif isinstance(value, (int, float, Decimal)):
            if prefix:
                flat[prefix] = float(value)
        elif isinstance(value, str):
            try:
                flat[prefix] = float(value)
            except ValueError:
                pass
        # Ignore lists/other complex structures for drift detection

    if isinstance(config_obj, dict):
        _walk("", config_obj)
    return flat


def _extract_tolerances(config_json: Optional[dict]) -> Optional[Dict[str, float]]:
    """Return the first tolerance entry (nomlength/errexpand/errshrink) if present."""
    if not isinstance(config_json, dict):
        return None

    results: List[Dict[str, float]] = []

    def _walk(node):
        if not isinstance(node, dict):
            return
        if node.get("_tag") == "tol":
            attrs = node.get("_attrs") or {}
            entry = {
                "nomlength": _to_float(attrs.get("nomlength")),
                "errexpand": _to_float(attrs.get("errexpand")),
                "errshrink": _to_float(attrs.get("errshrink")),
            }
            if any(value is not None for value in entry.values()):
                results.append(entry)
        for key, value in node.items():
            if key in {"_attrs", "_text"}:
                continue
            _walk(value)
        children = node.get("_children")
        if isinstance(children, list):
            for child in children:
                _walk(child)

    _walk(config_json)
    return results[0] if results else None


def _standard_map(
    sets_: Optional[Iterable[SensitivitySet]],
) -> Dict[str, Tuple[Optional[float], Optional[float]]]:
    result: Dict[str, Tuple[Optional[float], Optional[float]]] = {}
    if not sets_:
        return result
    for row in sets_:
        if row.set_name != "sId_mmx_stand":
            continue
        result[row.defect_class] = (
            _to_float(row.threshold_value),
            _to_float(row.warn_threshold),
        )
    return result


def _ordered_reference_images(
    images: Optional[Iterable[ReferenceImage]],
) -> List[ReferenceImage]:
    """Return reference images in capture order, filtering out empty records."""
    ordered = [
        image
        for image in (images or [])
        if (image.filename and image.filename.strip()) or (image.image_src and image.image_src.strip())
    ]
    return sorted(
        ordered,
        key=lambda img: (
            img.ref_image_id or 0,
            (img.filename or "").strip().lower(),
            (img.image_src or "").strip().lower(),
        ),
    )


def _reference_change_pairs(
    ordered_images: Iterable[ReferenceImage],
) -> List[Tuple[ReferenceImage, ReferenceImage]]:
    images = list(ordered_images)
    return list(zip(images, images[1:]))


def _counter_to_list(counter: Counter, limit: int | None = None) -> List[Dict[str, object]]:
    if not counter:
        return []
    items = counter.most_common()
    if limit is not None:
        items = items[:limit]
    return [{"name": name, "count": int(count)} for name, count in items]

def _reference_change_detail(
    previous: ReferenceImage,
    current: ReferenceImage,
) -> Dict[str, Optional[str]]:
    def _label(image: ReferenceImage) -> Optional[str]:
        if image.ref_image_id is not None:
            return str(image.ref_image_id)
        return image.filename or image.image_src

    return {
        "from": _label(previous),
        "to": _label(current),
        "from_filename": previous.filename,
        "to_filename": current.filename,
    }


def _reel_status_overview(
    session: Session,
    filters: Dict[str, Any],
    base_query,
    pending_query,
    latest_review_subq,
):
    reels = (
        _apply_reel_filters(session.query(Reel), filters)
        .options(selectinload(Reel.machine))
        .order_by(Reel.time_start.asc())
        .all()
    )
    if not reels:
        return None
    reel_ids = [reel.reel_id for reel in reels if reel.reel_id]
    if not reel_ids:
        return None
    pending_counts = {
        reel_id: count
        for reel_id, count in (
            pending_query.with_entities(Defect.reel_id, func.count())
            .group_by(Defect.reel_id)
            .all()
        )
    }
    defect_reel_ids = {
        result.reel_id
        for result in base_query.with_entities(Defect.reel_id).distinct()
    }
    latest_reviews = (
        session.query(Reel.reel_id, ReelReview.decision)
        .join(
            latest_review_subq,
            Reel.reel_id == latest_review_subq.c.reel_id,
        )
        .join(ReelReview, ReelReview.review_id == latest_review_subq.c.max_id)
        .filter(Reel.reel_id.in_(reel_ids))
        .all()
    )
    review_map = {
        row.reel_id: (row.decision or "").strip().lower() for row in latest_reviews
    }
    window_start = min(
        (reel.time_start for reel in reels if reel.time_start), default=None
    )
    window_end = max((reel.time_end for reel in reels if reel.time_end), default=None)
    counts = {
        "total": len(reels),
        "pending": 0,
        "ready": 0,
        "reviewed": 0,
        "clean": 0,
    }
    status_order = {"pending": 0, "ready": 1, "reviewed": 2, "clean": 3}
    rows: List[Dict[str, Any]] = []
    for reel in reels:
        if reel.reel_id is None:
            continue
        pending_total = pending_counts.get(reel.reel_id, 0)
        decision = review_map.get(reel.reel_id)
        has_defects = reel.reel_id in defect_reel_ids
        if pending_total:
            status = "pending"
            counts["pending"] += 1
        elif decision in {"pass", "fail"}:
            status = "reviewed"
            counts["reviewed"] += 1
        elif not has_defects:
            status = "clean"
            counts["clean"] += 1
        else:
            status = "ready"
            counts["ready"] += 1
        rows.append(
            {
                "reel_id": reel.reel_id,
                "reel_code": reel.reel_code,
                "job_name": reel.job_name,
                "status": status,
                "decision": decision,
                "pending_defects": pending_total,
                "start": _iso(reel.time_start),
                "end": _iso(reel.time_end),
                "status_order": status_order.get(status, 99),
            }
        )
    rows.sort(key=lambda row: (row["status_order"], row["start"] or ""))
    job_summary: Dict[str, Dict[str, object]] = {}
    for row in rows:
        job_key = row.get("job_name") or "Unassigned Job"
        summary = job_summary.get(job_key) or {"job_name": job_key, "total": 0, "reviewed": 0, "pending": 0}
        summary["total"] = int(summary["total"]) + 1
        status_value = row.get("status")
        if status_value in {"reviewed", "clean"}:
            summary["reviewed"] = int(summary["reviewed"]) + 1
        else:
            summary["pending"] = int(summary["pending"]) + 1
        job_summary[job_key] = summary
    job_rows = [
        {
            "job_name": entry["job_name"],
            "total_reels": entry["total"],
            "reviewed_reels": entry["reviewed"],
            "pending_reels": entry["pending"],
            "status": "pending" if entry["pending"] else "complete",
        }
        for entry in job_summary.values()
    ]
    job_rows.sort(key=lambda entry: (-int(entry["pending_reels"] or 0), entry["job_name"]))
    machine_name = None
    for reel in reels:
        if reel.machine and reel.machine.name:
            machine_name = reel.machine.name
            break
    overview_rows = rows
    return {
        "job_name": filters.get("job") or (reels[0].job_name if reels else None),
        "machine_name": machine_name,
        "window": {
            "start": _iso(window_start),
            "end": _iso(window_end),
        },
        "counts": counts,
        "reels": overview_rows,
        "jobs": job_rows,
    }



def _sensitivity_tuple_has_values(values: Optional[Tuple[Optional[float], Optional[float]]]) -> bool:
    if not values:
        return False
    threshold, warn = values
    has_threshold = _to_float(threshold) is not None
    has_warn = _to_float(warn) is not None
    return has_threshold or has_warn


def _sensitivity_tuple_delta(
    previous: Optional[Tuple[Optional[float], Optional[float]]],
    current: Optional[Tuple[Optional[float], Optional[float]]],
) -> Optional[Dict[str, Optional[float]]]:
    if not (_sensitivity_tuple_has_values(previous) and _sensitivity_tuple_has_values(current)):
        return None
    prev_threshold = _to_float(previous[0]) if previous else None
    curr_threshold = _to_float(current[0]) if current else None
    prev_warn = _to_float(previous[1]) if previous else None
    curr_warn = _to_float(current[1]) if current else None
    changed = False
    if prev_threshold is not None and curr_threshold is not None and prev_threshold != curr_threshold:
        changed = True
    if prev_warn is not None and curr_warn is not None and prev_warn != curr_warn:
        changed = True
    if not changed:
        return None
    return {
        "previous": {
            "threshold": prev_threshold,
            "warn": prev_warn,
        },
        "current": {
            "threshold": curr_threshold,
            "warn": curr_warn,
        },
    }


def _combine_timestamp(date_str: Optional[str], time_str: Optional[str]) -> Optional[str]:
    if not date_str and not time_str:
        return None
    if date_str and time_str:
        try:
            return datetime.fromisoformat(f"{date_str}T{time_str}").isoformat()
        except ValueError:
            pass
    if date_str and time_str:
        return f"{date_str} {time_str}".strip()
    return (date_str or time_str or "").strip() or None


def _extract_monpoints(config_json: Optional[dict]) -> List[Dict[str, Optional[object]]]:
    if not isinstance(config_json, dict):
        return []

    results: List[Dict[str, Optional[object]]] = []

    def _walk(node):
        if isinstance(node, list):
            for child in node:
                _walk(child)
            return

        if not isinstance(node, dict):
            return

        tag = node.get("_tag")
        attrs = node.get("_attrs")
        if tag == "monpoint" and isinstance(attrs, dict):
            entry = {
                "id": attrs.get("id"),
                "timestamp": _combine_timestamp(attrs.get("date"), attrs.get("time")),
                "format": _to_float(attrs.get("format")),
                "webspeed": _to_float(attrs.get("webspeed")),
                "curlength": _to_float(attrs.get("curlength")),
            }
            if any(value is not None for value in entry.values()):
                results.append(entry)

        for key, value in node.items():
            if key in {"_attrs", "_text"}:
                continue
            _walk(value)

        if isinstance(attrs, dict):
            _walk(attrs)

        children = node.get("_children")
        if isinstance(children, list):
            for child in children:
                _walk(child)

    _walk(config_json)
    return results


def _serialize_sensitivity_snapshot(
    snapshot: Optional[Dict[str, Optional[Tuple[Optional[float], Optional[float]]]]]
) -> Dict[str, Dict[str, Optional[float]]]:
    result: Dict[str, Dict[str, Optional[float]]] = {}
    if not snapshot:
        return result
    for cls in sorted(snapshot.keys()):
        values = snapshot[cls]
        if values is None:
            result[cls] = {"threshold": None, "warn": None}
        else:
            threshold, warn = values
            result[cls] = {
                "threshold": _to_float(threshold),
                "warn": _to_float(warn),
            }
    return result


def _serialize_rlm_snapshot(
    snapshot: Optional[Dict[str, Optional[float]]], keys: Iterable[str]
) -> Dict[str, Optional[float]]:
    if not snapshot:
        return {}
    result: Dict[str, Optional[float]] = {}
    for key in sorted(set(keys)):
        value = snapshot.get(key)
        if value is None:
            result[key] = None
        else:
            num = _to_float(value)
            result[key] = round(num, 3) if num is not None else None
    return result


# --------------------------------------------------------------------------- #
# Routes
# --------------------------------------------------------------------------- #


@dashboard_bp.route("/")
def dashboard_home():
    with SessionLocal() as session:
        machines = session.query(Machine).order_by(Machine.name.asc()).all()
        default_end = session.query(func.max(Reel.time_end)).scalar()
        if default_end is None:
            default_end = datetime.utcnow()
        default_start = default_end - timedelta(days=DAYS_DEFAULT_RANGE)
        defect_trends_default_start = default_end - timedelta(days=1)
        default_start_date = default_start.date().isoformat()
        default_end_date = default_end.date().isoformat()
        default_machine = next((m for m in machines if (m.name or "").lower() == "press 5"), None)
        if not default_machine and machines:
            default_machine = machines[0]
        default_machine_id = default_machine.machine_id if default_machine else None

        job_query = session.query(Reel.job_name).filter(Reel.job_name.isnot(None))
        if default_machine_id:
            job_query = job_query.filter(Reel.machine_id == default_machine_id)
        job_query = job_query.filter(Reel.job_name != "")
        default_job = job_query.order_by(Reel.time_end.desc()).limit(1).scalar()

    return render_template(
        "dashboard.html",
        machines=machines,
        default_machine_id=default_machine_id,
        default_start=default_start,
        default_end=default_end,
        defect_trends_default_start=defect_trends_default_start,
        defect_trends_default_end=default_end,
        default_start_date=default_start_date,
        default_end_date=default_end_date,
        default_job=default_job,
    )


@dashboard_bp.route("/api/rlm-assistant/chat", methods=["POST"])
def dashboard_rlm_assistant_chat():
    payload = request.get_json(silent=True) or {}
    if not isinstance(payload, dict):
        return jsonify({"error": "Invalid JSON payload."}), 400
    return jsonify(build_assistant_chat_response(payload, service=rlm_assistant_service))


@dashboard_bp.route("/api/filters")
def api_filters():
    with SessionLocal() as session:
        try:
            filters = _validate_filters(session)
        except ValueError as exc:
            return jsonify({"error": str(exc)}), 400

        base_query = _apply_reel_filters(
            session.query(Reel), filters, include_reel_code=False
        )
        status_filters = dict(filters)
        status_filters["reel_code"] = None
        status_filters["reel_codes"] = []
        status_filters["reel_ids"] = []
        # Status ticks cover every order and job in the window, whichever one is selected.
        status_filters["job"] = None
        status_filters["order"] = None
        status_query = _apply_reel_filters(
            session.query(Reel), status_filters, include_reel_code=True
        )

        job_filters = dict(filters)
        job_filters["job"] = None
        job_filters["reel_code"] = None
        job_filters["reel_codes"] = []
        job_filters["reel_ids"] = []
        jobs_query = _apply_reel_filters(
            session.query(Reel), job_filters, include_reel_code=False
        )

        jobs = (
            jobs_query.with_entities(
                Reel.job_name,
                func.max(Reel.time_end).label("latest"),
            )
            .filter(Reel.job_name.isnot(None))
            .group_by(Reel.job_name)
            .order_by(func.max(Reel.time_end).desc())
            .all()
        )

        # Order No. comes first: list every order run on this machine in the window,
        # no matter which job is selected.
        order_filters = dict(filters)
        order_filters["order"] = None
        order_filters["job"] = None
        order_filters["reel_code"] = None
        order_filters["reel_codes"] = []
        order_filters["reel_ids"] = []
        order_query = _apply_reel_filters(
            session.query(Reel), order_filters, include_reel_code=False
        )
        order_rows = (
            order_query.with_entities(
                Reel.order_number,
                func.max(Reel.time_end).label("latest"),
            )
            .group_by(Reel.order_number)
            .order_by(func.max(Reel.time_end).desc())
            .all()
        )

        status_rows = (
            status_query.with_entities(
                Reel.reel_id,
                Reel.reel_code,
                Reel.job_name,
                Reel.order_number,
            ).all()
        )
        reel_ids = [row.reel_id for row in status_rows if row.reel_id is not None]
        defect_counts: Dict[int, int] = {}
        if reel_ids:
            defect_counts = {
                reel_id: count
                for reel_id, count in (
                    session.query(Defect.reel_id, func.count(Defect.defect_id))
                    .filter(Defect.reel_id.in_(reel_ids))
                    .group_by(Defect.reel_id)
                    .all()
                )
            }
        latest_reviews: Dict[int, Optional[str]] = {}
        if reel_ids:
            latest_review_subq = (
                session.query(
                    ReelReview.reel_id.label("reel_id"),
                    func.max(ReelReview.review_id).label("max_id"),
                )
                .filter(ReelReview.reel_id.in_(reel_ids))
                .group_by(ReelReview.reel_id)
                .subquery()
            )
            latest_reviews = {
                reviewed_reel_id: decision
                for reviewed_reel_id, decision in (
                    session.query(
                        latest_review_subq.c.reel_id,
                        ReelReview.decision,
                    )
                    .join(
                        ReelReview,
                        ReelReview.review_id == latest_review_subq.c.max_id,
                    )
                    .all()
                )
            }

        selected_order = filters.get("order")

        def _in_selected_order(order_value: Optional[str]) -> bool:
            if not selected_order:
                return True
            if selected_order == SENTINEL_NONE:
                return not order_value
            return order_value == selected_order

        reel_status_map: Dict[int, Dict[str, object]] = {}
        job_stats: Dict[Optional[str], Dict[str, int]] = defaultdict(lambda: {"defect_total": 0, "defect_completed": 0})
        order_stats: Dict[str, Dict[str, int]] = defaultdict(lambda: {"defect_total": 0, "defect_completed": 0})
        for row in status_rows:
            reel_id = row.reel_id
            if reel_id is None:
                continue
            defect_total = int(defect_counts.get(reel_id, 0))
            decision = (latest_reviews.get(reel_id, "") or "").strip().lower()
            if defect_total == 0:
                status = "no_defects"
            elif decision in {"pass", "fail"}:
                status = decision
            else:
                status = "pending"
            reel_status_map[reel_id] = {
                "status": status,
                "defect_count": defect_total,
                "job_name": row.job_name,
                "order_number": row.order_number,
            }
            if defect_total > 0:
                if _in_selected_order(row.order_number):
                    job_stats[row.job_name]["defect_total"] += 1
                    if status in {"pass", "fail"}:
                        job_stats[row.job_name]["defect_completed"] += 1
                order_key = row.order_number if row.order_number else SENTINEL_NONE
                order_stats[order_key]["defect_total"] += 1
                if status in {"pass", "fail"}:
                    order_stats[order_key]["defect_completed"] += 1

        def _job_status(job_name: Optional[str]) -> str:
            stats = job_stats.get(job_name)
            if not stats:
                return "complete"
            if stats["defect_total"] == 0:
                return "complete"
            if stats["defect_completed"] >= stats["defect_total"]:
                return "complete"
            return "pending"

        def _order_status(order_value: Optional[str]) -> str:
            key = order_value if order_value else SENTINEL_NONE
            stats = order_stats.get(key)
            if not stats:
                return "complete"
            if stats["defect_total"] == 0:
                return "complete"
            if stats["defect_completed"] >= stats["defect_total"]:
                return "complete"
            return "pending"

        job_entries = [
            {
                "value": job_name or "",
                "label": job_name or "",
                "status": _job_status(job_name),
                "total_reels": job_stats.get(job_name, {}).get("defect_total", 0),
                "reviewed_reels": job_stats.get(job_name, {}).get("defect_completed", 0),
            }
            for job_name, _ in jobs
        ]

        order_entries: List[Dict[str, str]] = []
        has_null_order = False
        for order_value, _ in order_rows:
            if order_value is None or (isinstance(order_value, str) and not order_value.strip()):
                has_null_order = True
            else:
                order_entries.append(
                    {
                        "value": order_value,
                        "label": order_value,
                        "status": _order_status(order_value),
                    }
                )
        if has_null_order:
            order_entries.insert(
                0,
                {
                    "value": SENTINEL_NONE,
                    "label": "None",
                    "status": _order_status(None),
                },
            )

        reel_filters = dict(filters)
        reel_filters["reel_code"] = None
        reel_filters["reel_codes"] = []
        reel_filters["reel_ids"] = []
        reel_query = _apply_reel_filters(
            session.query(Reel), reel_filters, include_reel_code=False
        )
        reel_rows = (
            reel_query.with_entities(
                Reel.reel_id,
                Reel.reel_code,
                Reel.job_name,
                Reel.order_number,
                Reel.time_end,
            )
            .order_by(Reel.time_end.desc())
            .all()
        )

        def _reel_label(
            code: Optional[str],
            job_value: Optional[str],
            order_value: Optional[str],
            time_end: Optional[datetime],
        ) -> str:
            label_parts: List[str] = []
            if code:
                label_parts.append(code)
            # The Order No. is already selected, so show which job the reel belongs to.
            job_or_order = job_value or order_value
            if job_or_order:
                label_parts.append(str(job_or_order))
            if time_end:
                label_parts.append(time_end.strftime("%Y-%m-%d %H:%M"))
            return " · ".join(label_parts) or "Reel"

        reel_options = [
            {
                "reel_id": reel_id,
                "reel_code": reel_code,
                "label": _reel_label(reel_code, job_name, order_number, time_end),
                "status": reel_status_map.get(reel_id, {}).get("status", "pending"),
            }
            for reel_id, reel_code, job_name, order_number, time_end in reel_rows
            if reel_id is not None
        ]

        return jsonify(
            {
                "jobs": job_entries,
                "orders": order_entries,
                "reel_codes": reel_options,
                "job_overview": {
                    "jobs": job_entries,
                },
            }
        )


@dashboard_bp.route("/api/last-review")
def api_last_review():
    with SessionLocal() as session:
        latest_review = (
            session.query(ReelReview)
            .order_by(ReelReview.created_at.desc(), ReelReview.review_id.desc())
            .first()
        )
        if not latest_review:
            return jsonify({"review": None})

        reel: Optional[Reel] = None
        if latest_review.reel_id:
            reel = (
                session.query(Reel)
                .options(selectinload(Reel.machine))
                .filter(Reel.reel_id == latest_review.reel_id)
                .first()
            )
        if not reel and latest_review.reel_code:
            reel = (
                session.query(Reel)
                .options(selectinload(Reel.machine))
                .filter(
                    collate(Reel.reel_code, "utf8mb4_unicode_ci")
                    == collate(latest_review.reel_code, "utf8mb4_unicode_ci")
                )
                .order_by(Reel.reel_id.desc())
                .first()
            )

        reel_id = reel.reel_id if reel else latest_review.reel_id
        reel_code = reel.reel_code if reel else latest_review.reel_code
        machine_name = reel.machine.name if reel and reel.machine else None
        job_name = reel.job_name if reel else None
        order_number = reel.order_number if reel else None

        defect_counts = {"pass": 0, "fail": 0, "pending": 0, "total": 0}
        defect_types: List[Dict[str, object]] = []
        if reel_id:
            decision_rows = (
                session.query(Defect.qc_decision, func.count())
                .filter(Defect.reel_id == reel_id)
                .group_by(Defect.qc_decision)
                .all()
            )
            for decision_value, decision_total in decision_rows:
                normalized = _normalize_decision(decision_value)
                count_value = int(decision_total or 0)
                if normalized == "pass":
                    defect_counts["pass"] += count_value
                elif normalized == "fail":
                    defect_counts["fail"] += count_value
                else:
                    defect_counts["pending"] += count_value
            defect_counts["total"] = (
                defect_counts["pass"] + defect_counts["fail"] + defect_counts["pending"]
            )
            type_rows = (
                session.query(Defect.class_name, func.count())
                .filter(Defect.reel_id == reel_id)
                .group_by(Defect.class_name)
                .order_by(func.count().desc())
                .limit(6)
                .all()
            )
            defect_types = [
                {"class_name": class_name or "Unclassified", "count": int(count)}
                for class_name, count in type_rows
            ]

        reviewer_label = latest_review.reviewer_id
        review_payload = {
            "review_id": latest_review.review_id,
            "reel_id": reel_id,
            "reel_code": reel_code,
            "job_name": job_name,
            "order_number": order_number,
            "machine_name": machine_name,
            "decision": latest_review.decision,
            "reviewer": reviewer_label,
            "reviewed_at": _iso(latest_review.created_at),
            "reel_time_start": _iso(reel.time_start) if reel else None,
            "reel_time_end": _iso(reel.time_end) if reel else None,
            "defect_counts": defect_counts,
            "defect_types": defect_types,
        }
        return jsonify({"review": review_payload})


@dashboard_bp.route("/api/overview")
def api_overview():
    with SessionLocal() as session:
        try:
            filters = _validate_filters(session)
        except ValueError as exc:
            return jsonify({"error": str(exc)}), 400
        overall_start = time.perf_counter()

        window_start = filters["start"]
        window_end = filters["end"]
        if window_start is None or window_end is None:
            window_start, window_end = _default_window()

        db_start = time.perf_counter()
        reels = (
            _apply_reel_filters(session.query(Reel), filters)
            .options(
                selectinload(Reel.inspection_phases),
                selectinload(Reel.sensitivity_sets),
                selectinload(Reel.masks),
                selectinload(Reel.reference_images),
                selectinload(Reel.rlm_config),
                selectinload(Reel.rlm_phases),
            )
            .all()
        )
        db_duration = time.perf_counter() - db_start
        processing_start = time.perf_counter()

        SENSITIVITY_WATCH = {
            "colour",
            "flaw",
            "register",
            "sporadicflaw",
            "sporadicstreak",
            "streak",
        }
        EVENT_DEFECT = "defect"
        EVENT_REFERENCE = "reference_change"
        EVENT_MASK = "mask_applied"
        EVENT_MASK_REMOVED = "mask_removed"
        EVENT_SENSITIVITY = "sensitivity_change"
        EVENT_RLM = "rlm_config_change"
        TIMELINE_EVENT_TYPES = {
            EVENT_MASK,
            EVENT_MASK_REMOVED,
            EVENT_SENSITIVITY,
            EVENT_RLM,
            EVENT_REFERENCE,
        }

        event_aggregates: Dict[Tuple[str, datetime, str], Dict[str, object]] = {}
        summary_counts: Dict[str, Dict[str, int]] = defaultdict(lambda: defaultdict(int))
        job_trackers: Dict[Tuple[str, str], Dict[str, object]] = {}
        job_operations_timeline_map: Dict[Tuple[str, datetime], Dict[str, object]] = {}
        reel_operations_timeline_points: List[Dict[str, object]] = []
        job_order_metrics: Dict[
            Tuple[str, str],
            Dict[str, object],
        ] = {}
        job_metrics_summary: Dict[
            str,
            Dict[str, object],
        ] = {}
        job_reel_counts_map: Dict[str, Dict[str, int]] = defaultdict(lambda: defaultdict(int))
        job_reel_meta_map: Dict[str, Dict[str, Dict[str, object]]] = defaultdict(dict)
        job_mask_counts_map: Dict[str, Dict[str, int]] = defaultdict(lambda: defaultdict(int))
        job_mask_presence: Dict[str, Dict[str, set]] = defaultdict(lambda: {"with": set(), "without": set()})
        job_mask_change_counts: Dict[str, int] = defaultdict(int)
        job_mask_reel_changes: Dict[str, Dict[int, int]] = defaultdict(lambda: defaultdict(int))
        job_reference_summary_map: Dict[Tuple[str, str], Dict[str, int]] = defaultdict(
            lambda: {
                "reference_changes": 0,
                "single_reference_reels": 0,
                "single_reference_change_reels": 0,
                "multi_reference_reels": 0,
                "mask_changes": 0,
                "total_reels": 0,
            }
        )
        daily_reference_summary_map: Dict[Tuple[str, str, str], Dict[str, int]] = defaultdict(
            lambda: {
                "reference_changes": 0,
                "single_reference_change_reels": 0,
                "multi_reference_reels": 0,
                "total_reels": 0,
            }
        )
        job_value_map: Dict[str, str] = {}
        job_sensitivity_values: Dict[str, Dict[str, Counter]] = defaultdict(lambda: defaultdict(Counter))

        def job_label(name: Optional[str]) -> str:
            return name or "Unassigned"

        def mask_signature(masks: Iterable[Mask]) -> List[Tuple[str, str, str]]:
            return [
                (xml_id, sensitivity_id, coords)
                for xml_id, sensitivity_id, coords, _ in _mask_signature_entries(masks)
            ]

        def normalize_event_time(ts: Optional[datetime]) -> Optional[datetime]:
            if ts is None:
                return None
            if ts < window_start:
                return window_start
            if ts > window_end:
                return window_end
            return ts

        def record_event(
            job_name: Optional[str],
            timestamp: Optional[datetime],
            event_type: str,
            *,
        detail: Optional[Dict[str, object]] = None,
        class_name: Optional[str] = None,
        count: int = 1,
        reel_code: Optional[str] = None,
    ) -> None:
            ts = normalize_event_time(timestamp)
            if ts is None:
                return
            job_display = job_label(job_name)
            bucket = ts.replace(minute=0, second=0, microsecond=0)
            key = (job_display, bucket, event_type)
            if key not in event_aggregates:
                event_aggregates[key] = {
                    "job": job_display,
                    "time": bucket,
                    "event_type": event_type,
                    "count": 0,
                    "details": [],
                    "class_counts": Counter(),
                    "reel_codes": set(),
                }
            entry = event_aggregates[key]
            entry["count"] += count
            if detail is not None:
                safe_detail = copy.deepcopy(detail)
                entry["details"].append(safe_detail)
            if class_name:
                entry["class_counts"][class_name] += count
            if reel_code:
                entry["reel_codes"].add(reel_code)
            summary_counts[job_display][event_type] += count

            if event_type in TIMELINE_EVENT_TYPES:
                operations_entry = job_operations_timeline_map.setdefault(
                    (job_display, bucket),
                    {
                        "job": job_display,
                        "time": bucket,
                        "event_counts": Counter(),
                        "reels_by_type": defaultdict(set),
                        "details_by_type": defaultdict(list),
                    },
                )
                operations_entry["event_counts"][event_type] += count
                if reel_code:
                    operations_entry["reels_by_type"][event_type].add(reel_code)
                if detail is not None:
                    operations_entry["details_by_type"][event_type].append(copy.deepcopy(detail))

        reels_sorted = sorted(reels, key=lambda r: r.time_start or datetime.min)
        base_reel_count = len(reels_sorted)

        job_set = set()
        jobs_meters = defaultdict(float)
        jobs_time = defaultdict(lambda: {"active": 0.0, "inactive": 0.0, "learn": 0.0})
        jobs_length = defaultdict(lambda: {"active": 0.0, "inactive": 0.0, "learn": 0.0})
        jobs_defects = defaultdict(int)
        state_buckets: Dict[datetime, Dict[str, float]] = defaultdict(lambda: defaultdict(float))

        totals = {
            "length": 0.0,
            "active_seconds": 0.0,
            "inactive_seconds": 0.0,
            "learn_seconds": 0.0,
            "active_length": 0.0,
            "inactive_length": 0.0,
            "learn_length": 0.0,
        }

        reel_ids = [reel.reel_id for reel in reels_sorted if reel.reel_id is not None]
        overview_defects, defects_by_reel = _fetch_overview_defects(session, reel_ids, window_start, window_end)
        for defect_row in overview_defects:
            job_display = job_label(defect_row.job_name)
            job_value = defect_row.job_name or ""
            job_value_map.setdefault(job_display, job_value)
            key = _tracking_key_for_values(job_value, defect_row.reel_id, defect_row.reel_code)
            job_reel_counts_map[job_display][key] += 1
            if key not in job_reel_meta_map[job_display]:
                label = defect_row.reel_code or (f"Reel {defect_row.reel_id}" if defect_row.reel_id is not None else "Reel")
                job_reel_meta_map[job_display][key] = {
                    "job": job_display,
                    "job_value": job_value,
                    "reel_id": defect_row.reel_id,
                    "reel_code": defect_row.reel_code or "",
                    "order_number": defect_row.order_number or "",
                    "label": label,
                }
        reel_monitor_counts, job_monitor_counts = _fetch_rlm_monitor_counts(session, reel_ids, window_start, window_end)
        for reel in reels_sorted:
            job_name = reel.job_name
            job_display = job_label(job_name)
            job_key = (job_name or SENTINEL_NONE, reel.order_number or SENTINEL_NONE)
            tracker = job_trackers.setdefault(
                job_key, {"sens": None, "rlm_config": None, "mask_signature": None}
            )

            job_order_key = (job_name or SENTINEL_NONE, reel.order_number or SENTINEL_NONE)
            order_display = reel.order_number if reel.order_number else None
            job_value = job_name or ""
            job_value_map.setdefault(job_display, job_value)
            reel_key = _tracking_key_for_values(job_value, reel.reel_id, reel.reel_code)
            if reel_key not in job_reel_meta_map[job_display]:
                label = reel.reel_code or (f"Reel {reel.reel_id}" if reel.reel_id is not None else "Reel")
                job_reel_meta_map[job_display][reel_key] = {
                    "job": job_display,
                    "job_value": job_value,
                    "reel_id": reel.reel_id,
                    "reel_code": reel.reel_code or "",
                    "order_number": order_display or "",
                    "label": label,
                }
            job_order_entry = job_order_metrics.setdefault(
                job_order_key,
                {
                    "job_key": job_name or SENTINEL_NONE,
                    "order_key": reel.order_number or SENTINEL_NONE,
                    "job_display": job_display,
                    "job_value": job_name or "",
                    "order_display": order_display,
                    "reference_changes": 0,
                    "rlm_monitor_count": 0,
                    "defect_count": 0,
                    "defect_classes": Counter(),
                    "phase_seconds": defaultdict(float),
                    "mask_count": 0,
                    "mask_counter": Counter(),
                },
            )
            job_summary_entry = job_metrics_summary.setdefault(
                job_name or SENTINEL_NONE,
                {
                    "job_display": job_display,
                    "reference_changes": 0,
                    "rlm_monitor_count": 0,
                    "defect_count": 0,
                    "defect_classes": Counter(),
                    "phase_seconds": defaultdict(float),
                    "mask_count": 0,
                    "mask_counter": Counter(),
                },
            )

            for sens in reel.sensitivity_sets or []:
                canonical_class = _canonical_sensitivity_class(getattr(sens, "defect_class", None))
                if not canonical_class:
                    continue
                threshold_value = _to_float(getattr(sens, "threshold_value", None))
                if threshold_value is None:
                    continue
                job_sensitivity_values[job_display][canonical_class][threshold_value] += 1

            meters = 0.0
            if reel.reel_start is not None and reel.reel_end is not None:
                meters = max(
                    (_to_float(reel.reel_end) or 0.0) - (_to_float(reel.reel_start) or 0.0),
                    0.0,
                )
            totals["length"] += meters
            if job_name:
                job_set.add(job_name)
                jobs_meters[job_name] += meters

            inspection_phases_sorted = sorted(
                reel.inspection_phases or [], key=lambda p: p.start_time or datetime.min
            )
            phase_mix = _phase_mix_for_reel(reel, window_start, window_end)

            for key in ("active", "inactive", "learn"):
                seconds = phase_mix.get(key, {}).get("seconds", 0.0)
                length = phase_mix.get(key, {}).get("length", 0.0)
                totals[f"{key}_seconds"] += seconds
                totals[f"{key}_length"] += length
                if job_name:
                    jobs_time[job_name][key] += seconds / 60.0  # minutes
                    jobs_length[job_name][key] += length
                if seconds > 0:
                    job_order_entry["phase_seconds"][key] += seconds
                    job_summary_entry["phase_seconds"][key] += seconds

            reel_defects = defects_by_reel.get(reel.reel_id, [])
            for defect in reel_defects:
                if job_name:
                    jobs_defects[job_name] += 1
                job_order_entry["defect_count"] += 1
                job_summary_entry["defect_count"] += 1
                if defect.class_name:
                    cls_name = defect.class_name.strip()
                    if cls_name:
                        job_order_entry["defect_classes"][cls_name] += 1
                        job_summary_entry["defect_classes"][cls_name] += 1
                if defect.defect_time:
                    record_event(
                        job_name,
                        defect.defect_time,
                        EVENT_DEFECT,
                        class_name=(defect.class_name or "").strip() or None,
                        reel_code=reel.reel_code,
                    )

            _accumulate_phase_buckets(
                state_buckets,
                inspection_phases_sorted,
                window_start,
                window_end,
            )

            # Reference image changes
            ordered_refs = _ordered_reference_images(reel.reference_images)
            reference_summary_key = (job_name or SENTINEL_NONE, reel.order_number or SENTINEL_NONE)
            reference_summary_entry = job_reference_summary_map[reference_summary_key]
            reel_date = reel.time_start.date().isoformat() if reel.time_start else ""
            daily_in_range = bool(
                reel.time_start
                and window_start.date() <= reel.time_start.date() <= window_end.date()
            )
            daily_reference_entry = None
            if daily_in_range:
                daily_reference_key = (
                    reel_date,
                    job_name or SENTINEL_NONE,
                    reel.order_number or SENTINEL_NONE,
                )
                daily_reference_entry = daily_reference_summary_map[daily_reference_key]
            reference_summary_entry["total_reels"] += 1
            if daily_reference_entry is not None:
                daily_reference_entry["total_reels"] += 1
            if ordered_refs:
                ref_image_count = len(ordered_refs)
                if ref_image_count == 1:
                    reference_summary_entry["single_reference_reels"] += 1
                elif ref_image_count > 1:
                    reference_summary_entry["multi_reference_reels"] += 1
                if ref_image_count == 2:
                    reference_summary_entry["single_reference_change_reels"] += 1
                    if daily_reference_entry is not None:
                        daily_reference_entry["single_reference_change_reels"] += 1
                if ref_image_count > 1:
                    if daily_reference_entry is not None:
                        daily_reference_entry["multi_reference_reels"] += 1
            ref_change_pairs = _reference_change_pairs(ordered_refs)
            reel_operation_counter: Counter = Counter()
            if ref_change_pairs:
                change_time = reel.time_end or reel.time_start or window_end
                change_count = len(ref_change_pairs)
                job_order_entry["reference_changes"] += change_count
                job_summary_entry["reference_changes"] += change_count
                reference_summary_entry["reference_changes"] += change_count
                if daily_reference_entry is not None:
                    daily_reference_entry["reference_changes"] += change_count
                reel_operation_counter[EVENT_REFERENCE] += change_count
                for previous_ref, new_ref in ref_change_pairs:
                    detail = _reference_change_detail(previous_ref, new_ref)
                    record_event(
                        job_name,
                        change_time,
                        EVENT_REFERENCE,
                        detail=detail,
                        reel_code=reel.reel_code,
                    )

            # Mask applications
            masks_in_window = [
                mask for mask in (reel.masks or []) if mask.timestamp and window_start <= mask.timestamp <= window_end
            ]
            for mask in masks_in_window:
                is_applied = _mask_noinspection_enabled(mask.noinspection)
                detail = {
                    "xml_id": mask.xml_id,
                    "sensitivity_id": mask.sensitivitysetid,
                    "format_value": _to_float(mask.format_value),
                    "event": "applied" if is_applied else "removed",
                }
                mask_label = (
                    (mask.xml_id or "").strip()
                    or (mask.sensitivitysetid or "").strip()
                    or "Mask"
                )
                if is_applied:
                    job_order_entry["mask_count"] += 1
                    job_summary_entry["mask_count"] += 1
                    job_mask_counts_map[job_display][reel_key] += 1
                    job_mask_presence[job_display]["with"].add(reel.reel_id)
                    if mask_label:
                        job_order_entry["mask_counter"][mask_label] += 1
                        job_summary_entry["mask_counter"][mask_label] += 1
                record_event(
                    job_name,
                    mask.timestamp,
                    EVENT_MASK if is_applied else EVENT_MASK_REMOVED,
                    detail=detail,
                    reel_code=reel.reel_code,
                )
            if not masks_in_window:
                job_mask_presence[job_display]["without"].add(reel.reel_id)

            current_mask_sig = mask_signature(masks_in_window)
            previous_mask_sig = tracker.get("mask_signature")
            if previous_mask_sig is None:
                tracker["mask_signature"] = current_mask_sig
            else:
                if current_mask_sig != previous_mask_sig:
                    change_time = reel.time_end or reel.time_start or window_end
                    detail = {
                        "previous_count": len(previous_mask_sig),
                        "current_count": len(current_mask_sig),
                    }
                    reel_operation_counter[EVENT_MASK] += 1
                    job_mask_counts_map[job_display][reel_key] += 1
                    job_mask_change_counts[job_display] += 1
                    if reel.reel_id is not None:
                        job_mask_reel_changes[job_display][reel.reel_id] += 1
                    reference_summary_entry["mask_changes"] += 1
                    record_event(
                        job_name,
                        change_time,
                        EVENT_MASK,
                        detail=detail,
                        reel_code=reel.reel_code,
                        count=1,
                    )
                tracker["mask_signature"] = current_mask_sig

            # RLM monitoring points
            # RLM configuration drift
            current_std = _standard_map(reel.sensitivity_sets)
            normalized_std = {
                (cls or "").lower(): values for cls, values in current_std.items()
            }
            current_watch_std = {
                cls: normalized_std.get(cls) for cls in SENSITIVITY_WATCH
            }
            previous_std = tracker.get("sens")
            if previous_std is not None:
                change_time = reel.time_start or reel.time_end or window_start
                sens_changes: List[Dict[str, object]] = []
                for cls in SENSITIVITY_WATCH:
                    prev_vals = previous_std.get(cls)
                    curr_vals = current_watch_std.get(cls)
                    delta = _sensitivity_tuple_delta(prev_vals, curr_vals)
                    if not delta:
                        continue
                    sens_changes.append(
                        {
                            "class": cls,
                            "previous": delta["previous"],
                            "current": delta["current"],
                        }
                    )
                if sens_changes:
                    detail = {
                        "changes": sens_changes,
                        "previous_settings": _serialize_sensitivity_snapshot(previous_std),
                        "current_settings": _serialize_sensitivity_snapshot(current_watch_std),
                    }
                    reel_operation_counter[EVENT_SENSITIVITY] += len(sens_changes)
                    record_event(
                        job_name,
                        change_time,
                        EVENT_SENSITIVITY,
                        detail=detail,
                        reel_code=reel.reel_code,
                        count=len(sens_changes),
                    )
            tracker["sens"] = current_watch_std

            # RLM configuration drift
            current_config_flat = (
                _flatten_config(reel.rlm_config.config_json) if reel.rlm_config else {}
            )
            previous_config = tracker.get("rlm_config")
            if previous_config is not None:
                change_time = reel.time_start or reel.time_end or window_start
                keys = sorted(set(previous_config) | set(current_config_flat))
                config_changes = []
                for key in keys:
                    prev_val = previous_config.get(key)
                    curr_val = current_config_flat.get(key)
                    if prev_val == curr_val:
                        continue
                    config_changes.append(
                        {
                            "key": key,
                            "old": None if prev_val is None else round(prev_val, 3),
                            "new": None if curr_val is None else round(curr_val, 3),
                        }
                    )
                if config_changes:
                    changed_keys = [entry["key"] for entry in config_changes]
                    detail = {
                        "changes": config_changes,
                        "previous_settings": _serialize_rlm_snapshot(previous_config, changed_keys),
                        "current_settings": _serialize_rlm_snapshot(current_config_flat, changed_keys),
                    }
                    reel_operation_counter[EVENT_RLM] += len(config_changes)
                    record_event(
                        job_name,
                        change_time,
                        EVENT_RLM,
                        detail=detail,
                        reel_code=reel.reel_code,
                        count=len(config_changes),
                    )
            tracker["rlm_config"] = current_config_flat

            monitor_count = reel_monitor_counts.get(reel.reel_id, 0)
            if monitor_count:
                job_order_entry["rlm_monitor_count"] += monitor_count

            if reel_operation_counter:
                reel_ts = reel.time_end or reel.time_start or window_end
                reel_label = reel.reel_code or (f"Reel {reel.reel_id}" if reel.reel_id else "Reel")
                for op_type, op_count in reel_operation_counter.items():
                    reel_entry = {
                        "job": job_display,
                        "reel_code": reel_label,
                        "event_type": op_type,
                        "time": _iso(reel_ts),
                        "count": int(op_count),
                    }
                    reel_operations_timeline_points.append(reel_entry)

        phase_length_per_second = {}
        for key in ("active", "inactive", "learn"):
            seconds_total = totals.get(f"{key}_seconds", 0.0)
            length_total = totals.get(f"{key}_length", 0.0)
            phase_length_per_second[key] = (length_total / seconds_total) if seconds_total else 0.0

        state_trend = []
        for bucket_time in sorted(state_buckets.keys()):
            bucket_totals = state_buckets[bucket_time]
            bucket_seconds = sum(bucket_totals.values())
            bucket_lengths = {
                key: bucket_totals.get(key, 0.0) * phase_length_per_second.get(key, 0.0)
                for key in ("active", "inactive", "learn")
            }
            bucket_total_length = sum(bucket_lengths.values())
            if bucket_total_length <= 0 and bucket_seconds > 0:
                bucket_total_length = bucket_seconds
                bucket_lengths = {
                    "active": bucket_totals.get("active", 0.0),
                    "inactive": bucket_totals.get("inactive", 0.0),
                    "learn": bucket_totals.get("learn", 0.0),
                }
            entry = {
                "time": _iso(bucket_time),
                "active_pct": round((bucket_lengths["active"] / bucket_total_length * 100) if bucket_total_length else 0.0, 1),
                "inactive_pct": round((bucket_lengths["inactive"] / bucket_total_length * 100) if bucket_total_length else 0.0, 1),
                "learn_pct": round((bucket_lengths["learn"] / bucket_total_length * 100) if bucket_total_length else 0.0, 1),
            }
            state_trend.append(entry)

        defects_by_type, defects_trend, defect_classes, total_defects = _defect_buckets(
            overview_defects, window_start, window_end
        )

        total_length = (
            totals["active_length"] + totals["inactive_length"] + totals["learn_length"]
        )
        if total_length <= 0:
            total_length = totals["length"]

        def pct(value: float) -> float:
            return round(value / total_length * 100, 1) if total_length else 0.0

        job_events = []
        for entry in sorted(
            event_aggregates.values(),
            key=lambda item: (item["time"], item["job"], item["event_type"]),
        ):
            class_counts = entry["class_counts"]
            breakdown = [
                {"class": cls, "count": int(count)}
                for cls, count in class_counts.most_common()
                if count
            ]
            details = entry["details"]
            event_payload: Dict[str, object] = {
                "job": entry["job"],
                "time": _iso(entry["time"]),
                "event_type": entry["event_type"],
                "count": int(entry["count"]),
            }
            if breakdown:
                event_payload["class_breakdown"] = breakdown
            if details:
                max_details = 20
                event_payload["details"] = details[:max_details]
                remaining = len(details) - max_details
                if remaining > 0:
                    event_payload["details_more"] = remaining
            reel_codes = entry.get("reel_codes")
            if reel_codes:
                event_payload["reel_codes"] = sorted({code for code in reel_codes if code})
            job_events.append(event_payload)

        job_event_summary = [
            {"job": job, "event_type": event_type, "count": int(count)}
            for job in sorted(summary_counts.keys())
            for event_type, count in sorted(summary_counts[job].items())
            if count
        ]

        job_reel_operations_timeline = []
        job_operations_timeline = []

        def _dominant_phase(phase_seconds: Dict[str, float]) -> Optional[str]:
            if not phase_seconds:
                return None
            return max(phase_seconds.items(), key=lambda item: item[1])[0]

        def _top_counter(counter: Counter) -> Tuple[Optional[str], int]:
            if not counter:
                return None, 0
            name, count = counter.most_common(1)[0]
            return name, int(count)

        def _prepare_breakdown(counter: Counter, limit: int | None = None) -> List[Dict[str, object]]:
            return _counter_to_list(counter, limit)

        job_order_metrics_payload: List[Dict[str, object]] = []
        for (_, _), metrics in job_order_metrics.items():
            defect_class_counter: Counter = metrics["defect_classes"]
            mask_counter: Counter = metrics.get("mask_counter", Counter())
            phase_seconds: Dict[str, float] = metrics["phase_seconds"]
            dominant_phase = _dominant_phase(phase_seconds)
            top_defect_class, top_defect_count = _top_counter(defect_class_counter)
            top_mask_xml, top_mask_count = _top_counter(mask_counter)
            job_order_metrics_payload.append(
                {
                    "job": metrics["job_display"],
                    "order": metrics["order_display"],
                    "reference_changes": int(metrics["reference_changes"]),
                    "rlm_monitor_count": int(metrics["rlm_monitor_count"]),
                    "defect_count": int(metrics["defect_count"]),
                    "defect_type_count": len(defect_class_counter),
                    "top_defect_class": top_defect_class,
                    "top_defect_count": top_defect_count,
                    "dominant_phase": dominant_phase,
                    "mask_count": int(metrics.get("mask_count", 0)),
                    "top_mask_xml": top_mask_xml,
                    "top_mask_count": top_mask_count,
                    "defect_breakdown": _prepare_breakdown(defect_class_counter, limit=8),
                    "mask_breakdown": _prepare_breakdown(mask_counter, limit=8),
                }
            )

        for job_key, total in job_monitor_counts.items():
            normalized_key = job_key if job_key else SENTINEL_NONE
            if normalized_key in job_metrics_summary:
                job_metrics_summary[normalized_key]["rlm_monitor_count"] = int(total)

        job_metrics_payload: List[Dict[str, object]] = []
        for metrics in job_metrics_summary.values():
            defect_class_counter: Counter = metrics["defect_classes"]
            top_defect_class, top_defect_count = _top_counter(defect_class_counter)
            mask_counter: Counter = metrics.get("mask_counter", Counter())
            top_mask_xml, top_mask_count = _top_counter(mask_counter)
            phase_seconds: Dict[str, float] = metrics["phase_seconds"]
            dominant_phase = _dominant_phase(phase_seconds)
            job_metrics_payload.append(
                {
                    "job": metrics["job_display"],
                    "reference_changes": int(metrics["reference_changes"]),
                    "rlm_monitor_count": int(metrics["rlm_monitor_count"]),
                    "defect_count": int(metrics["defect_count"]),
                    "defect_type_count": len(defect_class_counter),
                    "top_defect_class": top_defect_class,
                    "top_defect_count": top_defect_count,
                    "dominant_phase": dominant_phase,
                    "mask_count": int(metrics.get("mask_count", 0)),
                    "top_mask_xml": top_mask_xml,
                    "top_mask_count": top_mask_count,
                    "defect_breakdown": _prepare_breakdown(defect_class_counter, limit=8),
                    "mask_breakdown": _prepare_breakdown(mask_counter, limit=8),
                }
            )

        job_sensitivity_summary: List[Dict[str, object]] = []
        for job_display in sorted(job_sensitivity_values.keys()):
            classes_map = job_sensitivity_values[job_display]
            payload_classes: Dict[str, List[Dict[str, float]]] = {}
            for class_key, counter in classes_map.items():
                entries = [
                    {"value": _to_float(value), "count": int(count)}
                    for value, count in sorted(counter.items(), key=lambda item: (-item[1], item[0]))
                ]
                payload_classes[class_key] = entries
            job_sensitivity_summary.append(
                {
                    "job": job_display,
                    "job_value": job_value_map.get(job_display, ""),
                    "classes": payload_classes,
                }
            )
        job_mask_summary: List[Dict[str, object]] = []
        for job_display in sorted(job_mask_presence.keys()):
            presence = job_mask_presence[job_display]
            with_count = len(presence["with"])
            without_count = len(presence["without"])
            total_reels = len(presence["with"] | presence["without"])
            multi_reels = sum(
                1
                for count in job_mask_reel_changes[job_display].values()
                if count > 1
            )
            job_mask_summary.append(
                {
                    "job": job_display,
                    "job_value": job_value_map.get(job_display, ""),
                    "mask_changes": int(job_mask_change_counts.get(job_display, 0)),
                    "with_masks": with_count,
                    "without_masks": without_count,
                    "multi_reel_changes": multi_reels,
                    "total_reels": total_reels,
                }
            )
        job_reference_summary: List[Dict[str, object]] = []
        for reference_summary_key in sorted(job_reference_summary_map.keys()):
            job_key, order_key = reference_summary_key
            job_display = job_label(None if job_key == SENTINEL_NONE else job_key)
            order_display = None if order_key == SENTINEL_NONE else order_key
            summary = job_reference_summary_map[reference_summary_key]
            if not summary:
                continue
            total_changes = int(summary.get("reference_changes", 0))
            single_reels = int(summary.get("single_reference_reels", 0))
            single_change_reels = int(summary.get("single_reference_change_reels", 0))
            multi_reels = int(summary.get("multi_reference_reels", 0))
            mask_changes = int(summary.get("mask_changes", 0))
            total_reels = int(summary.get("total_reels", 0))
            job_reference_summary.append(
                {
                    "job": job_display,
                    "job_value": None if job_key == SENTINEL_NONE else job_key,
                    "order_number": order_display or "",
                    "reference_changes": total_changes,
                    "single_reference_reels": single_reels,
                    "single_reference_change_reels": single_change_reels,
                    "multi_reference_reels": multi_reels,
                    "mask_changes": mask_changes,
                    "total_reels": total_reels,
                }
            )

        job_reference_daily_summary: List[Dict[str, object]] = []
        for daily_reference_key in sorted(daily_reference_summary_map.keys()):
            reel_date, job_key, order_key = daily_reference_key
            summary = daily_reference_summary_map[daily_reference_key]
            job_reference_daily_summary.append(
                {
                    "date": reel_date,
                    "job": job_label(None if job_key == SENTINEL_NONE else job_key),
                    "job_value": None if job_key == SENTINEL_NONE else job_key,
                    "order_number": "" if order_key == SENTINEL_NONE else order_key,
                    "reference_changes": int(summary.get("reference_changes", 0)),
                    "single_reference_change_reels": int(summary.get("single_reference_change_reels", 0)),
                    "multi_reference_reels": int(summary.get("multi_reference_reels", 0)),
                    "total_reels": int(summary.get("total_reels", 0)),
                }
            )

        response = {
                "kpis": {
                    "total_jobs": len(job_set),
                    "total_length": round(total_length, 2),
                    "active_pct": pct(totals["active_length"]),
                    "inactive_pct": pct(totals["inactive_length"]),
                    "learn_pct": pct(totals["learn_length"]),
                    "active_length": round(totals["active_length"], 2),
                    "inactive_length": round(totals["inactive_length"], 2),
                    "learn_length": round(totals["learn_length"], 2),
                "total_defects": total_defects,
                "defect_classes": int(defect_classes),
            },
            "defects_by_type": defects_by_type,
            "defects_trend": defects_trend,
            "jobs_meters": [
                {"job": job, "meters": round(meters, 2)}
                for job, meters in sorted(jobs_meters.items(), key=lambda item: item[1], reverse=True)
            ],
            "jobs_time": [
                {
                    "job": job,
                    "minutes_active": round(mix["active"], 1),
                    "minutes_inactive": round(mix["inactive"], 1),
                    "minutes_learn": round(mix["learn"], 1),
                    "length_active": round(jobs_length.get(job, {}).get("active", 0.0), 2),
                    "length_inactive": round(jobs_length.get(job, {}).get("inactive", 0.0), 2),
                    "length_learn": round(jobs_length.get(job, {}).get("learn", 0.0), 2),
                }
                for job, mix in jobs_time.items()
            ],
            "jobs_defects": [
                {"job": job, "count": count}
                for job, count in sorted(jobs_defects.items(), key=lambda item: item[1], reverse=True)
            ],
            "state_trend": state_trend,
            "job_events": job_events,
            "job_event_summary": job_event_summary,
            "job_operations_timeline": job_operations_timeline,
            "job_reel_operations_timeline": job_reel_operations_timeline,
            "job_order_metrics": job_order_metrics_payload,
            "job_metrics": job_metrics_payload,
            "job_sensitivity_summary": job_sensitivity_summary,
            "job_mask_summary": job_mask_summary,
            "job_reference_summary": job_reference_summary,
            "job_reference_daily_summary": job_reference_daily_summary,
        }
        processing_duration = time.perf_counter() - processing_start
        serialize_start = time.perf_counter()
        resp = jsonify(response)
        payload_bytes = len(resp.get_data())
        serialize_duration = time.perf_counter() - serialize_start
        total_duration = time.perf_counter() - overall_start
        machine_label = filters.get("machine_id")
        start_label = window_start.isoformat() if window_start else None
        end_label = window_end.isoformat() if window_end else None
        reel_count = base_reel_count
        defect_count = len(overview_defects)
        phase_count = sum(len(reel.inspection_phases or []) for reel in reels_sorted)
        mask_count = sum(len(reel.masks or []) for reel in reels_sorted)
        reference_count = sum(len(reel.reference_images or []) for reel in reels_sorted)
        sens_count = sum(len(reel.sensitivity_sets or []) for reel in reels_sorted)
        rlm_monitor_count = sum(reel_monitor_counts.values())
        rlm_config_count = sum(1 for reel in reels_sorted if reel.rlm_config)
        if current_app:
            current_app.logger.info(
                (
                    "overview timings | machine=%s window=%s→%s | reels=%s defects=%s phases=%s "
                    "masks=%s refs=%s sens_sets=%s rlm_configs=%s rlm_monitors=%s | "
                    "db=%.3fs process=%.3fs json=%.3fs total=%.3fs payload=%dB"
                ),
                machine_label,
                start_label,
                end_label,
                reel_count,
                defect_count,
                phase_count,
                mask_count,
                reference_count,
                sens_count,
                rlm_config_count,
                rlm_monitor_count,
                db_duration,
                processing_duration,
                serialize_duration,
                total_duration,
                payload_bytes,
            )
        return resp


DRIVER_DEFECT_CLASSES = (
    "flaw",
    "sporadicflaw",
    "streak",
    "sporadicstreak",
    "colour",
    "register",
)
DRIVER_EVENT_LABELS = {
    "sensitivity_change": "Sensitivity change",
    "mask_change": "Mask change",
    "reference_change": "Reference change",
    "speed_shift": "Speed shift",
    "bst_coverage": "BST coverage",
    "defect_spike": "Defect spike",
}
# BST coverage thresholds are intentionally explicit:
# <= 1% active means inspection was effectively off.
# > 1% and < 75% active means coverage was only partial.
BST_OFF_ACTIVE_PCT_THRESHOLD = 1.0
BST_PARTIAL_ACTIVE_PCT_THRESHOLD = 75.0
SPEED_SHIFT_MIN_DELTA = 0.5


def _driver_class_label(name: Optional[str]) -> str:
    canonical = _canonical_sensitivity_class(name) or _normalize_defect_label(name) or ""
    labels = {
        "flaw": "Flaw",
        "sporadicflaw": "Sporadic Flaw",
        "streak": "Streak",
        "sporadicstreak": "Sporadic Streak",
        "colour": "Colour",
        "register": "Register",
    }
    return labels.get(canonical, canonical.title() if canonical else "Unknown")


def _driver_class_breakdown(counter: Counter) -> List[Dict[str, object]]:
    rows: List[Dict[str, object]] = []
    ordered_keys = list(DRIVER_DEFECT_CLASSES) + [
        key for key, _ in counter.most_common() if key not in DRIVER_DEFECT_CLASSES
    ]
    seen: Set[str] = set()
    for key in ordered_keys:
        if key in seen:
            continue
        seen.add(key)
        count = int(counter.get(key, 0))
        if count <= 0:
            continue
        rows.append({"name": key, "label": _driver_class_label(key), "count": count})
    return rows


def _reel_length_feet(reel: Reel) -> float:
    feet = compute_reel_feet_from_range(reel.reel_start, reel.reel_end, reel.format_length)
    return round(float(feet or 0.0), 2)


def _rate_per_1000ft(defect_count: int, length_ft: Optional[float]) -> Optional[float]:
    length_value = _to_float(length_ft)
    if length_value is None or length_value <= 0:
        return None
    return round((defect_count / length_value) * 1000.0, 3)


def _safe_delta(current: Optional[float], previous: Optional[float], digits: int = 3) -> Optional[float]:
    current_value = _to_float(current)
    previous_value = _to_float(previous)
    if current_value is None or previous_value is None:
        return None
    return round(current_value - previous_value, digits)


def _relative_change(current: Optional[float], previous: Optional[float]) -> Optional[float]:
    current_value = _to_float(current)
    previous_value = _to_float(previous)
    if current_value is None or previous_value is None:
        return None
    baseline = abs(previous_value)
    if baseline < 1e-9:
        if abs(current_value) < 1e-9:
            return 0.0
        return None
    return (current_value - previous_value) / baseline


def _material_rate_change(
    previous_rate: Optional[float],
    current_rate: Optional[float],
) -> Optional[Dict[str, object]]:
    previous_value = _to_float(previous_rate)
    current_value = _to_float(current_rate)
    if previous_value is None or current_value is None:
        return None
    delta = current_value - previous_value
    if previous_value <= 0 and current_value >= 1.0:
        return {"direction": "up", "delta": round(delta, 3), "relative": None}
    if current_value <= 0 and previous_value >= 1.0:
        return {"direction": "down", "delta": round(delta, 3), "relative": None}
    relative = _relative_change(current_value, previous_value)
    if abs(delta) < 0.5:
        return None
    if relative is not None and abs(relative) < 0.4:
        return None
    return {
        "direction": "up" if delta > 0 else "down",
        "delta": round(delta, 3),
        "relative": round(relative, 3) if relative is not None else None,
    }


def _driver_percentile(values: List[float], pct: float) -> Optional[float]:
    finite = sorted(value for value in values if value is not None)
    if not finite:
        return None
    if len(finite) == 1:
        return finite[0]
    position = max(0.0, min(1.0, pct)) * (len(finite) - 1)
    lower = int(math.floor(position))
    upper = int(math.ceil(position))
    if lower == upper:
        return finite[lower]
    weight = position - lower
    return finite[lower] + (finite[upper] - finite[lower]) * weight


def _bucket_thresholds(values: List[float]) -> Tuple[Optional[float], Optional[float]]:
    low_cut = _driver_percentile(values, 1 / 3)
    high_cut = _driver_percentile(values, 2 / 3)
    if low_cut is None or high_cut is None:
        return (None, None)
    if low_cut > high_cut:
        low_cut, high_cut = high_cut, low_cut
    return (low_cut, high_cut)


def _bucket_label(
    value: Optional[float],
    thresholds: Tuple[Optional[float], Optional[float]],
    noun: str,
    digits: int = 1,
    suffix: str = "",
) -> str:
    numeric = _to_float(value)
    if numeric is None:
        return f"No {noun} data"
    low_cut, high_cut = thresholds
    if low_cut is None or high_cut is None:
        return f"All {noun}"
    if low_cut == high_cut:
        return f"{noun.title()} near {round(low_cut, digits):.{digits}f}{suffix}"
    if numeric <= low_cut:
        return f"Low {noun} (≤ {round(low_cut, digits):.{digits}f}{suffix})"
    if numeric <= high_cut:
        return (
            f"Mid {noun} ({round(low_cut, digits):.{digits}f}"
            f"–{round(high_cut, digits):.{digits}f}{suffix})"
        )
    return f"High {noun} (> {round(high_cut, digits):.{digits}f}{suffix})"


def _driver_adjusted_rate(
    total_defects: Optional[int],
    total_feet: Optional[float],
    avg_bst_active_pct: Optional[float],
) -> Optional[float]:
    feet_value = _to_float(total_feet) or 0.0
    bst_value = _to_float(avg_bst_active_pct)
    if feet_value <= 0 or bst_value is None:
        return None
    adjusted_feet = feet_value * (bst_value / 100.0)
    if adjusted_feet < 1.0:
        return None
    return _rate_per_1000ft(int(total_defects or 0), adjusted_feet)


def _driver_speed_range_definition(values: List[float]) -> Optional[Dict[str, object]]:
    numeric = sorted(_to_float(value) for value in values if _to_float(value) is not None)
    if not numeric:
        return None
    low = math.floor(min(numeric))
    high = math.ceil(max(numeric))
    if high <= low:
        high = low + 5
    span = high - low
    step = span / 5.0
    return {"min": float(low), "max": float(high), "step": step}


def _driver_speed_bucket_index(
    value: Optional[float],
    definition: Optional[Dict[str, object]],
) -> Optional[int]:
    numeric = _to_float(value)
    if numeric is None or not definition:
        return None
    step = _to_float(definition.get("step")) or 0.0
    low = _to_float(definition.get("min")) or 0.0
    if step <= 0:
        return 0
    return max(0, min(4, int((numeric - low) / step)))


def _driver_speed_bucket_label(index: int, definition: Dict[str, object]) -> str:
    low = _to_float(definition.get("min")) or 0.0
    step = _to_float(definition.get("step")) or 0.0
    start = low + (step * index)
    end = low + (step * (index + 1))
    if index == 4:
        return f"{start:.1f} - {end:.1f}"
    return f"{start:.1f} - {end:.1f}"


def _driver_length_bucket_label(length_ft: Optional[float]) -> str:
    numeric = _to_float(length_ft) or 0.0
    if numeric < 5000:
        return "< 5,000 ft"
    if numeric < 8000:
        return "5,000 - 8,000 ft"
    if numeric < 11000:
        return "8,000 - 11,000 ft"
    if numeric < 14000:
        return "11,000 - 14,000 ft"
    return "> 14,000 ft"


def _mask_noinspection_enabled(value: object) -> bool:
    if isinstance(value, bool):
        return value
    if value is None:
        return False
    if isinstance(value, (int, float)):
        return value != 0
    normalized = str(value).strip().lower()
    if not normalized:
        return False
    if normalized in {"1", "true", "yes", "y", "on"}:
        return True
    if normalized in {"0", "false", "no", "n", "off"}:
        return False
    return bool(normalized)


def _mask_signature_entries(masks: Iterable[Mask]) -> List[Tuple[str, str, str, str]]:
    serialized = [_serialize_mask_detail(mask) for mask in masks or []]
    active_masks = _active_mask_details(serialized)
    return sorted(
        (
            (mask.get("xml_id") or "").strip(),
            (mask.get("sensitivitysetid") or "").strip(),
            (mask.get("coords") or "").strip(),
            "1" if _mask_noinspection_enabled(mask.get("noinspection")) else "0",
        )
        for mask in active_masks
    )


def _reference_signature(images: Iterable[ReferenceImage]) -> Tuple[str, ...]:
    ordered = _ordered_reference_images(images)
    result: List[str] = []
    for image in ordered:
        label = None
        if image.ref_image_id is not None:
            label = str(image.ref_image_id)
        elif image.filename:
            label = image.filename.strip()
        elif image.image_src:
            label = image.image_src.strip()
        if label:
            result.append(label)
    return tuple(result)


def _active_mask_count(masks: Iterable[Dict[str, object]]) -> int:
    return len(_active_mask_details(masks))


def _mask_segment_validity_label(active_pct: Optional[float]) -> str:
    numeric = _to_float(active_pct) or 0.0
    if numeric <= BST_OFF_ACTIVE_PCT_THRESHOLD:
        return "BST mostly off"
    if numeric < BST_PARTIAL_ACTIVE_PCT_THRESHOLD:
        return "Low BST coverage"
    return "Valid comparison"


def _mask_state_label(active_mask_count: int) -> str:
    if active_mask_count > 0:
        return "Mask On"
    return "No Mask"


def _active_mask_signature(masks: Iterable[Dict[str, object]]) -> Set[Tuple[str, str, str]]:
    signature: Set[Tuple[str, str, str]] = set()
    for mask in _active_mask_details(masks):
        xml_id = (mask.get("xml_id") or "").strip()
        sensitivitysetid = (mask.get("sensitivitysetid") or "").strip()
        coords = (mask.get("coords") or "").strip()
        has_definition = bool(coords or xml_id or sensitivitysetid)
        if not has_definition:
            continue
        signature.add((xml_id, sensitivitysetid, coords))
    return signature


def _active_mask_details(masks: Iterable[Dict[str, object]]) -> List[Dict[str, object]]:
    ordered: List[Tuple[int, Dict[str, object]]] = []
    for index, mask in enumerate(masks or []):
        if not (
            (mask.get("coords") or "").strip()
            or (mask.get("xml_id") or "").strip()
            or (mask.get("sensitivitysetid") or "").strip()
        ):
            continue
        ordered.append((index, mask))

    def event_order(item: Tuple[int, Dict[str, object]]) -> Tuple[str, float, int]:
        index, mask = item
        format_value = _to_float(mask.get("format_value"))
        return (
            str(mask.get("timestamp") or ""),
            format_value if format_value is not None else float("inf"),
            index,
        )

    latest_by_mask: Dict[Tuple[str, str, str], Tuple[str, Dict[str, object]]] = {}
    for _, mask in sorted(ordered, key=event_order):
        signature = _mask_detail_signature(mask)
        event = mask.get("event")
        if event not in {"applied", "removed"}:
            event = "applied" if (
                "noinspection" not in mask
                or _mask_noinspection_enabled(mask.get("noinspection"))
            ) else "removed"
        latest_by_mask[signature] = (str(event), mask)
    return [
        mask
        for event, mask in latest_by_mask.values()
        if event == "applied"
    ]


def _mask_local_feet(mask: Dict[str, object], reel: Reel) -> Optional[float]:
    reel_start = _to_float(reel.reel_start)
    format_length = _to_float(reel.format_length)
    format_value = _to_float(mask.get("format_value"))
    if reel_start is None or format_length is None or format_value is None:
        return None
    feet = ((format_value - reel_start) * format_length) / MM_PER_FOOT
    if feet < 0:
        return 0.0
    reel_length = _reel_length_feet(reel)
    return min(feet, reel_length) if reel_length is not None else feet


def _mask_feet_between(
    start_format: object,
    end_format: object,
    reel: Reel,
) -> Optional[float]:
    start = _to_float(start_format)
    end = _to_float(end_format)
    format_length = _to_float(reel.format_length)
    if start is None or end is None or format_length is None or format_length <= 0:
        return None
    return max((end - start) * format_length / MM_PER_FOOT, 0.0)


def _mask_lifecycle_snapshots(
    masks: Iterable[Dict[str, object]],
    reel: Reel,
) -> List[Dict[str, object]]:
    events = [
        (index, mask)
        for index, mask in enumerate(masks or [])
        if mask.get("event") in {"applied", "removed"}
    ]

    def event_order(item: Tuple[int, Dict[str, object]]) -> Tuple[str, float, int]:
        index, mask = item
        format_value = _to_float(mask.get("format_value"))
        return (
            str(mask.get("timestamp") or ""),
            format_value if format_value is not None else float("inf"),
            index,
        )

    ordered = sorted(events, key=event_order)
    applied_events: Dict[Tuple[str, str, str], Dict[str, object]] = {}
    lifetime_details: Dict[int, Dict[str, Optional[float]]] = {}
    for _, mask in ordered:
        signature = _mask_detail_signature(mask)
        if mask.get("event") == "applied":
            applied_events[signature] = mask
            continue
        applied = applied_events.pop(signature, None)
        if applied is None:
            continue
        duration = _mask_feet_between(
            applied.get("format_value"),
            mask.get("format_value"),
            reel,
        )
        applied_feet = _mask_local_feet(applied, reel)
        removed_feet = _mask_local_feet(mask, reel)
        lifetime = {
            "applied_at_feet": applied_feet,
            "applied_for_feet": duration,
            "removed_at_feet": removed_feet,
        }
        lifetime_details[id(applied)] = lifetime
        lifetime_details[id(mask)] = lifetime

    for signature, applied in applied_events.items():
        lifetime_details[id(applied)] = {
            "applied_at_feet": _mask_local_feet(applied, reel),
            "applied_for_feet": _mask_feet_between(
                applied.get("format_value"),
                reel.reel_end,
                reel,
            ),
            "removed_at_feet": None,
        }

    groups: List[List[Dict[str, object]]] = []
    group_end: Optional[datetime] = None
    for _, mask in ordered:
        raw_time = mask.get("timestamp")
        try:
            event_time = datetime.fromisoformat(str(raw_time)) if raw_time else None
        except ValueError:
            event_time = None
        if (
            not groups
            or event_time is None
            or group_end is None
            or (event_time - group_end).total_seconds() > MASK_EVENT_GROUP_SECONDS
        ):
            groups.append([])
        groups[-1].append(mask)
        group_end = event_time

    active: Dict[Tuple[str, str, str], Dict[str, object]] = {}
    removed: Dict[Tuple[str, str, str], Dict[str, object]] = {}
    snapshots: List[Dict[str, object]] = []
    for group in groups:
        for mask in group:
            signature = _mask_detail_signature(mask)
            lifecycle = lifetime_details.get(id(mask), {})
            if mask.get("event") == "removed":
                active.pop(signature, None)
                removed[signature] = {
                    **mask,
                    **lifecycle,
                }
            else:
                active[signature] = {
                    **mask,
                    **lifecycle,
                    "event": "applied",
                }
                removed.pop(signature, None)

        group_time = group[-1].get("timestamp")
        group_formats = [
            value
            for value in (_to_float(mask.get("format_value")) for mask in group)
            if value is not None
        ]
        format_value = max(group_formats) if group_formats else None
        group_anchor = {"format_value": format_value}
        snapshots.append(
            {
                "timestamp": group_time,
                "format_value": format_value,
                "feet_from_reel_start": _mask_local_feet(group_anchor, reel),
                "active_mask_count": len(active),
                "event_count": len(group),
                "masks": list(active.values()),
                "mask_history": [*active.values(), *removed.values()],
            }
        )
    return snapshots


def _mask_detail_signature(mask: Dict[str, object]) -> Tuple[str, str, str]:
    return (
        (mask.get("xml_id") or "").strip(),
        (mask.get("sensitivitysetid") or "").strip(),
        (mask.get("coords") or "").strip(),
    )


def _mask_type_hint(mask: Dict[str, object]) -> Optional[str]:
    probe = " ".join(
        str(value or "").strip().lower()
        for value in (
            mask.get("xml_id"),
            mask.get("sensitivitysetid"),
            mask.get("coords"),
        )
    )
    if not probe:
        return None
    if any(token in probe for token in ("ellipse", "circle", "oval")):
        return "ellipse"
    if any(token in probe for token in ("rect", "rectangle", "border", "box")):
        return "rectangle"
    if "poly" in probe:
        return "polygon"
    return None


def _mask_display_label(mask: Dict[str, object], fallback_index: int) -> str:
    name = (
        (mask.get("xml_id") or "").strip()
        or (mask.get("sensitivitysetid") or "").strip()
        or f"Mask {fallback_index}"
    )
    mask_type = _mask_type_hint(mask)
    if mask_type:
        return f"{name} ({mask_type})"
    return name


def _mask_display_labels(masks: Iterable[Dict[str, object]]) -> List[str]:
    labels: List[str] = []
    seen: Set[str] = set()
    for index, mask in enumerate(masks or [], start=1):
        label = _mask_display_label(mask, index)
        if label in seen:
            continue
        seen.add(label)
        labels.append(label)
    return labels


def _sensitivity_change_detail(
    previous_snapshot: Dict[str, Tuple[Optional[float], Optional[float]]],
    current_snapshot: Dict[str, Tuple[Optional[float], Optional[float]]],
) -> List[Dict[str, object]]:
    changes: List[Dict[str, object]] = []
    for cls in DRIVER_DEFECT_CLASSES:
        delta = _sensitivity_tuple_delta(previous_snapshot.get(cls), current_snapshot.get(cls))
        if not delta:
            continue
        changes.append(
            {
                "name": cls,
                "label": _driver_class_label(cls),
                "previous": delta["previous"],
                "current": delta["current"],
            }
        )
    return changes


def _serialize_reel_metrics(record: Dict[str, object]) -> Dict[str, object]:
    return {
        "defect_count": int(record.get("total_defects") or 0),
        "rate_per_1000ft": _to_float(record.get("defects_per_1000ft")),
        "avg_defect_size": _to_float(record.get("avg_defect_size")),
        "class_counts": _driver_class_breakdown(record.get("class_counter") or Counter()),
    }


def _driver_impact_row(
    current_record: Dict[str, object],
    previous_record: Dict[str, object],
    *,
    extra: Optional[Dict[str, object]] = None,
) -> Dict[str, object]:
    before_metrics = _serialize_reel_metrics(previous_record)
    after_metrics = _serialize_reel_metrics(current_record)
    payload = {
        "reel_id": current_record.get("reel_id"),
        "reel_code": current_record.get("reel_code"),
        "job": current_record.get("job"),
        "order": current_record.get("order"),
        "time": current_record.get("time"),
        "before_defect_count": before_metrics["defect_count"],
        "after_defect_count": after_metrics["defect_count"],
        "before_rate_per_1000ft": before_metrics["rate_per_1000ft"],
        "after_rate_per_1000ft": after_metrics["rate_per_1000ft"],
        "rate_delta_per_1000ft": _safe_delta(
            after_metrics["rate_per_1000ft"], before_metrics["rate_per_1000ft"]
        ),
        "before_avg_size": before_metrics["avg_defect_size"],
        "after_avg_size": after_metrics["avg_defect_size"],
        "avg_size_delta": _safe_delta(
            after_metrics["avg_defect_size"], before_metrics["avg_defect_size"]
        ),
        "before_class_counts": before_metrics["class_counts"],
        "after_class_counts": after_metrics["class_counts"],
    }
    if extra:
        payload.update(extra)
    return payload


def _weighted_average(pairs: Iterable[Tuple[Optional[float], int]]) -> Optional[float]:
    total_weight = 0
    total_value = 0.0
    for value, weight in pairs:
        numeric = _to_float(value)
        qty = int(weight or 0)
        if numeric is None or qty <= 0:
            continue
        total_value += numeric * qty
        total_weight += qty
    if total_weight <= 0:
        return None
    return round(total_value / total_weight, 3)


def _average(values: Iterable[Optional[float]]) -> Optional[float]:
    numeric = [_to_float(value) for value in values]
    filtered = [value for value in numeric if value is not None]
    if not filtered:
        return None
    return round(sum(filtered) / len(filtered), 3)


def _drivers_window_metrics(records: Iterable[Dict[str, object]]) -> Dict[str, object]:
    rows = list(records or [])
    if not rows:
        return {
            "reel_start": None,
            "reel_end": None,
            "time_start": None,
            "time_end": None,
            "reel_count": 0,
            "total_feet": 0.0,
            "total_defects": 0,
            "defects_per_1000ft": None,
            "avg_defect_size": None,
            "bst_active_pct": None,
            "bst_validity": _mask_segment_validity_label(None),
        }
    total_feet = sum(_to_float(row.get("length_ft")) or 0.0 for row in rows)
    total_defects = sum(int(row.get("total_defects") or 0) for row in rows)
    avg_defect_size = _weighted_average(
        (row.get("avg_defect_size"), int(row.get("total_defects") or 0)) for row in rows
    )
    bst_active_pct = _average((row.get("bst_coverage") or {}).get("active_pct") for row in rows)
    return {
        "reel_start": rows[0].get("reel_code"),
        "reel_end": rows[-1].get("reel_code"),
        "time_start": rows[0].get("time"),
        "time_end": rows[-1].get("time"),
        "reel_count": len(rows),
        "total_feet": round(total_feet, 2),
        "total_defects": total_defects,
        "defects_per_1000ft": _rate_per_1000ft(total_defects, total_feet),
        "avg_defect_size": avg_defect_size,
        "bst_active_pct": bst_active_pct,
        "bst_validity": _mask_segment_validity_label(bst_active_pct),
    }


def _reference_impact_interpretation(
    before_rate: Optional[float],
    after_rate: Optional[float],
    validity_notes: Iterable[Optional[str]],
) -> str:
    notes = [note for note in (validity_notes or []) if note]
    if any(note != "Valid comparison" for note in notes):
        return "Inconclusive"
    delta = _safe_delta(after_rate, before_rate)
    if delta is None:
        return "Inconclusive"
    if delta > 0.1:
        return "Worsened"
    if delta < -0.1:
        return "Improved"
    return "Stable"


def _resolve_size_metric(
    severity_value: Optional[float],
    magnitude_value: Optional[float],
) -> Tuple[Optional[float], Optional[str]]:
    severity_num = _to_float(severity_value)
    if severity_num is not None:
        return severity_num, "severity_value"
    magnitude_num = _to_float(magnitude_value)
    if magnitude_num is not None:
        return magnitude_num, "magnitude_value_fallback"
    return None, None


def _serialize_mask_detail(mask: Mask) -> Dict[str, object]:
    noinspection = _mask_noinspection_enabled(getattr(mask, "noinspection", False))
    return {
        "xml_id": (mask.xml_id or "").strip() or None,
        "sensitivitysetid": (mask.sensitivitysetid or "").strip() or None,
        "coords": (mask.coords or "").strip() if mask.coords else "",
        "timestamp": _iso(mask.timestamp),
        "format_value": _to_float(mask.format_value),
        "noinspection": noinspection,
        "event": "applied" if noinspection else "removed",
    }


def _serialize_reference_detail(
    image: ReferenceImage,
    *,
    order_index: int,
    reel_time: Optional[str],
) -> Dict[str, object]:
    return {
        "ref_image_id": image.ref_image_id,
        "filename": image.filename,
        "image_src": (image.image_src or "").replace("\\", "/"),
        "order_index": order_index,
        "format": _to_float(image.format),
        "captured_at": reel_time,
    }


def _reference_check_status_band(match_pct: Optional[float]) -> str:
    if match_pct is None:
        return "Not compared"
    if match_pct >= REFERENCE_CHECK_STRONG_THRESHOLD:
        return "Strong match"
    if match_pct >= REFERENCE_CHECK_MINOR_THRESHOLD:
        return "Minor variation"
    if match_pct >= REFERENCE_CHECK_CHANGE_THRESHOLD:
        return "Noticeable variation"
    return "Likely changed"


def _reference_check_status_key(match_pct: Optional[float]) -> str:
    if match_pct is None:
        return "unscored"
    if match_pct >= REFERENCE_CHECK_STRONG_THRESHOLD:
        return "strong_match"
    if match_pct >= REFERENCE_CHECK_MINOR_THRESHOLD:
        return "minor_variation"
    if match_pct >= REFERENCE_CHECK_CHANGE_THRESHOLD:
        return "noticeable_variation"
    return "likely_changed"


def _reference_check_similarity_cluster(match_pct: Optional[float]) -> Dict[str, str]:
    if match_pct is None:
        return {"key": "unscored", "label": "Unscored"}
    if match_pct >= 97.0:
        return {"key": "strong_core", "label": "Strong Core"}
    if match_pct >= 93.0:
        return {"key": "near_match", "label": "Near Match"}
    if match_pct >= 88.0:
        return {"key": "mild_shift", "label": "Mild Shift"}
    if match_pct >= REFERENCE_CHECK_CHANGE_THRESHOLD:
        return {"key": "moderate_shift", "label": "Moderate Shift"}
    return {"key": "major_change", "label": "Major Change"}


def _reference_check_base_filters(filters: Dict[str, Any]) -> Dict[str, Any]:
    normalized = dict(filters)
    normalized["order"] = None
    normalized["reel_code"] = None
    normalized["reel_codes"] = []
    normalized["reel_ids"] = []
    return normalized


def _resolve_reference_check_job(session: Session, filters: Dict[str, Any]) -> Optional[str]:
    normalized = _reference_check_base_filters(filters)
    if normalized.get("job"):
        return normalized["job"]

    # A Job No. (order number) without an item: use the item that Job No. is running.
    order_value = filters.get("order")
    if order_value and order_value != SENTINEL_NONE:
        order_filters = dict(normalized)
        order_filters["order"] = order_value
        order_job = (
            _apply_reel_filters(session.query(Reel), order_filters, include_reel_code=False)
            .filter(Reel.job_name.isnot(None))
            .filter(Reel.job_name != "")
            .order_by(Reel.time_end.desc(), Reel.reel_id.desc())
            .with_entities(Reel.job_name)
            .limit(1)
            .scalar()
        )
        if order_job:
            return order_job

    query = (
        _apply_reel_filters(session.query(Reel), normalized, include_reel_code=False)
        .filter(Reel.job_name.isnot(None))
        .filter(Reel.job_name != "")
    )
    latest_job = query.order_by(Reel.time_end.desc(), Reel.reel_id.desc()).with_entities(Reel.job_name).limit(1).scalar()
    if latest_job:
        return latest_job

    fallback = (
        session.query(Reel.job_name)
        .filter(Reel.machine_id == normalized["machine_id"])
        .filter(Reel.job_name.isnot(None))
        .filter(Reel.job_name != "")
        .order_by(Reel.time_end.desc(), Reel.reel_id.desc())
        .limit(1)
        .scalar()
    )
    return fallback


def _resolve_reference_asset_path(image_src: Optional[str]) -> Optional[str]:
    if not image_src or not current_app.static_folder:
        return None
    normalized = str(image_src).strip().replace("\\", "/")
    if not normalized:
        return None
    if normalized.startswith(("http://", "https://", "data:")):
        return None
    if normalized.startswith("/static/"):
        normalized = normalized[len("/static/") :]
    elif normalized.startswith("static/"):
        normalized = normalized[len("static/") :]
    normalized = normalized.lstrip("/")
    static_root = os.path.abspath(current_app.static_folder)
    candidate = os.path.abspath(os.path.join(static_root, normalized))
    if candidate != static_root and not candidate.startswith(f"{static_root}{os.sep}"):
        return None
    if not os.path.exists(candidate):
        return None
    return candidate


def _reference_check_image_array(image_src: Optional[str]) -> Optional[np.ndarray]:
    asset_path = _resolve_reference_asset_path(image_src)
    if not asset_path:
        return None
    try:
        with Image.open(asset_path) as image:
            normalized = ImageOps.exif_transpose(image).convert("L")
            normalized = ImageOps.autocontrast(normalized)
            normalized = normalized.resize(REFERENCE_CHECK_IMAGE_SIZE, Image.Resampling.BILINEAR)
            return np.asarray(normalized, dtype=np.float32) / 255.0
    except (FileNotFoundError, OSError, ValueError):
        return None


def _reference_check_image_payload(image_src: Optional[str]) -> Optional[Dict[str, np.ndarray]]:
    asset_path = _resolve_reference_asset_path(image_src)
    if not asset_path:
        return None
    try:
        with Image.open(asset_path) as image:
            rgb_image = ImageOps.exif_transpose(image).convert("RGB")
            rgb_image = rgb_image.resize(REFERENCE_CHECK_IMAGE_SIZE, Image.Resampling.BILINEAR)
            gray_image = ImageOps.autocontrast(rgb_image.convert("L"))
            gray_array = np.asarray(gray_image, dtype=np.float32) / 255.0
            normalized_gray = _reference_check_local_contrast_normalize(gray_array)
            rgb_array = np.asarray(rgb_image, dtype=np.float32) / 255.0
            edge_x = np.abs(np.diff(normalized_gray, axis=1, append=normalized_gray[:, -1:]))
            edge_y = np.abs(np.diff(normalized_gray, axis=0, append=normalized_gray[-1:, :]))
            edge_array = np.clip(edge_x + edge_y, 0.0, 1.0)
            gradient_array = np.sqrt((edge_x ** 2) + (edge_y ** 2))
            return {
                "gray": gray_array,
                "normalized_gray": normalized_gray,
                "rgb": rgb_array,
                "edge": edge_array,
                "gradient": gradient_array,
            }
    except (FileNotFoundError, OSError, ValueError):
        return None


def _reference_check_local_contrast_normalize(gray_array: np.ndarray, radius: int = 2) -> np.ndarray:
    if gray_array.size == 0:
        return gray_array
    total = np.zeros_like(gray_array, dtype=np.float32)
    total_sq = np.zeros_like(gray_array, dtype=np.float32)
    count = 0
    for dy in range(-radius, radius + 1):
        shifted_y = np.roll(gray_array, dy, axis=0)
        for dx in range(-radius, radius + 1):
            shifted = np.roll(shifted_y, dx, axis=1)
            total += shifted
            total_sq += shifted * shifted
            count += 1
    mean = total / max(count, 1)
    variance = np.maximum((total_sq / max(count, 1)) - (mean * mean), 1e-6)
    std = np.sqrt(variance)
    normalized = (gray_array - mean) / std
    normalized = np.clip((normalized + 3.0) / 6.0, 0.0, 1.0)
    return normalized.astype(np.float32)


def _reference_check_shift_array(array: np.ndarray, dy: int = 0, dx: int = 0) -> np.ndarray:
    shifted = np.roll(array, int(dy), axis=0)
    if dx == 0:
        return shifted
    width = shifted.shape[1]
    if abs(dx) >= width:
        return np.repeat(shifted[:, :1], width, axis=1)
    if shifted.ndim == 2:
        output = np.empty_like(shifted)
        if dx > 0:
            output[:, dx:] = shifted[:, :-dx]
            output[:, :dx] = shifted[:, :1]
        else:
            dx_abs = abs(dx)
            output[:, :-dx_abs] = shifted[:, dx_abs:]
            output[:, -dx_abs:] = shifted[:, -1:]
        return output
    output = np.empty_like(shifted)
    if dx > 0:
        output[:, dx:, ...] = shifted[:, :-dx, ...]
        output[:, :dx, ...] = shifted[:, :1, ...]
    else:
        dx_abs = abs(dx)
        output[:, :-dx_abs, ...] = shifted[:, dx_abs:, ...]
        output[:, -dx_abs:, ...] = shifted[:, -1:, ...]
    return output


def _reference_check_ssim_percent(
    baseline_array: Optional[np.ndarray],
    comparison_array: Optional[np.ndarray],
) -> Optional[float]:
    if baseline_array is None or comparison_array is None:
        return None
    if baseline_array.shape != comparison_array.shape:
        return None
    base = baseline_array.astype(np.float32)
    comp = comparison_array.astype(np.float32)
    mu_base = float(base.mean())
    mu_comp = float(comp.mean())
    var_base = float(base.var())
    var_comp = float(comp.var())
    covariance = float(((base - mu_base) * (comp - mu_comp)).mean())
    c1 = 0.01 ** 2
    c2 = 0.03 ** 2
    denominator = (mu_base * mu_base + mu_comp * mu_comp + c1) * (var_base + var_comp + c2)
    if denominator <= 0:
        similarity = 1.0 if np.allclose(base, comp) else 0.0
    else:
        similarity = ((2 * mu_base * mu_comp + c1) * (2 * covariance + c2)) / denominator
    similarity = max(0.0, min(1.0, similarity))
    return round(similarity * 100.0, 1)


def _reference_check_color_match_percent(
    baseline_rgb: Optional[np.ndarray],
    comparison_rgb: Optional[np.ndarray],
) -> Optional[float]:
    if baseline_rgb is None or comparison_rgb is None:
        return None
    if baseline_rgb.shape != comparison_rgb.shape:
        return None
    mean_abs_diff = float(np.mean(np.abs(baseline_rgb.astype(np.float32) - comparison_rgb.astype(np.float32))))
    similarity = max(0.0, min(1.0, 1.0 - mean_abs_diff / 0.65))
    return round(similarity * 100.0, 1)


def _reference_check_correlation_percent(
    baseline_array: Optional[np.ndarray],
    comparison_array: Optional[np.ndarray],
) -> Optional[float]:
    if baseline_array is None or comparison_array is None:
        return None
    if baseline_array.shape != comparison_array.shape:
        return None
    base = baseline_array.astype(np.float32).reshape(-1)
    comp = comparison_array.astype(np.float32).reshape(-1)
    base = base - float(base.mean())
    comp = comp - float(comp.mean())
    base_norm = float(np.linalg.norm(base))
    comp_norm = float(np.linalg.norm(comp))
    if base_norm <= 1e-8 or comp_norm <= 1e-8:
        return None
    correlation = float(np.dot(base, comp) / (base_norm * comp_norm))
    similarity = max(0.0, min(1.0, (correlation + 1.0) / 2.0))
    return round(similarity * 100.0, 1)


def _reference_check_edge_overlap_percent(
    baseline_edge: Optional[np.ndarray],
    comparison_edge: Optional[np.ndarray],
) -> Tuple[Optional[float], Optional[float]]:
    if baseline_edge is None or comparison_edge is None:
        return None, None
    if baseline_edge.shape != comparison_edge.shape:
        return None, None
    combined = np.concatenate(
        [
            baseline_edge.astype(np.float32).reshape(-1),
            comparison_edge.astype(np.float32).reshape(-1),
        ]
    )
    threshold = float(np.percentile(combined, 76))
    threshold = max(threshold, 0.04)
    base_mask = baseline_edge >= threshold
    comp_mask = comparison_edge >= threshold
    overlap = float(np.logical_and(base_mask, comp_mask).sum())
    denom = float(base_mask.sum() + comp_mask.sum())
    if denom <= 0:
        return 100.0, 0.0
    dice = (2.0 * overlap) / denom
    return round(max(0.0, min(1.0, dice)) * 100.0, 1), round(
        float((base_mask.sum() + comp_mask.sum()) / (2.0 * base_mask.size)) * 100.0, 1
    )


def _reference_check_print_region_mask(
    rgb_array: Optional[np.ndarray],
    edge_array: Optional[np.ndarray],
) -> Optional[np.ndarray]:
    if rgb_array is None or edge_array is None:
        return None
    luminance = (
        (rgb_array[..., 0] * 0.299) + (rgb_array[..., 1] * 0.587) + (rgb_array[..., 2] * 0.114)
    ).astype(np.float32)
    saturation = (np.max(rgb_array, axis=2) - np.min(rgb_array, axis=2)).astype(np.float32)
    edge_threshold = max(float(np.percentile(edge_array, 68)), 0.03)
    luminance_mask = luminance < 0.94
    saturation_mask = saturation > 0.08
    edge_mask = edge_array >= edge_threshold
    combined = np.logical_or(np.logical_or(luminance_mask, saturation_mask), edge_mask)
    if not np.any(combined):
        combined = luminance < 0.985
    return combined


def _reference_check_rgb_to_lab(rgb_array: np.ndarray) -> np.ndarray:
    rgb = np.clip(rgb_array.astype(np.float32), 0.0, 1.0)
    threshold = 0.04045
    linear = np.where(rgb <= threshold, rgb / 12.92, ((rgb + 0.055) / 1.055) ** 2.4)
    x = (linear[..., 0] * 0.4124564) + (linear[..., 1] * 0.3575761) + (linear[..., 2] * 0.1804375)
    y = (linear[..., 0] * 0.2126729) + (linear[..., 1] * 0.7151522) + (linear[..., 2] * 0.0721750)
    z = (linear[..., 0] * 0.0193339) + (linear[..., 1] * 0.1191920) + (linear[..., 2] * 0.9503041)
    x = x / 0.95047
    y = y / 1.00000
    z = z / 1.08883

    def _f(channel: np.ndarray) -> np.ndarray:
        delta = 6.0 / 29.0
        threshold_local = delta ** 3
        return np.where(channel > threshold_local, np.cbrt(channel), (channel / (3 * delta * delta)) + (4.0 / 29.0))

    fx = _f(x)
    fy = _f(y)
    fz = _f(z)
    l = (116.0 * fy) - 16.0
    a = 500.0 * (fx - fy)
    b = 200.0 * (fy - fz)
    return np.stack([l, a, b], axis=-1)


def _reference_check_region_color_match(
    baseline_rgb: Optional[np.ndarray],
    comparison_rgb: Optional[np.ndarray],
    region_mask: Optional[np.ndarray],
) -> Tuple[Optional[float], Optional[float], Optional[float], Optional[float], Optional[float]]:
    if baseline_rgb is None or comparison_rgb is None or region_mask is None:
        return None, None, None, None, None
    if baseline_rgb.shape != comparison_rgb.shape or baseline_rgb.shape[:2] != region_mask.shape:
        return None, None, None, None, None
    base_lab = _reference_check_rgb_to_lab(baseline_rgb)
    comp_lab = _reference_check_rgb_to_lab(comparison_rgb)
    active_mask = region_mask.astype(bool)
    if not np.any(active_mask):
        active_mask = np.ones(region_mask.shape, dtype=bool)
    lightness_delta = np.abs(base_lab[..., 0] - comp_lab[..., 0])
    chroma_delta = np.linalg.norm(base_lab[..., 1:] - comp_lab[..., 1:], axis=2)
    masked_lightness_delta = float(lightness_delta[active_mask].mean())
    masked_chroma_delta = float(chroma_delta[active_mask].mean())
    global_chroma_delta = float(chroma_delta.mean())
    chroma_blended = (masked_chroma_delta * 0.85) + (global_chroma_delta * 0.15)
    chroma_similarity = max(0.0, min(1.0, 1.0 - (chroma_blended / 18.0)))
    lightness_penalty = min(masked_lightness_delta / 45.0, 1.0) * 0.12
    similarity = max(0.0, min(1.0, chroma_similarity - lightness_penalty))
    return (
        round(similarity * 100.0, 1),
        round(masked_chroma_delta, 2),
        round(global_chroma_delta, 2),
        round(masked_lightness_delta, 2),
        round(chroma_similarity * 100.0, 1),
    )


def _reference_check_signed_vertical_shift(dy: int, height: int) -> int:
    signed = int(dy)
    if signed > height // 2:
        signed -= height
    return signed


def _reference_check_find_best_alignment(
    baseline_payload: Optional[Dict[str, np.ndarray]],
    comparison_payload: Optional[Dict[str, np.ndarray]],
) -> Dict[str, object]:
    if not baseline_payload or not comparison_payload:
        return {"dy": 0, "dx": 0, "confidence": None, "score": None}
    base_norm = baseline_payload.get("normalized_gray")
    comp_norm = comparison_payload.get("normalized_gray")
    base_grad = baseline_payload.get("gradient")
    comp_grad = comparison_payload.get("gradient")
    base_edge = baseline_payload.get("edge")
    comp_edge = comparison_payload.get("edge")
    if base_norm is None or comp_norm is None or base_grad is None or comp_grad is None:
        return {"dy": 0, "dx": 0, "confidence": None, "score": None}
    height = base_norm.shape[0]
    baseline_profile = base_grad.mean(axis=1).astype(np.float32)
    comparison_profile = comp_grad.mean(axis=1).astype(np.float32)
    dy_candidates: List[Tuple[float, int]] = []
    for dy in range(height):
        shifted_profile = np.roll(comparison_profile, dy)
        profile_score = _reference_check_correlation_percent(
            baseline_profile.reshape(-1, 1), shifted_profile.reshape(-1, 1)
        )
        dy_candidates.append((float(profile_score or 0.0), dy))
    dy_candidates.sort(key=lambda item: item[0], reverse=True)
    top_dys = sorted({0, *[dy for _, dy in dy_candidates[:8]]})
    candidate_results: List[Dict[str, object]] = []
    for dy in top_dys:
        for dx in range(-REFERENCE_CHECK_MAX_HORIZONTAL_SHIFT_PX, REFERENCE_CHECK_MAX_HORIZONTAL_SHIFT_PX + 1):
            shifted_norm = _reference_check_shift_array(comp_norm, dy=dy, dx=dx)
            shifted_grad = _reference_check_shift_array(comp_grad, dy=dy, dx=dx)
            shifted_edge = _reference_check_shift_array(comp_edge, dy=dy, dx=dx) if comp_edge is not None else None
            gradient_corr = _reference_check_correlation_percent(base_grad, shifted_grad) or 0.0
            structure_corr = _reference_check_correlation_percent(base_norm, shifted_norm) or 0.0
            edge_overlap, _ = _reference_check_edge_overlap_percent(base_edge, shifted_edge)
            composite_score = (gradient_corr * 0.55) + (structure_corr * 0.20) + ((edge_overlap or 0.0) * 0.25)
            candidate_results.append(
                {
                    "dy": dy,
                    "dx": dx,
                    "score": round(composite_score, 3),
                    "gradient_corr_pct": gradient_corr,
                    "normalized_gray_corr_pct": structure_corr,
                    "edge_overlap_pct": edge_overlap,
                }
            )
    if not candidate_results:
        return {"dy": 0, "dx": 0, "confidence": None, "score": None}
    candidate_results.sort(key=lambda item: float(item.get("score") or 0.0), reverse=True)
    best = candidate_results[0]
    second_score = float(candidate_results[1]["score"]) if len(candidate_results) > 1 else float(best["score"] or 0.0)
    score_margin = max(float(best["score"] or 0.0) - second_score, 0.0)
    composite_score = float(best["score"] or 0.0)
    gradient_corr = float(best.get("gradient_corr_pct") or 0.0)
    structure_corr = float(best.get("normalized_gray_corr_pct") or 0.0)
    edge_overlap = float(best.get("edge_overlap_pct") or 0.0)
    dx_similarity = max(0.0, 100.0 - ((abs(int(best["dx"])) / max(REFERENCE_CHECK_MAX_HORIZONTAL_SHIFT_PX, 1)) * 8.0))
    base_confidence = (gradient_corr * 0.58) + (edge_overlap * 0.22) + (structure_corr * 0.12) + (composite_score * 0.08)
    confidence = min(
        100.0,
        max(
            0.0,
            (base_confidence * 0.93) + (min(score_margin, 12.0) * 0.05) + (dx_similarity * 0.02),
        ),
    )
    return {
        "dy": int(best["dy"]),
        "dx": int(best["dx"]),
        "confidence": round(confidence, 1),
        "score": round(float(best["score"] or 0.0), 1),
        "gradient_corr_pct": best.get("gradient_corr_pct"),
        "normalized_gray_corr_pct": best.get("normalized_gray_corr_pct"),
        "edge_overlap_pct": best.get("edge_overlap_pct"),
        "dx_similarity_pct": round(dx_similarity, 1),
        "score_margin_pct": round(score_margin, 1),
    }


def _reference_check_coarse_presence(
    baseline_mask: Optional[np.ndarray],
    comparison_mask: Optional[np.ndarray],
    grid_x: int = 12,
    grid_y: int = 8,
) -> Dict[str, object]:
    if baseline_mask is None or comparison_mask is None:
        return {"content_presence_pct": None, "coarse_presence_pct": None, "missing_regions": []}
    height, width = baseline_mask.shape
    if comparison_mask.shape != baseline_mask.shape:
        return {"content_presence_pct": None, "coarse_presence_pct": None, "missing_regions": []}
    baseline_blocks = np.zeros((grid_y, grid_x), dtype=bool)
    comparison_blocks = np.zeros((grid_y, grid_x), dtype=bool)
    for gy in range(grid_y):
        y0 = int(round((gy / grid_y) * height))
        y1 = int(round(((gy + 1) / grid_y) * height))
        for gx in range(grid_x):
            x0 = int(round((gx / grid_x) * width))
            x1 = int(round(((gx + 1) / grid_x) * width))
            baseline_slice = baseline_mask[y0:y1, x0:x1]
            comparison_slice = comparison_mask[y0:y1, x0:x1]
            baseline_blocks[gy, gx] = bool(baseline_slice.size and float(baseline_slice.mean()) >= 0.22)
            comparison_blocks[gy, gx] = bool(comparison_slice.size and float(comparison_slice.mean()) >= 0.22)
    baseline_active = float(baseline_blocks.sum())
    overlap = float(np.logical_and(baseline_blocks, comparison_blocks).sum())
    comparison_active = float(comparison_blocks.sum())
    content_presence_pct = round((overlap / baseline_active) * 100.0, 1) if baseline_active > 0 else 100.0
    coarse_presence_pct = (
        round(((2.0 * overlap) / (baseline_active + comparison_active)) * 100.0, 1)
        if (baseline_active + comparison_active) > 0
        else 100.0
    )
    missing_mask = np.logical_and(baseline_blocks, np.logical_not(comparison_blocks))
    visited = np.zeros_like(missing_mask, dtype=bool)
    regions: List[Dict[str, float]] = []
    for gy in range(grid_y):
        for gx in range(grid_x):
            if not missing_mask[gy, gx] or visited[gy, gx]:
                continue
            stack = [(gy, gx)]
            visited[gy, gx] = True
            min_x = max_x = gx
            min_y = max_y = gy
            area = 0
            while stack:
                current_y, current_x = stack.pop()
                area += 1
                min_x = min(min_x, current_x)
                max_x = max(max_x, current_x)
                min_y = min(min_y, current_y)
                max_y = max(max_y, current_y)
                for next_y, next_x in (
                    (current_y - 1, current_x),
                    (current_y + 1, current_x),
                    (current_y, current_x - 1),
                    (current_y, current_x + 1),
                ):
                    if next_y < 0 or next_y >= grid_y or next_x < 0 or next_x >= grid_x:
                        continue
                    if visited[next_y, next_x] or not missing_mask[next_y, next_x]:
                        continue
                    visited[next_y, next_x] = True
                    stack.append((next_y, next_x))
            if area < 2:
                continue
            x0 = int(round((min_x / grid_x) * width))
            y0 = int(round((min_y / grid_y) * height))
            x1 = int(round(((max_x + 1) / grid_x) * width))
            y1 = int(round(((max_y + 1) / grid_y) * height))
            regions.append(
                {
                    "x": x0,
                    "y": y0,
                    "w": max(x1 - x0, 1),
                    "h": max(y1 - y0, 1),
                    "area": max(area, 1),
                }
            )
    regions.sort(key=lambda region: float(region.get("area") or 0.0), reverse=True)
    return {
        "content_presence_pct": content_presence_pct,
        "coarse_presence_pct": coarse_presence_pct,
        "missing_regions": regions[:4],
    }


def _reference_check_alignment_match_percent(
    baseline_gray: Optional[np.ndarray],
    comparison_gray: Optional[np.ndarray],
) -> Tuple[Optional[float], Optional[Dict[str, float]]]:
    if baseline_gray is None or comparison_gray is None:
        return None, None
    if baseline_gray.shape != comparison_gray.shape:
        return None, None
    base = baseline_gray.astype(np.float32) - float(baseline_gray.mean())
    comp = comparison_gray.astype(np.float32) - float(comparison_gray.mean())
    if not np.any(base) or not np.any(comp):
        return 100.0, {"dx_px": 0.0, "dy_px": 0.0, "shift_px": 0.0}
    correlation = np.fft.ifft2(np.fft.fft2(base) * np.conj(np.fft.fft2(comp)))
    correlation = np.abs(correlation)
    peak_y, peak_x = np.unravel_index(int(np.argmax(correlation)), correlation.shape)
    height, width = correlation.shape
    if peak_x > width // 2:
        peak_x -= width
    if peak_y > height // 2:
        peak_y -= height
    shift_px = math.sqrt(float(peak_x * peak_x + peak_y * peak_y))
    max_shift = math.sqrt(width * width + height * height) * REFERENCE_CHECK_ALIGNMENT_MAX_SHIFT_RATIO
    similarity = max(0.0, min(1.0, 1.0 - (shift_px / max_shift if max_shift > 0 else 0.0)))
    return round(similarity * 100.0, 1), {
        "dx_px": float(peak_x),
        "dy_px": float(peak_y),
        "shift_px": round(shift_px, 2),
    }


def _reference_check_difference_profile(
    baseline_payload: Optional[Dict[str, np.ndarray]],
    comparison_payload: Optional[Dict[str, np.ndarray]],
) -> Dict[str, object]:
    if not baseline_payload or not comparison_payload:
        return {
            "overall_match_pct": None,
            "content_match_pct": None,
            "color_match_pct": None,
            "alignment_match_pct": None,
            "likely_difference_type": "Unscored",
            "difference_reason_key": "unscored",
            "difference_explanation": "Reference scoring is unavailable for this comparison.",
            "brightness_delta_pct": None,
            "alignment_offset": None,
            "best_vertical_wrap_dy_px": None,
            "best_horizontal_dx_px": None,
            "alignment_confidence": None,
            "content_presence_pct": None,
            "coarse_presence_pct": None,
            "gradient_corr_pct": None,
            "edge_overlap_pct": None,
            "lab_chroma_similarity_pct": None,
            "lab_lightness_similarity_pct": None,
            "coarse_missing_regions": [],
            "debug_metrics": {},
        }
    gray_base = baseline_payload.get("gray")
    rgb_base = baseline_payload.get("rgb")
    edge_base = baseline_payload.get("edge")
    gradient_base = baseline_payload.get("gradient")
    alignment = _reference_check_find_best_alignment(baseline_payload, comparison_payload)
    dy = int(alignment.get("dy") or 0)
    dx = int(alignment.get("dx") or 0)
    gray_comp_shifted = _reference_check_shift_array(comparison_payload.get("gray"), dy=dy, dx=dx)
    normalized_gray_base = baseline_payload.get("normalized_gray")
    normalized_gray_comp_shifted = _reference_check_shift_array(
        comparison_payload.get("normalized_gray"), dy=dy, dx=dx
    )
    rgb_comp_shifted = _reference_check_shift_array(comparison_payload.get("rgb"), dy=dy, dx=dx)
    edge_comp_shifted = _reference_check_shift_array(comparison_payload.get("edge"), dy=dy, dx=dx)
    gradient_comp_shifted = _reference_check_shift_array(comparison_payload.get("gradient"), dy=dy, dx=dx)
    normalized_gray_score = _reference_check_correlation_percent(normalized_gray_base, normalized_gray_comp_shifted)
    edge_overlap_score, print_region_coverage = _reference_check_edge_overlap_percent(edge_base, edge_comp_shifted)
    gradient_score = _reference_check_correlation_percent(gradient_base, gradient_comp_shifted)
    gray_ssim_score = _reference_check_ssim_percent(gray_base, gray_comp_shifted)
    normalized_gray_ssim = _reference_check_ssim_percent(normalized_gray_base, normalized_gray_comp_shifted)
    baseline_region_mask = _reference_check_print_region_mask(rgb_base, edge_base)
    comparison_region_mask = _reference_check_print_region_mask(rgb_comp_shifted, edge_comp_shifted)
    presence = _reference_check_coarse_presence(baseline_region_mask, comparison_region_mask)
    content_presence_pct = presence.get("content_presence_pct")
    coarse_presence_pct = presence.get("coarse_presence_pct")
    coarse_missing_regions = presence.get("missing_regions") or []
    if (
        content_presence_pct is not None
        and gradient_score is not None
        and edge_overlap_score is not None
        and normalized_gray_score is not None
    ):
        content_match = round(
            (float(content_presence_pct) * 0.46)
            + (float(coarse_presence_pct or content_presence_pct) * 0.14)
            + (float(gradient_score) * 0.24)
            + (float(edge_overlap_score) * 0.12)
            + (float(normalized_gray_score) * 0.04),
            1,
        )
    else:
        content_match = content_presence_pct if content_presence_pct is not None else gradient_score
    union_region_mask = None
    if baseline_region_mask is not None and comparison_region_mask is not None:
        union_region_mask = np.logical_or(baseline_region_mask, comparison_region_mask)
    elif baseline_region_mask is not None:
        union_region_mask = baseline_region_mask
    elif comparison_region_mask is not None:
        union_region_mask = comparison_region_mask
    region_coverage_pct = round(float(union_region_mask.mean()) * 100.0, 1) if union_region_mask is not None else None
    color_match, masked_lab_delta, global_lab_delta, masked_lightness_delta, chroma_similarity_pct = _reference_check_region_color_match(
        rgb_base, rgb_comp_shifted, union_region_mask
    )
    lab_lightness_similarity_pct = None
    if masked_lightness_delta is not None:
        lab_lightness_similarity_pct = round(
            max(0.0, min(1.0, 1.0 - (float(masked_lightness_delta) / 60.0))) * 100.0,
            1,
        )
    alignment_confidence = alignment.get("confidence")
    dx_similarity = float(alignment.get("dx_similarity_pct") or max(
        0.0,
        100.0 - ((abs(dx) / max(REFERENCE_CHECK_MAX_HORIZONTAL_SHIFT_PX, 1)) * 8.0),
    ))
    alignment_match = (
        round(((float(alignment_confidence or 0.0) * 0.92) + (dx_similarity * 0.08)), 1)
        if alignment_confidence is not None
        else None
    )
    signed_dy = _reference_check_signed_vertical_shift(dy, gray_base.shape[0] if gray_base is not None else 0)
    alignment_offset = {
        "dx_px": float(dx),
        "dy_px": float(signed_dy),
        "shift_px": round(math.sqrt(float((dx * dx) + (signed_dy * signed_dy))), 2),
    }
    brightness_delta_pct = None
    if gray_base is not None and gray_comp_shifted is not None:
        brightness_delta_pct = round(abs(float(gray_base.mean()) - float(gray_comp_shifted.mean())) * 100.0, 1)
    overall_components: List[float] = []
    overall_weights: List[float] = []
    if content_match is not None:
        overall_components.append(content_match)
        overall_weights.append(REFERENCE_CHECK_CONTENT_WEIGHT)
    if color_match is not None:
        overall_components.append(color_match)
        overall_weights.append(REFERENCE_CHECK_COLOR_DOMINANT_WEIGHT)
    if alignment_match is not None:
        overall_components.append(alignment_match)
        overall_weights.append(REFERENCE_CHECK_ALIGNMENT_LIGHT_WEIGHT)
    if overall_components and overall_weights:
        weighted_total = sum(value * weight for value, weight in zip(overall_components, overall_weights))
        total_weight = sum(overall_weights) or 1.0
        overall_match = round(weighted_total / total_weight, 1)
    else:
        overall_match = None
    reason_key = "mixed_change"
    reason_label = "Mixed change"
    explanation = "Multiple difference signals are contributing to this comparison."
    content_value = float(content_match or 0.0)
    color_value = float(color_match or 0.0)
    alignment_value = float(alignment_match or 0.0)
    brightness_value = float(brightness_delta_pct or 0.0)
    chroma_value = float(chroma_similarity_pct or 0.0)
    lightness_value = float(lab_lightness_similarity_pct or 0.0)
    content_presence_value = float(content_presence_pct or 0.0)
    overall_value = float(overall_match or 0.0)
    if overall_match is None:
        reason_key = "unscored"
        reason_label = "Unscored"
        explanation = "Comparison scoring is unavailable for this image pair."
    elif content_value >= 92 and alignment_value >= 82 and color_value >= 82:
        reason_key = "strong_match"
        reason_label = "Strong match"
        explanation = "Content, color, and placement all remain highly consistent with the baseline."
    elif content_value >= 90 and alignment_value >= 78 and chroma_value >= 86 and lightness_value < 78:
        reason_key = "exposure_shift"
        reason_label = "Brightness / exposure shift"
        explanation = "Printed structure and placement remain stable; the main difference is brightness or display exposure."
    elif content_value >= 88 and alignment_value >= 78 and color_value < 76:
        if brightness_value >= 14 and lightness_value < 72 and chroma_value >= 84:
            reason_key = "exposure_shift"
            reason_label = "Exposure / brightness shift"
            explanation = "Printed structure remains stable, but brightness or exposure changed noticeably."
        else:
            reason_key = "color_shift"
            reason_label = "Color shift"
            explanation = "Printed content still matches strongly, but chroma or tone drifted from the baseline."
    elif content_value >= 86 and alignment_value < 70 and abs(dx) >= 2:
        reason_key = "alignment_shift"
        reason_label = "Alignment shift"
        explanation = "The main difference appears to be slight horizontal placement or registration offset rather than missing content."
    elif content_value < 70 and color_value < 72 and content_presence_value < 78:
        reason_key = "major_change"
        reason_label = "Major change"
        explanation = "Both structure and color differ substantially from the baseline."
    elif content_value < 80 and content_presence_value < 82:
        if coarse_missing_regions:
            reason_key = "missing_content"
            reason_label = "Missing content"
            explanation = "One or more coarse content regions appear absent after wrap-aware alignment."
        else:
            reason_key = "content_change"
            reason_label = "Content / template change"
            explanation = "The printed structure changed more than color or placement, suggesting a template/content change."
    elif overall_value >= 84:
        reason_key = "minor_variation"
        reason_label = "Minor appearance shift"
        explanation = "The same content appears present with only limited appearance variation."
    elif content_value < 84 and alignment_value >= 72:
        reason_key = "content_change"
        reason_label = "Content / template change"
        explanation = "The printed structure changed more than color or placement, suggesting a template/content change."
    debug_metrics = {
        "gray_ssim_pct": gray_ssim_score,
        "normalized_gray_ssim_pct": normalized_gray_ssim,
        "normalized_gray_corr_pct": normalized_gray_score,
        "gradient_ssim_pct": gradient_score,
        "gradient_corr_pct": gradient_score,
        "edge_overlap_pct": edge_overlap_score,
        "print_region_coverage_pct": region_coverage_pct if region_coverage_pct is not None else print_region_coverage,
        "masked_lab_delta": masked_lab_delta,
        "global_lab_delta": global_lab_delta,
        "lab_lightness_delta": masked_lightness_delta,
        "lab_chroma_similarity_pct": chroma_similarity_pct,
        "lab_lightness_similarity_pct": lab_lightness_similarity_pct,
        "brightness_delta_pct": brightness_delta_pct,
        "alignment_match_pct": alignment_match,
        "alignment_offset": alignment_offset,
        "alignment_inputs": {
            "alignment_confidence": alignment_confidence,
            "dx_similarity_pct": dx_similarity,
            "best_vertical_wrap_dy_px": signed_dy,
            "best_horizontal_dx_px": dx,
            "score_margin_pct": alignment.get("score_margin_pct"),
        },
        "content_inputs": {
            "content_presence_pct": content_presence_pct,
            "coarse_presence_pct": coarse_presence_pct,
            "normalized_gray_corr_pct": normalized_gray_score,
            "normalized_gray_ssim_pct": normalized_gray_ssim,
            "gradient_corr_pct": gradient_score,
            "edge_overlap_pct": edge_overlap_score,
        },
        "color_inputs": {
            "lab_chroma_similarity_pct": chroma_similarity_pct,
            "lab_lightness_similarity_pct": lab_lightness_similarity_pct,
            "lab_lightness_delta": masked_lightness_delta,
            "masked_lab_delta": masked_lab_delta,
            "global_lab_delta": global_lab_delta,
        },
        "rule_inputs": {
            "content_match_pct": content_match,
            "color_match_pct": color_match,
            "alignment_match_pct": alignment_match,
            "brightness_delta_pct": brightness_delta_pct,
            "content_presence_pct": content_presence_pct,
            "coarse_presence_pct": coarse_presence_pct,
            "coarse_missing_region_count": len(coarse_missing_regions),
            "alignment_confidence": alignment_confidence,
            "dx_similarity_pct": dx_similarity,
        },
    }
    return {
        "overall_match_pct": overall_match,
        "content_match_pct": content_match,
        "color_match_pct": color_match,
        "alignment_match_pct": alignment_match,
        "best_vertical_wrap_dy_px": _reference_check_signed_vertical_shift(
            dy, gray_base.shape[0] if gray_base is not None else 0
        ),
        "best_horizontal_dx_px": int(dx),
        "alignment_confidence": alignment_confidence,
        "content_presence_pct": content_presence_pct,
        "coarse_presence_pct": coarse_presence_pct,
        "gradient_corr_pct": gradient_score,
        "edge_overlap_pct": edge_overlap_score,
        "lab_chroma_similarity_pct": chroma_similarity_pct,
        "lab_lightness_similarity_pct": lab_lightness_similarity_pct,
        "coarse_missing_regions": coarse_missing_regions,
        "likely_difference_type": reason_label,
        "difference_reason_key": reason_key,
        "difference_explanation": explanation,
        "brightness_delta_pct": brightness_delta_pct,
        "alignment_offset": alignment_offset,
        "debug_metrics": debug_metrics,
    }


def _reference_check_similarity_percent(
    baseline_array: Optional[np.ndarray],
    comparison_array: Optional[np.ndarray],
) -> Optional[float]:
    return _reference_check_ssim_percent(baseline_array, comparison_array)


def _reference_check_average(values: Iterable[Optional[float]]) -> Optional[float]:
    numbers = [float(value) for value in values if value is not None]
    if not numbers:
        return None
    return round(sum(numbers) / len(numbers), 1)


def _reference_check_streaks(rows: List[Dict[str, object]]) -> Dict[str, object]:
    longest_strong = 0
    current_strong = 0
    unstable_periods: List[Dict[str, object]] = []
    unstable_start: Optional[Dict[str, object]] = None
    unstable_rows: List[Dict[str, object]] = []

    for row in rows:
        match_pct = row.get("match_pct")
        if isinstance(match_pct, (int, float)) and match_pct >= REFERENCE_CHECK_STRONG_THRESHOLD:
            current_strong += 1
            longest_strong = max(longest_strong, current_strong)
        else:
            current_strong = 0

        if row.get("likely_changed"):
            if unstable_start is None:
                unstable_start = row
                unstable_rows = [row]
            else:
                unstable_rows.append(row)
        elif unstable_start is not None:
            unstable_periods.append(
                {
                    "start_ref_image_id": unstable_start.get("ref_image_id"),
                    "start_reel_code": unstable_start.get("reel_code"),
                    "start_timestamp": unstable_start.get("captured_at"),
                    "count": len(unstable_rows),
                }
            )
            unstable_start = None
            unstable_rows = []

    if unstable_start is not None:
        unstable_periods.append(
            {
                "start_ref_image_id": unstable_start.get("ref_image_id"),
                "start_reel_code": unstable_start.get("reel_code"),
                "start_timestamp": unstable_start.get("captured_at"),
                "count": len(unstable_rows),
            }
        )

    return {
        "longest_strong_match_streak": longest_strong,
        "unstable_periods": unstable_periods,
    }


def _reference_check_defect_association(rows: List[Dict[str, object]]) -> Dict[str, object]:
    low_match_rows = [
        row for row in rows if row.get("likely_changed") and isinstance(row.get("defect_count"), int)
    ]
    strong_match_rows = [
        row
        for row in rows
        if isinstance(row.get("overall_match_pct"), (int, float))
        and row["overall_match_pct"] >= REFERENCE_CHECK_STRONG_THRESHOLD
        and isinstance(row.get("defect_count"), int)
    ]
    low_avg = _reference_check_average([row.get("defect_count") for row in low_match_rows])
    strong_avg = _reference_check_average([row.get("defect_count") for row in strong_match_rows])
    interpretation = "Insufficient defect data"
    if low_avg is not None and strong_avg is not None:
        if low_avg > strong_avg:
            interpretation = "Lower-match references coincide with higher average defect counts"
        elif low_avg < strong_avg:
            interpretation = "Lower-match references do not show higher average defect counts"
        else:
            interpretation = "Lower-match and strong-match references show similar defect counts"
    return {
        "low_match_reference_count": len(low_match_rows),
        "strong_match_reference_count": len(strong_match_rows),
        "avg_defects_low_match": low_avg,
        "avg_defects_strong_match": strong_avg,
        "interpretation": interpretation,
    }


def _reference_check_cluster_summary(rows: List[Dict[str, object]]) -> Dict[str, object]:
    cluster_counts: Counter[str] = Counter()
    cluster_labels: Dict[str, str] = {}
    for row in rows:
        cluster_key = str(row.get("similarity_cluster_key") or "unscored")
        cluster_label = str(row.get("similarity_cluster_label") or "Unscored")
        cluster_counts[cluster_key] += 1
        cluster_labels[cluster_key] = cluster_label
    clusters = [
        {
            "key": key,
            "label": cluster_labels.get(key, key.replace("_", " ").title()),
            "count": int(count),
        }
        for key, count in cluster_counts.most_common()
    ]
    dominant = clusters[0] if clusters else None
    return {
        "clusters": clusters,
        "dominant_cluster": dominant,
    }


def _reference_check_difference_type_summary(rows: List[Dict[str, object]]) -> Dict[str, object]:
    counts: Counter[str] = Counter()
    labels: Dict[str, str] = {}
    for row in rows:
        key = str(row.get("difference_reason_key") or "unscored")
        label = str(row.get("likely_difference_type") or "Unscored")
        counts[key] += 1
        labels[key] = label
    items = [
        {"key": key, "label": labels.get(key, key.replace("_", " ").title()), "count": int(count)}
        for key, count in counts.most_common()
    ]
    dominant = items[0] if items else None
    return {"items": items, "dominant": dominant}


def _reference_check_change_windows(rows: List[Dict[str, object]]) -> List[Dict[str, object]]:
    windows: List[Dict[str, object]] = []
    current: List[Dict[str, object]] = []
    for row in rows:
        if row.get("likely_changed"):
            current.append(row)
            continue
        if current:
            windows.append(current)
            current = []
    if current:
        windows.append(current)
    payload: List[Dict[str, object]] = []
    for index, window in enumerate(windows, start=1):
        match_values = [row.get("match_pct") for row in window if isinstance(row.get("match_pct"), (int, float))]
        payload.append(
            {
                "window_id": index,
                "count": len(window),
                "start_reel_code": window[0].get("reel_code"),
                "end_reel_code": window[-1].get("reel_code"),
                "start_timestamp": window[0].get("captured_at"),
                "end_timestamp": window[-1].get("captured_at"),
                "avg_match_pct": _reference_check_average(match_values),
                "min_match_pct": round(min(match_values), 1) if match_values else None,
            }
        )
    return payload


def _reference_check_defect_type_payload(counter: Counter) -> Dict[str, int]:
    payload: Dict[str, int] = {}
    for defect_type in DRIVER_DEFECT_CLASSES:
        payload[defect_type] = int(counter.get(defect_type, 0))
    return payload


@dashboard_bp.route("/api/defect-drivers")
def api_defect_drivers():
    with SessionLocal() as session:
        try:
            filters = _validate_filters(session)
        except ValueError as exc:
            return jsonify({"error": str(exc)}), 400

        window_start = filters["start"]
        window_end = filters["end"]
        if window_start is None or window_end is None:
            window_start, window_end = _default_window()

        reels = (
            _apply_reel_filters(session.query(Reel), filters, include_reel_code=False)
            .options(
                selectinload(Reel.defects),
                selectinload(Reel.inspection_phases),
                selectinload(Reel.sensitivity_sets),
                selectinload(Reel.masks),
                selectinload(Reel.reference_images),
            )
            .order_by(Reel.time_start.asc(), Reel.reel_id.asc())
            .all()
        )
        if not reels:
            return jsonify(
                {
                    "kpis": {
                        "reels_analyzed": 0,
                        "total_footage": 0.0,
                        "defects_per_1000ft": None,
                        "average_defect_size": None,
                        "avg_size_basis": "magnitude",
                        "top_defect_type": None,
                        "top_defect_type_label": None,
                        "top_defect_type_count": 0,
                        "total_defects": 0,
                    },
                    "event_counts": {},
                    "timeline": [],
                    "sensitivity_impacts": [],
                    "sensitivity_summary": [],
                    "mask_impacts": [],
                    "mask_segments": [],
                    "mask_overview": {
                        "summary": {
                            "total_reels": 0,
                            "reels_with_masks": 0,
                            "reels_without_masks": 0,
                            "total_feet_with_masks": 0.0,
                        },
                        "buckets": [],
                        "time_of_day": [],
                    },
                    "reference_stability": {
                        "summary": {
                            "reels_with_changes": 0,
                            "reels_with_repeated_updates": 0,
                            "total_reference_events": 0,
                        },
                        "events": [],
                        "frequent_updates": [],
                    },
                    "speed_impact": {
                        "summary": {
                            "total_reels_with_speed": 0,
                            "reels_without_speed": 0,
                        },
                        "buckets": [],
                        "stability": [],
                        "time_of_day": [],
                        "best_range": None,
                    },
                    "length_impact": {"buckets": [], "time_of_day": []},
                }
            )

        reel_ids = [reel.reel_id for reel in reels if reel.reel_id is not None]
        filtered_reels_subq = _apply_reel_filters(
            session.query(Reel.reel_id.label("reel_id")),
            filters,
            include_reel_code=False,
        ).subquery()

        kpi_defect_summary = session.query(
            func.count(Defect.defect_id).label("total_defects"),
            func.avg(Defect.severity_value).label("avg_severity"),
            func.avg(Defect.magnitude_value).label("avg_magnitude"),
        ).join(
            filtered_reels_subq,
            Defect.reel_id == filtered_reels_subq.c.reel_id,
        ).one()
        kpi_total_defects = int(getattr(kpi_defect_summary, "total_defects", 0) or 0)
        kpi_avg_size, kpi_avg_size_basis = _resolve_size_metric(
            getattr(kpi_defect_summary, "avg_severity", None),
            getattr(kpi_defect_summary, "avg_magnitude", None),
        )

        defect_rows = (
            session.query(
                Defect.reel_id,
                Defect.class_name,
                func.count(Defect.defect_id).label("defect_count"),
                func.avg(Defect.severity_value).label("avg_severity"),
                func.avg(Defect.magnitude_value).label("avg_magnitude"),
            )
            .filter(Defect.reel_id.in_(reel_ids))
            .group_by(Defect.reel_id, Defect.class_name)
            .all()
        )
        defect_summary_rows = (
            session.query(
                Defect.reel_id,
                func.count(Defect.defect_id).label("defect_count"),
                func.avg(Defect.severity_value).label("avg_severity"),
                func.avg(Defect.magnitude_value).label("avg_magnitude"),
            )
            .filter(Defect.reel_id.in_(reel_ids))
            .group_by(Defect.reel_id)
            .all()
        )
        speed_rows = (
            session.query(
                RLMMonitoring.reel_id,
                func.count(RLMMonitoring.monitor_id).label("sample_count"),
                func.avg(RLMMonitoring.webspeed).label("avg_speed"),
                func.min(RLMMonitoring.webspeed).label("min_speed"),
                func.max(RLMMonitoring.webspeed).label("max_speed"),
            )
            .filter(RLMMonitoring.reel_id.in_(reel_ids))
            .filter(RLMMonitoring.timestamp >= window_start)
            .filter(RLMMonitoring.timestamp <= window_end)
            .group_by(RLMMonitoring.reel_id)
            .all()
        )

        class_counts_by_reel: Dict[int, Counter] = defaultdict(Counter)
        class_avg_size_by_reel: Dict[int, Dict[str, Optional[float]]] = defaultdict(dict)
        class_avg_size_basis_by_reel: Dict[int, Dict[str, Optional[str]]] = defaultdict(dict)
        for row in defect_rows:
            reel_id = getattr(row, "reel_id", None)
            canonical = _canonical_sensitivity_class(getattr(row, "class_name", None))
            if reel_id is None or canonical not in DRIVER_DEFECT_CLASSES:
                continue
            class_counts_by_reel[reel_id][canonical] += int(getattr(row, "defect_count", 0) or 0)
            avg_size, avg_size_basis = _resolve_size_metric(
                getattr(row, "avg_severity", None),
                getattr(row, "avg_magnitude", None),
            )
            class_avg_size_by_reel[reel_id][canonical] = avg_size
            class_avg_size_basis_by_reel[reel_id][canonical] = avg_size_basis

        defect_stats_by_reel: Dict[int, Dict[str, object]] = defaultdict(
            lambda: {"count": 0, "avg_size": None, "avg_size_basis": None}
        )
        for row in defect_summary_rows:
            reel_id = getattr(row, "reel_id", None)
            if reel_id is None:
                continue
            avg_size, avg_size_basis = _resolve_size_metric(
                getattr(row, "avg_severity", None),
                getattr(row, "avg_magnitude", None),
            )
            defect_stats_by_reel[reel_id] = {
                "count": int(getattr(row, "defect_count", 0) or 0),
                "avg_size": avg_size,
                "avg_size_basis": avg_size_basis,
            }

        speed_by_reel: Dict[int, Dict[str, object]] = {}
        for row in speed_rows:
            reel_id = getattr(row, "reel_id", None)
            if reel_id is None:
                continue
            avg_speed = _to_float(getattr(row, "avg_speed", None))
            min_speed = _to_float(getattr(row, "min_speed", None))
            max_speed = _to_float(getattr(row, "max_speed", None))
            speed_by_reel[reel_id] = {
                "sample_count": int(getattr(row, "sample_count", 0) or 0),
                "avg_speed": avg_speed,
                "min_speed": min_speed,
                "max_speed": max_speed,
                "speed_range": round(max_speed - min_speed, 3)
                if min_speed is not None and max_speed is not None
                else None,
            }
        speed_trend_by_reel: Dict[int, List[Dict[str, Optional[object]]]] = defaultdict(list)
        speed_trend_rows = (
            session.query(
                RLMMonitoring.reel_id,
                RLMMonitoring.timestamp,
                RLMMonitoring.webspeed,
            )
            .filter(RLMMonitoring.reel_id.in_(reel_ids))
            .filter(RLMMonitoring.timestamp >= window_start)
            .filter(RLMMonitoring.timestamp <= window_end)
            .order_by(RLMMonitoring.reel_id.asc(), RLMMonitoring.timestamp.asc(), RLMMonitoring.monitor_id.asc())
            .all()
        )
        for row in speed_trend_rows:
            reel_id = getattr(row, "reel_id", None)
            timestamp = getattr(row, "timestamp", None)
            webspeed = _to_float(getattr(row, "webspeed", None))
            if reel_id is None or timestamp is None or webspeed is None:
                continue
            speed_trend_by_reel[reel_id].append(
                {
                    "timestamp": _iso(timestamp),
                    "webspeed": webspeed,
                }
            )

        reel_records: List[Dict[str, object]] = []
        grouped_records: Dict[Tuple[str, str], List[Dict[str, object]]] = defaultdict(list)
        overall_class_counter: Counter = Counter()
        total_footage = 0.0
        total_defects = 0
        sized_reels = 0
        avg_size_sum = 0.0
        severity_basis_count = 0
        fallback_basis_count = 0

        for reel in reels:
            reel_id = reel.reel_id
            if reel_id is None:
                continue
            reel_defects = list(reel.defects or [])
            length_ft = _reel_length_feet(reel)
            defect_entry = defect_stats_by_reel.get(reel_id, {})
            class_counter = class_counts_by_reel.get(reel_id, Counter())
            total_defects_reel = int(defect_entry.get("count", 0) or 0)
            avg_size = _to_float(defect_entry.get("avg_size"))
            avg_size_basis = defect_entry.get("avg_size_basis")
            if reel_defects:
                total_defects_reel = len(reel_defects)
                class_counter = Counter()
                severity_values: List[float] = []
                magnitude_values: List[float] = []
                for defect in reel_defects:
                    canonical = _canonical_sensitivity_class(getattr(defect, "class_name", None))
                    if canonical in DRIVER_DEFECT_CLASSES:
                        class_counter[canonical] += 1
                    severity_value = _to_float(getattr(defect, "severity_value", None))
                    magnitude_value = _to_float(getattr(defect, "magnitude_value", None))
                    if severity_value is not None:
                        severity_values.append(severity_value)
                    if magnitude_value is not None:
                        magnitude_values.append(magnitude_value)
                avg_size, avg_size_basis = _resolve_size_metric(
                    (sum(severity_values) / len(severity_values)) if severity_values else None,
                    (sum(magnitude_values) / len(magnitude_values)) if magnitude_values else None,
                )
            speed_entry = speed_by_reel.get(reel_id, {})
            total_footage += length_ft
            total_defects += total_defects_reel
            overall_class_counter.update(class_counter)
            if avg_size is not None:
                avg_size_sum += avg_size
                sized_reels += 1
                if avg_size_basis == "severity_value":
                    severity_basis_count += 1
                elif avg_size_basis == "magnitude_value_fallback":
                    fallback_basis_count += 1
            standard_map = _standard_map(reel.sensitivity_sets)
            sensitivity_snapshot = {cls: standard_map.get(cls) for cls in DRIVER_DEFECT_CLASSES}
            phase_mix = _phase_mix_for_reel(reel, window_start, window_end)
            active_seconds = _to_float((phase_mix.get("active") or {}).get("seconds")) or 0.0
            inactive_seconds = _to_float((phase_mix.get("inactive") or {}).get("seconds")) or 0.0
            learn_seconds = _to_float((phase_mix.get("learn") or {}).get("seconds")) or 0.0
            total_phase_seconds = sum(
                _to_float(values.get("seconds")) or 0.0 for values in phase_mix.values()
            )
            unknown_seconds = max(total_phase_seconds - active_seconds - inactive_seconds - learn_seconds, 0.0)
            active_pct = round((active_seconds / total_phase_seconds) * 100.0, 1) if total_phase_seconds else 0.0
            inactive_pct = round((inactive_seconds / total_phase_seconds) * 100.0, 1) if total_phase_seconds else 0.0
            learn_pct = round((learn_seconds / total_phase_seconds) * 100.0, 1) if total_phase_seconds else 0.0
            unknown_pct = round((unknown_seconds / total_phase_seconds) * 100.0, 1) if total_phase_seconds else 0.0
            bst_status = "active"
            bst_label = "BST Mostly Active"
            if active_pct <= BST_OFF_ACTIVE_PCT_THRESHOLD:
                bst_status = "off"
                bst_label = "BST Off"
            elif active_pct < BST_PARTIAL_ACTIVE_PCT_THRESHOLD:
                bst_status = "partial"
                bst_label = "Partial BST Coverage"
            masks_in_window = [
                mask
                for mask in (reel.masks or [])
                if mask.timestamp is None or (window_start <= mask.timestamp <= window_end)
            ]
            masks_for_state = list(reel.masks or [])
            serialized_masks_in_window = [_serialize_mask_detail(mask) for mask in masks_in_window]
            serialized_masks_for_state = [_serialize_mask_detail(mask) for mask in masks_for_state]
            effective_mask_signature = tuple(sorted(_active_mask_signature(serialized_masks_for_state)))
            ordered_refs = _ordered_reference_images(reel.reference_images)
            serialized_reference_images = [
                _serialize_reference_detail(
                    image,
                    order_index=index + 1,
                    reel_time=_iso(reel.time_end or reel.time_start),
                )
                for index, image in enumerate(ordered_refs)
            ]
            latest_reference_image = serialized_reference_images[-1] if serialized_reference_images else None
            record = {
                "reel_id": reel_id,
                "reel_code": reel.reel_code or f"Reel {reel_id}",
                "job": reel.job_name or "Unassigned",
                "job_value": reel.job_name or "",
                "order": reel.order_number or "No order",
                "time": _iso(reel.time_end or reel.time_start),
                "time_sort": reel.time_end or reel.time_start or window_end,
                "length_ft": length_ft,
                "format_length": _to_float(reel.format_length),
                "format_width": _to_float(reel.format_width),
                "total_defects": total_defects_reel,
                "defects_per_1000ft": _rate_per_1000ft(total_defects_reel, length_ft),
                "avg_defect_size": avg_size,
                "avg_defect_size_basis": avg_size_basis,
                "class_counter": class_counter,
                "class_avg_size_map": class_avg_size_by_reel.get(reel_id, {}),
                "class_avg_size_basis_map": class_avg_size_basis_by_reel.get(reel_id, {}),
                "type_breakdown": [],
                "top_defect_type": class_counter.most_common(1)[0][0] if class_counter else None,
                "sensitivity_snapshot": sensitivity_snapshot,
                "bst_coverage": {
                    "active_pct": active_pct,
                    "inactive_pct": inactive_pct,
                    "learn_pct": learn_pct,
                    "unknown_pct": unknown_pct,
                    "status": bst_status,
                    "label": bst_label,
                },
                "mask_signature": _mask_signature_entries(masks_in_window),
                "masks": serialized_masks_in_window,
                "mask_state_signature": _mask_signature_entries(masks_for_state),
                "mask_state_masks": serialized_masks_for_state,
                "mask_effective_signature": effective_mask_signature,
                "mask_effective_count": len(effective_mask_signature),
                "mask_count": len(effective_mask_signature),
                "reference_signature": _reference_signature(ordered_refs),
                "reference_count": len(ordered_refs),
                "reference_repeated_updates": max(len(ordered_refs) - 1, 0),
                "reference_images": serialized_reference_images,
                "latest_reference_image": latest_reference_image,
                "speed_avg": _to_float(speed_entry.get("avg_speed")),
                "speed_min": _to_float(speed_entry.get("min_speed")),
                "speed_max": _to_float(speed_entry.get("max_speed")),
                "speed_range": _to_float(speed_entry.get("speed_range")),
                "speed_samples": int(speed_entry.get("sample_count", 0) or 0),
                "speed_points": speed_trend_by_reel.get(reel_id, []),
                "events": [],
                "instability_score": 0,
                "has_mask_change": False,
            }
            reel_records.append(record)
            group_key = (reel.job_name or SENTINEL_NONE, reel.order_number or SENTINEL_NONE)
            grouped_records[group_key].append(record)

        speed_thresholds = _bucket_thresholds(
            [record["speed_avg"] for record in reel_records if _to_float(record.get("speed_avg")) is not None]
        )
        length_thresholds = _bucket_thresholds(
            [record["length_ft"] for record in reel_records if (_to_float(record.get("length_ft")) or 0) > 0]
        )
        speed_variation_thresholds = _bucket_thresholds(
            [
                _to_float(record.get("speed_range")) or 0.0
                for record in reel_records
                if _to_float(record.get("speed_range")) is not None
            ]
        )

        speed_bucket_stats: Dict[str, Dict[str, object]] = defaultdict(
            lambda: {"reels": 0, "total_defects": 0, "total_footage": 0.0, "size_sum": 0.0, "size_count": 0}
        )
        length_bucket_stats: Dict[str, Dict[str, object]] = defaultdict(
            lambda: {"reels": 0, "total_defects": 0, "total_footage": 0.0, "size_sum": 0.0, "size_count": 0}
        )

        for record in reel_records:
            speed_bucket = _bucket_label(record.get("speed_avg"), speed_thresholds, "speed")
            length_bucket = _bucket_label(record.get("length_ft"), length_thresholds, "reel length", digits=0, suffix=" ft")
            record["speed_bucket"] = speed_bucket
            record["length_bucket"] = length_bucket

            speed_bucket_stats[speed_bucket]["reels"] += 1
            speed_bucket_stats[speed_bucket]["total_defects"] += int(record.get("total_defects") or 0)
            speed_bucket_stats[speed_bucket]["total_footage"] += _to_float(record.get("length_ft")) or 0.0
            length_bucket_stats[length_bucket]["reels"] += 1
            length_bucket_stats[length_bucket]["total_defects"] += int(record.get("total_defects") or 0)
            length_bucket_stats[length_bucket]["total_footage"] += _to_float(record.get("length_ft")) or 0.0
            avg_size = _to_float(record.get("avg_defect_size"))
            if avg_size is not None:
                speed_bucket_stats[speed_bucket]["size_sum"] += avg_size
                speed_bucket_stats[speed_bucket]["size_count"] += 1
                length_bucket_stats[length_bucket]["size_sum"] += avg_size
                length_bucket_stats[length_bucket]["size_count"] += 1

        event_counts: Counter = Counter()
        sensitivity_impacts: List[Dict[str, object]] = []
        mask_impacts: List[Dict[str, object]] = []
        mask_segments: List[Dict[str, object]] = []
        reference_events: List[Dict[str, object]] = []
        reference_bucket_stats: Dict[str, Dict[str, object]] = {
            "no_change": {
                "bucket_key": "no_change",
                "bucket_label": "No Reference Change",
                "reels": 0,
                "total_feet": 0.0,
                "total_defects": 0,
                "size_sum": 0.0,
                "size_weight": 0,
                "bst_sum": 0.0,
                "bst_count": 0,
            },
            "single_change": {
                "bucket_key": "single_change",
                "bucket_label": "Single Reference Change",
                "reels": 0,
                "total_feet": 0.0,
                "total_defects": 0,
                "size_sum": 0.0,
                "size_weight": 0,
                "bst_sum": 0.0,
                "bst_count": 0,
            },
            "multiple_changes": {
                "bucket_key": "multiple_changes",
                "bucket_label": "Multiple Reference Changes",
                "reels": 0,
                "total_feet": 0.0,
                "total_defects": 0,
                "size_sum": 0.0,
                "size_weight": 0,
                "bst_sum": 0.0,
                "bst_count": 0,
            },
        }
        reference_change_points: List[Dict[str, object]] = []
        speed_shifts: List[Dict[str, object]] = []
        sensitivity_summary_rows: List[Dict[str, object]] = []
        sensitivity_threshold_stats: Dict[Tuple[str, float], Dict[str, object]] = defaultdict(
            lambda: {
                "reels": 0,
                "total_feet": 0.0,
                "total_defects": 0,
                "bst_sum": 0.0,
                "bst_count": 0,
                "size_sum": 0.0,
                "size_weight": 0,
            }
        )
        reels_with_reference_changes = 0
        reels_with_repeated_reference_updates = 0

        event_priority = {
            "sensitivity_change": 4,
            "mask_change": 3,
            "reference_change": 2,
            "speed_shift": 1,
        }

        for record in reel_records:
            snapshot = record.get("sensitivity_snapshot") or {}
            bst_active_pct = _to_float((record.get("bst_coverage") or {}).get("active_pct"))
            length_ft = _to_float(record.get("length_ft")) or 0.0
            class_counter = record.get("class_counter") or Counter()
            class_avg_size_map = record.get("class_avg_size_map") or {}
            for cls in DRIVER_DEFECT_CLASSES:
                threshold_tuple = snapshot.get(cls)
                threshold_value = _to_float(threshold_tuple[0]) if threshold_tuple else None
                if threshold_value is None:
                    continue
                bucket = sensitivity_threshold_stats[(cls, threshold_value)]
                bucket["reels"] += 1
                bucket["total_feet"] += length_ft
                class_defects = int(class_counter.get(cls, 0) or 0)
                bucket["total_defects"] += class_defects
                if bst_active_pct is not None:
                    bucket["bst_sum"] += bst_active_pct
                    bucket["bst_count"] += 1
                avg_size = _to_float(class_avg_size_map.get(cls))
                if avg_size is not None and class_defects > 0:
                    bucket["size_sum"] += avg_size * class_defects
                    bucket["size_weight"] += class_defects
        for (cls, threshold_value), stats in sensitivity_threshold_stats.items():
            total_feet = _to_float(stats.get("total_feet")) or 0.0
            total_defects_cls = int(stats.get("total_defects") or 0)
            bst_count = int(stats.get("bst_count") or 0)
            avg_bst_active_pct = (
                round(((_to_float(stats.get("bst_sum")) or 0.0) / bst_count), 3)
                if bst_count > 0
                else None
            )
            size_weight = int(stats.get("size_weight") or 0)
            avg_size = (
                round(((_to_float(stats.get("size_sum")) or 0.0) / size_weight), 3)
                if size_weight > 0
                else None
            )
            sensitivity_summary_rows.append(
                {
                    "class_name": cls,
                    "class_label": _driver_class_label(cls),
                    "threshold_value": threshold_value,
                    "reel_count": int(stats.get("reels") or 0),
                    "total_footage": round(total_feet, 2),
                    "avg_bst_active_pct": avg_bst_active_pct,
                    "total_defects": total_defects_cls,
                    "defects_per_1000ft": _rate_per_1000ft(total_defects_cls, total_feet),
                    "adjusted_defects_per_1000ft": _driver_adjusted_rate(
                        total_defects_cls,
                        total_feet,
                        avg_bst_active_pct,
                    ),
                    "avg_defect_size": avg_size,
                }
            )

        for _, records in grouped_records.items():
            ordered_records = sorted(records, key=lambda item: item["time_sort"])
            mask_state_segments: List[Dict[str, object]] = []
            current_mask_segment: Optional[Dict[str, object]] = None
            for record in ordered_records:
                signature = tuple(record.get("mask_effective_signature") or [])
                if current_mask_segment is None or current_mask_segment["signature"] != signature:
                    current_mask_segment = {
                        "signature": signature,
                        "records": [],
                    }
                    mask_state_segments.append(current_mask_segment)
                current_mask_segment["records"].append(record)

            for segment_index, segment in enumerate(mask_state_segments):
                segment_records = segment["records"]
                first_record = segment_records[0]
                last_record = segment_records[-1]
                total_segment_feet = sum(_to_float(row.get("length_ft")) or 0.0 for row in segment_records)
                total_segment_defects = sum(int(row.get("total_defects") or 0) for row in segment_records)
                avg_segment_size = _weighted_average(
                    (
                        row.get("avg_defect_size"),
                        int(row.get("total_defects") or 0),
                    )
                    for row in segment_records
                )
                avg_bst_active = _average((row.get("bst_coverage") or {}).get("active_pct") for row in segment_records)
                avg_bst_inactive = _average((row.get("bst_coverage") or {}).get("inactive_pct") for row in segment_records)
                avg_bst_learn = _average((row.get("bst_coverage") or {}).get("learn_pct") for row in segment_records)
                representative_masks = first_record.get("mask_state_masks") or []
                current_active_masks = _active_mask_details(representative_masks)
                active_mask_count = int(first_record.get("mask_effective_count") or _active_mask_count(representative_masks))
                masks_on = active_mask_count > 0
                previous_segment = mask_state_segments[segment_index - 1] if segment_index > 0 else None
                added_count = 0
                removed_count = 0
                coordinate_change_count = 0
                mask_event_type = "No Mask"
                masks_involved_labels: List[str] = []
                if previous_segment is not None:
                    previous_masks = previous_segment["records"][0].get("mask_state_masks") or []
                    previous_active_masks = _active_mask_details(previous_masks)
                    prev_signature = set(previous_segment["records"][0].get("mask_effective_signature") or [])
                    curr_signature = set(first_record.get("mask_effective_signature") or [])
                    added_count = len(curr_signature - prev_signature)
                    removed_count = len(prev_signature - curr_signature)
                    shared_keys = {(entry[0], entry[1]) for entry in prev_signature} & {
                        (entry[0], entry[1]) for entry in curr_signature
                    }
                    coordinate_change_count = sum(
                        1
                        for key in shared_keys
                        if {
                            entry[2]
                            for entry in prev_signature
                            if (entry[0], entry[1]) == key
                        }
                        != {
                            entry[2]
                            for entry in curr_signature
                            if (entry[0], entry[1]) == key
                        }
                    )
                    if not prev_signature and curr_signature:
                        mask_event_type = "Mask Added"
                        masks_involved_labels = _mask_display_labels(current_active_masks)
                    elif prev_signature and not curr_signature:
                        mask_event_type = "Mask Removed"
                        removed_masks = [
                            mask
                            for mask in previous_active_masks
                            if _mask_detail_signature(mask) in (prev_signature - curr_signature)
                        ]
                        masks_involved_labels = _mask_display_labels(removed_masks or previous_active_masks)
                    elif prev_signature != curr_signature:
                        mask_event_type = "Mask Updated"
                        changed_signatures = (curr_signature - prev_signature) | (prev_signature - curr_signature)
                        changed_masks = [
                            mask
                            for mask in current_active_masks
                            if _mask_detail_signature(mask) in changed_signatures
                        ]
                        if not changed_masks and coordinate_change_count > 0:
                            changed_keys = {
                                key
                                for key in shared_keys
                                if {
                                    entry[2]
                                    for entry in prev_signature
                                    if (entry[0], entry[1]) == key
                                }
                                != {
                                    entry[2]
                                    for entry in curr_signature
                                    if (entry[0], entry[1]) == key
                                }
                            }
                            changed_masks = [
                                mask
                                for mask in current_active_masks
                                if (_mask_detail_signature(mask)[0], _mask_detail_signature(mask)[1]) in changed_keys
                            ]
                        masks_involved_labels = _mask_display_labels(changed_masks or current_active_masks)
                elif current_active_masks:
                    mask_event_type = "Mask Added"
                    masks_involved_labels = _mask_display_labels(current_active_masks)
                else:
                    masks_involved_labels = ["none"]
                if not masks_involved_labels:
                    masks_involved_labels = _mask_display_labels(current_active_masks) or ["none"]
                previous_segment_defects_per_1000ft = None
                previous_segment_avg_size = None
                if previous_segment is not None:
                    prev_records = previous_segment["records"]
                    prev_feet = sum(_to_float(row.get("length_ft")) or 0.0 for row in prev_records)
                    prev_defects = sum(int(row.get("total_defects") or 0) for row in prev_records)
                    previous_segment_defects_per_1000ft = _rate_per_1000ft(prev_defects, prev_feet)
                    previous_segment_avg_size = _weighted_average(
                        (
                            row.get("avg_defect_size"),
                            int(row.get("total_defects") or 0),
                        )
                        for row in prev_records
                    )
                segment_counter: Counter = Counter()
                for row in segment_records:
                    segment_counter.update(row.get("class_counter") or Counter())
                top_type_name, _ = segment_counter.most_common(1)[0] if segment_counter else (None, 0)
                mask_segments.append(
                    {
                        "segment_id": f"{first_record.get('job') or 'job'}-{first_record.get('order') or 'order'}-{segment_index + 1}",
                        "job": first_record.get("job"),
                        "order": first_record.get("order"),
                        "reel_start": first_record.get("reel_code"),
                        "reel_end": last_record.get("reel_code"),
                        "time_start": first_record.get("time"),
                        "time_end": last_record.get("time"),
                        "reel_count": len(segment_records),
                        "total_feet": round(total_segment_feet, 2),
                        "mask_event_type": mask_event_type,
                        "mask_state": "ON" if masks_on else "OFF",
                        "mask_state_summary": _mask_state_label(active_mask_count),
                        "masks_involved": masks_involved_labels,
                        "active_mask_count": active_mask_count,
                        "coordinates_changed_vs_prior": coordinate_change_count > 0,
                        "masks_added_vs_prior": added_count,
                        "masks_removed_vs_prior": removed_count,
                        "bst_active_pct": avg_bst_active,
                        "bst_inactive_pct": avg_bst_inactive,
                        "bst_learn_pct": avg_bst_learn,
                        "bst_validity": _mask_segment_validity_label(avg_bst_active),
                        "total_defects": total_segment_defects,
                        "defects_per_1000ft": _rate_per_1000ft(total_segment_defects, total_segment_feet),
                        "avg_defect_size": avg_segment_size,
                        "top_defect_type": _driver_class_label(top_type_name) if top_type_name else None,
                        "previous_defects_per_1000ft": previous_segment_defects_per_1000ft,
                        "delta_defects_per_1000ft": _safe_delta(
                            _rate_per_1000ft(total_segment_defects, total_segment_feet),
                            previous_segment_defects_per_1000ft,
                        ),
                        "previous_avg_defect_size": previous_segment_avg_size,
                        "delta_avg_defect_size": _safe_delta(avg_segment_size, previous_segment_avg_size),
                    }
                )

            previous_record: Optional[Dict[str, object]] = None
            for index, record in enumerate(ordered_records):
                matched_driver_events: List[Dict[str, object]] = []
                reference_changed = int(record.get("reference_count") or 0) > 1
                bst_coverage = record.get("bst_coverage") or {}
                bst_status = bst_coverage.get("status")
                prior_records = ordered_records[:index]

                reference_count = int(record.get("reference_count") or 0)
                if reference_count >= 3:
                    bucket_key = "multiple_changes"
                elif reference_count == 2:
                    bucket_key = "single_change"
                else:
                    bucket_key = "no_change"
                bucket_entry = reference_bucket_stats[bucket_key]
                bucket_entry["reels"] += 1
                bucket_entry["total_feet"] += _to_float(record.get("length_ft")) or 0.0
                bucket_entry["total_defects"] += int(record.get("total_defects") or 0)
                avg_size = _to_float(record.get("avg_defect_size"))
                total_defects_for_size = int(record.get("total_defects") or 0)
                if avg_size is not None and total_defects_for_size > 0:
                    bucket_entry["size_sum"] += avg_size * total_defects_for_size
                    bucket_entry["size_weight"] += total_defects_for_size
                bst_active_pct = _to_float(bst_coverage.get("active_pct"))
                if bst_active_pct is not None:
                    bucket_entry["bst_sum"] += bst_active_pct
                    bucket_entry["bst_count"] += 1

                if reference_changed:
                    reels_with_reference_changes += 1
                    if record["reference_repeated_updates"]:
                        reels_with_repeated_reference_updates += 1
                    reference_change_points.append(
                        {
                            "time": record.get("time"),
                            "time_sort": record.get("time_sort"),
                            "reel_code": record.get("reel_code"),
                            "job": record.get("job"),
                            "order": record.get("order"),
                        }
                    )
                    event = {
                        "type": "reference_change",
                        "label": DRIVER_EVENT_LABELS["reference_change"],
                        "summary": (
                            f"{int(record['reference_repeated_updates'] or 0)} reference change"
                            f"{'s' if int(record['reference_repeated_updates'] or 0) != 1 else ''}"
                            if record["reference_repeated_updates"]
                            else "reference updated within reel"
                        ),
                        "detail": {
                            "reel_id": record.get("reel_id"),
                            "reel_code": record.get("reel_code"),
                            "job": record.get("job"),
                            "order": record.get("order"),
                            "time": record.get("time"),
                            "reference_count": int(record.get("reference_count") or 0),
                            "repeated_updates": int(record.get("reference_repeated_updates") or 0),
                            "reference_images": record.get("reference_images") or [],
                        },
                    }
                    record["events"].append(event)
                    record["instability_score"] += 1 + int(record["reference_repeated_updates"] or 0)
                    event_counts["reference_change"] += 1
                    if previous_record is not None:
                        matched_driver_events.append(event)

                if bst_status in {"off", "partial"}:
                    event = {
                        "type": "bst_coverage",
                        "label": DRIVER_EVENT_LABELS["bst_coverage"],
                        "summary": (
                            "BST Off"
                            if bst_status == "off"
                            else f"Partial BST coverage ({bst_coverage.get('active_pct', 0)}% active)"
                        ),
                        "detail": {
                            "reel_id": record.get("reel_id"),
                            "reel_code": record.get("reel_code"),
                            "job": record.get("job"),
                            "order": record.get("order"),
                            "time": record.get("time"),
                            "active_pct": bst_coverage.get("active_pct"),
                            "inactive_pct": bst_coverage.get("inactive_pct"),
                            "learn_pct": bst_coverage.get("learn_pct"),
                            "unknown_pct": bst_coverage.get("unknown_pct"),
                            "status": bst_status,
                            "interpretation": (
                                "BST was off"
                                if bst_status == "off"
                                else "BST was partially active"
                            ),
                        },
                    }
                    record["events"].append(event)
                    event_counts["bst_coverage"] += 1

                if previous_record is None:
                    previous_record = record
                    continue

                sensitivity_changes = _sensitivity_change_detail(
                    previous_record.get("sensitivity_snapshot") or {},
                    record.get("sensitivity_snapshot") or {},
                )
                if sensitivity_changes:
                    event = {
                        "type": "sensitivity_change",
                        "label": DRIVER_EVENT_LABELS["sensitivity_change"],
                        "summary": f"{len(sensitivity_changes)} class changes",
                        "detail": {
                            "reel_id": record.get("reel_id"),
                            "reel_code": record.get("reel_code"),
                            "job": record.get("job"),
                            "order": record.get("order"),
                            "time": record.get("time"),
                            "changes": sensitivity_changes,
                        },
                    }
                    record["events"].append(event)
                    record["instability_score"] += len(sensitivity_changes)
                    event_counts["sensitivity_change"] += 1
                    matched_driver_events.append(event)
                    sensitivity_impacts.append(
                        _driver_impact_row(
                            record,
                            previous_record,
                            extra={"changed_classes": sensitivity_changes},
                        )
                    )

                previous_mask_signature = set(previous_record.get("mask_effective_signature") or [])
                current_mask_signature = set(record.get("mask_effective_signature") or [])
                if current_mask_signature != previous_mask_signature:
                    prev_set = previous_mask_signature
                    curr_set = current_mask_signature
                    record["has_mask_change"] = True
                    shared_keys = {
                        (entry[0], entry[1]) for entry in prev_set
                    } & {
                        (entry[0], entry[1]) for entry in curr_set
                    }
                    coordinate_change_count = sum(
                        1
                        for key in shared_keys
                        if {
                            entry[2] for entry in prev_set if (entry[0], entry[1]) == key
                        }
                        != {
                            entry[2] for entry in curr_set if (entry[0], entry[1]) == key
                        }
                    )
                    if not prev_set and curr_set:
                        mask_summary = "Mask Added"
                    elif prev_set and not curr_set:
                        mask_summary = "Mask Removed"
                    else:
                        mask_summary = "Mask Updated"
                    event = {
                        "type": "mask_change",
                        "label": DRIVER_EVENT_LABELS["mask_change"],
                        "summary": mask_summary,
                        "detail": {
                            "reel_id": record.get("reel_id"),
                            "reel_code": record.get("reel_code"),
                            "job": record.get("job"),
                            "order": record.get("order"),
                            "time": record.get("time"),
                            "format_length": record.get("format_length"),
                            "format_width": record.get("format_width"),
                            "latest_reference_image": record.get("latest_reference_image"),
                            "reference_images": record.get("reference_images") or [],
                            "before_mask_count": len(prev_set),
                            "after_mask_count": len(curr_set),
                            "coordinate_change_count": coordinate_change_count,
                            "before_masks": _active_mask_details(previous_record.get("mask_state_masks") or []),
                            "after_masks": _active_mask_details(record.get("mask_state_masks") or []),
                        },
                    }
                    record["events"].append(event)
                    record["instability_score"] += 1 + coordinate_change_count
                    event_counts["mask_change"] += 1
                    matched_driver_events.append(event)
                    mask_impacts.append(
                        _driver_impact_row(
                            record,
                            previous_record,
                            extra={
                                "added_mask_count": len(curr_set - prev_set),
                                "removed_mask_count": len(prev_set - curr_set),
                                "coordinate_change_count": coordinate_change_count,
                            },
                        )
                    )

                prev_speed = _to_float(previous_record.get("speed_avg"))
                curr_speed = _to_float(record.get("speed_avg"))
                speed_relative = _relative_change(curr_speed, prev_speed)
                speed_bucket_changed = record.get("speed_bucket") != previous_record.get("speed_bucket")
                if (
                    prev_speed is not None
                    and curr_speed is not None
                    and abs(curr_speed - prev_speed) >= SPEED_SHIFT_MIN_DELTA
                    and (
                        speed_bucket_changed
                        or (speed_relative is not None and abs(speed_relative) >= 0.15)
                        or abs(curr_speed - prev_speed) >= SPEED_SHIFT_MIN_DELTA
                    )
                ):
                    event = {
                        "type": "speed_shift",
                        "label": DRIVER_EVENT_LABELS["speed_shift"],
                        "summary": f"{round(prev_speed, 1)} -> {round(curr_speed, 1)}",
                        "detail": {
                            "reel_id": record.get("reel_id"),
                            "reel_code": record.get("reel_code"),
                            "previous_reel_id": previous_record.get("reel_id"),
                            "previous_reel_code": previous_record.get("reel_code"),
                            "job": record.get("job"),
                            "order": record.get("order"),
                            "time": record.get("time"),
                            "previous_speed_avg": prev_speed,
                            "current_speed_avg": curr_speed,
                            "delta_speed": _safe_delta(curr_speed, prev_speed),
                            "previous_speed_bucket": previous_record.get("speed_bucket"),
                            "current_speed_bucket": record.get("speed_bucket"),
                            "reason": (
                                "Speed bucket changed"
                                if speed_bucket_changed
                                else "Material average speed change exceeded threshold"
                            ),
                            "previous_speed_trend": previous_record.get("speed_points") or [],
                            "current_speed_trend": record.get("speed_points") or [],
                        },
                    }
                    record["events"].append(event)
                    record["instability_score"] += 1
                    event_counts["speed_shift"] += 1
                    matched_driver_events.append(event)
                    speed_shifts.append(
                        _driver_impact_row(
                            record,
                            previous_record,
                            extra={
                                "before_speed_avg": prev_speed,
                                "after_speed_avg": curr_speed,
                                "before_speed_bucket": previous_record.get("speed_bucket"),
                                "after_speed_bucket": record.get("speed_bucket"),
                            },
                        )
                    )

                previous_rate = previous_record.get("defects_per_1000ft") if previous_record else None
                rolling_window = prior_records[-3:]
                rolling_rate = _average(
                    prior_record.get("defects_per_1000ft") for prior_record in rolling_window
                )
                rolling_count = len(rolling_window)
                if rolling_count >= 2:
                    baseline_rate = rolling_rate
                    baseline_source = f"rolling_avg_{rolling_count}"
                else:
                    baseline_rate = previous_rate
                    baseline_source = "previous_reel"
                rate_change = _material_rate_change(
                    baseline_rate,
                    record.get("defects_per_1000ft"),
                )
                if rate_change and rate_change["direction"] == "up":
                    type_breakdown = []
                    for cls in DRIVER_DEFECT_CLASSES:
                        current_count = int((record.get("class_counter") or Counter()).get(cls, 0) or 0)
                        current_rate = _rate_per_1000ft(current_count, record.get("length_ft"))
                        previous_count = (
                            int((previous_record.get("class_counter") or Counter()).get(cls, 0) or 0)
                            if previous_record
                            else 0
                        )
                        previous_rate_type = (
                            _rate_per_1000ft(previous_count, previous_record.get("length_ft"))
                            if previous_record
                            else None
                        )
                        baseline_type_rate = (
                            _average(
                                _rate_per_1000ft(
                                    int((prior_record.get("class_counter") or Counter()).get(cls, 0) or 0),
                                    prior_record.get("length_ft"),
                                )
                                for prior_record in rolling_window
                            )
                            if rolling_count >= 2
                            else previous_rate_type
                        )
                        baseline_type_count = (
                            _average(
                                int((prior_record.get("class_counter") or Counter()).get(cls, 0) or 0)
                                for prior_record in rolling_window
                            )
                            if rolling_count >= 2
                            else previous_count
                        )
                        if current_count <= 0 and not baseline_type_rate and not baseline_type_count:
                            continue
                        type_breakdown.append(
                            {
                                "name": cls,
                                "label": _driver_class_label(cls),
                                "current_count": current_count,
                                "current_rate_per_1000ft": current_rate,
                                "baseline_count": baseline_type_count,
                                "baseline_rate_per_1000ft": baseline_type_rate,
                                "delta_rate_per_1000ft": _safe_delta(current_rate, baseline_type_rate),
                                "previous_rate_per_1000ft": previous_rate_type,
                                "baseline_source": baseline_source,
                                "avg_defect_size": _to_float((record.get("class_avg_size_map") or {}).get(cls)),
                            }
                        )
                    spike_event = {
                        "type": "defect_spike",
                        "label": DRIVER_EVENT_LABELS["defect_spike"],
                        "summary": (
                            f"{round(baseline_rate or 0.0, 2)}"
                            f" -> {round(record.get('defects_per_1000ft') or 0.0, 2)} /1k ft"
                        ),
                        "detail": {
                            "reel_id": record.get("reel_id"),
                            "reel_code": record.get("reel_code"),
                            "previous_reel_id": previous_record.get("reel_id") if previous_record else None,
                            "previous_reel_code": previous_record.get("reel_code") if previous_record else None,
                            "job": record.get("job"),
                            "order": record.get("order"),
                            "time": record.get("time"),
                            "current_rate_per_1000ft": record.get("defects_per_1000ft"),
                            "current_defect_count": record.get("total_defects"),
                            "current_avg_defect_size": record.get("avg_defect_size"),
                            "current_length_ft": record.get("length_ft"),
                            "current_bst_active_pct": ((record.get("bst_coverage") or {}).get("active_pct")),
                            "previous_reel_rate_per_1000ft": previous_rate,
                            "previous_reel_count": previous_record.get("total_defects") if previous_record else None,
                            "previous_reel_avg_defect_size": previous_record.get("avg_defect_size") if previous_record else None,
                            "previous_length_ft": previous_record.get("length_ft") if previous_record else None,
                            "previous_bst_active_pct": ((previous_record.get("bst_coverage") or {}).get("active_pct")) if previous_record else None,
                            "rolling_rate_per_1000ft": rolling_rate,
                            "rolling_reel_count": rolling_count,
                            "baseline_rate_per_1000ft": baseline_rate,
                            "baseline_source": baseline_source,
                            "triggered_by": baseline_source,
                            "type_breakdown": type_breakdown,
                        },
                    }
                    record["events"].append(spike_event)
                    event_counts["defect_spike"] += 1

                previous_record = record

        timeline = []
        for record in sorted(reel_records, key=lambda item: item["time_sort"], reverse=True):
            record["type_breakdown"] = [
                {
                    "name": cls,
                    "label": _driver_class_label(cls),
                    "count": int((record.get("class_counter") or Counter()).get(cls, 0) or 0),
                    "avg_size": _to_float((record.get("class_avg_size_map") or {}).get(cls)),
                    "avg_size_basis": (record.get("class_avg_size_basis_map") or {}).get(cls),
                }
                for cls in DRIVER_DEFECT_CLASSES
                if int((record.get("class_counter") or Counter()).get(cls, 0) or 0) > 0
            ]
            timeline.append(
                {
                    "reel_id": record["reel_id"],
                    "reel_code": record["reel_code"],
                    "job": record["job"],
                    "order": record["order"],
                    "time": record["time"],
                    "length_ft": record["length_ft"],
                    "total_defects": record["total_defects"],
                    "defects_per_1000ft": record["defects_per_1000ft"],
                    "avg_defect_size": record["avg_defect_size"],
                    "avg_defect_size_basis": record.get("avg_defect_size_basis"),
                    "type_breakdown": record["type_breakdown"],
                    "top_defect_type": record["top_defect_type"],
                    "speed_avg": record["speed_avg"],
                    "bst_active_pct": _to_float((record.get("bst_coverage") or {}).get("active_pct")),
                    "speed_bucket": record["speed_bucket"],
                    "length_bucket": record["length_bucket"],
                    "events": record["events"],
                    "instability_score": int(record["instability_score"] or 0),
                }
            )

        def _bucket_payload(bucket_map: Dict[str, Dict[str, object]]) -> List[Dict[str, object]]:
            rows: List[Dict[str, object]] = []
            for bucket, stats in bucket_map.items():
                total_bucket_footage = _to_float(stats.get("total_footage")) or 0.0
                total_bucket_defects = int(stats.get("total_defects") or 0)
                size_count = int(stats.get("size_count") or 0)
                size_sum = _to_float(stats.get("size_sum")) or 0.0
                rows.append(
                    {
                        "bucket": bucket,
                        "reels": int(stats.get("reels") or 0),
                        "total_footage": round(total_bucket_footage, 2),
                        "defects_per_1000ft": _rate_per_1000ft(total_bucket_defects, total_bucket_footage),
                        "avg_defect_size": round(size_sum / size_count, 3) if size_count else None,
                    }
                )
            return sorted(rows, key=lambda item: item["bucket"])

        top_type_name, top_type_count = overall_class_counter.most_common(1)[0] if overall_class_counter else (None, 0)
        overall_avg_basis = "severity_value"
        if severity_basis_count == 0 and fallback_basis_count > 0:
            overall_avg_basis = "magnitude_value_fallback"
        elif severity_basis_count > 0 and fallback_basis_count > 0:
            overall_avg_basis = "severity_value_with_fallback"
        baseline_reference_rate = None
        if (_to_float(reference_bucket_stats["no_change"].get("total_feet")) or 0.0) > 0:
            baseline_reference_rate = _rate_per_1000ft(
                int(reference_bucket_stats["no_change"].get("total_defects") or 0),
                reference_bucket_stats["no_change"].get("total_feet"),
            )
        speed_records = [record for record in reel_records if _to_float(record.get("speed_avg")) is not None]
        speed_definition = _driver_speed_range_definition(
            [_to_float(record.get("speed_avg")) or 0.0 for record in speed_records]
        )
        speed_bucket_overview: List[Dict[str, object]] = []
        speed_stability_rows: List[Dict[str, object]] = []
        speed_time_of_day_rows: List[Dict[str, object]] = []
        speed_best_range = None
        if speed_definition:
            speed_bucket_stats_overview: List[Dict[str, object]] = [
                {
                    "bucket_key": f"speed_{idx + 1}",
                    "bucket_label": _driver_speed_bucket_label(idx, speed_definition),
                    "reels": 0,
                    "total_feet": 0.0,
                    "total_defects": 0,
                    "speed_sum": 0.0,
                    "speed_count": 0,
                    "bst_sum": 0.0,
                    "bst_count": 0,
                    "size_sum": 0.0,
                    "size_weight": 0,
                }
                for idx in range(5)
            ]
            stability_thresholds = _bucket_thresholds(
                [_to_float(record.get("speed_range")) or 0.0 for record in speed_records if _to_float(record.get("speed_range")) is not None]
            )
            speed_stability_stats: Dict[str, Dict[str, object]] = {
                "stable": {"bucket_label": "Stable Speed", "reels": 0, "total_feet": 0.0, "total_defects": 0, "bst_sum": 0.0, "bst_count": 0, "size_sum": 0.0, "size_weight": 0, "metric_sum": 0.0, "metric_count": 0},
                "moderate": {"bucket_label": "Moderate Variation", "reels": 0, "total_feet": 0.0, "total_defects": 0, "bst_sum": 0.0, "bst_count": 0, "size_sum": 0.0, "size_weight": 0, "metric_sum": 0.0, "metric_count": 0},
                "high": {"bucket_label": "High Variation", "reels": 0, "total_feet": 0.0, "total_defects": 0, "bst_sum": 0.0, "bst_count": 0, "size_sum": 0.0, "size_weight": 0, "metric_sum": 0.0, "metric_count": 0},
            }
            speed_time_of_day_stats: List[Dict[str, object]] = [
                {"bucket_label": "12:00 AM - 6:00 AM", "reels": 0, "speed_sum": 0.0, "speed_count": 0, "speed_min": None, "speed_max": None, "total_feet": 0.0, "total_defects": 0, "bst_sum": 0.0, "bst_count": 0},
                {"bucket_label": "6:00 AM - 12:00 PM", "reels": 0, "speed_sum": 0.0, "speed_count": 0, "speed_min": None, "speed_max": None, "total_feet": 0.0, "total_defects": 0, "bst_sum": 0.0, "bst_count": 0},
                {"bucket_label": "12:00 PM - 6:00 PM", "reels": 0, "speed_sum": 0.0, "speed_count": 0, "speed_min": None, "speed_max": None, "total_feet": 0.0, "total_defects": 0, "bst_sum": 0.0, "bst_count": 0},
                {"bucket_label": "6:00 PM - 12:00 AM", "reels": 0, "speed_sum": 0.0, "speed_count": 0, "speed_min": None, "speed_max": None, "total_feet": 0.0, "total_defects": 0, "bst_sum": 0.0, "bst_count": 0},
            ]
            for record in speed_records:
                speed_avg = _to_float(record.get("speed_avg"))
                if speed_avg is None:
                    continue
                bucket_index = _driver_speed_bucket_index(speed_avg, speed_definition)
                if bucket_index is not None:
                    bucket = speed_bucket_stats_overview[bucket_index]
                    bucket["reels"] += 1
                    bucket["total_feet"] += _to_float(record.get("length_ft")) or 0.0
                    bucket["total_defects"] += int(record.get("total_defects") or 0)
                    bucket["speed_sum"] += speed_avg
                    bucket["speed_count"] += 1
                    avg_size = _to_float(record.get("avg_defect_size"))
                    total_defects_for_size = int(record.get("total_defects") or 0)
                    if avg_size is not None and total_defects_for_size > 0:
                        bucket["size_sum"] += avg_size * total_defects_for_size
                        bucket["size_weight"] += total_defects_for_size
                    bst_active_pct = _to_float((record.get("bst_coverage") or {}).get("active_pct"))
                    if bst_active_pct is not None:
                        bucket["bst_sum"] += bst_active_pct
                        bucket["bst_count"] += 1
                speed_variation = _to_float(record.get("speed_range"))
                if speed_variation is not None:
                    low_cut, high_cut = stability_thresholds
                    if low_cut is None or high_cut is None or speed_variation <= low_cut:
                        stability_bucket = speed_stability_stats["stable"]
                    elif speed_variation <= high_cut:
                        stability_bucket = speed_stability_stats["moderate"]
                    else:
                        stability_bucket = speed_stability_stats["high"]
                    stability_bucket["reels"] += 1
                    stability_bucket["total_feet"] += _to_float(record.get("length_ft")) or 0.0
                    stability_bucket["total_defects"] += int(record.get("total_defects") or 0)
                    stability_bucket["metric_sum"] += speed_variation
                    stability_bucket["metric_count"] += 1
                    avg_size = _to_float(record.get("avg_defect_size"))
                    total_defects_for_size = int(record.get("total_defects") or 0)
                    if avg_size is not None and total_defects_for_size > 0:
                        stability_bucket["size_sum"] += avg_size * total_defects_for_size
                        stability_bucket["size_weight"] += total_defects_for_size
                    bst_active_pct = _to_float((record.get("bst_coverage") or {}).get("active_pct"))
                    if bst_active_pct is not None:
                        stability_bucket["bst_sum"] += bst_active_pct
                        stability_bucket["bst_count"] += 1
                ts = record.get("time_sort")
                if ts is not None:
                    hour = ts.hour
                    if hour < 6:
                        time_bucket = speed_time_of_day_stats[0]
                    elif hour < 12:
                        time_bucket = speed_time_of_day_stats[1]
                    elif hour < 18:
                        time_bucket = speed_time_of_day_stats[2]
                    else:
                        time_bucket = speed_time_of_day_stats[3]
                    time_bucket["reels"] += 1
                    time_bucket["speed_sum"] += speed_avg
                    time_bucket["speed_count"] += 1
                    time_bucket["speed_min"] = speed_avg if time_bucket["speed_min"] is None else min(time_bucket["speed_min"], speed_avg)
                    time_bucket["speed_max"] = speed_avg if time_bucket["speed_max"] is None else max(time_bucket["speed_max"], speed_avg)
                    time_bucket["total_feet"] += _to_float(record.get("length_ft")) or 0.0
                    time_bucket["total_defects"] += int(record.get("total_defects") or 0)
                    bst_active_pct = _to_float((record.get("bst_coverage") or {}).get("active_pct"))
                    if bst_active_pct is not None:
                        time_bucket["bst_sum"] += bst_active_pct
                        time_bucket["bst_count"] += 1
            for bucket in speed_bucket_stats_overview:
                total_feet = _to_float(bucket.get("total_feet")) or 0.0
                total_defects = int(bucket.get("total_defects") or 0)
                avg_bst_active_pct = (
                    round(((_to_float(bucket.get("bst_sum")) or 0.0) / int(bucket.get("bst_count") or 0)), 3)
                    if int(bucket.get("bst_count") or 0) > 0
                    else None
                )
                avg_speed = (
                    round(((_to_float(bucket.get("speed_sum")) or 0.0) / int(bucket.get("speed_count") or 0)), 3)
                    if int(bucket.get("speed_count") or 0) > 0
                    else None
                )
                size_weight = int(bucket.get("size_weight") or 0)
                avg_size = (
                    round(((_to_float(bucket.get("size_sum")) or 0.0) / size_weight), 3)
                    if size_weight > 0
                    else None
                )
                row = {
                    "bucket_label": bucket.get("bucket_label"),
                    "reels": int(bucket.get("reels") or 0),
                    "total_defects": total_defects,
                    "total_feet": round(total_feet, 2),
                    "avg_speed": avg_speed,
                    "avg_bst_active_pct": avg_bst_active_pct,
                    "defects_per_1000ft": _rate_per_1000ft(total_defects, total_feet),
                    "adjusted_defects_per_1000ft": _driver_adjusted_rate(total_defects, total_feet, avg_bst_active_pct),
                    "avg_defect_size": avg_size,
                }
                speed_bucket_overview.append(row)
            eligible_best_rows = [
                row for row in speed_bucket_overview
                if int(row.get("reels") or 0) >= 2
                and (_to_float(row.get("total_feet")) or 0.0) >= 1000.0
                and _to_float(row.get("adjusted_defects_per_1000ft")) is not None
            ]
            if not eligible_best_rows:
                eligible_best_rows = [
                    row for row in speed_bucket_overview if _to_float(row.get("adjusted_defects_per_1000ft")) is not None
                ]
            if eligible_best_rows:
                speed_best_range = min(
                    eligible_best_rows,
                    key=lambda item: _to_float(item.get("adjusted_defects_per_1000ft")) or float("inf"),
                )
            for key in ("stable", "moderate", "high"):
                bucket = speed_stability_stats[key]
                total_feet = _to_float(bucket.get("total_feet")) or 0.0
                total_defects = int(bucket.get("total_defects") or 0)
                avg_bst_active_pct = (
                    round(((_to_float(bucket.get("bst_sum")) or 0.0) / int(bucket.get("bst_count") or 0)), 3)
                    if int(bucket.get("bst_count") or 0) > 0
                    else None
                )
                size_weight = int(bucket.get("size_weight") or 0)
                avg_size = (
                    round(((_to_float(bucket.get("size_sum")) or 0.0) / size_weight), 3)
                    if size_weight > 0
                    else None
                )
                avg_metric = (
                    round(((_to_float(bucket.get("metric_sum")) or 0.0) / int(bucket.get("metric_count") or 0)), 3)
                    if int(bucket.get("metric_count") or 0) > 0
                    else None
                )
                speed_stability_rows.append(
                    {
                        "bucket_label": bucket.get("bucket_label"),
                        "reels": int(bucket.get("reels") or 0),
                        "total_feet": round(total_feet, 2),
                        "total_defects": total_defects,
                        "avg_bst_active_pct": avg_bst_active_pct,
                        "defects_per_1000ft": _rate_per_1000ft(total_defects, total_feet),
                        "adjusted_defects_per_1000ft": _driver_adjusted_rate(total_defects, total_feet, avg_bst_active_pct),
                        "avg_defect_size": avg_size,
                        "avg_speed_variation": avg_metric,
                    }
                )
            for bucket in speed_time_of_day_stats:
                total_feet = _to_float(bucket.get("total_feet")) or 0.0
                total_defects = int(bucket.get("total_defects") or 0)
                avg_bst_active_pct = (
                    round(((_to_float(bucket.get("bst_sum")) or 0.0) / int(bucket.get("bst_count") or 0)), 3)
                    if int(bucket.get("bst_count") or 0) > 0
                    else None
                )
                avg_speed = (
                    round(((_to_float(bucket.get("speed_sum")) or 0.0) / int(bucket.get("speed_count") or 0)), 3)
                    if int(bucket.get("speed_count") or 0) > 0
                    else None
                )
                speed_time_of_day_rows.append(
                    {
                        "bucket_label": bucket.get("bucket_label"),
                        "reels": int(bucket.get("reels") or 0),
                        "avg_speed": avg_speed,
                        "min_speed": _to_float(bucket.get("speed_min")),
                        "max_speed": _to_float(bucket.get("speed_max")),
                        "total_feet": round(total_feet, 2),
                        "total_defects": total_defects,
                        "defects_per_1000ft": _rate_per_1000ft(total_defects, total_feet),
                        "adjusted_defects_per_1000ft": _driver_adjusted_rate(total_defects, total_feet, avg_bst_active_pct),
                        "avg_bst_active_pct": avg_bst_active_pct,
                    }
                )
        length_bucket_stats_fixed: Dict[str, Dict[str, object]] = {
            "< 5,000 ft": {"bucket_label": "< 5,000 ft", "reels": 0, "total_feet": 0.0, "total_defects": 0, "bst_sum": 0.0, "bst_count": 0, "size_sum": 0.0, "size_weight": 0},
            "5,000 - 8,000 ft": {"bucket_label": "5,000 - 8,000 ft", "reels": 0, "total_feet": 0.0, "total_defects": 0, "bst_sum": 0.0, "bst_count": 0, "size_sum": 0.0, "size_weight": 0},
            "8,000 - 11,000 ft": {"bucket_label": "8,000 - 11,000 ft", "reels": 0, "total_feet": 0.0, "total_defects": 0, "bst_sum": 0.0, "bst_count": 0, "size_sum": 0.0, "size_weight": 0},
            "11,000 - 14,000 ft": {"bucket_label": "11,000 - 14,000 ft", "reels": 0, "total_feet": 0.0, "total_defects": 0, "bst_sum": 0.0, "bst_count": 0, "size_sum": 0.0, "size_weight": 0},
            "> 14,000 ft": {"bucket_label": "> 14,000 ft", "reels": 0, "total_feet": 0.0, "total_defects": 0, "bst_sum": 0.0, "bst_count": 0, "size_sum": 0.0, "size_weight": 0},
        }
        length_time_of_day_stats: List[Dict[str, object]] = [
            {"bucket_label": "12:00 AM - 6:00 AM", "reels": 0, "length_sum": 0.0, "length_count": 0, "length_min": None, "length_max": None, "total_feet": 0.0, "total_defects": 0, "bst_sum": 0.0, "bst_count": 0},
            {"bucket_label": "6:00 AM - 12:00 PM", "reels": 0, "length_sum": 0.0, "length_count": 0, "length_min": None, "length_max": None, "total_feet": 0.0, "total_defects": 0, "bst_sum": 0.0, "bst_count": 0},
            {"bucket_label": "12:00 PM - 6:00 PM", "reels": 0, "length_sum": 0.0, "length_count": 0, "length_min": None, "length_max": None, "total_feet": 0.0, "total_defects": 0, "bst_sum": 0.0, "bst_count": 0},
            {"bucket_label": "6:00 PM - 12:00 AM", "reels": 0, "length_sum": 0.0, "length_count": 0, "length_min": None, "length_max": None, "total_feet": 0.0, "total_defects": 0, "bst_sum": 0.0, "bst_count": 0},
        ]
        for record in reel_records:
            length_ft = _to_float(record.get("length_ft")) or 0.0
            length_bucket = length_bucket_stats_fixed[_driver_length_bucket_label(length_ft)]
            length_bucket["reels"] += 1
            length_bucket["total_feet"] += length_ft
            length_bucket["total_defects"] += int(record.get("total_defects") or 0)
            avg_size = _to_float(record.get("avg_defect_size"))
            total_defects_for_size = int(record.get("total_defects") or 0)
            if avg_size is not None and total_defects_for_size > 0:
                length_bucket["size_sum"] += avg_size * total_defects_for_size
                length_bucket["size_weight"] += total_defects_for_size
            bst_active_pct = _to_float((record.get("bst_coverage") or {}).get("active_pct"))
            if bst_active_pct is not None:
                length_bucket["bst_sum"] += bst_active_pct
                length_bucket["bst_count"] += 1
            ts = record.get("time_sort")
            if ts is not None:
                hour = ts.hour
                if hour < 6:
                    time_bucket = length_time_of_day_stats[0]
                elif hour < 12:
                    time_bucket = length_time_of_day_stats[1]
                elif hour < 18:
                    time_bucket = length_time_of_day_stats[2]
                else:
                    time_bucket = length_time_of_day_stats[3]
                time_bucket["reels"] += 1
                time_bucket["length_sum"] += length_ft
                time_bucket["length_count"] += 1
                time_bucket["length_min"] = length_ft if time_bucket["length_min"] is None else min(time_bucket["length_min"], length_ft)
                time_bucket["length_max"] = length_ft if time_bucket["length_max"] is None else max(time_bucket["length_max"], length_ft)
                time_bucket["total_feet"] += length_ft
                time_bucket["total_defects"] += int(record.get("total_defects") or 0)
                if bst_active_pct is not None:
                    time_bucket["bst_sum"] += bst_active_pct
                    time_bucket["bst_count"] += 1
        length_bucket_rows: List[Dict[str, object]] = []
        for bucket_key in ("< 5,000 ft", "5,000 - 8,000 ft", "8,000 - 11,000 ft", "11,000 - 14,000 ft", "> 14,000 ft"):
            bucket = length_bucket_stats_fixed[bucket_key]
            total_feet = _to_float(bucket.get("total_feet")) or 0.0
            total_defects = int(bucket.get("total_defects") or 0)
            avg_bst_active_pct = (
                round(((_to_float(bucket.get("bst_sum")) or 0.0) / int(bucket.get("bst_count") or 0)), 3)
                if int(bucket.get("bst_count") or 0) > 0
                else None
            )
            size_weight = int(bucket.get("size_weight") or 0)
            avg_size = (
                round(((_to_float(bucket.get("size_sum")) or 0.0) / size_weight), 3)
                if size_weight > 0
                else None
            )
            length_bucket_rows.append(
                {
                    "bucket_label": bucket.get("bucket_label"),
                    "reels": int(bucket.get("reels") or 0),
                    "total_feet": round(total_feet, 2),
                    "total_defects": total_defects,
                    "avg_bst_active_pct": avg_bst_active_pct,
                    "defects_per_1000ft": _rate_per_1000ft(total_defects, total_feet),
                    "adjusted_defects_per_1000ft": _driver_adjusted_rate(total_defects, total_feet, avg_bst_active_pct),
                    "avg_defect_size": avg_size,
                }
            )
        length_time_of_day_rows: List[Dict[str, object]] = []
        for bucket in length_time_of_day_stats:
            total_feet = _to_float(bucket.get("total_feet")) or 0.0
            total_defects = int(bucket.get("total_defects") or 0)
            avg_bst_active_pct = (
                round(((_to_float(bucket.get("bst_sum")) or 0.0) / int(bucket.get("bst_count") or 0)), 3)
                if int(bucket.get("bst_count") or 0) > 0
                else None
            )
            avg_length = (
                round(((_to_float(bucket.get("length_sum")) or 0.0) / int(bucket.get("length_count") or 0)), 2)
                if int(bucket.get("length_count") or 0) > 0
                else None
            )
            length_time_of_day_rows.append(
                {
                    "bucket_label": bucket.get("bucket_label"),
                    "reels": int(bucket.get("reels") or 0),
                    "avg_length_ft": avg_length,
                    "min_length_ft": _to_float(bucket.get("length_min")),
                    "max_length_ft": _to_float(bucket.get("length_max")),
                    "total_feet": round(total_feet, 2),
                    "total_defects": total_defects,
                    "defects_per_1000ft": _rate_per_1000ft(total_defects, total_feet),
                    "adjusted_defects_per_1000ft": _driver_adjusted_rate(total_defects, total_feet, avg_bst_active_pct),
                    "avg_bst_active_pct": avg_bst_active_pct,
                }
            )
        mask_presence_stats: Dict[str, Dict[str, object]] = {
            "no_mask": {
                "bucket_key": "no_mask",
                "bucket_label": "No Mask",
                "reels": 0,
                "total_feet": 0.0,
                "total_defects": 0,
                "size_sum": 0.0,
                "size_weight": 0,
                "bst_sum": 0.0,
                "bst_count": 0,
            },
            "masked_reel": {
                "bucket_key": "masked_reel",
                "bucket_label": "Masked Reel",
                "reels": 0,
                "total_feet": 0.0,
                "total_defects": 0,
                "size_sum": 0.0,
                "size_weight": 0,
                "bst_sum": 0.0,
                "bst_count": 0,
            },
            "mask_changes": {
                "bucket_key": "mask_changes",
                "bucket_label": "Mask Changes",
                "reels": 0,
                "total_feet": 0.0,
                "total_defects": 0,
                "size_sum": 0.0,
                "size_weight": 0,
                "bst_sum": 0.0,
                "bst_count": 0,
            },
        }
        mask_time_of_day_stats: List[Dict[str, object]] = [
            {"bucket_key": "overnight", "bucket_label": "12:00 AM - 6:00 AM", "reel_count": 0, "reels_with_masks": 0, "total_feet": 0.0},
            {"bucket_key": "morning", "bucket_label": "6:00 AM - 12:00 PM", "reel_count": 0, "reels_with_masks": 0, "total_feet": 0.0},
            {"bucket_key": "afternoon", "bucket_label": "12:00 PM - 6:00 PM", "reel_count": 0, "reels_with_masks": 0, "total_feet": 0.0},
            {"bucket_key": "evening", "bucket_label": "6:00 PM - 12:00 AM", "reel_count": 0, "reels_with_masks": 0, "total_feet": 0.0},
        ]
        for record in reel_records:
            masked = int(record.get("mask_effective_count") or 0) > 0
            if bool(record.get("has_mask_change")):
                mask_bucket = mask_presence_stats["mask_changes"]
            elif masked:
                mask_bucket = mask_presence_stats["masked_reel"]
            else:
                mask_bucket = mask_presence_stats["no_mask"]
            mask_bucket["reels"] += 1
            mask_bucket["total_feet"] += _to_float(record.get("length_ft")) or 0.0
            mask_bucket["total_defects"] += int(record.get("total_defects") or 0)
            avg_size = _to_float(record.get("avg_defect_size"))
            total_defects_for_size = int(record.get("total_defects") or 0)
            if avg_size is not None and total_defects_for_size > 0:
                mask_bucket["size_sum"] += avg_size * total_defects_for_size
                mask_bucket["size_weight"] += total_defects_for_size
            bst_active_pct = _to_float((record.get("bst_coverage") or {}).get("active_pct"))
            if bst_active_pct is not None:
                mask_bucket["bst_sum"] += bst_active_pct
                mask_bucket["bst_count"] += 1
            ts = record.get("time_sort")
            if ts is not None:
                hour = ts.hour
                if hour < 6:
                    time_bucket = mask_time_of_day_stats[0]
                elif hour < 12:
                    time_bucket = mask_time_of_day_stats[1]
                elif hour < 18:
                    time_bucket = mask_time_of_day_stats[2]
                else:
                    time_bucket = mask_time_of_day_stats[3]
                time_bucket["reel_count"] += 1
                time_bucket["total_feet"] += _to_float(record.get("length_ft")) or 0.0
                if masked:
                    time_bucket["reels_with_masks"] += 1
        reference_bucket_rows: List[Dict[str, object]] = []
        mask_bucket_rows: List[Dict[str, object]] = []
        for bucket_key in ("no_change", "single_change", "multiple_changes"):
            bucket = reference_bucket_stats[bucket_key]
            total_feet = _to_float(bucket.get("total_feet")) or 0.0
            total_defects = int(bucket.get("total_defects") or 0)
            defects_per_1000ft = _rate_per_1000ft(total_defects, total_feet)
            size_weight = int(bucket.get("size_weight") or 0)
            avg_size = (
                round(((_to_float(bucket.get("size_sum")) or 0.0) / size_weight), 3)
                if size_weight > 0
                else None
            )
            bst_count = int(bucket.get("bst_count") or 0)
            avg_bst_active_pct = (
                round(((_to_float(bucket.get("bst_sum")) or 0.0) / bst_count), 3)
                if bst_count > 0
                else None
            )
            interpretation = "Baseline"
            if bucket_key != "no_change":
                delta = _safe_delta(defects_per_1000ft, baseline_reference_rate)
                if delta is None:
                    interpretation = "No comparison"
                elif delta > 0.1:
                    interpretation = "Higher defects"
                elif delta < -0.1:
                    interpretation = "Lower defects"
                else:
                    interpretation = "Similar"
            reference_bucket_rows.append(
                {
                    "bucket_key": bucket_key,
                    "bucket_label": bucket.get("bucket_label"),
                    "reels": int(bucket.get("reels") or 0),
                    "total_feet": round(total_feet, 2),
                    "total_defects": total_defects,
                    "defects_per_1000ft": defects_per_1000ft,
                    "adjusted_feet": (
                        round(total_feet * (avg_bst_active_pct / 100.0), 2)
                        if avg_bst_active_pct is not None
                        else None
                    ),
                    "adjusted_defects_per_1000ft": (
                        _rate_per_1000ft(
                            total_defects,
                            total_feet * (avg_bst_active_pct / 100.0),
                        )
                        if avg_bst_active_pct is not None
                        and (total_feet * (avg_bst_active_pct / 100.0)) >= 1.0
                        else None
                    ),
                    "avg_defect_size": avg_size,
                    "avg_bst_active_pct": avg_bst_active_pct,
                    "interpretation": interpretation,
                }
            )
        for bucket_key in ("no_mask", "masked_reel", "mask_changes"):
            bucket = mask_presence_stats[bucket_key]
            total_feet = _to_float(bucket.get("total_feet")) or 0.0
            total_defects = int(bucket.get("total_defects") or 0)
            bst_count = int(bucket.get("bst_count") or 0)
            avg_bst_active_pct = (
                round(((_to_float(bucket.get("bst_sum")) or 0.0) / bst_count), 3)
                if bst_count > 0
                else None
            )
            size_weight = int(bucket.get("size_weight") or 0)
            avg_size = (
                round(((_to_float(bucket.get("size_sum")) or 0.0) / size_weight), 3)
                if size_weight > 0
                else None
            )
            mask_bucket_rows.append(
                {
                    "bucket_key": bucket_key,
                    "bucket_label": bucket.get("bucket_label"),
                    "reels": int(bucket.get("reels") or 0),
                    "total_feet": round(total_feet, 2),
                    "total_defects": total_defects,
                    "avg_bst_active_pct": avg_bst_active_pct,
                    "defects_per_1000ft": _rate_per_1000ft(total_defects, total_feet),
                    "adjusted_defects_per_1000ft": (
                        _rate_per_1000ft(total_defects, total_feet * (avg_bst_active_pct / 100.0))
                        if avg_bst_active_pct is not None and (total_feet * (avg_bst_active_pct / 100.0)) >= 1.0
                        else None
                    ),
                    "avg_defect_size": avg_size,
                }
            )
        mask_time_of_day_rows: List[Dict[str, object]] = []
        for bucket in mask_time_of_day_stats:
            reel_count = int(bucket.get("reel_count") or 0)
            reels_with_masks = int(bucket.get("reels_with_masks") or 0)
            mask_time_of_day_rows.append(
                {
                    "bucket_key": bucket.get("bucket_key"),
                    "bucket_label": bucket.get("bucket_label"),
                    "reel_count": reel_count,
                    "reels_with_masks": reels_with_masks,
                    "total_feet": round(_to_float(bucket.get("total_feet")) or 0.0, 2),
                    "pct_with_masks": round((reels_with_masks / reel_count) * 100.0, 1) if reel_count else 0.0,
                }
            )
        reference_hour_buckets: List[Dict[str, object]] = []
        reference_time_of_day_rows: List[Dict[str, object]] = []
        timeline_records = sorted(
            [record for record in reel_records if record.get("time_sort") is not None],
            key=lambda item: item.get("time_sort"),
        )
        time_of_day_stats: List[Dict[str, object]] = [
            {
                "bucket_key": "overnight",
                "bucket_label": "12:00 AM - 6:00 AM",
                "start_hour": 0,
                "end_hour": 6,
                "reel_count": 0,
                "reels_with_reference_changes": 0,
                "total_reference_changes": 0,
                "total_feet": 0.0,
                "total_defects": 0,
                "size_sum": 0.0,
                "size_weight": 0,
                "bst_sum": 0.0,
                "bst_count": 0,
            },
            {
                "bucket_key": "morning",
                "bucket_label": "6:00 AM - 12:00 PM",
                "start_hour": 6,
                "end_hour": 12,
                "reel_count": 0,
                "reels_with_reference_changes": 0,
                "total_reference_changes": 0,
                "total_feet": 0.0,
                "total_defects": 0,
                "size_sum": 0.0,
                "size_weight": 0,
                "bst_sum": 0.0,
                "bst_count": 0,
            },
            {
                "bucket_key": "afternoon",
                "bucket_label": "12:00 PM - 6:00 PM",
                "start_hour": 12,
                "end_hour": 18,
                "reel_count": 0,
                "reels_with_reference_changes": 0,
                "total_reference_changes": 0,
                "total_feet": 0.0,
                "total_defects": 0,
                "size_sum": 0.0,
                "size_weight": 0,
                "bst_sum": 0.0,
                "bst_count": 0,
            },
            {
                "bucket_key": "evening",
                "bucket_label": "6:00 PM - 12:00 AM",
                "start_hour": 18,
                "end_hour": 24,
                "reel_count": 0,
                "reels_with_reference_changes": 0,
                "total_reference_changes": 0,
                "total_feet": 0.0,
                "total_defects": 0,
                "size_sum": 0.0,
                "size_weight": 0,
                "bst_sum": 0.0,
                "bst_count": 0,
            },
        ]
        if timeline_records:
            start_time = timeline_records[0]["time_sort"]
            end_time = timeline_records[-1]["time_sort"]
            for record in timeline_records:
                ts = record.get("time_sort")
                if ts is None:
                    continue
                hour = ts.hour
                if hour < 6:
                    time_bucket = time_of_day_stats[0]
                elif hour < 12:
                    time_bucket = time_of_day_stats[1]
                elif hour < 18:
                    time_bucket = time_of_day_stats[2]
                else:
                    time_bucket = time_of_day_stats[3]
                time_bucket["reel_count"] += 1
                time_bucket["total_feet"] += _to_float(record.get("length_ft")) or 0.0
                time_bucket["total_defects"] += int(record.get("total_defects") or 0)
                if int(record.get("reference_count") or 0) > 1:
                    time_bucket["reels_with_reference_changes"] += 1
                time_bucket["total_reference_changes"] += int(record.get("reference_repeated_updates") or 0)
                avg_size = _to_float(record.get("avg_defect_size"))
                total_defects_for_size = int(record.get("total_defects") or 0)
                if avg_size is not None and total_defects_for_size > 0:
                    time_bucket["size_sum"] += avg_size * total_defects_for_size
                    time_bucket["size_weight"] += total_defects_for_size
                bst_active_pct = _to_float((record.get("bst_coverage") or {}).get("active_pct"))
                if bst_active_pct is not None:
                    time_bucket["bst_sum"] += bst_active_pct
                    time_bucket["bst_count"] += 1
            bucket_start = start_time
            bucket_index = 0
            while bucket_start <= end_time:
                bucket_end = bucket_start + timedelta(hours=1)
                bucket_records = [
                    record
                    for record in timeline_records
                    if record.get("time_sort") is not None
                    and record["time_sort"] >= bucket_start
                    and (
                        record["time_sort"] < bucket_end
                        or (bucket_end > end_time and record["time_sort"] <= end_time)
                    )
                ]
                reel_count = len(bucket_records)
                reels_with_changes = sum(
                    1 for record in bucket_records if int(record.get("reference_count") or 0) > 1
                )
                total_reference_changes = sum(
                    int(record.get("reference_repeated_updates") or 0) for record in bucket_records
                )
                total_feet_bucket = sum(_to_float(record.get("length_ft")) or 0.0 for record in bucket_records)
                total_defects_bucket = sum(int(record.get("total_defects") or 0) for record in bucket_records)
                avg_bst_active_bucket = _average(
                    (record.get("bst_coverage") or {}).get("active_pct") for record in bucket_records
                )
                reference_hour_buckets.append(
                    {
                        "bucket_key": f"hour_{bucket_index + 1}",
                        "bucket_index": bucket_index,
                        "bucket_start": _iso(bucket_start),
                        "bucket_end": _iso(bucket_end if bucket_end <= end_time else end_time),
                        "reel_count": reel_count,
                        "reels_with_reference_changes": reels_with_changes,
                        "total_reference_changes": total_reference_changes,
                        "total_feet": round(total_feet_bucket, 2),
                        "total_defects": total_defects_bucket,
                        "defects_per_1000ft": _rate_per_1000ft(total_defects_bucket, total_feet_bucket),
                        "avg_bst_active_pct": avg_bst_active_bucket,
                    }
                )
                bucket_index += 1
                bucket_start = bucket_end
        max_time_of_day_changes = max(
            (int(bucket.get("reels_with_reference_changes") or 0) for bucket in time_of_day_stats),
            default=0,
        )
        for bucket in time_of_day_stats:
            total_feet_bucket = _to_float(bucket.get("total_feet")) or 0.0
            total_defects_bucket = int(bucket.get("total_defects") or 0)
            avg_bst_active_bucket = (
                round(((_to_float(bucket.get("bst_sum")) or 0.0) / int(bucket.get("bst_count") or 0)), 3)
                if int(bucket.get("bst_count") or 0) > 0
                else None
            )
            size_weight = int(bucket.get("size_weight") or 0)
            avg_size_bucket = (
                round(((_to_float(bucket.get("size_sum")) or 0.0) / size_weight), 3)
                if size_weight > 0
                else None
            )
            adjusted_feet_bucket = (
                total_feet_bucket * (avg_bst_active_bucket / 100.0)
                if avg_bst_active_bucket is not None
                else None
            )
            reference_time_of_day_rows.append(
                {
                    "bucket_key": bucket.get("bucket_key"),
                    "bucket_label": bucket.get("bucket_label"),
                    "reel_count": int(bucket.get("reel_count") or 0),
                    "reels_with_reference_changes": int(bucket.get("reels_with_reference_changes") or 0),
                    "total_reference_changes": int(bucket.get("total_reference_changes") or 0),
                    "total_feet": round(total_feet_bucket, 2),
                    "total_defects": total_defects_bucket,
                    "defects_per_1000ft": _rate_per_1000ft(total_defects_bucket, total_feet_bucket),
                    "adjusted_defects_per_1000ft": (
                        _rate_per_1000ft(total_defects_bucket, adjusted_feet_bucket)
                        if adjusted_feet_bucket is not None and adjusted_feet_bucket >= 1.0
                        else None
                    ),
                    "avg_bst_active_pct": avg_bst_active_bucket,
                    "avg_defect_size": avg_size_bucket,
                    "is_peak_change_bucket": int(bucket.get("reels_with_reference_changes") or 0) == max_time_of_day_changes
                    and max_time_of_day_changes > 0,
                }
            )
        BST_SUMMARY_ACTIVE_THRESHOLD = 95.0
        bst_length_stats: Dict[str, Dict[str, object]] = {
            bucket_label: {
                "bucket_label": bucket_label,
                "reels": 0,
                "active_reels": 0,
                "partial_reels": 0,
                "inactive_reels": 0,
            }
            for bucket_label in (
                "< 5,000 ft",
                "5,000 - 8,000 ft",
                "8,000 - 11,000 ft",
                "11,000 - 14,000 ft",
                "> 14,000 ft",
            )
        }
        bst_time_of_day_stats: List[Dict[str, object]] = [
            {
                "bucket_key": "overnight",
                "bucket_label": "12:00 AM - 6:00 AM",
                "reels": 0,
                "length_buckets": {
                    bucket_label: {"reels": 0, "active_reels": 0, "partial_reels": 0, "inactive_reels": 0}
                    for bucket_label in ("< 5,000 ft", "5,000 - 8,000 ft", "8,000 - 11,000 ft", "11,000 - 14,000 ft", "> 14,000 ft")
                },
            },
            {
                "bucket_key": "morning",
                "bucket_label": "6:00 AM - 12:00 PM",
                "reels": 0,
                "length_buckets": {
                    bucket_label: {"reels": 0, "active_reels": 0, "partial_reels": 0, "inactive_reels": 0}
                    for bucket_label in ("< 5,000 ft", "5,000 - 8,000 ft", "8,000 - 11,000 ft", "11,000 - 14,000 ft", "> 14,000 ft")
                },
            },
            {
                "bucket_key": "afternoon",
                "bucket_label": "12:00 PM - 6:00 PM",
                "reels": 0,
                "length_buckets": {
                    bucket_label: {"reels": 0, "active_reels": 0, "partial_reels": 0, "inactive_reels": 0}
                    for bucket_label in ("< 5,000 ft", "5,000 - 8,000 ft", "8,000 - 11,000 ft", "11,000 - 14,000 ft", "> 14,000 ft")
                },
            },
            {
                "bucket_key": "evening",
                "bucket_label": "6:00 PM - 12:00 AM",
                "reels": 0,
                "length_buckets": {
                    bucket_label: {"reels": 0, "active_reels": 0, "partial_reels": 0, "inactive_reels": 0}
                    for bucket_label in ("< 5,000 ft", "5,000 - 8,000 ft", "8,000 - 11,000 ft", "11,000 - 14,000 ft", "> 14,000 ft")
                },
            },
        ]
        bst_active_reels = 0
        bst_partial_reels = 0
        bst_inactive_reels = 0
        for record in reel_records:
            bst_active_pct = _to_float((record.get("bst_coverage") or {}).get("active_pct")) or 0.0
            if bst_active_pct >= BST_SUMMARY_ACTIVE_THRESHOLD:
                bst_summary_status = "active"
                bst_active_reels += 1
            elif bst_active_pct > BST_OFF_ACTIVE_PCT_THRESHOLD:
                bst_summary_status = "partial"
                bst_partial_reels += 1
            else:
                bst_summary_status = "inactive"
                bst_inactive_reels += 1
            length_bucket = bst_length_stats[_driver_length_bucket_label(_to_float(record.get("length_ft")))]
            length_bucket["reels"] += 1
            if bst_summary_status == "active":
                length_bucket["active_reels"] += 1
            elif bst_summary_status == "partial":
                length_bucket["partial_reels"] += 1
            else:
                length_bucket["inactive_reels"] += 1
            ts = record.get("time_sort")
            if ts is not None:
                hour = ts.hour
                if hour < 6:
                    time_bucket = bst_time_of_day_stats[0]
                elif hour < 12:
                    time_bucket = bst_time_of_day_stats[1]
                elif hour < 18:
                    time_bucket = bst_time_of_day_stats[2]
                else:
                    time_bucket = bst_time_of_day_stats[3]
                time_bucket["reels"] += 1
                length_bucket_label = _driver_length_bucket_label(_to_float(record.get("length_ft")))
                matrix_bucket = time_bucket["length_buckets"][length_bucket_label]
                matrix_bucket["reels"] += 1
                if bst_summary_status == "active":
                    matrix_bucket["active_reels"] += 1
                elif bst_summary_status == "partial":
                    matrix_bucket["partial_reels"] += 1
                else:
                    matrix_bucket["inactive_reels"] += 1
        bst_length_rows: List[Dict[str, object]] = []
        for bucket_key in ("< 5,000 ft", "5,000 - 8,000 ft", "8,000 - 11,000 ft", "11,000 - 14,000 ft", "> 14,000 ft"):
            bucket = bst_length_stats[bucket_key]
            reels_count = int(bucket.get("reels") or 0)
            active_count = int(bucket.get("active_reels") or 0)
            partial_count = int(bucket.get("partial_reels") or 0)
            inactive_count = int(bucket.get("inactive_reels") or 0)
            bst_length_rows.append(
                {
                    "bucket_label": bucket.get("bucket_label"),
                    "reels": reels_count,
                    "active_reels": active_count,
                    "partial_reels": partial_count,
                    "inactive_reels": inactive_count,
                    "active_pct": round((active_count / reels_count) * 100.0, 1) if reels_count else 0.0,
                    "partial_pct": round((partial_count / reels_count) * 100.0, 1) if reels_count else 0.0,
                    "inactive_pct": round((inactive_count / reels_count) * 100.0, 1) if reels_count else 0.0,
                }
            )
        bst_time_of_day_rows: List[Dict[str, object]] = []
        for bucket in bst_time_of_day_stats:
            matrix_cells = []
            for bucket_key in ("< 5,000 ft", "5,000 - 8,000 ft", "8,000 - 11,000 ft", "11,000 - 14,000 ft", "> 14,000 ft"):
                length_bucket = bucket["length_buckets"][bucket_key]
                reels_count = int(length_bucket.get("reels") or 0)
                active_count = int(length_bucket.get("active_reels") or 0)
                partial_count = int(length_bucket.get("partial_reels") or 0)
                inactive_count = int(length_bucket.get("inactive_reels") or 0)
                matrix_cells.append(
                    {
                        "bucket_label": bucket_key,
                        "reels": reels_count,
                        "active_reels": active_count,
                        "partial_reels": partial_count,
                        "inactive_reels": inactive_count,
                        "active_pct": round((active_count / reels_count) * 100.0, 1) if reels_count else 0.0,
                        "partial_pct": round((partial_count / reels_count) * 100.0, 1) if reels_count else 0.0,
                        "inactive_pct": round((inactive_count / reels_count) * 100.0, 1) if reels_count else 0.0,
                    }
                )
            bst_time_of_day_rows.append(
                {
                    "bucket_key": bucket.get("bucket_key"),
                    "bucket_label": bucket.get("bucket_label"),
                    "reels": int(bucket.get("reels") or 0),
                    "length_buckets": matrix_cells,
                }
            )
        flag_labels = {
            "reference_change": "Reference Change",
            "multiple_reference_changes": "Multiple Reference Changes",
            "mask_change": "Mask Change",
            "masked_reel": "Masked Reel",
            "sensitivity_change": "Sensitivity Change",
            "speed_shift": "Speed Shift",
            "speed_instability": "Speed Instability",
            "bst_low_off": "BST Low/Off",
            "long_reel": "Long Reel",
            "short_reel": "Short Reel",
        }
        spike_records: List[Dict[str, object]] = []
        low_length_cut, high_length_cut = length_thresholds
        _, high_variation_cut = speed_variation_thresholds
        for record in reel_records:
            event_types = {event.get("type") for event in record.get("events") or [] if event.get("type")}
            flags: List[Tuple[str, str]] = []
            reference_count = int(record.get("reference_count") or 0)
            if reference_count > 1:
                flags.append(("reference_change", flag_labels["reference_change"]))
            if reference_count >= 3:
                flags.append(("multiple_reference_changes", flag_labels["multiple_reference_changes"]))
            if bool(record.get("has_mask_change")):
                flags.append(("mask_change", flag_labels["mask_change"]))
            if int(record.get("mask_effective_count") or 0) > 0:
                flags.append(("masked_reel", flag_labels["masked_reel"]))
            if "sensitivity_change" in event_types:
                flags.append(("sensitivity_change", flag_labels["sensitivity_change"]))
            if "speed_shift" in event_types:
                flags.append(("speed_shift", flag_labels["speed_shift"]))
            speed_range = _to_float(record.get("speed_range"))
            if speed_range is not None and high_variation_cut is not None and speed_range > high_variation_cut:
                flags.append(("speed_instability", flag_labels["speed_instability"]))
            bst_active_pct = _to_float((record.get("bst_coverage") or {}).get("active_pct"))
            if bst_active_pct is not None and bst_active_pct < BST_PARTIAL_ACTIVE_PCT_THRESHOLD:
                flags.append(("bst_low_off", flag_labels["bst_low_off"]))
            length_ft = _to_float(record.get("length_ft"))
            if length_ft is not None and high_length_cut is not None and length_ft > high_length_cut:
                flags.append(("long_reel", flag_labels["long_reel"]))
            if length_ft is not None and low_length_cut is not None and length_ft <= low_length_cut:
                flags.append(("short_reel", flag_labels["short_reel"]))
            record["driver_summary_flags"] = flags
            is_spike = "defect_spike" in event_types
            record["is_spike_reel"] = is_spike
            if is_spike:
                spike_records.append(record)

        all_flag_stats: Dict[str, Dict[str, object]] = {}
        single_flag_stats: Dict[str, Dict[str, object]] = {}
        combination_stats: Dict[Tuple[str, str], Dict[str, object]] = {}
        spike_time_of_day_stats: List[Dict[str, object]] = [
            {
                "bucket_key": "overnight",
                "bucket_label": "12:00 AM - 6:00 AM",
                "reels": 0,
                "total_feet": 0.0,
                "total_defects": 0,
                "bst_sum": 0.0,
                "bst_count": 0,
            },
            {
                "bucket_key": "morning",
                "bucket_label": "6:00 AM - 12:00 PM",
                "reels": 0,
                "total_feet": 0.0,
                "total_defects": 0,
                "bst_sum": 0.0,
                "bst_count": 0,
            },
            {
                "bucket_key": "afternoon",
                "bucket_label": "12:00 PM - 6:00 PM",
                "reels": 0,
                "total_feet": 0.0,
                "total_defects": 0,
                "bst_sum": 0.0,
                "bst_count": 0,
            },
            {
                "bucket_key": "evening",
                "bucket_label": "6:00 PM - 12:00 AM",
                "reels": 0,
                "total_feet": 0.0,
                "total_defects": 0,
                "bst_sum": 0.0,
                "bst_count": 0,
            },
        ]
        spike_no_flag_count = 0
        spike_one_flag_count = 0
        spike_multi_flag_count = 0
        for record in spike_records:
            flags = list(dict.fromkeys(record.get("driver_summary_flags") or []))
            flag_keys = [key for key, _ in flags]
            ts = record.get("time_sort")
            if ts is not None:
                hour = ts.hour
                if hour < 6:
                    time_bucket = spike_time_of_day_stats[0]
                elif hour < 12:
                    time_bucket = spike_time_of_day_stats[1]
                elif hour < 18:
                    time_bucket = spike_time_of_day_stats[2]
                else:
                    time_bucket = spike_time_of_day_stats[3]
                time_bucket["reels"] += 1
                time_bucket["total_feet"] += _to_float(record.get("length_ft")) or 0.0
                time_bucket["total_defects"] += int(record.get("total_defects") or 0)
                bst_active_pct = _to_float((record.get("bst_coverage") or {}).get("active_pct"))
                if bst_active_pct is not None:
                    time_bucket["bst_sum"] += bst_active_pct
                    time_bucket["bst_count"] += 1
            if not flag_keys:
                spike_no_flag_count += 1
                continue
            for key, label in flags:
                bucket = all_flag_stats.setdefault(
                    key,
                    {
                        "flag_key": key,
                        "flag_label": label,
                        "reels": 0,
                    },
                )
                bucket["reels"] += 1
            if len(flag_keys) == 1:
                spike_one_flag_count += 1
                key, label = flags[0]
                if key != "masked_reel":
                    bucket = single_flag_stats.setdefault(
                        key,
                        {
                            "flag_key": key,
                            "flag_label": label,
                            "reels": 0,
                        },
                    )
                    bucket["reels"] += 1
                continue
            spike_multi_flag_count += 1
            sorted_keys = sorted(set(flag_keys), key=lambda item: flag_labels.get(item, item))
            combination_label = " + ".join(flag_labels.get(key, key) for key in sorted_keys)
            combo_key = tuple(sorted_keys)
            combo_bucket = combination_stats.setdefault(
                combo_key,
                {
                    "combination_label": combination_label,
                    "reels": 0,
                }
            )
            combo_bucket["reels"] += 1

        spike_count = len(spike_records)
        all_flag_rows: List[Dict[str, object]] = []
        for key, stats in all_flag_stats.items():
            all_flag_rows.append(
                {
                    "flag_key": key,
                    "flag_label": stats.get("flag_label"),
                    "reels": int(stats.get("reels") or 0),
                    "pct_of_spike_reels": round((int(stats.get("reels") or 0) / spike_count) * 100.0, 1)
                    if spike_count
                    else 0.0,
                }
            )
        all_flag_rows.sort(
            key=lambda item: (
                -(int(item.get("reels") or 0)),
                item.get("flag_label") or "",
            )
        )

        single_flag_rows: List[Dict[str, object]] = []
        for key, stats in single_flag_stats.items():
            single_flag_rows.append(
                {
                    "flag_key": key,
                    "flag_label": stats.get("flag_label"),
                    "reels": int(stats.get("reels") or 0),
                    "pct_of_spike_reels": round((int(stats.get("reels") or 0) / spike_count) * 100.0, 1)
                    if spike_count
                    else 0.0,
                }
            )
        single_flag_rows.sort(
            key=lambda item: (
                -(int(item.get("reels") or 0)),
                item.get("flag_label") or "",
            )
        )

        combination_rows: List[Dict[str, object]] = []
        for _, stats in combination_stats.items():
            combination_rows.append(
                {
                    "combination_label": stats.get("combination_label"),
                    "reels": int(stats.get("reels") or 0),
                    "pct_of_spike_reels": round((int(stats.get("reels") or 0) / spike_count) * 100.0, 1)
                    if spike_count
                    else 0.0,
                }
            )
        combination_rows.sort(
            key=lambda item: (
                -(int(item.get("reels") or 0)),
                item.get("combination_label") or "",
            )
        )
        combination_rows = combination_rows[:8]
        spike_time_of_day_rows: List[Dict[str, object]] = []
        for bucket in spike_time_of_day_stats:
            total_feet_bucket = _to_float(bucket.get("total_feet")) or 0.0
            total_defects_bucket = int(bucket.get("total_defects") or 0)
            bst_count_bucket = int(bucket.get("bst_count") or 0)
            avg_bst_active_bucket = (
                round(((_to_float(bucket.get("bst_sum")) or 0.0) / bst_count_bucket), 3)
                if bst_count_bucket > 0
                else None
            )
            spike_time_of_day_rows.append(
                {
                    "bucket_key": bucket.get("bucket_key"),
                    "bucket_label": bucket.get("bucket_label"),
                    "reels": int(bucket.get("reels") or 0),
                    "total_feet": round(total_feet_bucket, 2),
                    "total_defects": total_defects_bucket,
                    "avg_bst_active_pct": avg_bst_active_bucket,
                    "defects_per_1000ft": _rate_per_1000ft(total_defects_bucket, total_feet_bucket),
                    "adjusted_defects_per_1000ft": _driver_adjusted_rate(
                        total_defects_bucket,
                        total_feet_bucket,
                        avg_bst_active_bucket,
                    ),
                }
            )
        payload = {
            "kpis": {
                "reels_analyzed": len(reel_records),
                "total_footage": round(total_footage, 2),
                "defects_per_1000ft": _rate_per_1000ft(kpi_total_defects, total_footage),
                "average_defect_size": kpi_avg_size,
                "avg_size_basis": kpi_avg_size_basis or overall_avg_basis,
                "top_defect_type": top_type_name,
                "top_defect_type_label": _driver_class_label(top_type_name) if top_type_name else None,
                "top_defect_type_count": int(top_type_count or 0),
                "total_defects": int(kpi_total_defects),
            },
            "event_counts": {key: int(value) for key, value in event_counts.items()},
            "timeline": timeline,
            "driver_summary": {
                "summary": {
                    "total_spike_reels": int(spike_count),
                    "no_flag_spike_reels": int(spike_no_flag_count),
                    "one_flag_spike_reels": int(spike_one_flag_count),
                    "multi_flag_spike_reels": int(spike_multi_flag_count),
                },
                "all_flag_rows": all_flag_rows,
                "single_flag_rows": single_flag_rows,
                "combination_rows": combination_rows,
                "time_of_day": spike_time_of_day_rows,
            },
            "bst_active_summary": {
                "summary": {
                    "total_reels": int(len(reel_records)),
                    "active_reels": int(bst_active_reels),
                    "partial_reels": int(bst_partial_reels),
                    "inactive_reels": int(bst_inactive_reels),
                    "active_pct": round((bst_active_reels / len(reel_records)) * 100.0, 1) if reel_records else 0.0,
                    "partial_pct": round((bst_partial_reels / len(reel_records)) * 100.0, 1) if reel_records else 0.0,
                    "inactive_pct": round((bst_inactive_reels / len(reel_records)) * 100.0, 1) if reel_records else 0.0,
                },
                "length_buckets": bst_length_rows,
                "time_of_day": bst_time_of_day_rows,
            },
            "sensitivity_impacts": sorted(
                sensitivity_impacts,
                key=lambda item: (
                    -(abs(_to_float(item.get("rate_delta_per_1000ft")) or 0.0)),
                    item.get("time") or "",
                ),
            ),
            "sensitivity_summary": sorted(
                sensitivity_summary_rows,
                key=lambda item: (
                    0 if item.get("class_name") == "flaw" else 1,
                    item.get("class_label") or "",
                    -(_to_float(item.get("threshold_value")) or 0.0),
                ),
            ),
            "mask_impacts": sorted(
                mask_impacts,
                key=lambda item: (
                    -(abs(_to_float(item.get("rate_delta_per_1000ft")) or 0.0)),
                    -(int(item.get("coordinate_change_count") or 0)),
                ),
            ),
            "mask_segments": sorted(
                mask_segments,
                key=lambda item: (
                    item.get("job") or "",
                    item.get("order") or "",
                    item.get("segment_id") or "",
                ),
            ),
            "mask_overview": {
                "summary": {
                    "total_reels": int(len(reel_records)),
                    "reels_with_masks": int(mask_presence_stats["masked_reel"].get("reels") or 0),
                    "reels_without_masks": int(mask_presence_stats["no_mask"].get("reels") or 0),
                    "total_feet_with_masks": round(
                        _to_float(mask_presence_stats["masked_reel"].get("total_feet")) or 0.0,
                        2,
                    ),
                },
                "buckets": mask_bucket_rows,
                "time_of_day": mask_time_of_day_rows,
            },
            "reference_stability": {
                "summary": {
                    "total_reels": int(len(reel_records)),
                    "reels_with_changes": int(reels_with_reference_changes),
                    "pct_with_changes": round(
                        (int(reels_with_reference_changes) / len(reel_records)) * 100.0, 1
                    )
                    if reel_records
                    else 0.0,
                    "time_start": reel_records[0].get("time") if reel_records else None,
                    "time_end": reel_records[-1].get("time") if reel_records else None,
                    "total_feet": round(total_footage, 2),
                    "reels_with_repeated_updates": int(reels_with_repeated_reference_updates),
                    "total_reference_events": int(reels_with_reference_changes),
                },
                "buckets": reference_bucket_rows,
                "hour_buckets": reference_hour_buckets,
                "time_of_day": reference_time_of_day_rows,
            },
            "speed_impact": {
                "summary": {
                    "total_reels_with_speed": int(len(speed_records)),
                    "reels_without_speed": int(max(len(reel_records) - len(speed_records), 0)),
                    "speed_range_min": _to_float(speed_definition.get("min")) if speed_definition else None,
                    "speed_range_max": _to_float(speed_definition.get("max")) if speed_definition else None,
                    "bucket_size": _to_float(speed_definition.get("step")) if speed_definition else None,
                },
                "buckets": speed_bucket_overview,
                "stability": speed_stability_rows,
                "time_of_day": speed_time_of_day_rows,
                "best_range": speed_best_range,
            },
            "length_impact": {
                "buckets": length_bucket_rows,
                "time_of_day": length_time_of_day_rows,
            },
        }
        return jsonify(payload)


def _baseline_for_job_order(
    session: Session,
    filters: Dict[str, Optional[str]],
    job: Optional[str],
    order: Optional[str],
) -> Optional[Reel]:
    baseline_filters = dict(filters)
    baseline_filters["job"] = job
    baseline_filters["order"] = order
    baseline_filters.pop("reel_code", None)
    baseline_filters.pop("reel_codes", None)

    query = _apply_reel_filters(
        session.query(Reel), baseline_filters, include_reel_code=False
    )
    if job:
        query = query.filter(Reel.job_name == job)
    else:
        query = query.filter(Reel.job_name.is_(None))
    if order == SENTINEL_NONE:
        query = query.filter(or_(Reel.order_number.is_(None), Reel.order_number == ""))
    elif order:
        query = query.filter(Reel.order_number == order)
    else:
        query = query.filter(Reel.order_number.is_(None))

    return (
        query.order_by(Reel.time_start.asc())
        .options(
            selectinload(Reel.sensitivity_sets),
            selectinload(Reel.rlm_config),
        )
        .first()
    )


def _job_explorer_key(job_name: Optional[str], order_number: Optional[str]) -> Tuple[str, str]:
    return job_name or SENTINEL_NONE, order_number or SENTINEL_NONE


def _job_explorer_phase_seconds_by_reel(
    phases: Iterable[object],
    window_start: datetime,
    window_end: datetime,
) -> Dict[int, Dict[str, float]]:
    grouped: Dict[int, List[object]] = defaultdict(list)
    for phase in phases or []:
        reel_id = getattr(phase, "reel_id", None)
        if reel_id is None:
            continue
        grouped[reel_id].append(phase)
    return {
        reel_id: _phase_seconds(rows, window_start, window_end)
        for reel_id, rows in grouped.items()
    }


def _job_explorer_phase_pct(seconds_by_phase: Optional[Dict[str, float]]) -> Dict[str, float]:
    totals = seconds_by_phase or {}
    total_seconds = sum(totals.values())
    if total_seconds <= 0:
        return {}
    return {
        key: round((value or 0.0) / total_seconds * 100.0, 1)
        for key, value in totals.items()
        if value
    }


def _job_explorer_standard_maps(
    sensitivity_rows: Iterable[SensitivitySet],
) -> Dict[int, Dict[str, Tuple[Optional[float], Optional[float]]]]:
    grouped: Dict[int, List[SensitivitySet]] = defaultdict(list)
    for row in sensitivity_rows or []:
        if row.reel_id is None:
            continue
        grouped[row.reel_id].append(row)
    return {
        reel_id: _standard_map(rows)
        for reel_id, rows in grouped.items()
    }


def _job_explorer_baseline_ids(
    session: Session,
    filters: Dict[str, Any],
    target_keys: Set[Tuple[str, str]],
) -> Dict[Tuple[str, str], int]:
    if not target_keys:
        return {}
    rows = (
        _apply_reel_filters(
            session.query(
                Reel.reel_id,
                Reel.job_name,
                Reel.order_number,
                Reel.time_start,
            ),
            filters,
            include_reel_code=False,
        )
        .order_by(Reel.time_start.asc(), Reel.reel_id.asc())
        .all()
    )
    result: Dict[Tuple[str, str], int] = {}
    for row in rows:
        reel_id = getattr(row, "reel_id", None)
        if reel_id is None:
            continue
        key = _job_explorer_key(getattr(row, "job_name", None), getattr(row, "order_number", None))
        if key in target_keys and key not in result:
            result[key] = reel_id
            if len(result) == len(target_keys):
                break
    return result


def _job_explorer_sensitivity_changes(
    reels: Iterable[object],
    standard_maps: Dict[int, Dict[str, Tuple[Optional[float], Optional[float]]]],
    baseline_ids: Dict[Tuple[str, str], int],
) -> Tuple[Dict[int, List[Dict[str, object]]], Counter]:
    changes_by_reel: Dict[int, List[Dict[str, object]]] = {}
    class_counter: Counter = Counter()
    for reel in reels or []:
        reel_id = getattr(reel, "reel_id", None)
        if reel_id is None:
            continue
        key = _job_explorer_key(getattr(reel, "job_name", None), getattr(reel, "order_number", None))
        baseline_reel_id = baseline_ids.get(key)
        current_std = standard_maps.get(reel_id, {})
        baseline_std = standard_maps.get(baseline_reel_id, {}) if baseline_reel_id is not None else {}
        sens_changes: List[Dict[str, object]] = []
        for cls in sorted(set(current_std) | set(baseline_std)):
            current_values = current_std.get(cls)
            baseline_values = baseline_std.get(cls)
            delta = _sensitivity_tuple_delta(baseline_values, current_values)
            if not delta:
                continue
            prev_thresh = delta["previous"].get("threshold")
            curr_thresh = delta["current"].get("threshold")
            prev_warn = delta["previous"].get("warn")
            curr_warn = delta["current"].get("warn")
            sens_changes.append(
                {
                    "name": cls,
                    "previous_threshold": prev_thresh,
                    "current_threshold": curr_thresh,
                    "previous_warn": prev_warn,
                    "current_warn": curr_warn,
                    "thres_delta": round(curr_thresh - prev_thresh, 3)
                    if prev_thresh is not None and curr_thresh is not None
                    else None,
                    "warn_delta": round(curr_warn - prev_warn, 3)
                    if prev_warn is not None and curr_warn is not None
                    else None,
                }
            )
            class_counter[cls] += 1
        changes_by_reel[reel_id] = sens_changes
    return changes_by_reel, class_counter


def _job_explorer_latest_reviews(
    session: Session,
    reel_ids: List[int],
) -> Dict[int, ReelReview]:
    if not reel_ids:
        return {}
    review_rows = (
        session.query(ReelReview)
        .filter(ReelReview.reel_id.in_(reel_ids))
        .order_by(ReelReview.reel_id.asc(), ReelReview.created_at.desc(), ReelReview.review_id.desc())
        .all()
    )
    result: Dict[int, ReelReview] = {}
    for review in review_rows:
        if review.reel_id and review.reel_id not in result:
            result[review.reel_id] = review
    return result


@dashboard_bp.route("/api/job-explorer")
def api_job_explorer():
    with SessionLocal() as session:
        try:
            filters = _validate_filters(session)
        except ValueError as exc:
            return jsonify({"error": str(exc)}), 400

        page, page_size = _paginate()
        explorer_filters = dict(filters)
        explorer_filters["reel_code"] = None
        explorer_filters["reel_codes"] = []
        explorer_filters["reel_ids"] = []
        base_query = _apply_reel_filters(session.query(Reel), explorer_filters, include_reel_code=False)

        raw_status_filters = request.args.getlist("review_status")
        valid_statuses = {"pass", "fail", "uninspected"}
        status_filter = None
        for raw_value in raw_status_filters:
            normalized = (raw_value or "").strip().lower()
            if normalized in valid_statuses:
                status_filter = normalized
                break

        REVIEW_DECISION_COLLATION = "utf8mb4_unicode_ci"
        latest_review_subq = (
            session.query(
                ReelReview.reel_id.label("lrr_reel_id"),
                func.max(ReelReview.review_id).label("lrr_review_id"),
            )
            .filter(ReelReview.reel_id.isnot(None))
            .group_by(ReelReview.reel_id)
            .subquery()
        )

        base_query = (
            base_query.outerjoin(
                latest_review_subq,
                Reel.reel_id == latest_review_subq.c.lrr_reel_id,
            )
            .outerjoin(
                ReelReview,
                ReelReview.review_id == latest_review_subq.c.lrr_review_id,
            )
        )

        if status_filter == "pass":
            base_query = base_query.filter(
                ReelReview.decision.collate(REVIEW_DECISION_COLLATION)
                == literal("pass").collate(REVIEW_DECISION_COLLATION)
            )
        elif status_filter == "fail":
            base_query = base_query.filter(
                ReelReview.decision.collate(REVIEW_DECISION_COLLATION)
                == literal("fail").collate(REVIEW_DECISION_COLLATION)
            )
        elif status_filter == "uninspected":
            base_query = base_query.filter(latest_review_subq.c.lrr_review_id.is_(None))

        all_reel_rows = (
            base_query.with_entities(
                Reel.reel_id,
                Reel.reel_code,
                Reel.job_name,
                Reel.order_number,
                Reel.time_start,
                Reel.time_end,
                Reel.reel_start,
                Reel.reel_end,
                Reel.format_length,
                Reel.format_width,
                Reel.classification,
            )
            .order_by(Reel.time_start.desc(), Reel.reel_id.desc())
            .all()
        )
        total = base_query.count()
        page_reels = (
            base_query.order_by(Reel.time_start.desc())
            .offset((page - 1) * page_size)
            .limit(page_size)
            .all()
        )

        qualifying_reel_ids = [row.reel_id for row in all_reel_rows if getattr(row, "reel_id", None) is not None]
        page_reel_ids = [reel.reel_id for reel in page_reels if reel and reel.reel_id is not None]
        job_order_keys: Set[Tuple[str, str]] = {
            _job_explorer_key(getattr(row, "job_name", None), getattr(row, "order_number", None))
            for row in all_reel_rows
        }
        baseline_ids = _job_explorer_baseline_ids(session, filters, job_order_keys)

        needed_sensitivity_reel_ids = set(qualifying_reel_ids) | set(baseline_ids.values())
        sensitivity_rows = (
            session.query(SensitivitySet)
            .filter(SensitivitySet.reel_id.in_(needed_sensitivity_reel_ids))
            .all()
            if needed_sensitivity_reel_ids
            else []
        )
        standard_maps = _job_explorer_standard_maps(sensitivity_rows)
        sens_changes_by_reel, sensitivity_class_counter = _job_explorer_sensitivity_changes(
            all_reel_rows,
            standard_maps,
            baseline_ids,
        )

        inspection_phase_rows = (
            session.query(InspectionPhase)
            .filter(InspectionPhase.reel_id.in_(qualifying_reel_ids))
            .all()
            if qualifying_reel_ids
            else []
        )
        inspection_seconds_by_reel = _job_explorer_phase_seconds_by_reel(
            inspection_phase_rows,
            filters["start"],
            filters["end"],
        )
        inspection_pct_by_reel = {
            reel_id: _job_explorer_phase_pct(seconds)
            for reel_id, seconds in inspection_seconds_by_reel.items()
        }

        rlm_phase_rows = (
            session.query(RLMPhase)
            .filter(RLMPhase.reel_id.in_(qualifying_reel_ids))
            .all()
            if qualifying_reel_ids
            else []
        )
        rlm_seconds_by_reel = _job_explorer_phase_seconds_by_reel(
            rlm_phase_rows,
            filters["start"],
            filters["end"],
        )
        rlm_pct_by_reel = {
            reel_id: _job_explorer_phase_pct(seconds)
            for reel_id, seconds in rlm_seconds_by_reel.items()
        }

        monitor_count_rows = (
            session.query(
                RLMMonitoring.reel_id,
                func.count(RLMMonitoring.monitor_id).label("monitor_count"),
            )
            .filter(RLMMonitoring.reel_id.in_(qualifying_reel_ids))
            .filter(RLMMonitoring.timestamp >= filters["start"])
            .filter(RLMMonitoring.timestamp <= filters["end"])
            .group_by(RLMMonitoring.reel_id)
            .all()
            if qualifying_reel_ids
            else []
        )
        rlm_monitor_counts = {
            row.reel_id: int(row.monitor_count or 0)
            for row in monitor_count_rows
            if getattr(row, "reel_id", None) is not None
        }

        reference_count_rows = (
            session.query(
                ReferenceImage.reel_id,
                func.count(ReferenceImage.ref_image_id).label("ref_count"),
            )
            .filter(ReferenceImage.reel_id.in_(qualifying_reel_ids))
            .group_by(ReferenceImage.reel_id)
            .all()
            if qualifying_reel_ids
            else []
        )
        reference_counts = {
            row.reel_id: int(row.ref_count or 0)
            for row in reference_count_rows
            if getattr(row, "reel_id", None) is not None
        }

        page_reference_images_rows = (
            session.query(ReferenceImage)
            .filter(ReferenceImage.reel_id.in_(page_reel_ids))
            .order_by(ReferenceImage.reel_id.asc(), ReferenceImage.ref_image_id.asc())
            .all()
            if page_reel_ids
            else []
        )
        page_reference_images: Dict[int, List[Dict[str, object]]] = defaultdict(list)
        for image in page_reference_images_rows:
            reel_id = image.reel_id
            if reel_id is None or len(page_reference_images[reel_id]) >= 5:
                continue
            page_reference_images[reel_id].append(
                {
                    "filename": image.filename,
                    "image_src": (image.image_src or "").replace("\\", "/"),
                }
            )

        page_mask_rows = (
            session.query(Mask)
            .filter(Mask.reel_id.in_(page_reel_ids))
            .all()
            if page_reel_ids
            else []
        )
        masks_by_reel: Dict[int, List[Dict[str, object]]] = defaultdict(list)
        for mask in page_mask_rows:
            if mask.reel_id is not None:
                masks_by_reel[mask.reel_id].append(_serialize_mask_detail(mask))
        page_mask_counts = {
            reel_id: _active_mask_count(reel_masks)
            for reel_id, reel_masks in masks_by_reel.items()
        }

        defect_rows = (
            session.query(
                Defect.reel_id,
                func.count(Defect.defect_id).label("defect_count"),
                func.count(func.distinct(Defect.class_name)).label("defect_types"),
            )
            .filter(Defect.reel_id.in_(page_reel_ids))
            .filter(Defect.defect_time >= filters["start"])
            .filter(Defect.defect_time <= filters["end"])
            .group_by(Defect.reel_id)
            .all()
            if page_reel_ids
            else []
        )
        page_defect_summary = {
            row.reel_id: {
                "defect_count": int(row.defect_count or 0),
                "defect_types": int(row.defect_types or 0),
            }
            for row in defect_rows
            if getattr(row, "reel_id", None) is not None
        }
        filtered_defect_rows = (
            session.query(
                Defect.reel_id,
                func.count(Defect.defect_id).label("defect_count"),
            )
            .filter(Defect.reel_id.in_(qualifying_reel_ids))
            .filter(Defect.defect_time >= filters["start"])
            .filter(Defect.defect_time <= filters["end"])
            .group_by(Defect.reel_id)
            .all()
            if qualifying_reel_ids
            else []
        )
        filtered_defect_counts = {
            row.reel_id: int(row.defect_count or 0)
            for row in filtered_defect_rows
            if getattr(row, "reel_id", None) is not None
        }
        total_filtered_defects = sum(filtered_defect_counts.values())

        config_needed_ids = set(page_reel_ids)
        for reel in page_reels:
            key = _job_explorer_key(reel.job_name, reel.order_number)
            baseline_id = baseline_ids.get(key)
            if baseline_id is not None:
                config_needed_ids.add(baseline_id)
        config_rows = (
            session.query(RLMConfig)
            .filter(RLMConfig.reel_id.in_(config_needed_ids))
            .all()
            if config_needed_ids
            else []
        )
        config_map = {
            row.reel_id: row.config_json
            for row in config_rows
            if row.reel_id is not None
        }

        config_enabled_ids = set(config_map.keys())
        rlm_phase_enabled_ids = set(rlm_seconds_by_reel.keys())
        rlm_enabled_ids = config_enabled_ids | rlm_phase_enabled_ids

        reel_id_to_review = _job_explorer_latest_reviews(session, page_reel_ids)
        items: List[Dict[str, object]] = []

        for reel in page_reels:
            reel_id = reel.reel_id
            key = _job_explorer_key(reel.job_name, reel.order_number)
            reel_meters = 0.0
            if reel.reel_start is not None and reel.reel_end is not None:
                start_val = _to_float(reel.reel_start) or 0.0
                end_val = _to_float(reel.reel_end) or 0.0
                reel_meters = max(end_val - start_val, 0.0)

            ref_image_count = reference_counts.get(reel_id, 0)
            ref_change_count = max(ref_image_count - 1, 0)
            sens_changes = sens_changes_by_reel.get(reel_id, [])

            rlm_phase_pct = rlm_pct_by_reel.get(reel_id, {})
            rlm_active_pct = rlm_phase_pct.get("active", 0.0) if rlm_phase_pct else 0.0
            rlm_monitor_count = rlm_monitor_counts.get(reel_id, 0)
            rlm_enabled = reel_id in rlm_enabled_ids

            baseline_reel_id = baseline_ids.get(key)
            baseline_config_flat = _flatten_config(config_map.get(baseline_reel_id)) if baseline_reel_id is not None else {}
            current_config_flat = _flatten_config(config_map.get(reel_id))
            rlm_drift = []
            for key in sorted(set(current_config_flat) | set(baseline_config_flat)):
                baseline_val = baseline_config_flat.get(key)
                current_val = current_config_flat.get(key)
                if baseline_val is None or current_val is None:
                    continue
                if abs(current_val - baseline_val) > 1e-6:
                    rlm_drift.append(
                        {
                            "key": key,
                            "old": round(baseline_val, 3),
                            "new": round(current_val, 3),
                        }
                    )

            phase_mix_pct = inspection_pct_by_reel.get(reel_id, {})
            active_inspection_pct = phase_mix_pct.get("active", 0.0) if phase_mix_pct else 0.0

            defect_summary = page_defect_summary.get(reel_id, {})
            latest_review_obj = reel_id_to_review.get(reel_id)
            serialized_review = _serialize_review(latest_review_obj)
            if serialized_review:
                decision_value = (serialized_review.get("decision") or "").lower()
                review_status = "pass" if decision_value == "pass" else "fail"
            else:
                review_status = "uninspected"

            item = {
                "reel_id": reel.reel_id,
                "reel_code": reel.reel_code,
                "job_name": reel.job_name,
                "classification": _normalize_classification(reel.classification) or "active",
                "order_number": reel.order_number,
                "time_start": _iso(reel.time_start),
                "time_end": _iso(reel.time_end),
                "meters": round(reel_meters, 2),
                "format_length": _to_float(reel.format_length),
                "format_width": _to_float(reel.format_width),
                "ref_images": page_reference_images.get(reel_id, []),
                "ref_change_count": ref_change_count,
                "ref_change_times": [],
                "sens_standard_changed": bool(sens_changes),
                "sens_changed_classes": sens_changes,
                "mask_count": page_mask_counts.get(reel_id, 0),
                "rlm_enabled": rlm_enabled,
                "rlm_active_pct": rlm_active_pct,
                "rlm_monitor_count": rlm_monitor_count,
                "rlm_config_drift": rlm_drift,
                "defect_count": int(defect_summary.get("defect_count", 0)),
                "defect_types": int(defect_summary.get("defect_types", 0)),
                "phase_mix_pct": phase_mix_pct,
                "active_inspection_pct": active_inspection_pct,
                "review": serialized_review,
                "review_status": review_status,
            }
            items.append(item)

        qualifying_count = len(all_reel_rows)
        average_defects_per_reel = (
            total_filtered_defects / qualifying_count if qualifying_count else 0.0
        )
        reels_below_average = sum(
            1
            for reel_id in qualifying_reel_ids
            if filtered_defect_counts.get(reel_id, 0) < average_defects_per_reel
        )
        reels_above_average = sum(
            1
            for reel_id in qualifying_reel_ids
            if filtered_defect_counts.get(reel_id, 0) > average_defects_per_reel
        )
        bst_active_count = 0
        rlm_active_count = 0
        reels_with_reference_changes = 0
        reels_with_sensitivity_changes = 0

        for row in all_reel_rows:
            reel_id = row.reel_id
            if reel_id is None:
                continue
            inspection_pct = inspection_pct_by_reel.get(reel_id, {})
            active_pct = inspection_pct.get("active", 0.0) if inspection_pct else 0.0
            if active_pct > 1.0:
                bst_active_count += 1

            rlm_pct = rlm_pct_by_reel.get(reel_id, {})
            rlm_active_pct = rlm_pct.get("active", 0.0) if rlm_pct else 0.0
            rlm_monitor_count = rlm_monitor_counts.get(reel_id, 0)
            rlm_enabled = reel_id in rlm_enabled_ids
            if rlm_enabled and (rlm_active_pct > 0 or rlm_monitor_count > 0):
                rlm_active_count += 1

            ref_change_count = max(reference_counts.get(reel_id, 0) - 1, 0)
            if ref_change_count > 0:
                reels_with_reference_changes += 1

            sens_changes = sens_changes_by_reel.get(reel_id, [])
            changed_classes = len(sens_changes)
            if changed_classes > 0:
                reels_with_sensitivity_changes += 1

        def _pct(part: int, whole: int) -> float:
            return round((part / whole * 100.0), 1) if whole else 0.0

        insights = {
            "qualifying_reel_count": qualifying_count,
            "min_reel_length": filters.get("min_reel_length") or 0.0,
            "defect_summary": {
                "total_defects": int(total_filtered_defects),
                "average_per_reel": round(average_defects_per_reel, 2),
                "reels_below_average": reels_below_average,
                "reels_above_average": reels_above_average,
            },
            "bst_coverage": {
                "qualifying_reel_count": qualifying_count,
                "active_count": bst_active_count,
                "inactive_count": max(qualifying_count - bst_active_count, 0),
                "active_pct": _pct(bst_active_count, qualifying_count),
                "inactive_pct": _pct(max(qualifying_count - bst_active_count, 0), qualifying_count),
                "subtitle": "More than 1% active inspection across qualifying reels.",
            },
            "rlm_coverage": {
                "qualifying_reel_count": qualifying_count,
                "active_count": rlm_active_count,
                "inactive_count": max(qualifying_count - rlm_active_count, 0),
                "active_pct": _pct(rlm_active_count, qualifying_count),
                "inactive_pct": _pct(max(qualifying_count - rlm_active_count, 0), qualifying_count),
                "subtitle": "RLM enabled and active via phase time or monitor points.",
            },
            "reference_summary": {
                "qualifying_reel_count": qualifying_count,
                "reels_with_reference_changes": reels_with_reference_changes,
                "reels_without_reference_changes": max(qualifying_count - reels_with_reference_changes, 0),
                "pct_with_changes": _pct(reels_with_reference_changes, qualifying_count),
                "pct_without_changes": _pct(
                    max(qualifying_count - reels_with_reference_changes, 0), qualifying_count
                ),
            },
            "sensitivity_summary": {
                "qualifying_reel_count": qualifying_count,
                "reels_with_sensitivity_changes": reels_with_sensitivity_changes,
                "reels_with_same_sensitivity": max(qualifying_count - reels_with_sensitivity_changes, 0),
                "pct_changed": _pct(reels_with_sensitivity_changes, qualifying_count),
                "pct_same": _pct(
                    max(qualifying_count - reels_with_sensitivity_changes, 0), qualifying_count
                ),
            },
        }

        total_pages = (total + page_size - 1) // page_size if total else 1
        return jsonify(
            {
                "items": items,
                "insights": insights,
                "total": total,
                "page_info": {
                    "page": page,
                    "page_size": page_size,
                    "total": total,
                    "total_pages": total_pages or 1,
                },
            }
        )


@dashboard_bp.route("/api/reference-check")
def api_reference_check():
    with SessionLocal() as session:
        try:
            filters = _validate_filters(session)
        except ValueError as exc:
            return jsonify({"error": str(exc)}), 400

        requested_job = (filters.get("job") or "").strip()
        resolved_job = _resolve_reference_check_job(session, filters)
        if not resolved_job:
            return jsonify(
                {
                    "resolved_job": None,
                    "requested_job": requested_job or None,
                    "auto_selected_job": False,
                    "job_context": None,
                    "gallery": [],
                    "baseline": None,
                    "summary": None,
                    "comparisons": [],
                    "trend": [],
                    "insights": {
                        "first_major_change_point": None,
                        "lowest_match_references": [],
                        "stable_streaks": {"longest_strong_match_streak": 0},
                        "unstable_periods": [],
                        "defect_association": {
                            "low_match_reference_count": 0,
                            "strong_match_reference_count": 0,
                            "avg_defects_low_match": None,
                            "avg_defects_strong_match": None,
                            "interpretation": "No job found in the current machine or window",
                        },
                    },
                    "thresholds": {
                        "strong_match_min": REFERENCE_CHECK_STRONG_THRESHOLD,
                        "minor_variation_min": REFERENCE_CHECK_MINOR_THRESHOLD,
                        "noticeable_variation_min": REFERENCE_CHECK_CHANGE_THRESHOLD,
                    },
                }
            )

        normalized_filters = _reference_check_base_filters(filters)
        normalized_filters["job"] = resolved_job
        reels = (
            _apply_reel_filters(session.query(Reel), normalized_filters, include_reel_code=False)
            .filter(Reel.job_name == resolved_job)
            .options(
                joinedload(Reel.machine),
                selectinload(Reel.reference_images),
                selectinload(Reel.inspection_phases),
            )
            .order_by(Reel.time_start.asc(), Reel.reel_id.asc())
            .all()
        )

        reel_ids = [reel.reel_id for reel in reels if reel.reel_id is not None]
        defect_counts: Dict[int, int] = {}
        top_defect_by_reel: Dict[int, Optional[str]] = {}
        top_defect_count_by_reel: Dict[int, int] = {}
        defect_breakdown_by_reel: Dict[int, Counter] = defaultdict(Counter)
        if reel_ids:
            defect_counts = {
                reel_id: int(count or 0)
                for reel_id, count in (
                    session.query(Defect.reel_id, func.count(Defect.defect_id))
                    .filter(Defect.reel_id.in_(reel_ids))
                    .group_by(Defect.reel_id)
                    .all()
                )
            }
            top_defect_rows = (
                session.query(
                    Defect.reel_id,
                    Defect.class_name,
                    func.count(Defect.defect_id).label("defect_count"),
                )
                .filter(Defect.reel_id.in_(reel_ids))
                .filter(Defect.class_name.isnot(None))
                .group_by(Defect.reel_id, Defect.class_name)
                .all()
            )
            for row in top_defect_rows:
                reel_id = getattr(row, "reel_id", None)
                class_name = getattr(row, "class_name", None)
                count = int(getattr(row, "defect_count", 0) or 0)
                if reel_id is None or not class_name:
                    continue
                canonical = _canonical_sensitivity_class(class_name) or _normalize_defect_label(class_name) or ""
                if canonical:
                    defect_breakdown_by_reel[reel_id][canonical] += count
                existing_count = int(top_defect_count_by_reel.get(reel_id, -1))
                if count > existing_count:
                    top_defect_by_reel[reel_id] = _driver_class_label(class_name)
                    top_defect_count_by_reel[reel_id] = count

        gallery: List[Dict[str, object]] = []
        for reel in reels:
            captured_at = _iso(reel.time_end or reel.time_start)
            total_feet = _reel_length_feet(reel)
            ordered_images = _ordered_reference_images(reel.reference_images)
            for image_index, image in enumerate(ordered_images, start=1):
                gallery.append(
                    {
                        "ref_image_id": image.ref_image_id,
                        "reel_id": reel.reel_id,
                        "reel_code": reel.reel_code,
                        "job_name": reel.job_name,
                        "order_number": reel.order_number,
                        "machine_name": reel.machine.name if reel.machine else None,
                        "captured_at": captured_at,
                        "total_feet": total_feet,
                        "image_src": (image.image_src or "").replace("\\", "/"),
                        "filename": image.filename,
                        "reference_index": image_index,
                        "defect_count": int(defect_counts.get(reel.reel_id, 0)),
                        "top_defect_type": top_defect_by_reel.get(reel.reel_id),
                    }
                )

        gallery.sort(
            key=lambda row: (
                row.get("captured_at") or "",
                row.get("reel_code") or "",
                int(row.get("reference_index") or 0),
                int(row.get("ref_image_id") or 0),
            )
        )

        requested_baseline_id = request.args.get("baseline_ref_image_id", type=int)
        baseline_row = next(
            (row for row in gallery if row.get("ref_image_id") == requested_baseline_id),
            None,
        )
        baseline_payload = None
        comparison_rows: List[Dict[str, object]] = []
        reel_comparison_rows: List[Dict[str, object]] = []
        first_major_change_point = None
        lowest_match_references: List[Dict[str, object]] = []
        stable_streaks = {"longest_strong_match_streak": 0}
        unstable_periods: List[Dict[str, object]] = []
        defect_association = {
            "low_match_reference_count": 0,
            "strong_match_reference_count": 0,
            "avg_defects_low_match": None,
            "avg_defects_strong_match": None,
            "interpretation": "Select a baseline to compare the job",
        }
        summary = None

        if baseline_row:
            baseline_image_payload = _reference_check_image_payload(baseline_row.get("image_src"))
            baseline_payload = {**baseline_row, "is_baseline": True}
            enriched_gallery: List[Dict[str, object]] = []
            for row in gallery:
                comparison = dict(row)
                comparison["is_baseline"] = comparison.get("ref_image_id") == baseline_row.get("ref_image_id")
                if comparison["is_baseline"]:
                    comparison["overall_match_pct"] = 100.0
                    comparison["content_match_pct"] = 100.0
                    comparison["color_match_pct"] = 100.0
                    comparison["alignment_match_pct"] = 100.0
                    comparison["match_pct"] = 100.0
                    comparison["status_band"] = "Baseline"
                    comparison["status_key"] = "baseline"
                    comparison["likely_changed"] = False
                    comparison["change_group"] = None
                    comparison["likely_difference_type"] = "Strong match"
                    comparison["difference_reason_key"] = "baseline"
                    comparison["difference_explanation"] = "This reference is the active baseline for the selected job."
                else:
                    comparison_image_payload = _reference_check_image_payload(comparison.get("image_src"))
                    score_profile = _reference_check_difference_profile(baseline_image_payload, comparison_image_payload)
                    overall_match_pct = score_profile.get("overall_match_pct")
                    cluster = _reference_check_similarity_cluster(_to_float(overall_match_pct))
                    comparison.update(score_profile)
                    comparison["match_pct"] = overall_match_pct
                    comparison["status_band"] = _reference_check_status_band(_to_float(overall_match_pct))
                    comparison["status_key"] = _reference_check_status_key(_to_float(overall_match_pct))
                    comparison["similarity_cluster_key"] = cluster["key"]
                    comparison["similarity_cluster_label"] = cluster["label"]
                    comparison["likely_changed"] = bool(
                        overall_match_pct is not None and overall_match_pct < REFERENCE_CHECK_CHANGE_THRESHOLD
                    )
                    comparison["change_group"] = None
                    comparison_rows.append(comparison)
                if comparison["is_baseline"]:
                    comparison["similarity_cluster_key"] = "baseline"
                    comparison["similarity_cluster_label"] = "Baseline"
                enriched_gallery.append(comparison)
            gallery = enriched_gallery

            gallery_by_reel: Dict[int, List[Dict[str, object]]] = defaultdict(list)
            for row in comparison_rows:
                reel_id = row.get("reel_id")
                if reel_id is None:
                    continue
                gallery_by_reel[int(reel_id)].append(row)

            for reel in reels:
                reel_id = reel.reel_id
                if reel_id is None:
                    continue
                actual_images = sorted(
                    gallery_by_reel.get(reel_id, []),
                    key=lambda row: (
                        row.get("captured_at") or "",
                        int(row.get("reference_index") or 0),
                        int(row.get("ref_image_id") or 0),
                    ),
                )
                if not actual_images:
                    continue
                match_values_for_reel = [
                    _to_float(row.get("overall_match_pct"))
                    for row in actual_images
                    if _to_float(row.get("overall_match_pct")) is not None
                ]
                content_values_for_reel = [
                    _to_float(row.get("content_match_pct"))
                    for row in actual_images
                    if _to_float(row.get("content_match_pct")) is not None
                ]
                color_values_for_reel = [
                    _to_float(row.get("color_match_pct"))
                    for row in actual_images
                    if _to_float(row.get("color_match_pct")) is not None
                ]
                alignment_values_for_reel = [
                    _to_float(row.get("alignment_match_pct"))
                    for row in actual_images
                    if _to_float(row.get("alignment_match_pct")) is not None
                ]
                reason_counter: Counter[str] = Counter(str(row.get("difference_reason_key") or "unscored") for row in actual_images)
                dominant_reason_key = reason_counter.most_common(1)[0][0] if reason_counter else "unscored"
                dominant_reason_label = next(
                    (
                        str(row.get("likely_difference_type") or "Unscored")
                        for row in actual_images
                        if str(row.get("difference_reason_key") or "unscored") == dominant_reason_key
                    ),
                    "Unscored",
                )
                dominant_explanation = next(
                    (
                        str(row.get("difference_explanation") or "")
                        for row in actual_images
                        if str(row.get("difference_reason_key") or "unscored") == dominant_reason_key
                    ),
                    "",
                )
                total_feet = _reel_length_feet(reel)
                bst_active_pct = 0.0
                phase_intervals = reel.inspection_phases or []
                if phase_intervals:
                    total_phase_seconds = 0.0
                    active_seconds = 0.0
                    for phase in phase_intervals:
                        start_time = phase.start_time
                        end_time = phase.end_time
                        if not start_time or not end_time or end_time <= start_time:
                            continue
                        seconds = (end_time - start_time).total_seconds()
                        total_phase_seconds += seconds
                        if (phase.phase or "").strip().lower() == "active":
                            active_seconds += seconds
                    if total_phase_seconds > 0:
                        bst_active_pct = round((active_seconds / total_phase_seconds) * 100.0, 1)
                total_defects = int(defect_counts.get(reel_id, 0))
                defects_per_1000ft = _rate_per_1000ft(total_defects, total_feet)
                adjusted_defects_per_1000ft = _driver_adjusted_rate(total_defects, total_feet, bst_active_pct)
                reel_comparison_rows.append(
                    {
                        "reel_id": reel_id,
                        "reel_code": reel.reel_code,
                        "job_name": reel.job_name,
                        "order_number": reel.order_number,
                        "machine_name": reel.machine.name if reel.machine else None,
                        "captured_at": _iso(reel.time_end or reel.time_start),
                        "overall_match_pct": round(min(match_values_for_reel), 1) if match_values_for_reel else None,
                        "content_match_pct": _reference_check_average(content_values_for_reel),
                        "color_match_pct": _reference_check_average(color_values_for_reel),
                        "alignment_match_pct": _reference_check_average(alignment_values_for_reel),
                        "match_pct": round(min(match_values_for_reel), 1) if match_values_for_reel else None,
                        "likely_difference_type": dominant_reason_label,
                        "difference_reason_key": dominant_reason_key,
                        "difference_explanation": dominant_explanation,
                        "bst_active_pct": bst_active_pct,
                        "total_feet": total_feet,
                        "defect_count": total_defects,
                        "defects_per_1000ft": defects_per_1000ft,
                        "adjusted_defects_per_1000ft": adjusted_defects_per_1000ft,
                        "defect_breakdown": _reference_check_defect_type_payload(
                            defect_breakdown_by_reel.get(reel_id, Counter())
                        ),
                        "baseline_image": baseline_payload,
                        "actual_images": actual_images,
                    }
                )

            change_group = 0
            in_change_group = False
            for row in comparison_rows:
                if row.get("likely_changed"):
                    if not in_change_group:
                        change_group += 1
                        in_change_group = True
                    row["change_group"] = change_group
                else:
                    in_change_group = False

            match_values = [row.get("match_pct") for row in comparison_rows if row.get("match_pct") is not None]
            content_values = [
                row.get("content_match_pct") for row in comparison_rows if row.get("content_match_pct") is not None
            ]
            color_values = [
                row.get("color_match_pct") for row in comparison_rows if row.get("color_match_pct") is not None
            ]
            alignment_values = [
                row.get("alignment_match_pct")
                for row in comparison_rows
                if row.get("alignment_match_pct") is not None
            ]
            difference_summary = _reference_check_difference_type_summary(comparison_rows)
            first_major_change_point = next((row for row in comparison_rows if row.get("likely_changed")), None)
            lowest_match_references = sorted(
                [row for row in comparison_rows if row.get("match_pct") is not None],
                key=lambda row: (row.get("match_pct"), row.get("captured_at") or ""),
            )[:5]
            streak_data = _reference_check_streaks(comparison_rows)
            stable_streaks = {
                "longest_strong_match_streak": int(streak_data.get("longest_strong_match_streak") or 0)
            }
            unstable_periods = streak_data.get("unstable_periods") or []
            defect_association = _reference_check_defect_association(comparison_rows)
            cluster_summary = _reference_check_cluster_summary(comparison_rows)
            change_windows = _reference_check_change_windows(comparison_rows)
            largest_drop = None
            if match_values:
                sorted_by_time = sorted(
                    [row for row in comparison_rows if isinstance(row.get("match_pct"), (int, float))],
                    key=lambda row: row.get("captured_at") or "",
                )
                previous_row = None
                largest_delta = None
                for row in sorted_by_time:
                    if previous_row is not None:
                        delta = float(row["match_pct"]) - float(previous_row["match_pct"])
                        if largest_delta is None or delta < largest_delta:
                            largest_delta = delta
                            largest_drop = {
                                "from_reel_code": previous_row.get("reel_code"),
                                "to_reel_code": row.get("reel_code"),
                                "from_timestamp": previous_row.get("captured_at"),
                                "to_timestamp": row.get("captured_at"),
                                "delta_match_pct": round(delta, 1),
                            }
                    previous_row = row
            summary = {
                "compared_references": len(comparison_rows),
                "average_match_pct": _reference_check_average(match_values),
                "average_content_match_pct": _reference_check_average(content_values),
                "average_color_match_pct": _reference_check_average(color_values),
                "average_alignment_match_pct": _reference_check_average(alignment_values),
                "min_match_pct": round(min(match_values), 1) if match_values else None,
                "max_match_pct": round(max(match_values), 1) if match_values else None,
                "below_threshold_count": sum(1 for row in comparison_rows if row.get("likely_changed")),
                "likely_change_event_count": change_group,
                "difference_type_summary": difference_summary,
                "color_shift_count": sum(
                    1 for row in comparison_rows if row.get("difference_reason_key") in {"color_shift", "exposure_shift"}
                ),
                "content_change_count": sum(
                    1 for row in comparison_rows if row.get("difference_reason_key") in {"content_change", "major_change"}
                ),
                "alignment_shift_count": sum(
                    1 for row in comparison_rows if row.get("difference_reason_key") == "alignment_shift"
                ),
            }
        else:
            cluster_summary = {"clusters": [], "dominant_cluster": None}
            change_windows = []
            largest_drop = None
            reel_comparison_rows = []
            difference_summary = {"items": [], "dominant": None}

        job_context = {
            "job_name": resolved_job,
            "total_reels": len(reels),
            "total_references": len(gallery),
            "window_start": _iso(filters.get("start")),
            "window_end": _iso(filters.get("end")),
        }
        trend = [
            {
                "ref_image_id": row.get("ref_image_id"),
                "reel_code": row.get("reel_code"),
                "captured_at": row.get("captured_at"),
                "match_pct": row.get("match_pct"),
                "overall_match_pct": row.get("overall_match_pct"),
                "content_match_pct": row.get("content_match_pct"),
                "color_match_pct": row.get("color_match_pct"),
                "alignment_match_pct": row.get("alignment_match_pct"),
                "likely_difference_type": row.get("likely_difference_type"),
                "status_key": row.get("status_key"),
                "likely_changed": row.get("likely_changed"),
            }
            for row in comparison_rows
        ]
        trend.sort(
            key=lambda row: (
                row.get("captured_at") or "",
                row.get("reel_code") or "",
                int(row.get("ref_image_id") or 0),
            )
        )

        return jsonify(
            {
                "requested_job": requested_job or None,
                "resolved_job": resolved_job,
                "auto_selected_job": not requested_job and bool(resolved_job),
                "job_context": job_context,
                "gallery": gallery,
                "baseline": baseline_payload,
                "summary": summary,
                "comparisons": comparison_rows,
                "reel_comparisons": reel_comparison_rows,
                "defect_types": [
                    {"key": defect_type, "label": _driver_class_label(defect_type)}
                    for defect_type in DRIVER_DEFECT_CLASSES
                ],
                "trend": trend,
                "insights": {
                    "first_major_change_point": first_major_change_point,
                    "lowest_match_references": lowest_match_references,
                    "stable_streaks": stable_streaks,
                    "unstable_periods": unstable_periods,
                    "defect_association": defect_association,
                    "cluster_summary": cluster_summary,
                    "difference_type_summary": difference_summary,
                    "change_windows": change_windows,
                    "largest_match_drop": largest_drop,
                },
                "thresholds": {
                    "strong_match_min": REFERENCE_CHECK_STRONG_THRESHOLD,
                    "minor_variation_min": REFERENCE_CHECK_MINOR_THRESHOLD,
                    "noticeable_variation_min": REFERENCE_CHECK_CHANGE_THRESHOLD,
                },
            }
        )


@dashboard_bp.route("/api/reel/<int:reel_id>/summary")
def api_reel_summary(reel_id: int):
    with SessionLocal() as session:
        reel = (
            session.query(Reel)
            .filter(Reel.reel_id == reel_id)
            .options(
                joinedload(Reel.machine),
                selectinload(Reel.reference_images),
                selectinload(Reel.sensitivity_sets),
                selectinload(Reel.masks),
                selectinload(Reel.inspection_phases),
                selectinload(Reel.rlm_config),
                selectinload(Reel.rlm_phases),
                selectinload(Reel.defects),
            )
            .first()
        )
        if not reel:
            return jsonify({"error": "Reel not found"}), 404

        rlm_monitor_count = (
            session.query(func.count(RLMMonitoring.monitor_id))
            .filter(RLMMonitoring.reel_id == reel.reel_id)
            .scalar()
            or 0
        )

        reference_images = [
            {
                "filename": img.filename,
                "image_src": (img.image_src or "").replace("\\", "/"),
            }
            for img in _ordered_reference_images(reel.reference_images)
        ]

        sensitivities = [
            {
                "defect_class": row.defect_class,
                "threshold_value": _to_float(row.threshold_value),
                "warn_threshold": _to_float(row.warn_threshold),
            }
            for row in sorted(reel.sensitivity_sets or [], key=lambda x: x.defect_class or "")
            if row.set_name == "sId_mmx_stand"
        ]

        masks = [
            {
                "timestamp": _iso(mask.timestamp),
                "coords": mask.coords,
                "format_value": _to_float(mask.format_value),
                "xml_id": mask.xml_id,
                "sensitivitysetid": mask.sensitivitysetid,
                "noinspection": _mask_noinspection_enabled(mask.noinspection),
                "event": "applied" if _mask_noinspection_enabled(mask.noinspection) else "removed",
            }
            for mask in sorted(reel.masks or [], key=lambda x: x.timestamp or datetime.min)
        ]
        mask_snapshots = _mask_lifecycle_snapshots(masks, reel)

        inspection_phases = [
            {
                "phase": phase.phase,
                "start_time": _iso(phase.start_time),
                "end_time": _iso(phase.end_time),
                "start_format": _to_float(phase.start_format),
                "end_format": _to_float(phase.end_format),
                "refimgid": phase.refimgid,
            }
            for phase in sorted(reel.inspection_phases or [], key=lambda x: x.start_time or datetime.min)
        ]

        rlm_phases = [
            {
                "phase": phase.phase,
                "start_time": _iso(phase.start_time),
                "end_time": _iso(phase.end_time),
            }
            for phase in sorted(reel.rlm_phases or [], key=lambda x: x.start_time or datetime.min)
        ]

        defects_summary = {
            "total": len(reel.defects or []),
            "types": len({d.class_name for d in reel.defects or [] if d.class_name}),
            "by_class": [
                {"class": class_name, "count": count}
                for class_name, count in sorted(
                    Counter(
                        d.class_name for d in reel.defects or [] if d.class_name
                    ).items(),
                    key=lambda item: item[1],
                    reverse=True,
                )
            ],
        }

        defects_payload = [
            {
                "defect_id": defect.defect_id,
                "reel_id": reel.reel_id,
                "class_name": defect.class_name,
                "defect_time": _iso(defect.defect_time),
                "format_position": _to_float(defect.format_position),
                "magnitude_value": _to_float(defect.magnitude_value),
                "severity_value": _to_float(defect.severity_value),
                "coords": defect.coords_json or [],
                "defect_category": defect.defect_category,
                "severity_score": _normalize_int(defect.severity_score),
                "severity_confidence": _normalize_int(defect.severity_confidence),
                "severity_uncertain": bool(defect.severity_uncertain),
            }
            for defect in sorted(reel.defects or [], key=lambda x: x.defect_time or datetime.min)
        ]

        response = {
            "reel": {
                "reel_id": reel.reel_id,
                "reel_code": reel.reel_code,
                "machine": reel.machine.name if reel.machine else None,
                "job_name": reel.job_name,
                "classification": _normalize_classification(reel.classification) or "active",
                "order_number": reel.order_number,
                "time_start": _iso(reel.time_start),
                "time_end": _iso(reel.time_end),
                "reel_start": _to_float(reel.reel_start),
                "reel_end": _to_float(reel.reel_end),
                "format_length": _to_float(reel.format_length),
                "format_width": _to_float(reel.format_width),
            },
            "reference_images": reference_images,
            "sensitivities": sensitivities,
            "masks": masks,
            "mask_snapshots": mask_snapshots,
            "inspection_phases": inspection_phases,
            "rlm": {
                "config": reel.rlm_config.config_json if reel.rlm_config else None,
                "phases": rlm_phases,
                "monitor_count": int(rlm_monitor_count),
                "points": _extract_monpoints(reel.rlm_config.config_json) if reel.rlm_config else [],
                "tolerances": _extract_tolerances(reel.rlm_config.config_json) if reel.rlm_config else None,
            },
            "defects_summary": defects_summary,
            "defects": defects_payload,
        }
        latest_review = (
            session.query(ReelReview)
            .filter(ReelReview.reel_id == reel.reel_id)
            .order_by(ReelReview.created_at.desc(), ReelReview.review_id.desc())
            .first()
        )
        response["review"] = _serialize_review(latest_review)
        return jsonify(response)


@dashboard_bp.route("/api/reel/<int:reel_id>/classification", methods=["POST"])
def api_reel_classification(reel_id: int):
    payload = request.get_json(silent=True) or {}
    requested_classification = _normalize_classification(payload.get("classification"))
    if not requested_classification:
        return (
            jsonify(
                {
                    "error": "Invalid classification",
                    "allowed": sorted(VALID_REEL_CLASSIFICATIONS),
                }
            ),
            400,
        )

    with SessionLocal() as session:
        reel = session.query(Reel).filter(Reel.reel_id == reel_id).first()
        if not reel:
            return jsonify({"error": "Reel not found"}), 404
        reel.classification = requested_classification
        session.add(reel)
        session.commit()
        return jsonify({"reel_id": reel.reel_id, "classification": requested_classification})


@dashboard_bp.route("/api/reel/<int:reel_id>/review", methods=["GET", "POST"])
def api_reel_review(reel_id: int):
    with SessionLocal() as session:
        reel = session.query(Reel).filter(Reel.reel_id == reel_id).first()
        if not reel:
            return jsonify({"error": "Reel not found"}), 404
        if not reel.reel_code:
            return jsonify({"error": "Reel has no reel_code"}), 400

        if request.method == "GET":
            reviews = (
                session.query(ReelReview)
                .filter(ReelReview.reel_id == reel.reel_id)
                .order_by(ReelReview.created_at.desc(), ReelReview.review_id.desc())
                .all()
            )
            serialized = [_serialize_review(review) for review in reviews if review]
            latest = serialized[0] if serialized else None
            return jsonify({"latest": latest, "history": serialized})

        payload = request.get_json(silent=True) or {}
        decision = (payload.get("decision") or "").strip().lower()
        reviewer_name = (
            payload.get("reviewer_name")
            or payload.get("reviewer_id")
            or ""
        ).strip()
        if decision not in {"pass", "fail"}:
            return jsonify({"error": "Decision must be 'pass' or 'fail'."}), 400
        if not reviewer_name:
            return jsonify({"error": "Reviewer name is required."}), 400
        comments = (payload.get("comments") or "").strip()
        extra_data = payload.get("extra_data")
        if extra_data is not None and not isinstance(extra_data, dict):
            return jsonify({"error": "extra_data must be an object if provided."}), 400

        review = ReelReview(
            reel_id=reel.reel_id,
            reel_code=reel.reel_code,
            decision=decision,
            reviewer_id=reviewer_name,
            comments=comments or None,
            extra_data=extra_data or None,
        )
        session.add(review)
        session.commit()
        session.refresh(review)
        return jsonify({"review": _serialize_review(review)})


def _build_defect_query(
    session: Session,
    filters: Dict[str, Optional[str]],
    class_names: List[str],
    numeric_filters: Dict[str, Optional[float]],
    phase_filter: Optional[str],
):
    query = session.query(Defect).join(Reel, Defect.reel_id == Reel.reel_id)
    query = _apply_reel_filters(query, filters)
    start = filters.get("start")
    end = filters.get("end")
    if start:
        query = query.filter(or_(Defect.defect_time.is_(None), Defect.defect_time >= start))
    if end:
        query = query.filter(or_(Defect.defect_time.is_(None), Defect.defect_time <= end))

    if class_names:
        query = query.filter(Defect.class_name.in_(class_names))

    if numeric_filters["magnitude_min"] is not None:
        query = query.filter(Defect.magnitude_value >= numeric_filters["magnitude_min"])
    if numeric_filters["magnitude_max"] is not None:
        query = query.filter(Defect.magnitude_value <= numeric_filters["magnitude_max"])
    if numeric_filters["severity_min"] is not None:
        query = query.filter(Defect.severity_value >= numeric_filters["severity_min"])
    if numeric_filters["severity_max"] is not None:
        query = query.filter(Defect.severity_value <= numeric_filters["severity_max"])
    if numeric_filters["position_min"] is not None:
        query = query.filter(Defect.format_position >= numeric_filters["position_min"])
    if numeric_filters["position_max"] is not None:
        query = query.filter(Defect.format_position <= numeric_filters["position_max"])

    if phase_filter:
        phase_exists = (
            session.query(InspectionPhase.phase)
            .filter(InspectionPhase.reel_id == Defect.reel_id)
            .filter(InspectionPhase.phase == phase_filter)
            .filter(InspectionPhase.start_time <= Defect.defect_time)
            .filter(or_(InspectionPhase.end_time.is_(None), InspectionPhase.end_time >= Defect.defect_time))
            .exists()
        )
        query = query.filter(phase_exists)

    return query


def _defect_trends_parse_window(source: Optional[Dict[str, object]] = None) -> Tuple[datetime, datetime]:
    raw_start = ""
    raw_end = ""
    if isinstance(source, dict):
        raw_start = str(source.get("start") or "").strip()
        raw_end = str(source.get("end") or "").strip()
    else:
        raw_start = str(request.args.get("start") or "").strip()
        raw_end = str(request.args.get("end") or "").strip()
    start = _parse_datetime(raw_start)
    end = _parse_datetime(raw_end)
    if not (start and end and start < end):
        return _default_window()
    return start, end


def _defect_trends_source_get(source: object, key: str) -> Optional[object]:
    if source is None:
        return None
    if hasattr(source, "getlist"):
        values = source.getlist(key)
        if values:
            return values[0]
    if hasattr(source, "get"):
        try:
            return source.get(key)
        except TypeError:
            pass
    if isinstance(source, dict):
        return source.get(key)
    return None


def _defect_trends_source_list(source: object, key: str) -> List[object]:
    values: List[object] = []
    if source is None:
        return values
    if hasattr(source, "getlist"):
        values.extend(source.getlist(key) or [])
    elif isinstance(source, dict):
        raw_value = source.get(key)
        if isinstance(raw_value, (list, tuple)):
            values.extend(list(raw_value))
        elif raw_value is not None:
            values.append(raw_value)
    else:
        raw_value = _defect_trends_source_get(source, key)
        if raw_value is not None:
            values.append(raw_value)
    if len(values) == 1 and isinstance(values[0], str) and "," in values[0]:
        return [value.strip() for value in values[0].split(",") if value.strip()]
    return values


def _defect_trends_parse_filters(
    source: Optional[object] = None,
    session: Optional[Session] = None,
) -> Dict[str, Any]:
    raw_source = source if source is not None else request.args
    window_start, window_end = _defect_trends_parse_window(raw_source if isinstance(raw_source, dict) else None)
    machine_id = _normalize_int(_defect_trends_source_get(raw_source, "machine_id"))
    if not machine_id and session is not None:
        first_machine = session.query(Machine).order_by(Machine.machine_id.asc()).first()
        if first_machine:
            machine_id = first_machine.machine_id
    if not machine_id:
        raise ValueError("machine_id is required")

    order_arg = _defect_trends_source_get(raw_source, "order")
    if order_arg == SENTINEL_NONE:
        order_value = SENTINEL_NONE
    elif order_arg:
        order_value = order_arg
    else:
        order_value = None

    reel_codes = [str(code).strip() for code in _defect_trends_source_list(raw_source, "reel_code") if str(code).strip()]
    if not reel_codes:
        reel_code = _defect_trends_source_get(raw_source, "reel_code")
        if reel_code:
            reel_codes = [str(reel_code).strip()]
    reel_ids: List[int] = []
    for raw_id in _defect_trends_source_list(raw_source, "reel_id"):
        parsed_id = _normalize_int(raw_id)
        if parsed_id is not None and parsed_id not in reel_ids:
            reel_ids.append(parsed_id)

    return {
        "machine_id": machine_id,
        "start": window_start,
        "end": window_end,
        "job": _defect_trends_source_get(raw_source, "job") or None,
        "order": order_value,
        "reel_code": reel_codes[0] if reel_codes else None,
        "reel_codes": reel_codes,
        "reel_ids": reel_ids,
    }


def _defect_trends_parse_min_feet(value: Optional[object]) -> Optional[float]:
    try:
        parsed = float(value) if value not in {None, ""} else None
    except (TypeError, ValueError):
        return None
    if parsed is None or parsed <= 0:
        return None
    return parsed


def _defect_trends_reel_feet_expr():
    start_expr = func.coalesce(Reel.reel_start, 0.0)
    end_expr = func.coalesce(Reel.reel_end, 0.0)
    format_length_expr = func.coalesce(Reel.format_length, 0.0)
    return ((end_expr - start_expr) * format_length_expr) / MM_PER_FOOT


def _defect_trends_job_key(job_name: Optional[str], order_number: Optional[str]) -> Optional[str]:
    cleaned_job = str(job_name or "").strip()
    if not cleaned_job:
        return None
    cleaned_order = str(order_number or "").strip()
    return f"{cleaned_job}|||{cleaned_order}"


def _defect_trends_parse_job_key(value: Optional[str]) -> Optional[Tuple[str, Optional[str]]]:
    cleaned = str(value or "").strip()
    if not cleaned:
        return None
    if "|||" not in cleaned:
        return cleaned, None
    job_name, order_number = cleaned.split("|||", 1)
    job_name = job_name.strip()
    order_number = order_number.strip()
    if not job_name:
        return None
    return job_name, order_number or None


def _defect_trends_format_job_label(job_name: Optional[str], order_number: Optional[str]) -> str:
    cleaned_job = str(job_name or "").strip() or "Unknown Job"
    cleaned_order = str(order_number or "").strip()
    return f"{cleaned_job} - {cleaned_order}" if cleaned_order else cleaned_job


def _normalize_defect_trend_selections(payload: object) -> List[Dict[str, object]]:
    raw_items = payload.get("selections") if isinstance(payload, dict) else []
    if not isinstance(raw_items, list):
        raw_items = []
    selections: List[Dict[str, object]] = []
    seen_machine_ids: Set[int] = set()
    for item in raw_items:
        if not isinstance(item, dict):
            continue
        try:
            machine_id = int(item.get("machineId"))
        except (TypeError, ValueError):
            continue
        if machine_id in seen_machine_ids:
            continue
        job_pairs: List[Tuple[str, Optional[str]]] = []
        for raw_key in item.get("jobKeys") or []:
            parsed = _defect_trends_parse_job_key(raw_key)
            if parsed and parsed not in job_pairs:
                job_pairs.append(parsed)
        selections.append(
            {
                "machine_id": machine_id,
                "enabled": item.get("enabled") is not False,
                "job_pairs": job_pairs,
            }
        )
        seen_machine_ids.add(machine_id)
    return selections


def _defect_trends_selection_clause(selections: List[Dict[str, object]]):
    enabled = [selection for selection in selections if selection.get("enabled") is not False]
    if not enabled:
        return None
    machine_clauses = []
    for selection in enabled:
        clauses = [Reel.machine_id == selection["machine_id"]]
        job_pairs = selection.get("job_pairs") or []
        if job_pairs:
            job_clauses = []
            for job_name, order_number in job_pairs:
                if order_number:
                    job_clauses.append(and_(Reel.job_name == job_name, Reel.order_number == order_number))
                else:
                    job_clauses.append(
                        and_(
                            Reel.job_name == job_name,
                            or_(Reel.order_number.is_(None), Reel.order_number == ""),
                        )
                    )
            clauses.append(or_(*job_clauses))
        machine_clauses.append(and_(*clauses))
    return or_(*machine_clauses) if machine_clauses else None


def _build_defect_trend_options(
    session: Session,
    start: datetime,
    end: datetime,
    min_feet: Optional[float] = None,
    filters: Optional[Dict[str, Any]] = None,
):
    defect_reels_subq = (
        session.query(
            Defect.reel_id.label("reel_id"),
            func.max(Defect.defect_time).label("latest_defect_time"),
            func.count(Defect.defect_id).label("defect_count"),
        )
        .filter(Defect.defect_time >= start)
        .filter(Defect.defect_time <= end)
        .group_by(Defect.reel_id)
        .subquery()
    )

    query = (
        session.query(
            Reel.machine_id.label("machine_id"),
            Machine.name.label("machine_name"),
            Reel.job_name.label("job_name"),
            Reel.order_number.label("order_number"),
            func.max(defect_reels_subq.c.latest_defect_time).label("latest_defect_time"),
            func.count(func.distinct(Reel.reel_id)).label("reel_count"),
            func.sum(defect_reels_subq.c.defect_count).label("defect_count"),
        )
        .join(defect_reels_subq, Reel.reel_id == defect_reels_subq.c.reel_id)
        .join(Machine, Reel.machine_id == Machine.machine_id)
        .filter(Reel.time_start <= end)
        .filter(Reel.time_end >= start)
    )
    if filters:
        query = _apply_reel_filters(query, filters)
    if min_feet is not None:
        query = query.filter(_defect_trends_reel_feet_expr() >= min_feet)
    rows = (
        query.group_by(Reel.machine_id, Machine.name, Reel.job_name, Reel.order_number)
        .order_by(Machine.name.asc(), text("latest_defect_time DESC"))
        .all()
    )

    machines_by_id: Dict[int, Dict[str, object]] = {}
    for row in rows:
        machine_id = getattr(row, "machine_id", None)
        if machine_id is None:
            continue
        entry = machines_by_id.setdefault(
            machine_id,
            {
                "machineId": machine_id,
                "machineName": getattr(row, "machine_name", None) or f"Press {machine_id}",
                "reelCount": 0,
                "defectCount": 0,
                "latestTime": None,
                "jobOptions": [],
            },
        )
        reel_count = int(getattr(row, "reel_count", 0) or 0)
        defect_count = int(getattr(row, "defect_count", 0) or 0)
        latest_dt = getattr(row, "latest_defect_time", None)
        entry["reelCount"] += reel_count
        entry["defectCount"] += defect_count
        if latest_dt and (entry["latestTime"] is None or latest_dt > datetime.fromisoformat(entry["latestTime"])):
            entry["latestTime"] = _iso(latest_dt)
        job_key = _defect_trends_job_key(getattr(row, "job_name", None), getattr(row, "order_number", None))
        if not job_key:
            continue
        entry["jobOptions"].append(
            {
                "value": job_key,
                "label": _defect_trends_format_job_label(getattr(row, "job_name", None), getattr(row, "order_number", None)),
                "jobName": getattr(row, "job_name", None),
                "orderNumber": getattr(row, "order_number", None),
                "reelCount": reel_count,
                "defectCount": defect_count,
                "latestTime": _iso(latest_dt),
            }
        )

    machine_rows = sorted(
        machines_by_id.values(),
        key=lambda item: (
            _machine_sort_key(item.get("machineName")),
            (item.get("machineName") or "").lower(),
        ),
    )
    return {"machines": machine_rows}


def _machine_sort_key(name: Optional[str]) -> Tuple[int, str]:
    label = str(name or "").strip().lower()
    digits = "".join(ch for ch in label if ch.isdigit())
    if digits:
        try:
            return int(digits), label
        except ValueError:
            pass
    return 10_000, label


def _nearest_monitoring_sample(
    samples: List[Dict[str, object]],
    timestamps: List[datetime],
    target_ts: Optional[datetime],
) -> Optional[Dict[str, object]]:
    if not samples or not timestamps or target_ts is None:
        return None
    index = bisect_left(timestamps, target_ts)
    if index <= 0:
        return samples[0]
    if index >= len(samples):
        return samples[-1]
    before = samples[index - 1]
    after = samples[index]
    before_ts = timestamps[index - 1]
    after_ts = timestamps[index]
    if abs((target_ts - before_ts).total_seconds()) <= abs((after_ts - target_ts).total_seconds()):
        return before
    return after


DEFECT_PATTERN_HEATMAP_BUCKETS: List[Dict[str, object]] = [
    {"key": "beginning", "label": "Beginning", "min": 0.0, "max": 0.2},
    {"key": "early_mid", "label": "Early Mid", "min": 0.2, "max": 0.4},
    {"key": "middle", "label": "Middle", "min": 0.4, "max": 0.6},
    {"key": "late_mid", "label": "Late Mid", "min": 0.6, "max": 0.8},
    {"key": "end", "label": "End", "min": 0.8, "max": 1.000001},
]

DEFECT_PATTERN_TREND_BUCKETS: List[Dict[str, object]] = [
    {"key": "beginning", "label": "Beginning", "min": 0.0, "max": 1.0 / 3.0},
    {"key": "middle", "label": "Middle", "min": 1.0 / 3.0, "max": 2.0 / 3.0},
    {"key": "end", "label": "End", "min": 2.0 / 3.0, "max": 1.000001},
]

DEFECT_PATTERN_LOCATION_GRID = {"cols": 5, "rows": 5}


def _defect_pattern_class_key(value: Optional[str]) -> str:
    cleaned = " ".join(str(value or "").strip().lower().split())
    return cleaned or "unclassified"


def _defect_pattern_bucket_for_ratio(
    ratio: Optional[float], bucket_defs: List[Dict[str, object]]
) -> Optional[Dict[str, object]]:
    numeric = _to_float(ratio)
    if numeric is None:
        return None
    numeric = max(0.0, min(1.0, numeric))
    for entry in bucket_defs:
        lower = _to_float(entry.get("min"))
        upper = _to_float(entry.get("max"))
        if lower is None or upper is None:
            continue
        if numeric >= lower and numeric < upper:
            return entry
    return bucket_defs[-1] if bucket_defs else None


def _defect_pattern_position_ratio(reel: Reel, defect: Defect) -> Optional[float]:
    reel_start = _to_float(reel.reel_start)
    reel_end = _to_float(reel.reel_end)
    format_position = _to_float(defect.format_position)
    if (
        reel_start is not None
        and reel_end is not None
        and format_position is not None
        and reel_end > reel_start
    ):
        return max(0.0, min(1.0, (format_position - reel_start) / (reel_end - reel_start)))
    return None


def _polygon_area(xs: List[float], ys: List[float]) -> Optional[float]:
    count = min(len(xs), len(ys))
    if count < 3:
        return None
    total = 0.0
    for index in range(count):
        next_index = (index + 1) % count
        total += (xs[index] * ys[next_index]) - (xs[next_index] * ys[index])
    return abs(total) / 2.0


def _defect_pattern_preview_shapes(
    shapes: List[Dict[str, List[float]]],
    min_x: float,
    max_x: float,
    min_y: float,
    max_y: float,
    format_width: Optional[float],
    format_length: Optional[float],
) -> List[Dict[str, List[float]]]:
    width = max(max_x - min_x, 1e-6)
    height = max(max_y - min_y, 1e-6)
    usable_size = 76.0
    has_format_dims = (
        format_width is not None
        and format_length is not None
        and format_width > 0
        and format_length > 0
    )
    if has_format_dims:
        format_aspect = max(format_width, 1e-6) / max(format_length, 1e-6)
        if format_aspect >= 1.0:
            frame_width = usable_size
            frame_height = usable_size / format_aspect
        else:
            frame_height = usable_size
            frame_width = usable_size * format_aspect
        frame_x = (100.0 - frame_width) / 2.0
        frame_y = (100.0 - frame_height) / 2.0
        target_width = frame_width * max(0.0, min(1.0, width / max(format_width, 1e-6)))
        target_height = frame_height * max(0.0, min(1.0, height / max(format_length, 1e-6)))
        scale = min(target_width / width if width > 0 else 1.0, target_height / height if height > 0 else 1.0)
        scale = max(scale, 1e-6)
        offset_x = frame_x + ((frame_width - (width * scale)) / 2.0)
        offset_y = frame_y + ((frame_height - (height * scale)) / 2.0)
    else:
        frame_width = usable_size
        frame_height = usable_size
        frame_x = (100.0 - frame_width) / 2.0
        frame_y = (100.0 - frame_height) / 2.0
        scale = min(frame_width / width, frame_height / height)
        offset_x = frame_x + ((frame_width - (width * scale)) / 2.0)
        offset_y = frame_y + ((frame_height - (height * scale)) / 2.0)
    preview: List[Dict[str, List[float]]] = []
    for shape in shapes:
        xs = shape.get("x") or []
        ys = shape.get("y") or []
        count = min(len(xs), len(ys))
        if count < 3:
            continue
        normalized_x = [round(offset_x + ((xs[idx] - min_x) * scale), 2) for idx in range(count)]
        normalized_y = [round(100.0 - (offset_y + ((ys[idx] - min_y) * scale)), 2) for idx in range(count)]
        preview.append({"x": normalized_x, "y": normalized_y})
    return {
        "shapes": preview,
        "frame": {
            "x": round(frame_x, 2),
            "y": round(frame_y, 2),
            "width": round(frame_width, 2),
            "height": round(frame_height, 2),
        },
        "mode": "format_relative_size" if has_format_dims else "bbox_fallback",
    }


def _defect_pattern_geometry(
    coords_data,
    format_width: Optional[float],
    format_length: Optional[float],
) -> Dict[str, object]:
    parsed = _parse_coords_shapes(coords_data)
    shapes = parsed.get("shapes") or []
    malformed_entries = int(parsed.get("malformed_entries") or 0)
    if not shapes:
        return {
            "valid": False,
            "min_x": None,
            "max_x": None,
            "min_y": None,
            "max_y": None,
            "width": None,
            "height": None,
            "aspect_ratio": None,
            "polygon_area": None,
            "width_pct": None,
            "height_pct": None,
            "area_pct": None,
            "fill_ratio": None,
            "point_count": 0,
            "polygon_count": 0,
            "dominant_polygon_area": None,
            "dominant_polygon_ratio": None,
            "avg_polygon_width": None,
            "avg_polygon_height": None,
            "max_polygon_width": None,
            "max_polygon_height": None,
            "malformed_polygon_count": malformed_entries,
            "preview_shapes": [],
            "preview_frame": None,
            "preview_mode": "unavailable",
        }
    xs: List[float] = []
    ys: List[float] = []
    point_count = 0
    area_total = 0.0
    polygon_count = 0
    polygon_areas: List[float] = []
    polygon_widths: List[float] = []
    polygon_heights: List[float] = []
    for shape in shapes:
        shape_x = shape.get("x") or []
        shape_y = shape.get("y") or []
        count = min(len(shape_x), len(shape_y))
        if count < 3:
            continue
        xs.extend(shape_x[:count])
        ys.extend(shape_y[:count])
        point_count += count
        polygon_count += 1
        shape_min_x = min(shape_x[:count])
        shape_max_x = max(shape_x[:count])
        shape_min_y = min(shape_y[:count])
        shape_max_y = max(shape_y[:count])
        polygon_widths.append(shape_max_x - shape_min_x)
        polygon_heights.append(shape_max_y - shape_min_y)
        polygon_area = _polygon_area(shape_x[:count], shape_y[:count])
        if polygon_area is not None:
            area_total += polygon_area
            polygon_areas.append(polygon_area)
    if not xs or not ys:
        return {
            "valid": False,
            "min_x": None,
            "max_x": None,
            "min_y": None,
            "max_y": None,
            "width": None,
            "height": None,
            "aspect_ratio": None,
            "polygon_area": None,
            "width_pct": None,
            "height_pct": None,
            "area_pct": None,
            "fill_ratio": None,
            "point_count": 0,
            "polygon_count": 0,
            "dominant_polygon_area": None,
            "dominant_polygon_ratio": None,
            "avg_polygon_width": None,
            "avg_polygon_height": None,
            "max_polygon_width": None,
            "max_polygon_height": None,
            "malformed_polygon_count": malformed_entries,
            "preview_shapes": [],
            "preview_frame": None,
            "preview_mode": "unavailable",
        }
    min_x = min(xs)
    max_x = max(xs)
    min_y = min(ys)
    max_y = max(ys)
    width = max_x - min_x
    height = max_y - min_y
    aspect_ratio = (width / height) if height > 0 else None
    width_pct = (width / format_width * 100.0) if format_width and format_width > 0 else None
    height_pct = (height / format_length * 100.0) if format_length and format_length > 0 else None
    area_pct = None
    fill_ratio = None
    if (
        area_total > 0
        and format_width is not None
        and format_length is not None
        and format_width > 0
        and format_length > 0
    ):
        area_pct = (area_total / (format_width * format_length)) * 100.0
    bbox_area = width * height
    if bbox_area > 0 and area_total > 0:
        fill_ratio = area_total / bbox_area
    dominant_polygon_area = max(polygon_areas) if polygon_areas else None
    dominant_polygon_ratio = (
        (dominant_polygon_area / area_total)
        if dominant_polygon_area is not None and area_total > 0
        else None
    )
    preview_payload = _defect_pattern_preview_shapes(shapes, min_x, max_x, min_y, max_y, format_width, format_length)
    return {
        "valid": True,
        "min_x": round(min_x, 3),
        "max_x": round(max_x, 3),
        "min_y": round(min_y, 3),
        "max_y": round(max_y, 3),
        "width": round(width, 3),
        "height": round(height, 3),
        "aspect_ratio": round(aspect_ratio, 3) if aspect_ratio is not None else None,
        "polygon_area": round(area_total, 3) if area_total > 0 else None,
        "width_pct": round(width_pct, 3) if width_pct is not None else None,
        "height_pct": round(height_pct, 3) if height_pct is not None else None,
        "area_pct": round(area_pct, 4) if area_pct is not None else None,
        "fill_ratio": round(fill_ratio, 4) if fill_ratio is not None else None,
        "point_count": point_count,
        "polygon_count": polygon_count,
        "dominant_polygon_area": round(dominant_polygon_area, 3) if dominant_polygon_area is not None else None,
        "dominant_polygon_ratio": round(dominant_polygon_ratio, 4) if dominant_polygon_ratio is not None else None,
        "avg_polygon_width": round(sum(polygon_widths) / len(polygon_widths), 3) if polygon_widths else None,
        "avg_polygon_height": round(sum(polygon_heights) / len(polygon_heights), 3) if polygon_heights else None,
        "max_polygon_width": round(max(polygon_widths), 3) if polygon_widths else None,
        "max_polygon_height": round(max(polygon_heights), 3) if polygon_heights else None,
        "malformed_polygon_count": malformed_entries,
        "preview_shapes": preview_payload.get("shapes") or [],
        "preview_frame": preview_payload.get("frame"),
        "preview_mode": preview_payload.get("mode") or "unavailable",
    }


def _defect_pattern_quantize(value: Optional[float], step: float) -> str:
    numeric = _to_float(value)
    if numeric is None or step <= 0:
        return "na"
    bucket = round(numeric / step) * step
    if abs(bucket - round(bucket)) < 1e-9:
        return str(int(round(bucket)))
    return f"{bucket:.2f}".rstrip("0").rstrip(".")


def _defect_pattern_shape_key(geometry: Dict[str, object]) -> Optional[str]:
    if not geometry.get("valid"):
        return None
    width_basis = geometry.get("width_pct") if geometry.get("width_pct") is not None else geometry.get("width")
    height_basis = geometry.get("height_pct") if geometry.get("height_pct") is not None else geometry.get("height")
    area_basis = geometry.get("area_pct") if geometry.get("area_pct") is not None else geometry.get("polygon_area")
    aspect_basis = geometry.get("aspect_ratio")
    fill_basis = geometry.get("fill_ratio")
    polygon_count_basis = min(int(geometry.get("polygon_count") or 0), 6)
    dominant_ratio_basis = geometry.get("dominant_polygon_ratio")
    point_basis = min(int(geometry.get("point_count") or 0), 24)
    return "|".join(
        [
            f"c:{polygon_count_basis}",
            f"w:{_defect_pattern_quantize(_to_float(width_basis), 2.0)}",
            f"h:{_defect_pattern_quantize(_to_float(height_basis), 2.0)}",
            f"a:{_defect_pattern_quantize(_to_float(aspect_basis), 0.35)}",
            f"p:{_defect_pattern_quantize(_to_float(area_basis), 0.5)}",
            f"f:{_defect_pattern_quantize(_to_float(fill_basis), 0.1)}",
            f"d:{_defect_pattern_quantize(_to_float(dominant_ratio_basis), 0.1)}",
            f"v:{point_basis}",
        ]
    )


def _defect_pattern_location_axis_label(index: int, total: int, axis: str) -> str:
    if total <= 1:
        return "Center"
    ratio = index / max(total - 1, 1)
    if axis == "x":
        if ratio <= 0.15:
            return "Left Edge"
        if ratio <= 0.35:
            return "Left"
        if ratio < 0.65:
            return "Center"
        if ratio < 0.85:
            return "Right"
        return "Right Edge"
    if ratio <= 0.15:
        return "Top Edge"
    if ratio <= 0.35:
        return "Upper"
    if ratio < 0.65:
        return "Center"
    if ratio < 0.85:
        return "Lower"
    return "Bottom Edge"


def _defect_pattern_location_label(col_index: int, row_index: int, cols: int, rows: int) -> str:
    horizontal = _defect_pattern_location_axis_label(col_index, cols, "x")
    vertical = _defect_pattern_location_axis_label(row_index, rows, "y")
    if horizontal == "Center" and vertical == "Center":
        return "Center"
    if horizontal == "Center":
        return f"{vertical} Center"
    if vertical == "Center":
        return f"{horizontal} Center"
    return f"{horizontal} / {vertical}"


def _defect_pattern_location_bucket(
    geometry: Dict[str, object],
    format_width: Optional[float],
    format_length: Optional[float],
    cols: int,
    rows: int,
) -> Optional[Dict[str, object]]:
    if not geometry.get("valid"):
        return None
    width = _to_float(format_width)
    length = _to_float(format_length)
    min_x = _to_float(geometry.get("min_x"))
    max_x = _to_float(geometry.get("max_x"))
    min_y = _to_float(geometry.get("min_y"))
    max_y = _to_float(geometry.get("max_y"))
    if (
        width is None
        or length is None
        or width <= 0
        or length <= 0
        or min_x is None
        or max_x is None
        or min_y is None
        or max_y is None
    ):
        return None
    centroid_x = (min_x + max_x) / 2.0
    centroid_y = (min_y + max_y) / 2.0
    x_ratio = max(0.0, min(1.0, centroid_x / width))
    y_ratio = max(0.0, min(1.0, centroid_y / length))
    col_index = min(cols - 1, max(0, int(x_ratio * cols)))
    row_index = min(rows - 1, max(0, int(y_ratio * rows)))
    label = _defect_pattern_location_label(col_index, row_index, cols, rows)
    return {
        "key": f"c{col_index + 1}-r{row_index + 1}",
        "label": label,
        "col_index": col_index,
        "row_index": row_index,
        "center_x_pct": round(((col_index + 0.5) / cols) * 100.0, 2),
        "center_y_pct": round(((row_index + 0.5) / rows) * 100.0, 2),
        "x_ratio": round(x_ratio, 4),
        "y_ratio": round(y_ratio, 4),
    }


def _defect_pattern_slope(points: List[Dict[str, object]]) -> Optional[float]:
    usable = [
        (float(point.get("reelIndex")), float(point.get("avgSeverity")))
        for point in points
        if _to_float(point.get("reelIndex")) is not None and _to_float(point.get("avgSeverity")) is not None
    ]
    if len(usable) < 2:
        return None
    count = float(len(usable))
    sum_x = sum(item[0] for item in usable)
    sum_y = sum(item[1] for item in usable)
    sum_xy = sum(item[0] * item[1] for item in usable)
    sum_x2 = sum(item[0] * item[0] for item in usable)
    denominator = (count * sum_x2) - (sum_x * sum_x)
    if abs(denominator) < 1e-9:
        return None
    return ((count * sum_xy) - (sum_x * sum_y)) / denominator


def _defect_pattern_example_distance(example: Dict[str, object], center: Dict[str, float]) -> float:
    metrics = (
        ("widthPct", 1.0),
        ("heightPct", 1.0),
        ("areaPct", 1.2),
        ("aspectRatio", 0.9),
        ("polygonCount", 1.1),
        ("dominantPolygonRatio", 0.8),
    )
    total = 0.0
    used = 0
    for key, weight in metrics:
        value = _to_float(example.get(key))
        center_value = _to_float(center.get(key))
        if value is None or center_value is None:
            continue
        total += abs(value - center_value) * weight
        used += 1
    return total if used > 0 else float("inf")


def _defect_pattern_curate_examples(
    examples: List[Dict[str, object]],
    dominant_bucket: str,
) -> List[Dict[str, object]]:
    if not examples:
        return []
    usable = [dict(example) for example in examples]
    examples_with_images = [example for example in usable if (example.get("imageSrc") or "").strip()]
    image_pool = examples_with_images or usable
    center: Dict[str, float] = {}
    for key in ("widthPct", "heightPct", "areaPct", "aspectRatio", "polygonCount", "dominantPolygonRatio"):
        values = [_to_float(example.get(key)) for example in usable]
        numeric_values = [float(value) for value in values if value is not None]
        if numeric_values:
            center[key] = sum(numeric_values) / len(numeric_values)
    for example in usable:
        example["_distance"] = _defect_pattern_example_distance(example, center)
    typical = min(image_pool, key=lambda example: (float(example.get("_distance") or 0.0), int(example.get("defectId") or 0)))
    largest = max(
        image_pool,
        key=lambda example: (_to_float(example.get("areaPct")) or _to_float(example.get("polygonArea")) or 0.0, int(example.get("defectId") or 0)),
    )
    highest_severity = max(
        image_pool,
        key=lambda example: (_to_float(example.get("severityValue")) or 0.0, int(example.get("defectId") or 0)),
    )
    dominant_region_pool = [example for example in image_pool if str(example.get("bucketLabel") or "") == str(dominant_bucket or "")]
    common_region_example = min(
        dominant_region_pool or image_pool,
        key=lambda example: (float(example.get("_distance") or 0.0), int(example.get("defectId") or 0)),
    )
    ordered: List[Dict[str, object]] = []
    used_ids = set()

    def push(example: Optional[Dict[str, object]], tag: str) -> None:
        if not example:
            return
        defect_id = int(example.get("defectId") or 0)
        if defect_id in used_ids:
            existing = next((item for item in ordered if int(item.get("defectId") or 0) == defect_id), None)
            if existing:
                tags = list(existing.get("selectionTags") or [])
                if tag not in tags:
                    tags.append(tag)
                    existing["selectionTags"] = tags
            return
        payload = dict(example)
        payload["selectionTags"] = [tag]
        ordered.append(payload)
        used_ids.add(defect_id)

    push(typical, "Typical")
    push(largest, "Largest")
    push(highest_severity, "Highest Severity")
    push(common_region_example, "Common Region")

    remaining = sorted(
        usable,
        key=lambda example: (
            0 if (example.get("imageSrc") or "").strip() else 1,
            float(example.get("_distance") or 0.0),
            -(_to_float(example.get("severityValue")) or 0.0),
            int(example.get("defectId") or 0),
        ),
    )
    for example in remaining:
        defect_id = int(example.get("defectId") or 0)
        if defect_id in used_ids:
            continue
        ordered.append(dict(example))
        used_ids.add(defect_id)
        if len(ordered) >= 18:
            break

    distances = [float(example.get("_distance") or 0.0) for example in usable if _to_float(example.get("_distance")) is not None]
    threshold = sorted(distances)[int(len(distances) * 0.85)] if distances else float("inf")
    for example in ordered:
        example["isTypical"] = "Typical" in (example.get("selectionTags") or [])
        example["isOutlier"] = float(example.get("_distance") or 0.0) >= threshold if threshold != float("inf") else False
        example.pop("_distance", None)
    return ordered


def _defect_pattern_curate_location_examples(
    examples: List[Dict[str, object]],
    dominant_class: str,
) -> List[Dict[str, object]]:
    if not examples:
        return []
    usable = [dict(example) for example in examples]
    image_pool = [example for example in usable if (example.get("imageSrc") or "").strip()] or usable
    center_x = sum((_to_float(example.get("locationXRatio")) or 0.0) for example in usable) / max(len(usable), 1)
    center_y = sum((_to_float(example.get("locationYRatio")) or 0.0) for example in usable) / max(len(usable), 1)
    for example in usable:
        x_ratio = _to_float(example.get("locationXRatio")) or center_x
        y_ratio = _to_float(example.get("locationYRatio")) or center_y
        example["_distance"] = abs(x_ratio - center_x) + abs(y_ratio - center_y)
    typical = min(image_pool, key=lambda example: (float(example.get("_distance") or 0.0), int(example.get("defectId") or 0)))
    largest = max(
        image_pool,
        key=lambda example: (_to_float(example.get("areaPct")) or _to_float(example.get("polygonArea")) or 0.0, int(example.get("defectId") or 0)),
    )
    highest_severity = max(
        image_pool,
        key=lambda example: (_to_float(example.get("severityValue")) or 0.0, int(example.get("defectId") or 0)),
    )
    dominant_class_pool = [example for example in image_pool if str(example.get("className") or "") == dominant_class]
    dominant_class_example = min(
        dominant_class_pool or image_pool,
        key=lambda example: (float(example.get("_distance") or 0.0), int(example.get("defectId") or 0)),
    )
    ordered: List[Dict[str, object]] = []
    used_ids = set()

    def push(example: Optional[Dict[str, object]], tag: str) -> None:
        if not example:
            return
        defect_id = int(example.get("defectId") or 0)
        if defect_id in used_ids:
            existing = next((item for item in ordered if int(item.get("defectId") or 0) == defect_id), None)
            if existing:
                tags = list(existing.get("selectionTags") or [])
                if tag not in tags:
                    tags.append(tag)
                    existing["selectionTags"] = tags
            return
        payload = dict(example)
        payload["selectionTags"] = [tag]
        ordered.append(payload)
        used_ids.add(defect_id)

    push(typical, "Typical")
    push(largest, "Largest")
    push(highest_severity, "Highest Severity")
    push(dominant_class_example, "Dominant Class")

    remaining = sorted(
        usable,
        key=lambda example: (
            0 if (example.get("imageSrc") or "").strip() else 1,
            float(example.get("_distance") or 0.0),
            -(_to_float(example.get("severityValue")) or 0.0),
            int(example.get("defectId") or 0),
        ),
    )
    for example in remaining:
        defect_id = int(example.get("defectId") or 0)
        if defect_id in used_ids:
            continue
        ordered.append(dict(example))
        used_ids.add(defect_id)
        if len(ordered) >= 18:
            break
    distances = [float(example.get("_distance") or 0.0) for example in usable if _to_float(example.get("_distance")) is not None]
    threshold = sorted(distances)[int(len(distances) * 0.85)] if distances else float("inf")
    for example in ordered:
        example["isTypical"] = "Typical" in (example.get("selectionTags") or [])
        example["isOutlier"] = float(example.get("_distance") or 0.0) >= threshold if threshold != float("inf") else False
        example.pop("_distance", None)
    return ordered


def _build_defect_pattern_summary_cards(
    class_key: str,
    class_label: str,
    total_defects: int,
    bucket_totals: Counter,
    class_counter: Counter,
    location_groups: List[Dict[str, object]],
    trend_series: List[Dict[str, object]],
) -> List[Dict[str, str]]:
    cards: List[Dict[str, str]] = []
    top_bucket, top_bucket_count = (bucket_totals.most_common(1)[0] if bucket_totals else ("", 0))
    top_bucket_share = (top_bucket_count / total_defects) if total_defects > 0 else 0.0
    if top_bucket and top_bucket_share >= 0.45:
        cards.append(
            {
                "title": "Location Pattern",
                "body": f"Most defects occur in the {top_bucket} region.",
                "tone": "strong",
            }
        )
    elif top_bucket and top_bucket_share >= 0.34:
        cards.append(
            {
                "title": "Location Pattern",
                "body": f"Defects lean toward the {top_bucket} region, but the spread is still mixed across the reel.",
                "tone": "info",
            }
        )
    else:
        cards.append(
            {
                "title": "Location Pattern",
                "body": "Defects are spread across the reel with no single dominant region.",
                "tone": "neutral",
            }
        )
    if class_key == "all":
        top_class, top_class_count = (class_counter.most_common(1)[0] if class_counter else ("Unclassified", 0))
        if total_defects > 0 and top_class_count / total_defects >= 0.35:
            cards.append(
                {
                    "title": "Dominant Class",
                    "body": f"{top_class} is the dominant defect class.",
                    "tone": "info",
                }
            )
    else:
        cards.append(
            {
                "title": "Class Focus",
                "body": f"Analysis is filtered to {class_label} defects.",
                "tone": "info",
            }
        )
    top_group = location_groups[0] if location_groups else None
    if top_group and int(top_group.get("uniqueReelCount") or 0) >= 3:
        cards.append(
            {
                "title": "Location Cluster",
                "body": f"{top_group.get('label') or 'One zone'} affects {int(top_group.get('uniqueReelCount') or 0)} reels and is the main repeat location.",
                "tone": "strong",
            }
        )
    else:
        cards.append(
            {
                "title": "Location Cluster",
                "body": "No single format region clearly dominates across reels.",
                "tone": "neutral",
            }
        )
    strongest_trend: Optional[Tuple[float, str]] = None
    for series in trend_series:
        slope = _defect_pattern_slope(series.get("points") or [])
        if slope is None:
            continue
        label = str(series.get("label") or "Region")
        if strongest_trend is None or abs(slope) > abs(strongest_trend[0]):
            strongest_trend = (slope, label)
    if strongest_trend and strongest_trend[0] >= 0.18:
        cards.append(
            {
                "title": "Severity Trend",
                "body": f"{strongest_trend[1]} severity is trending upward across reels.",
                "tone": "warn",
            }
        )
    elif strongest_trend and strongest_trend[0] <= -0.18:
        cards.append(
            {
                "title": "Severity Trend",
                "body": f"{strongest_trend[1]} severity is easing down across reels.",
                "tone": "info",
            }
        )
    else:
        cards.append(
            {
                "title": "Severity Trend",
                "body": "Severity is broadly stable by reel position.",
                "tone": "neutral",
            }
        )
    return cards[:4]


def _build_defect_pattern_analyzer_payload(
    session: Session,
    start: datetime,
    end: datetime,
    min_feet: Optional[float],
    selections: List[Dict[str, object]],
    filters: Optional[Dict[str, Any]] = None,
) -> Dict[str, object]:
    selection_clause = _defect_trends_selection_clause(selections)
    if selection_clause is None:
        return {"machines": []}
    defect_exists = (
        session.query(Defect.defect_id)
        .filter(Defect.reel_id == Reel.reel_id)
        .filter(Defect.defect_time >= start)
        .filter(Defect.defect_time <= end)
        .exists()
    )
    reel_query = (
        session.query(Reel)
        .options(selectinload(Reel.machine))
        .filter(Reel.time_start <= end)
        .filter(Reel.time_end >= start)
        .filter(selection_clause)
        .filter(defect_exists)
    )
    if filters:
        reel_query = _apply_reel_filters(reel_query, filters)
    if min_feet is not None:
        reel_query = reel_query.filter(_defect_trends_reel_feet_expr() >= min_feet)
    reels = reel_query.order_by(Reel.machine_id.asc(), Reel.time_start.asc(), Reel.reel_id.asc()).all()
    if not reels:
        return {"machines": []}
    reels_by_id = {reel.reel_id: reel for reel in reels if reel.reel_id is not None}
    reel_ids = list(reels_by_id.keys())
    defects = (
        session.query(Defect)
        .filter(Defect.reel_id.in_(reel_ids))
        .filter(Defect.defect_time >= start)
        .filter(Defect.defect_time <= end)
        .order_by(Defect.reel_id.asc(), Defect.defect_time.asc(), Defect.defect_id.asc())
        .all()
    )
    defects_by_machine: Dict[int, List[Defect]] = defaultdict(list)
    reels_by_machine: Dict[int, List[Reel]] = defaultdict(list)
    for reel in reels:
        reels_by_machine[reel.machine_id].append(reel)
    for defect in defects:
        reel = reels_by_id.get(defect.reel_id)
        if not reel:
            continue
        defects_by_machine[reel.machine_id].append(defect)

    machines_payload: List[Dict[str, object]] = []
    for machine_id, machine_reels in reels_by_machine.items():
        machine_reels.sort(key=lambda reel: (reel.time_start or datetime.min, reel.reel_id or 0))
        machine_defects = defects_by_machine.get(machine_id, [])
        if not machine_defects:
            continue
        reel_payload: List[Dict[str, object]] = []
        reel_meta_by_id: Dict[int, Dict[str, object]] = {}
        for index, reel in enumerate(machine_reels):
            reel_meta = {
                "reelId": reel.reel_id,
                "reelCode": reel.reel_code or f"Reel {index + 1}",
                "jobLabel": _defect_trends_format_job_label(reel.job_name, reel.order_number),
                "orderIndex": index + 1,
                "reelFeetTotal": round(_reel_length_feet(reel), 3),
            }
            reel_payload.append(reel_meta)
            if reel.reel_id is not None:
                reel_meta_by_id[int(reel.reel_id)] = reel_meta

        class_labels: Dict[str, str] = {}
        class_counter: Counter = Counter()
        heatmap_stats: Dict[str, Dict[Tuple[str, int], Dict[str, object]]] = defaultdict(dict)
        trend_stats: Dict[str, Dict[Tuple[str, int], Dict[str, float]]] = defaultdict(dict)
        location_group_stats: Dict[str, Dict[str, Dict[str, object]]] = defaultdict(dict)
        heatmap_bucket_totals: Dict[str, Counter] = defaultdict(Counter)
        location_parse_stats = {
            "singlePolygonDefects": 0,
            "multiPolygonDefects": 0,
            "skippedMalformedEntries": 0,
            "missingFormatDimensions": 0,
            "excludedFromLocationMap": 0,
        }

        for defect in machine_defects:
            reel = reels_by_id.get(defect.reel_id)
            reel_meta = reel_meta_by_id.get(int(defect.reel_id)) if defect.reel_id is not None else None
            if not reel or not reel_meta:
                continue
            class_label = str(defect.class_name or "").strip() or "Unclassified"
            class_key = _defect_pattern_class_key(class_label)
            class_labels[class_key] = class_label
            class_counter[class_label] += 1
            position_ratio = _defect_pattern_position_ratio(reel, defect)
            heatmap_bucket = _defect_pattern_bucket_for_ratio(position_ratio, DEFECT_PATTERN_HEATMAP_BUCKETS)
            trend_bucket = _defect_pattern_bucket_for_ratio(position_ratio, DEFECT_PATTERN_TREND_BUCKETS)
            severity_value = _to_float(defect.severity_value)
            magnitude_value = _to_float(defect.magnitude_value)
            geometry = _defect_pattern_geometry(
                defect.coords_json,
                _to_float(reel.format_width),
                _to_float(reel.format_length),
            )
            polygon_count = int(geometry.get("polygon_count") or 0)
            if polygon_count == 1:
                location_parse_stats["singlePolygonDefects"] += 1
            elif polygon_count > 1:
                location_parse_stats["multiPolygonDefects"] += 1
            location_parse_stats["skippedMalformedEntries"] += int(geometry.get("malformed_polygon_count") or 0)
            location_bucket = _defect_pattern_location_bucket(
                geometry,
                _to_float(reel.format_width),
                _to_float(reel.format_length),
                DEFECT_PATTERN_LOCATION_GRID["cols"],
                DEFECT_PATTERN_LOCATION_GRID["rows"],
            )
            if geometry.get("valid") and location_bucket is None:
                if not _to_float(reel.format_width) or not _to_float(reel.format_length):
                    location_parse_stats["missingFormatDimensions"] += 1
                location_parse_stats["excludedFromLocationMap"] += 1

            for group_key in ("all", class_key):
                if heatmap_bucket:
                    heatmap_bucket_totals[group_key][str(heatmap_bucket.get("label") or heatmap_bucket["key"])] += 1
                    cell_key = (str(heatmap_bucket["key"]), int(defect.reel_id))
                    cell = heatmap_stats[group_key].setdefault(
                        cell_key,
                        {"count": 0, "severity_total": 0.0, "severity_count": 0, "class_counter": Counter()},
                    )
                    cell["count"] = int(cell.get("count") or 0) + 1
                    if severity_value is not None:
                        cell["severity_total"] = float(cell.get("severity_total") or 0.0) + severity_value
                        cell["severity_count"] = int(cell.get("severity_count") or 0) + 1
                    cell["class_counter"][class_label] += 1
                if trend_bucket:
                    trend_key = (str(trend_bucket["key"]), int(defect.reel_id))
                    trend_entry = trend_stats[group_key].setdefault(
                        trend_key,
                        {
                            "count": 0.0,
                            "severity_total": 0.0,
                            "severity_count": 0.0,
                            "magnitude_total": 0.0,
                            "magnitude_count": 0.0,
                        },
                    )
                    trend_entry["count"] = float(trend_entry.get("count") or 0.0) + 1.0
                    if severity_value is not None:
                        trend_entry["severity_total"] = float(trend_entry.get("severity_total") or 0.0) + severity_value
                        trend_entry["severity_count"] = float(trend_entry.get("severity_count") or 0.0) + 1.0
                    if magnitude_value is not None:
                        trend_entry["magnitude_total"] = float(trend_entry.get("magnitude_total") or 0.0) + magnitude_value
                        trend_entry["magnitude_count"] = float(trend_entry.get("magnitude_count") or 0.0) + 1.0
                if location_bucket:
                    bucket_key = str(location_bucket["key"])
                    group_entry = location_group_stats[group_key].setdefault(
                        bucket_key,
                        {
                            "count": 0,
                            "severity_total": 0.0,
                            "severity_count": 0,
                            "magnitude_total": 0.0,
                            "magnitude_count": 0,
                            "class_counter": Counter(),
                            "reels": set(),
                            "label": location_bucket.get("label") or bucket_key,
                            "colIndex": int(location_bucket.get("col_index") or 0),
                            "rowIndex": int(location_bucket.get("row_index") or 0),
                            "centerXPct": _to_float(location_bucket.get("center_x_pct")),
                            "centerYPct": _to_float(location_bucket.get("center_y_pct")),
                            "representative_area": _to_float(geometry.get("area_pct")) or _to_float(geometry.get("polygon_area")) or 0.0,
                            "representative_image": (defect.image_src or "").replace("\\", "/"),
                            "examples": [],
                        },
                    )
                    group_entry["count"] = int(group_entry.get("count") or 0) + 1
                    if severity_value is not None:
                        group_entry["severity_total"] = float(group_entry.get("severity_total") or 0.0) + severity_value
                        group_entry["severity_count"] = int(group_entry.get("severity_count") or 0) + 1
                    if magnitude_value is not None:
                        group_entry["magnitude_total"] = float(group_entry.get("magnitude_total") or 0.0) + magnitude_value
                        group_entry["magnitude_count"] = int(group_entry.get("magnitude_count") or 0) + 1
                    group_entry["class_counter"][class_label] += 1
                    group_entry["reels"].add(int(defect.reel_id))
                    group_entry["examples"].append(
                        {
                            "defectId": defect.defect_id,
                            "imageSrc": (defect.image_src or "").replace("\\", "/"),
                            "coords": _serialize_coords(defect.coords_json),
                            "className": class_label,
                            "magnitudeValue": magnitude_value,
                            "severityValue": severity_value,
                            "formatPosition": _to_float(defect.format_position),
                            "reelId": reel_meta["reelId"],
                            "reelCode": reel_meta["reelCode"],
                            "reelIndex": reel_meta["orderIndex"],
                            "jobLabel": reel_meta["jobLabel"],
                            "defectTime": _iso(defect.defect_time),
                            "formatWidth": _to_float(reel.format_width),
                            "formatLength": _to_float(reel.format_length),
                            "bucketLabel": str(heatmap_bucket.get("label") or heatmap_bucket["key"]) if heatmap_bucket else "",
                            "locationKey": bucket_key,
                            "locationLabel": str(location_bucket.get("label") or bucket_key),
                            "locationXRatio": location_bucket.get("x_ratio"),
                            "locationYRatio": location_bucket.get("y_ratio"),
                            "locationColIndex": location_bucket.get("col_index"),
                            "locationRowIndex": location_bucket.get("row_index"),
                            "widthPct": geometry.get("width_pct"),
                            "heightPct": geometry.get("height_pct"),
                            "areaPct": geometry.get("area_pct"),
                            "aspectRatio": geometry.get("aspect_ratio"),
                            "polygonCount": geometry.get("polygon_count"),
                            "dominantPolygonRatio": geometry.get("dominant_polygon_ratio"),
                            "polygonArea": geometry.get("polygon_area"),
                            "previewMode": geometry.get("preview_mode"),
                            "centroidXPct": round(float(location_bucket.get("x_ratio") or 0.0) * 100.0, 2),
                            "centroidYPct": round(float(location_bucket.get("y_ratio") or 0.0) * 100.0, 2),
                        }
                    )
                    current_area = _to_float(geometry.get("area_pct")) or _to_float(geometry.get("polygon_area")) or 0.0
                    if current_area > float(group_entry.get("representative_area") or 0.0):
                        group_entry["representative_area"] = current_area
                        group_entry["representative_image"] = (defect.image_src or "").replace("\\", "/")

        normalized_class_counts: Counter = Counter()
        for label, count in class_counter.items():
            normalized_class_counts[_defect_pattern_class_key(label)] += int(count or 0)

        class_options = [
            {"key": "all", "label": "All Classes", "count": sum(class_counter.values())}
        ] + [
            {"key": class_key, "label": class_labels[class_key], "count": count}
            for class_key, count in sorted(
                ((key, int(count or 0)) for key, count in normalized_class_counts.items()),
                key=lambda item: (-item[1], class_labels.get(item[0], item[0])),
            )
        ]

        heatmap_by_class: Dict[str, Dict[str, object]] = {}
        trend_by_class: Dict[str, List[Dict[str, object]]] = {}
        location_map_by_class: Dict[str, Dict[str, object]] = {}
        location_groups_by_class: Dict[str, List[Dict[str, object]]] = {}
        summary_cards_by_class: Dict[str, List[Dict[str, str]]] = {}

        for option in class_options:
            group_key = str(option["key"])
            heatmap_matrix: List[List[int]] = []
            avg_severity_matrix: List[List[Optional[float]]] = []
            hover_matrix: List[List[str]] = []
            for bucket in DEFECT_PATTERN_HEATMAP_BUCKETS:
                row_counts: List[int] = []
                row_severity: List[Optional[float]] = []
                row_hover: List[str] = []
                for reel_meta in reel_payload:
                    reel_id = int(reel_meta["reelId"])
                    stats_entry = heatmap_stats[group_key].get((str(bucket["key"]), reel_id), {})
                    count_value = int(stats_entry.get("count") or 0)
                    severity_count = int(stats_entry.get("severity_count") or 0)
                    avg_severity = (
                        round(float(stats_entry.get("severity_total") or 0.0) / severity_count, 3)
                        if severity_count > 0
                        else None
                    )
                    dominant_class = ""
                    if group_key == "all":
                        class_counter_cell = stats_entry.get("class_counter") or Counter()
                        dominant_class = class_counter_cell.most_common(1)[0][0] if class_counter_cell else ""
                    hover_parts = [
                        f"<b>{reel_meta['reelCode']}</b>",
                        f"Job: {reel_meta['jobLabel']}",
                        f"Reel order: #{reel_meta['orderIndex']}",
                        f"Region: {bucket['label']}",
                        f"Defect count: {count_value}",
                    ]
                    if avg_severity is not None:
                        hover_parts.append(f"Avg severity: {avg_severity:.2f}")
                    if dominant_class:
                        hover_parts.append(f"Dominant class: {dominant_class}")
                    row_counts.append(count_value)
                    row_severity.append(avg_severity)
                    row_hover.append("<br>".join(hover_parts))
                heatmap_matrix.append(row_counts)
                avg_severity_matrix.append(row_severity)
                hover_matrix.append(row_hover)
            heatmap_by_class[group_key] = {
                "bucketLabels": [str(bucket["label"]) for bucket in DEFECT_PATTERN_HEATMAP_BUCKETS],
                "reelLabels": [f"#{int(reel['orderIndex'])}" for reel in reel_payload],
                "reels": reel_payload,
                "z": heatmap_matrix,
                "avgSeverity": avg_severity_matrix,
                "hover": hover_matrix,
            }

            trend_series: List[Dict[str, object]] = []
            for bucket in DEFECT_PATTERN_TREND_BUCKETS:
                points_payload: List[Dict[str, object]] = []
                for reel_meta in reel_payload:
                    reel_id = int(reel_meta["reelId"])
                    stats_entry = trend_stats[group_key].get((str(bucket["key"]), reel_id))
                    if not stats_entry:
                        continue
                    count_value = int(round(float(stats_entry.get("count") or 0.0)))
                    severity_count = int(round(float(stats_entry.get("severity_count") or 0.0)))
                    magnitude_count = int(round(float(stats_entry.get("magnitude_count") or 0.0)))
                    if count_value <= 0 or (severity_count <= 0 and magnitude_count <= 0):
                        continue
                    avg_severity = float(stats_entry.get("severity_total") or 0.0) / max(severity_count, 1)
                    avg_magnitude = (
                        float(stats_entry.get("magnitude_total") or 0.0) / max(magnitude_count, 1)
                        if magnitude_count > 0
                        else None
                    )
                    points_payload.append(
                        {
                            "reelId": reel_meta["reelId"],
                            "reelCode": reel_meta["reelCode"],
                            "jobLabel": reel_meta["jobLabel"],
                            "reelIndex": reel_meta["orderIndex"],
                            "avgSeverity": round(avg_severity, 3),
                            "avgMagnitude": round(avg_magnitude, 4) if avg_magnitude is not None else None,
                            "count": count_value,
                        }
                    )
                trend_series.append(
                    {
                        "key": bucket["key"],
                        "label": bucket["label"],
                        "points": points_payload,
                    }
                )
            trend_by_class[group_key] = trend_series

            location_cells: List[Dict[str, object]] = []
            raw_groups = []
            for group_bucket_key, group_entry in location_group_stats[group_key].items():
                count_value = int(group_entry.get("count") or 0)
                severity_count = int(group_entry.get("severity_count") or 0)
                magnitude_count = int(group_entry.get("magnitude_count") or 0)
                avg_severity = (
                    float(group_entry.get("severity_total") or 0.0) / max(severity_count, 1)
                    if severity_count > 0
                    else None
                )
                avg_magnitude = (
                    float(group_entry.get("magnitude_total") or 0.0) / max(magnitude_count, 1)
                    if magnitude_count > 0
                    else None
                )
                dominant_class = (
                    (group_entry.get("class_counter") or Counter()).most_common(1)[0][0]
                    if group_entry.get("class_counter")
                    else "Unclassified"
                )
                curated_examples = _defect_pattern_curate_location_examples(
                    list(group_entry.get("examples") or []),
                    str(dominant_class or ""),
                )
                reels_affected = len(group_entry.get("reels") or set())
                location_payload = {
                    "key": group_bucket_key,
                    "label": group_entry.get("label") or group_bucket_key,
                    "colIndex": int(group_entry.get("colIndex") or 0),
                    "rowIndex": int(group_entry.get("rowIndex") or 0),
                    "centerXPct": _to_float(group_entry.get("centerXPct")),
                    "centerYPct": _to_float(group_entry.get("centerYPct")),
                    "count": count_value,
                    "sharePct": round((count_value / max(int(option["count"]) or 1, 1)) * 100.0, 1),
                    "avgSeverity": round(avg_severity, 3) if avg_severity is not None else None,
                    "avgMagnitude": round(avg_magnitude, 4) if avg_magnitude is not None else None,
                    "dominantClassName": dominant_class,
                    "uniqueReelCount": reels_affected,
                    "thumbnailSrc": group_entry.get("representative_image") or "",
                    "examples": curated_examples,
                }
                location_cells.append(
                    {
                        "key": group_bucket_key,
                        "label": group_entry.get("label") or group_bucket_key,
                        "colIndex": int(group_entry.get("colIndex") or 0),
                        "rowIndex": int(group_entry.get("rowIndex") or 0),
                        "count": count_value,
                        "reelsAffected": reels_affected,
                        "avgSeverity": round(avg_severity, 3) if avg_severity is not None else None,
                        "avgMagnitude": round(avg_magnitude, 4) if avg_magnitude is not None else None,
                        "dominantClassName": dominant_class,
                    }
                )
                if count_value >= 2:
                    raw_groups.append(location_payload)
            raw_groups.sort(
                key=lambda item: (
                    -(int(item.get("uniqueReelCount") or 0)),
                    -int(item.get("count") or 0),
                    -(float(item.get("avgMagnitude") or item.get("avgSeverity") or 0.0)),
                )
            )
            location_groups_by_class[group_key] = raw_groups[:12]
            location_map_by_class[group_key] = {
                "cols": DEFECT_PATTERN_LOCATION_GRID["cols"],
                "rows": DEFECT_PATTERN_LOCATION_GRID["rows"],
                "cells": location_cells,
            }
            summary_cards_by_class[group_key] = _build_defect_pattern_summary_cards(
                group_key,
                str(option["label"]),
                int(option.get("count") or 0),
                heatmap_bucket_totals[group_key],
                class_counter,
                location_groups_by_class[group_key],
                trend_by_class[group_key],
            )

        machines_payload.append(
            {
                "machineId": machine_id,
                "machineName": machine_reels[0].machine.name if machine_reels[0].machine else f"Press {machine_id}",
                "classOptions": class_options,
                "heatmapByClass": heatmap_by_class,
                "trendByClass": trend_by_class,
                "locationMapByClass": location_map_by_class,
                "locationGroupsByClass": location_groups_by_class,
                "summaryCardsByClass": summary_cards_by_class,
                "locationParseStats": location_parse_stats,
            }
        )

    machines_payload.sort(
        key=lambda item: (
            _machine_sort_key(item.get("machineName")),
            (item.get("machineName") or "").lower(),
        )
    )
    return {"machines": machines_payload}


def _build_defect_trend_payload(
    session: Session,
    start: datetime,
    end: datetime,
    min_feet: Optional[float],
    selections: List[Dict[str, object]],
    filters: Optional[Dict[str, Any]] = None,
) -> Dict[str, object]:
    selection_clause = _defect_trends_selection_clause(selections)
    if selection_clause is None:
        return {"machines": []}

    defect_exists = (
        session.query(Defect.defect_id)
        .filter(Defect.reel_id == Reel.reel_id)
        .filter(Defect.defect_time >= start)
        .filter(Defect.defect_time <= end)
        .exists()
    )
    reel_query = (
        session.query(Reel)
        .options(selectinload(Reel.machine), selectinload(Reel.reference_images), selectinload(Reel.masks))
        .filter(Reel.time_start <= end)
        .filter(Reel.time_end >= start)
        .filter(selection_clause)
        .filter(defect_exists)
    )
    if filters:
        reel_query = _apply_reel_filters(reel_query, filters)
    if min_feet is not None:
        reel_query = reel_query.filter(_defect_trends_reel_feet_expr() >= min_feet)
    reels = reel_query.order_by(Reel.machine_id.asc(), Reel.time_start.asc(), Reel.reel_id.asc()).all()
    if not reels:
        return {"machines": []}

    reels_by_id = {reel.reel_id: reel for reel in reels if reel.reel_id is not None}
    reel_ids = list(reels_by_id.keys())
    defects = (
        session.query(Defect)
        .filter(Defect.reel_id.in_(reel_ids))
        .filter(Defect.defect_time >= start)
        .filter(Defect.defect_time <= end)
        .order_by(Defect.reel_id.asc(), Defect.defect_time.asc(), Defect.defect_id.asc())
        .all()
    )
    phase_rows = (
        session.query(
            InspectionPhase.reel_id,
            InspectionPhase.phase,
            InspectionPhase.start_format,
            InspectionPhase.end_format,
            InspectionPhase.start_time,
            InspectionPhase.end_time,
        )
        .filter(InspectionPhase.reel_id.in_(reel_ids))
        .order_by(InspectionPhase.reel_id.asc(), InspectionPhase.start_time.asc())
        .all()
    )

    monitoring_by_reel: Dict[int, List[Dict[str, object]]] = defaultdict(list)
    monitoring_times_by_reel: Dict[int, List[datetime]] = defaultdict(list)
    rlm_reel_by_dashboard_reel: Dict[int, RLMDbReel] = {}
    reel_codes = sorted({str(reel.reel_code or "").strip() for reel in reels if str(reel.reel_code or "").strip()})
    machine_names = sorted({str(reel.machine.name or "").strip() for reel in reels if reel.machine and str(reel.machine.name or "").strip()})
    if reel_codes and machine_names:
        with RLMSessionLocal() as rlm_session:
            rlm_machine_rows = (
                rlm_session.query(RLMDbMachine)
                .filter(RLMDbMachine.machine_name.in_(machine_names))
                .all()
            )
            rlm_machine_by_name = {
                str(machine.machine_name or "").strip().lower(): machine
                for machine in rlm_machine_rows
                if str(machine.machine_name or "").strip()
            }
            rlm_machine_ids = [machine.machine_id for machine in rlm_machine_rows if machine.machine_id is not None]
            rlm_reels = []
            if rlm_machine_ids:
                rlm_reels = (
                    rlm_session.query(RLMDbReel)
                    .join(RLMDbMachine, RLMDbReel.machine_id == RLMDbMachine.machine_id)
                    .filter(RLMDbReel.machine_id.in_(rlm_machine_ids))
                    .filter(RLMDbReel.reel_id.in_(reel_codes))
                    .filter(RLMDbReel.production_start_dt <= end)
                    .filter(or_(RLMDbReel.production_end_dt.is_(None), RLMDbReel.production_end_dt >= start))
                    .order_by(RLMDbMachine.machine_name.asc(), RLMDbReel.production_start_dt.asc(), RLMDbReel.reel_db_id.asc())
                    .all()
                )
            rlm_reels_by_key: Dict[Tuple[str, str], List[RLMDbReel]] = defaultdict(list)
            for rlm_reel in rlm_reels:
                rlm_machine_name = str(rlm_reel.machine.machine_name if rlm_reel.machine else "").strip().lower()
                rlm_reel_code = str(rlm_reel.reel_id or "").strip().lower()
                if rlm_machine_name and rlm_reel_code:
                    rlm_reels_by_key[(rlm_machine_name, rlm_reel_code)].append(rlm_reel)

            matched_rlm_reel_ids: List[int] = []
            for reel in reels:
                dashboard_reel_id = getattr(reel, "reel_id", None)
                dashboard_reel_code = str(reel.reel_code or "").strip().lower()
                dashboard_machine_name = str(reel.machine.name if reel.machine else "").strip().lower()
                if dashboard_reel_id is None or not dashboard_reel_code or not dashboard_machine_name:
                    continue
                candidates = rlm_reels_by_key.get((dashboard_machine_name, dashboard_reel_code), [])
                if not candidates:
                    continue
                target_ts = reel.time_start or reel.time_end or datetime.min
                matched_reel = min(
                    candidates,
                    key=lambda candidate: abs(((candidate.production_start_dt or candidate.production_end_dt or datetime.min) - target_ts).total_seconds()),
                )
                rlm_reel_by_dashboard_reel[dashboard_reel_id] = matched_reel
                if matched_reel.reel_db_id is not None:
                    matched_rlm_reel_ids.append(int(matched_reel.reel_db_id))

            if matched_rlm_reel_ids:
                monitoring_rows = (
                    rlm_session.query(
                        RLMDbMonitoring.reel_db_id,
                        RLMDbMonitoring.monitoring_ts,
                        RLMDbMonitoring.webspeed,
                        RLMDbMonitoring.format_value,
                        RLMDbMonitoring.monitoring_id,
                    )
                    .filter(RLMDbMonitoring.reel_db_id.in_(matched_rlm_reel_ids))
                    .filter(RLMDbMonitoring.monitoring_ts >= start)
                    .filter(RLMDbMonitoring.monitoring_ts <= end)
                    .order_by(RLMDbMonitoring.reel_db_id.asc(), RLMDbMonitoring.monitoring_ts.asc(), RLMDbMonitoring.monitoring_id.asc())
                    .all()
                )
                dashboard_reel_ids_by_rlm_reel_id: Dict[int, List[int]] = defaultdict(list)
                for dashboard_reel_id, rlm_reel in rlm_reel_by_dashboard_reel.items():
                    if rlm_reel and rlm_reel.reel_db_id is not None:
                        dashboard_reel_ids_by_rlm_reel_id[int(rlm_reel.reel_db_id)].append(int(dashboard_reel_id))
                for row in monitoring_rows:
                    rlm_reel_id = getattr(row, "reel_db_id", None)
                    timestamp = getattr(row, "monitoring_ts", None)
                    webspeed = _to_float(getattr(row, "webspeed", None))
                    format_value = _to_float(getattr(row, "format_value", None))
                    if rlm_reel_id is None or timestamp is None or webspeed is None:
                        continue
                    for dashboard_reel_id in dashboard_reel_ids_by_rlm_reel_id.get(int(rlm_reel_id), []):
                        monitoring_by_reel[dashboard_reel_id].append({
                            "timestamp": timestamp,
                            "webspeed": webspeed,
                            "formatValue": format_value,
                        })
                        monitoring_times_by_reel[dashboard_reel_id].append(timestamp)

    inactive_segments_by_reel: Dict[int, List[Dict[str, object]]] = defaultdict(list)
    for row in phase_rows:
        reel_id = getattr(row, "reel_id", None)
        if reel_id is None:
            continue
        reel = reels_by_id.get(reel_id)
        if not reel:
            continue
        phase_name = str(getattr(row, "phase", "") or "").strip().lower()
        if phase_name != "inactive":
            continue
        total_feet = _reel_length_feet(reel)
        start_value = _to_float(reel.reel_start)
        feet_per_unit = _to_float(reel.format_length)
        phase_start = _to_float(getattr(row, "start_format", None))
        phase_end = _to_float(getattr(row, "end_format", None))
        if start_value is None or feet_per_unit is None or phase_start is None or phase_end is None:
            continue
        start_feet = ((phase_start - start_value) * feet_per_unit) / MM_PER_FOOT
        end_feet = ((phase_end - start_value) * feet_per_unit) / MM_PER_FOOT
        start_feet = max(0.0, min(total_feet, start_feet))
        end_feet = max(0.0, min(total_feet, end_feet))
        if end_feet <= start_feet:
            continue
        inactive_segments_by_reel[reel_id].append(
            {
                "phase": phase_name,
                "startFeet": round(start_feet, 3),
                "endFeet": round(end_feet, 3),
                "startTime": _iso(getattr(row, "start_time", None)),
                "endTime": _iso(getattr(row, "end_time", None)),
            }
        )

    defects_by_reel: Dict[int, List[Dict[str, object]]] = defaultdict(list)
    for defect in defects:
        reel = reels_by_id.get(defect.reel_id)
        if not reel:
            continue
        total_feet = _reel_length_feet(reel)
        coordinate_summary = _defect_coordinate_summary(defect.coords_json)
        format_width = _to_float(reel.format_width)
        format_length = _to_float(reel.format_length)
        start_value = _to_float(reel.reel_start)
        format_position = _to_float(defect.format_position)
        local_feet = None
        if start_value is not None and format_position is not None:
            feet_per_unit = _to_float(reel.format_length)
            if feet_per_unit is not None:
                local_feet = ((format_position - start_value) * feet_per_unit) / MM_PER_FOOT
                if total_feet:
                    local_feet = max(0.0, min(total_feet, local_feet))
        matched_sample = _nearest_monitoring_sample(
            monitoring_by_reel.get(defect.reel_id, []),
            monitoring_times_by_reel.get(defect.reel_id, []),
            defect.defect_time,
        )
        defects_by_reel[defect.reel_id].append(
            {
                "defectId": defect.defect_id,
                "time": _iso(defect.defect_time),
                "timeRaw": defect.defect_time,
                "className": defect.class_name,
                "magnitudeValue": _to_float(defect.magnitude_value),
                "severityValue": _to_float(defect.severity_value),
                "imageSrc": (defect.image_src or "").replace("\\", "/"),
                "coords": _serialize_coords(defect.coords_json),
                "coordCentroidX": coordinate_summary["centroid_x"],
                "coordCentroidY": coordinate_summary["centroid_y"],
                "coordMinX": coordinate_summary["min_x"],
                "coordMaxX": coordinate_summary["max_x"],
                "coordMinY": coordinate_summary["min_y"],
                "coordMaxY": coordinate_summary["max_y"],
                "formatWidth": format_width,
                "formatLength": format_length,
                "formatPosition": format_position,
                "feetFromReelStart": round(local_feet, 3) if local_feet is not None else None,
                "reelFeetTotal": round(total_feet, 3) if total_feet is not None else None,
                "webspeed": matched_sample.get("webspeed") if matched_sample else None,
                "jobName": reel.job_name,
                "orderNumber": reel.order_number,
                "reelCode": reel.reel_code,
                "reelId": reel.reel_id,
                "machineId": reel.machine_id,
                "machineName": reel.machine.name if reel.machine else f"Press {reel.machine_id}",
            }
        )

    machines_payload: List[Dict[str, object]] = []
    reels_by_machine: Dict[int, List[Reel]] = defaultdict(list)
    for reel in reels:
        reels_by_machine[reel.machine_id].append(reel)

    for machine_id, machine_reels in reels_by_machine.items():
        if not machine_reels:
            continue
        machine_reels.sort(key=lambda reel: (reel.time_start or datetime.min, reel.reel_id or 0))
        points: List[Dict[str, object]] = []
        speed_points: List[Dict[str, object]] = []
        reference_image_events: List[Dict[str, object]] = []
        mask_events: List[Dict[str, object]] = []
        reel_rows: List[Dict[str, object]] = []
        total_defects = 0
        total_speed_points = 0
        previous_reference_filename: Optional[str] = None
        previous_reference_display_name: Optional[str] = None
        previous_reference_image_src: Optional[str] = None
        previous_mask_signature: Optional[Tuple[Tuple[str, str, str], ...]] = None
        previous_mask_details: List[Dict[str, object]] = []
        for reel in machine_reels:
            total_feet = _reel_length_feet(reel)
            rlm_reel = rlm_reel_by_dashboard_reel.get(reel.reel_id) if reel.reel_id is not None else None
            reel_rows.append(
                {
                    "reelId": reel.reel_id,
                    "reelCode": reel.reel_code,
                    "jobName": reel.job_name,
                    "orderNumber": reel.order_number,
                    "timeStart": _iso(reel.time_start),
                    "timeEnd": _iso(reel.time_end),
                    "reelFeetTotal": round(total_feet, 3),
                    "bstOffSegments": inactive_segments_by_reel.get(reel.reel_id, []),
                }
            )
            ordered_reference_images = sorted(
                [
                    image
                    for image in (reel.reference_images or [])
                    if (image.filename and image.filename.strip()) or (image.image_src and image.image_src.strip())
                ],
                key=lambda image: (
                    _to_float(getattr(image, "format", None)) if _to_float(getattr(image, "format", None)) is not None else float("inf"),
                    int(image.ref_image_id or 0),
                ),
            )
            for image in ordered_reference_images:
                current_filename = str(image.filename or image.image_src or "").strip()
                if not current_filename:
                    continue
                current_filename_key = current_filename.lower()
                current_image_src = (image.image_src or "").replace("\\", "/")
                image_format = _to_float(getattr(image, "format", None))
                image_local_feet = None
                reel_start_value = _to_float(reel.reel_start)
                reel_format_length_bst = _to_float(reel.format_length)
                if reel_start_value is not None and reel_format_length_bst is not None and image_format is not None:
                    image_local_feet = ((image_format - reel_start_value) * reel_format_length_bst) / MM_PER_FOOT
                    if total_feet:
                        image_local_feet = max(0.0, min(total_feet, image_local_feet))
                if previous_reference_filename is not None and current_filename_key != previous_reference_filename:
                    reference_image_events.append(
                        {
                            "reelId": reel.reel_id,
                            "reelCode": reel.reel_code,
                            "jobName": reel.job_name,
                            "orderNumber": reel.order_number,
                            "time": _iso(reel.time_start or reel.time_end),
                            "formatPosition": image_format,
                            "feetFromReelStart": round(image_local_feet, 3) if image_local_feet is not None else None,
                            "filename": current_filename,
                            "previousFilename": previous_reference_display_name,
                            "imageSrc": current_image_src,
                            "previousImageSrc": previous_reference_image_src,
                        }
                    )
                previous_reference_filename = current_filename_key
                previous_reference_display_name = current_filename
                previous_reference_image_src = current_image_src
            ordered_masks = sorted(
                list(reel.masks or []),
                key=lambda mask: (
                    mask.timestamp or datetime.min,
                    int(mask.mask_id or 0),
                    _to_float(getattr(mask, "format_value", None)) if _to_float(getattr(mask, "format_value", None)) is not None else float("inf"),
                ),
            )
            serialized_masks = [_serialize_mask_detail(mask) for mask in ordered_masks]
            current_mask_details = _active_mask_details(serialized_masks)
            current_mask_signature = tuple(sorted(_active_mask_signature(current_mask_details)))
            if current_mask_signature:
                anchor_mask = next(
                    (
                        mask
                        for mask in reversed(ordered_masks)
                        if bool(
                            (getattr(mask, "coords", None) or "").strip()
                            or (getattr(mask, "xml_id", None) or "").strip()
                            or (getattr(mask, "sensitivitysetid", None) or "").strip()
                        )
                    ),
                    None,
                )
                if (
                    previous_mask_signature is not None
                    and current_mask_signature != previous_mask_signature
                    and anchor_mask is not None
                ):
                    mask_format = _to_float(getattr(anchor_mask, "format_value", None))
                    mask_local_feet = None
                    reel_start_value_bst = _to_float(reel.reel_start)
                    reel_format_length_bst = _to_float(reel.format_length)
                    if reel_start_value_bst is not None and reel_format_length_bst is not None and mask_format is not None:
                        mask_local_feet = ((mask_format - reel_start_value_bst) * reel_format_length_bst) / MM_PER_FOOT
                        if total_feet:
                            mask_local_feet = max(0.0, min(total_feet, mask_local_feet))
                    current_coords = (getattr(anchor_mask, "coords", None) or "").strip()
                    previous_coords = ""
                    if previous_mask_details:
                        previous_coords = (previous_mask_details[-1].get("coords") or "").strip()
                    mask_events.append(
                        {
                            "reelId": reel.reel_id,
                            "reelCode": reel.reel_code,
                            "jobName": reel.job_name,
                            "orderNumber": reel.order_number,
                            "time": _iso(anchor_mask.timestamp or reel.time_start or reel.time_end),
                            "formatPosition": mask_format,
                            "feetFromReelStart": round(mask_local_feet, 3) if mask_local_feet is not None else None,
                            "coords": current_coords,
                            "previousCoords": previous_coords,
                            "formatWidth": _to_float(reel.format_width),
                            "formatLength": _to_float(reel.format_length),
                            "beforeMasks": previous_mask_details,
                            "afterMasks": current_mask_details,
                        }
                    )
                previous_mask_signature = current_mask_signature
                previous_mask_details = current_mask_details
            reel_start_value = _to_float(rlm_reel.reel_start) if rlm_reel else None
            reel_format_length = _to_float(rlm_reel.format_length) if rlm_reel else None
            reel_total_feet = compute_reel_feet_from_range(
                _to_float(rlm_reel.reel_start) if rlm_reel else None,
                _to_float(rlm_reel.reel_end) if rlm_reel else None,
                reel_format_length,
            ) if rlm_reel else None
            for sample in monitoring_by_reel.get(reel.reel_id, []):
                sample_local_feet = None
                format_value = _to_float(sample.get("formatValue"))
                if reel_start_value is not None and reel_format_length is not None and format_value is not None:
                    sample_local_feet = ((format_value - reel_start_value) * reel_format_length) / MM_PER_FOOT
                    if reel_total_feet:
                        sample_local_feet = max(0.0, min(reel_total_feet, sample_local_feet))
                speed_points.append(
                    {
                        "time": _iso(sample.get("timestamp")),
                        "webspeed": _to_float(sample.get("webspeed")),
                        "formatPosition": format_value,
                        "feetFromReelStart": round(sample_local_feet, 3) if sample_local_feet is not None else None,
                        "reelFeetTotal": round(reel_total_feet, 3) if reel_total_feet is not None else None,
                        "jobName": reel.job_name,
                        "orderNumber": reel.order_number,
                        "reelCode": reel.reel_code,
                        "reelId": reel.reel_id,
                        "machineId": reel.machine_id,
                        "machineName": reel.machine.name if reel.machine else f"Press {reel.machine_id}",
                    }
                )
                total_speed_points += 1
            previous_speed = None
            for point in defects_by_reel.get(reel.reel_id, []):
                speed = _to_float(point.get("webspeed"))
                speed_delta = None
                if speed is not None and previous_speed is not None:
                    speed_delta = round(speed - previous_speed, 3)
                elif speed is not None:
                    speed_delta = 0.0
                previous_speed = speed if speed is not None else previous_speed
                enriched = {
                    **point,
                    "speedDelta": speed_delta,
                }
                points.append(enriched)
                total_defects += 1
        machine_name = machine_reels[0].machine.name if machine_reels[0].machine else f"Press {machine_id}"
        job_names = {
            _defect_trends_format_job_label(reel.job_name, reel.order_number)
            for reel in machine_reels
            if str(reel.job_name or "").strip()
        }
        machines_payload.append(
            {
                "machineId": machine_id,
                "machineName": machine_name,
                "reels": reel_rows,
                "points": points,
                "speedPoints": speed_points,
                "referenceImageEvents": reference_image_events,
                "maskEvents": mask_events,
                "stats": {
                    "reelCount": len(machine_reels),
                    "defectCount": total_defects,
                    "speedPointCount": total_speed_points,
                    "jobCount": len(job_names),
                },
            }
        )

    machines_payload.sort(key=lambda item: (_machine_sort_key(item.get("machineName")), (item.get("machineName") or "").lower()))
    return {"machines": machines_payload}


def _histogram_from_subquery(session: Session, subquery, column, bins: List[Tuple[float, float, str]]):
    if not bins:
        return []
    selects = [
        func.sum(
            case(
                (
                    and_(column >= lower, column < upper),
                    1,
                ),
                else_=0,
            )
        ).label(label)
        for lower, upper, label in bins
    ]

    row = session.query(*selects).select_from(subquery).one()
    histogram = []
    for idx, (_, _, label) in enumerate(bins):
        histogram.append(
            {
                "bin": label,
                "count": int(row[idx] or 0),
            }
        )
    return histogram


@dashboard_bp.route("/api/defect-trends/options")
def api_defect_trend_options():
    with SessionLocal() as session:
        try:
            filters = _defect_trends_parse_filters(request.args, session)
            start, end = filters["start"], filters["end"]
            min_feet = _defect_trends_parse_min_feet(request.args.get("min_feet"))
            return jsonify(_build_defect_trend_options(session, start, end, min_feet, filters))
        except ValueError as exc:
            return jsonify({"error": str(exc)}), 400
        except Exception as exc:
            current_app.logger.exception("Failed to build defect trend options")
            return jsonify({"error": f"Unable to load defect trend options: {exc}"}), 500


@dashboard_bp.route("/api/defect-trends/data", methods=["POST"])
def api_defect_trend_data():
    payload = request.get_json(silent=True) or {}
    if not isinstance(payload, dict):
        return jsonify({"error": "Invalid JSON payload."}), 400
    with SessionLocal() as session:
        try:
            filters = _defect_trends_parse_filters(payload, session)
            start, end = filters["start"], filters["end"]
            min_feet = _defect_trends_parse_min_feet(payload.get("min_feet"))
            selections = _normalize_defect_trend_selections(payload)
            return jsonify(_build_defect_trend_payload(session, start, end, min_feet, selections, filters))
        except ValueError as exc:
            return jsonify({"error": str(exc)}), 400
        except Exception as exc:
            current_app.logger.exception("Failed to build defect trend data")
            return jsonify({"error": f"Unable to load defect trend data: {exc}"}), 500


@dashboard_bp.route("/api/defect-trends/pattern-analyzer", methods=["POST"])
def api_defect_trend_pattern_analyzer():
    payload = request.get_json(silent=True) or {}
    if not isinstance(payload, dict):
        return jsonify({"error": "Invalid JSON payload."}), 400
    with SessionLocal() as session:
        try:
            filters = _defect_trends_parse_filters(payload, session)
            start, end = filters["start"], filters["end"]
            min_feet = _defect_trends_parse_min_feet(payload.get("min_feet"))
            selections = _normalize_defect_trend_selections(payload)
            return jsonify(_build_defect_pattern_analyzer_payload(session, start, end, min_feet, selections, filters))
        except ValueError as exc:
            return jsonify({"error": str(exc)}), 400
        except Exception as exc:
            current_app.logger.exception("Failed to build defect pattern analyzer")
            return jsonify({"error": f"Unable to load defect pattern analyzer: {exc}"}), 500


@dashboard_bp.route("/api/qc-review")
def api_qc_review():
    with SessionLocal() as session:
        try:
            filters = _validate_filters(session)
        except ValueError as exc:
            return jsonify({"error": str(exc)}), 400

        class_names = request.args.getlist("class_name")
        if len(class_names) == 1 and "," in class_names[0]:
            class_names = [name.strip() for name in class_names[0].split(",") if name.strip()]

        numeric_filters = {
            "magnitude_min": request.args.get("magnitude_min", type=float),
            "magnitude_max": request.args.get("magnitude_max", type=float),
            "severity_min": request.args.get("severity_min", type=float),
            "severity_max": request.args.get("severity_max", type=float),
            "position_min": request.args.get("position_min", type=float),
            "position_max": request.args.get("position_max", type=float),
        }

        focus_reel_id = request.args.get("focus_reel_id", type=int)
        focus_defect_id = request.args.get("focus_defect_id", type=int)

        base_query = _build_defect_query(
            session,
            filters,
            class_names,
            numeric_filters,
            None,
        )

        latest_review_subq = (
            session.query(
                ReelReview.reel_id.label("reel_id"),
                func.max(ReelReview.review_id).label("max_id"),
            )
            .filter(ReelReview.reel_id.isnot(None))
            .group_by(ReelReview.reel_id)
            .subquery()
        )
        finalized_reels_subq = (
            session.query(Reel.reel_id)
            .join(
                latest_review_subq,
                Reel.reel_id == latest_review_subq.c.reel_id,
            )
            .join(
                ReelReview,
                ReelReview.review_id == latest_review_subq.c.max_id,
            )
            .filter(ReelReview.decision.in_(("pass", "fail")))
            .subquery()
        )
        base_query = base_query.filter(
            ~Defect.reel_id.in_(session.query(finalized_reels_subq.c.reel_id))
        )

        pending_filter = and_(
            Defect.severity_score.is_(None),
            or_(Defect.severity_uncertain.is_(None), Defect.severity_uncertain.is_(False)),
            or_(Defect.qc_decision.is_(None), Defect.qc_decision == ""),
        )
        pending_query = base_query.filter(pending_filter)
        has_pending = (
            pending_query.with_entities(Defect.reel_id).limit(1).first()
            is not None
        )

        if focus_defect_id and not focus_reel_id:
            focus_parent = (
                base_query.with_entities(Defect.reel_id)
                .filter(Defect.defect_id == focus_defect_id)
                .first()
            )
            if focus_parent:
                focus_reel_id = focus_parent.reel_id

        def build_reel_context(reel_id: int, target_defect_id: Optional[int] = None):
            reel = (
                session.query(Reel)
                .options(
                    selectinload(Reel.machine),
                    selectinload(Reel.reference_images),
                )
                .filter(Reel.reel_id == reel_id)
                .first()
            )
            if not reel:
                return None

            phases = (
                session.query(InspectionPhase)
                .filter(InspectionPhase.reel_id == reel_id)
                .order_by(InspectionPhase.start_time.asc())
                .all()
            )

            reel_query = base_query.filter(Defect.reel_id == reel_id)
            reel_defect_rows = (
                reel_query.options(selectinload(Defect.reel))
                .order_by(Defect.defect_time.asc(), Defect.defect_id.asc())
                .all()
            )
            if not reel_defect_rows:
                return None

            ordered_refs = _ordered_reference_images(reel.reference_images)
            reference_images = [
                {
                    "filename": ref.filename,
                    "image_src": (ref.image_src or "").replace("\\", "/"),
                }
                for ref in ordered_refs
                if (ref.image_src or "").strip()
            ]
            reference_image = reference_images[0] if reference_images else None

            next_defect_row = (
                reel_query.filter(pending_filter)
                .filter(Defect.image_src.isnot(None))
                .filter(Defect.image_src != "")
                .order_by(Defect.defect_time.desc(), Defect.defect_id.desc())
                .first()
            )
            target_defect_row = None
            if target_defect_id:
                target_defect_row = (
                    reel_query.options(selectinload(Defect.reel))
                    .filter(Defect.defect_id == target_defect_id)
                    .first()
                )
                if not target_defect_row:
                    target_defect_id = None
            if target_defect_row:
                next_defect_row = target_defect_row

            summary_counts = {"pass": 0, "fail": 0, "pending": 0}
            type_breakdown: Dict[str, Dict[str, int]] = defaultdict(lambda: {"pass": 0, "fail": 0, "pending": 0})
            summary_defects: List[Dict[str, Any]] = []
            pending_without_image = 0
            no_image_total = 0
            for defect in reel_defect_rows:
                decision = _normalize_decision(defect.qc_decision)
                bucket = decision if decision in {"pass", "fail"} else "pending"
                summary_counts[bucket] += 1
                class_name = defect.class_name or "Unclassified"
                type_breakdown[class_name][bucket] += 1
                has_image = bool(defect.image_src)
                if not has_image:
                    no_image_total += 1
                    if bucket == "pending" and not has_image:
                        pending_without_image += 1
                summary_defects.append(
                    {
                        "defect_id": defect.defect_id,
                        "class_name": defect.class_name,
                        "magnitude_value": _to_float(defect.magnitude_value),
                        "severity_value": _to_float(defect.severity_value),
                        "format_position": _to_float(defect.format_position),
                        "defect_time": _iso(defect.defect_time),
                        "qc_decision": decision,
                        "has_image": has_image,
                        "defect_category": defect.defect_category,
                        "severity_score": _normalize_int(defect.severity_score),
                        "severity_confidence": _normalize_int(defect.severity_confidence),
                        "severity_uncertain": bool(defect.severity_uncertain),
                        "severity_label": _severity_label(
                            _normalize_int(defect.severity_score), bool(defect.severity_uncertain)
                        ),
                    }
                )

            summary_counts["total"] = sum(summary_counts.values())
            type_breakdown_rows = [
                {
                    "class_name": cls,
                    "pass": counts["pass"],
                    "fail": counts["fail"],
                    "pending": counts["pending"],
                }
                for cls, counts in sorted(type_breakdown.items(), key=lambda item: item[0])
            ]

            latest_review = (
                session.query(ReelReview)
                .filter(ReelReview.reel_id == reel.reel_id)
                .order_by(ReelReview.created_at.desc(), ReelReview.review_id.desc())
                .first()
            )

            next_defect_payload: Optional[Dict[str, Any]] = None
            if next_defect_row:
                phase_value = None
                if next_defect_row.defect_time:
                    phase_value = _phase_for_timestamp(list(phases), next_defect_row.defect_time)
                coords_payload = _serialize_coords(next_defect_row.coords_json)
                next_defect_payload = {
                    "defect_id": next_defect_row.defect_id,
                    "reel_id": next_defect_row.reel_id,
                    "reel_code": reel.reel_code,
                    "order_number": reel.order_number,
                    "job_name": reel.job_name,
                    "class_name": next_defect_row.class_name,
                    "magnitude_value": _to_float(next_defect_row.magnitude_value),
                    "severity_value": _to_float(next_defect_row.severity_value),
                    "format_position": _to_float(next_defect_row.format_position),
                    "defect_time": _iso(next_defect_row.defect_time),
                    "image_src": next_defect_row.image_src,
                    "phase": phase_value,
                    "machine_name": reel.machine.name if reel.machine else None,
                    "coords": coords_payload,
                    "format_length": _to_float(reel.format_length),
                    "format_width": _to_float(reel.format_width),
                    "defect_category": next_defect_row.defect_category,
                    "severity_score": _normalize_int(next_defect_row.severity_score),
                    "severity_confidence": _normalize_int(next_defect_row.severity_confidence),
                    "severity_uncertain": bool(next_defect_row.severity_uncertain),
                    "severity_label": _severity_label(
                        _normalize_int(next_defect_row.severity_score), bool(next_defect_row.severity_uncertain)
                    ),
                    "reference_image": reference_image,
                }

            reel_summary = {
                "reel_id": reel.reel_id,
                "reel_code": reel.reel_code,
                "job_name": reel.job_name,
                "order_number": reel.order_number,
                "machine_name": reel.machine.name if reel.machine else None,
                "counts": summary_counts,
                "defects": summary_defects,
                "by_type": type_breakdown_rows,
                "latest_review": _serialize_review(latest_review),
                "no_image_total": no_image_total,
                "no_image_pending": pending_without_image,
            }

            reel_payload = {
                "reel_id": reel.reel_id,
                "reel_code": reel.reel_code,
                "order_number": reel.order_number,
                "job_name": reel.job_name,
                "machine_name": reel.machine.name if reel.machine else None,
                "time_start": _iso(reel.time_start),
                "time_end": _iso(reel.time_end),
                "format_length": _to_float(reel.format_length),
                "format_width": _to_float(reel.format_width),
                "reference_image": reference_image,
                "reel_start_position": _to_float(reel.reel_start),
                "reel_end_position": _to_float(reel.reel_end),
            }

            return {
                "reel": reel_payload,
                "reel_summary": reel_summary,
                "next_defect": next_defect_payload,
            }

        if focus_reel_id:
            context = build_reel_context(
                focus_reel_id,
                focus_defect_id if focus_defect_id else None,
            )
            if context:
                return jsonify(
                    {
                        "has_pending": True,
                        "reel": context["reel"],
                        "next_defect": context["next_defect"],
                        "reel_summary": context["reel_summary"],
                    }
                )

        if not has_pending:
            return jsonify(
                {
                    "has_pending": False,
                    "reel": None,
                    "next_defect": None,
                    "reel_summary": None,
                }
            )

        target_reel_entry = (
            pending_query.with_entities(
                Defect.reel_id.label("reel_id"),
                func.max(Defect.defect_time).label("latest_defect_time"),
            )
            .group_by(Defect.reel_id)
            .order_by(func.max(Defect.defect_time).desc())
            .first()
        )
        if not target_reel_entry:
            return jsonify({"has_pending": has_pending, "reel": None, "next_defect": None, "reel_summary": None})

        context = build_reel_context(target_reel_entry.reel_id)
        if not context:
            return jsonify({"has_pending": has_pending, "reel": None, "next_defect": None, "reel_summary": None})

        return jsonify(
            {
                "has_pending": True,
                "reel": context["reel"],
                "next_defect": context["next_defect"],
                "reel_summary": context["reel_summary"],
            }
        )


@dashboard_bp.route("/api/qc-review/jobs-overview")
def api_qc_review_jobs_overview():
    with SessionLocal() as session:
        try:
            filters = _validate_filters(session)
        except ValueError as exc:
            return jsonify({"error": str(exc)}), 400

        overview_filters = dict(filters)
        overview_filters["job"] = None
        overview_filters["order"] = None
        overview_filters["reel_code"] = None
        overview_filters["reel_codes"] = []
        overview_filters["reel_ids"] = []

        overview_numeric_filters = {
            "magnitude_min": None,
            "magnitude_max": None,
            "severity_min": None,
            "severity_max": None,
            "position_min": None,
            "position_max": None,
        }

        base_query = _build_defect_query(
            session,
            overview_filters,
            [],
            overview_numeric_filters,
            None,
        )

        latest_review_subq = (
            session.query(
                ReelReview.reel_id.label("reel_id"),
                func.max(ReelReview.review_id).label("max_id"),
            )
            .filter(ReelReview.reel_id.isnot(None))
            .group_by(ReelReview.reel_id)
            .subquery()
        )
        finalized_reels_subq = (
            session.query(Reel.reel_id)
            .join(
                latest_review_subq,
                Reel.reel_id == latest_review_subq.c.reel_id,
            )
            .join(
                ReelReview,
                ReelReview.review_id == latest_review_subq.c.max_id,
            )
            .filter(ReelReview.decision.in_(("pass", "fail")))
            .subquery()
        )
        base_query = base_query.filter(
            ~Defect.reel_id.in_(session.query(finalized_reels_subq.c.reel_id))
        )

        pending_filter = and_(
            Defect.severity_score.is_(None),
            or_(Defect.severity_uncertain.is_(None), Defect.severity_uncertain.is_(False)),
            or_(Defect.qc_decision.is_(None), Defect.qc_decision == ""),
        )
        pending_query = base_query.filter(pending_filter)
        overview = _reel_status_overview(
            session, overview_filters, base_query, pending_query, latest_review_subq
        )
        return jsonify({"overview": overview})


@dashboard_bp.route("/api/qc-review/review-summary")
def api_qc_review_review_summary():
    with SessionLocal() as session:
        try:
            filters = _validate_filters(session)
        except ValueError as exc:
            return jsonify({"error": str(exc)}), 400

        reel_rows = (
            _apply_reel_filters(session.query(Reel.reel_id.label("reel_id")), filters)
            .distinct()
            .all()
        )
        reel_ids = [row.reel_id for row in reel_rows if row and row.reel_id]
        return jsonify(_build_review_summary_payload(session, reel_ids))


@dashboard_bp.route("/api/qc-review/review-summary/history")
def api_qc_review_review_summary_history():
    with SessionLocal() as session:
        return jsonify(_build_review_history_summary(session))


@dashboard_bp.route("/api/defects/<int:defect_id>/decision", methods=["POST"])
def api_defect_decision(defect_id: int):
    payload = request.get_json(silent=True) or {}
    raw_severity = payload.get("severity")
    severity_score = _normalize_int(raw_severity)
    if raw_severity is not None and severity_score is None:
        return jsonify({"error": "Severity must be a number between 0 and 5."}), 400
    if severity_score is not None and not (0 <= severity_score <= 5):
        return jsonify({"error": "Severity must be between 0 and 5."}), 400
    raw_confidence = payload.get("confidence")
    severity_confidence = None
    if raw_confidence is not None:
        severity_confidence = _normalize_int(raw_confidence)
        if severity_confidence is None or not (1 <= severity_confidence <= 3):
            return jsonify({"error": "Confidence must be 1 (low), 2 (medium), or 3 (high)."}), 400
    uncertain_flag = bool(payload.get("uncertain"))
    if not uncertain_flag and severity_score is None:
        return jsonify({"error": "Select a severity or mark the defect as uncertain."}), 400
    if severity_score is not None and severity_confidence is None:
        return jsonify({"error": "Select a confidence level for the chosen severity."}), 400

    update_category = "defect_category" in payload
    defect_category: Optional[str] = None
    if update_category:
        raw_category = payload.get("defect_category")
        if raw_category is None:
            defect_category = None
        else:
            value = str(raw_category).strip()
            defect_category = value or None

    with SessionLocal() as session:
        defect = session.query(Defect).filter(Defect.defect_id == defect_id).first()
        if not defect:
            return jsonify({"error": "Defect not found."}), 404

        defect.severity_score = severity_score
        defect.severity_confidence = severity_confidence
        defect.severity_uncertain = uncertain_flag
        if uncertain_flag:
            defect.qc_decision = "uncertain"
        else:
            defect.qc_decision = _qc_decision_from_severity(severity_score)
        if update_category:
            defect.defect_category = defect_category
        session.commit()
        return jsonify(
            {
                "defect_id": defect.defect_id,
                "severity": severity_score,
                "confidence": severity_confidence,
                "uncertain": uncertain_flag,
            }
        )
def _normalize_defect_label(value: Optional[str]) -> Optional[str]:
    if not value:
        return None
    return str(value).strip().lower()


def _canonical_sensitivity_class(value: Optional[str]) -> Optional[str]:
    normalized = _normalize_defect_label(value)
    if not normalized:
        return None
    return SENSITIVITY_CLASS_CANONICAL.get(normalized)