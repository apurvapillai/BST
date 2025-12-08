from __future__ import annotations

import copy
import json
import math
from collections import Counter, defaultdict
from datetime import datetime, timedelta
from decimal import Decimal
from typing import Any, Dict, Iterable, List, Optional, Set, Tuple

from flask import Blueprint, jsonify, render_template, request
from sqlalchemy import and_, case, exists, false, func, literal, or_, text
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


DAYS_DEFAULT_RANGE = 2
MAX_PAGE_SIZE = 500
SENTINEL_NONE = "__NONE__"
SIZE_BUCKET_SENTINEL_NONE = "__none__"

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

dashboard_bp = Blueprint("dashboard", __name__)


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


def _defect_buckets(
    defects: Iterable[Defect],
    window_start: datetime,
    window_end: datetime,
) -> Tuple[List[Dict[str, object]], List[Dict[str, object]], int, int]:
    by_type = defaultdict(int)
    trend = defaultdict(int)
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
            trend[bucket] += 1

    defects_by_type = [
        {"class": cls, "count": count}
        for cls, count in sorted(by_type.items(), key=lambda item: item[1], reverse=True)
    ]
    defects_trend = [
        {"time": _iso(ts), "count": count}
        for ts, count in sorted(trend.items())
    ]
    return defects_by_type, defects_trend, len(unique_classes), total


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
        default_start_date=default_start_date,
        default_end_date=default_end_date,
        default_job=default_job,
    )


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

        job_filters = dict(filters)
        job_filters["job"] = None
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

        order_filters = dict(filters)
        order_filters["order"] = None
        order_filters["reel_code"] = None
        order_filters["reel_codes"] = []
        order_filters["reel_ids"] = []
        order_query = _apply_reel_filters(
            session.query(Reel), order_filters, include_reel_code=False
        )
        if filters.get("job"):
            order_query = order_query.filter(Reel.job_name == filters["job"])
        order_rows = (
            order_query.with_entities(
                Reel.order_number,
                func.max(Reel.time_end).label("latest"),
            )
            .group_by(Reel.order_number)
            .order_by(func.max(Reel.time_end).desc())
            .all()
        )

        order_values: List[str] = []
        has_null_order = False
        for order_value, _ in order_rows:
            if order_value is None or (isinstance(order_value, str) and not order_value.strip()):
                has_null_order = True
            else:
                order_values.append(order_value)
        if has_null_order:
            order_values.insert(0, SENTINEL_NONE)

        reel_query = order_query
        order_filter = filters.get("order")
        if order_filter:
            if order_filter == SENTINEL_NONE:
                reel_query = reel_query.filter(or_(Reel.order_number.is_(None), Reel.order_number == ""))
            else:
                reel_query = reel_query.filter(Reel.order_number == order_filter)
        reel_rows = (
            reel_query.with_entities(
                Reel.reel_id,
                Reel.reel_code,
                Reel.order_number,
                Reel.time_end,
            )
            .order_by(Reel.time_end.desc())
            .all()
        )

        def _reel_label(code: Optional[str], order_value: Optional[str], time_end: Optional[datetime]) -> str:
            label_parts: List[str] = []
            if code:
                label_parts.append(code)
            if order_value:
                label_parts.append(str(order_value))
            if time_end:
                label_parts.append(time_end.strftime("%Y-%m-%d %H:%M"))
            return " · ".join(label_parts) or "Reel"

        reel_options = [
            {
                "reel_id": reel_id,
                "reel_code": reel_code,
                "label": _reel_label(reel_code, order_number, time_end),
            }
            for reel_id, reel_code, order_number, time_end in reel_rows
            if reel_id is not None
        ]

        return jsonify(
            {
                "jobs": [job for job, _ in jobs],
                "orders": order_values,
                "reel_codes": reel_options,
            }
        )


@dashboard_bp.route("/api/overview")
def api_overview():
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
            _apply_reel_filters(session.query(Reel), filters)
            .options(
                selectinload(Reel.inspection_phases),
                selectinload(Reel.defects),
                selectinload(Reel.sensitivity_sets),
                selectinload(Reel.masks),
                selectinload(Reel.reference_images),
                selectinload(Reel.rlm_config),
                selectinload(Reel.rlm_monitoring),
                selectinload(Reel.rlm_phases),
            )
            .all()
        )

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
        EVENT_SENSITIVITY = "sensitivity_change"
        EVENT_RLM = "rlm_config_change"
        TIMELINE_EVENT_TYPES = {EVENT_MASK, EVENT_SENSITIVITY, EVENT_RLM, EVENT_REFERENCE}

        event_aggregates: Dict[Tuple[str, datetime, str], Dict[str, object]] = {}
        summary_counts: Dict[str, Dict[str, int]] = defaultdict(lambda: defaultdict(int))
        job_trackers: Dict[Tuple[str, str], Dict[str, object]] = {}
        job_defect_timeline: Dict[Tuple[str, datetime], int] = defaultdict(int)
        job_reel_defect_timeline: Dict[Tuple[str, str, Optional[int], datetime], int] = defaultdict(int)
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
        rlm_trend_points: List[Dict[str, object]] = []
        rlm_reel_spans: List[Dict[str, object]] = []

        def job_label(name: Optional[str]) -> str:
            return name or "Unassigned"

        def mask_signature(masks: Iterable[Mask]) -> List[Tuple[str, str, str]]:
            signature: List[Tuple[str, str, str]] = []
            for m in masks or []:
                coords = (m.coords or "").strip() if m.coords else ""
                signature.append(((m.xml_id or "").strip(), (m.sensitivitysetid or "").strip(), coords))
            signature.sort()
            return signature

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

            if event_type == EVENT_DEFECT:
                job_defect_timeline[(job_display, bucket)] += count
            else:
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
                if event_type in TIMELINE_EVENT_TYPES:
                    operations_entry["event_counts"][event_type] += count
                    if reel_code:
                        operations_entry["reels_by_type"][event_type].add(reel_code)
                    if detail is not None:
                        operations_entry["details_by_type"][event_type].append(copy.deepcopy(detail))

        reels_sorted = sorted(reels, key=lambda r: r.time_start or datetime.min)

        job_set = set()
        jobs_meters = defaultdict(float)
        jobs_time = defaultdict(lambda: {"active": 0.0, "inactive": 0.0, "learn": 0.0})
        jobs_length = defaultdict(lambda: {"active": 0.0, "inactive": 0.0, "learn": 0.0})
        jobs_defects = defaultdict(int)
        state_buckets: Dict[datetime, Dict[str, float]] = defaultdict(lambda: defaultdict(float))
        job_reference_latest: Dict[str, Dict[str, Any]] = {}
        job_heatmap_records: Dict[Tuple[str, str], List[Dict[str, Any]]] = defaultdict(list)
        job_heatmap_dims: Dict[Tuple[str, str], Dict[str, Optional[float]]] = {}

        totals = {
            "length": 0.0,
            "active_seconds": 0.0,
            "inactive_seconds": 0.0,
            "learn_seconds": 0.0,
            "active_length": 0.0,
            "inactive_length": 0.0,
            "learn_length": 0.0,
        }

        defects = []
        for reel in reels_sorted:
            job_name = reel.job_name
            job_display = job_label(job_name)
            job_key = (job_name or SENTINEL_NONE, reel.order_number or SENTINEL_NONE)
            tracker = job_trackers.setdefault(
                job_key, {"sens": None, "rlm_config": None, "mask_signature": None}
            )

            job_order_key = (job_name or SENTINEL_NONE, reel.order_number or SENTINEL_NONE)
            order_display = reel.order_number if reel.order_number else None
            heatmap_key = (job_display, order_display or SENTINEL_NONE)
            job_order_entry = job_order_metrics.setdefault(
                job_order_key,
                {
                    "job_key": job_name or SENTINEL_NONE,
                    "order_key": reel.order_number or SENTINEL_NONE,
                    "job_display": job_display,
                    "order_display": order_display,
                    "reference_changes": 0,
                    "rlm_monitor_count": 0,
                    "defect_count": 0,
                    "defect_classes": Counter(),
                    "phase_seconds": defaultdict(float),
                    "mask_count": 0,
                    "mask_counter": Counter(),
                    "rlm_points": [],
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
                    "rlm_points": [],
                },
            )

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

            width_val = _to_float(reel.format_width)
            length_val = _to_float(reel.format_length)
            heatmap_key = (job_display, order_display or SENTINEL_NONE)
            if (
                heatmap_key not in job_heatmap_dims
                and width_val is not None
                and length_val is not None
            ):
                job_heatmap_dims[heatmap_key] = {
                    "format_width": width_val,
                    "format_length": length_val,
                }

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

            for defect in reel.defects or []:
                defects.append(defect)
                if not _defect_within_window(defect, window_start, window_end):
                    continue
                if job_name:
                    jobs_defects[job_name] += 1
                if defect.coords_json:
                    job_heatmap_records[heatmap_key].append(
                        {
                            "coords": defect.coords_json,
                            "magnitude_value": _to_float(defect.magnitude_value),
                            "severity_value": _to_float(defect.severity_value),
                            "defect_id": defect.defect_id,
                            "reel_id": reel.reel_id,
                            "order": order_display,
                        }
                    )
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

            reel_defects_in_window = [
                d for d in reel.defects or [] if _defect_within_window(d, window_start, window_end)
            ]
            if reel_defects_in_window:
                reel_ts = reel.time_end or reel.time_start or window_end
                reel_label = reel.reel_code or (f"Reel {reel.reel_id}" if reel.reel_id else "Reel")
                job_reel_defect_timeline[(job_display, reel_label, reel.reel_id, reel_ts)] += len(reel_defects_in_window)

            _accumulate_phase_buckets(
                state_buckets,
                inspection_phases_sorted,
                window_start,
                window_end,
            )

            # Reference image changes
            ordered_refs = _ordered_reference_images(reel.reference_images)
            ref_change_pairs = _reference_change_pairs(ordered_refs)
            reel_operation_counter: Counter = Counter()
            if ref_change_pairs:
                change_time = reel.time_end or reel.time_start or window_end
                change_count = len(ref_change_pairs)
                job_order_entry["reference_changes"] += change_count
                job_summary_entry["reference_changes"] += change_count
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

            if ordered_refs:
                reel_timestamp = reel.time_end or reel.time_start or datetime.min
                images: List[Dict[str, str]] = []
                for ref in ordered_refs:
                    image_src = (ref.image_src or "").replace("\\", "/")
                    if not image_src:
                        continue
                    images.append({"filename": ref.filename, "image_src": image_src})
                    if len(images) >= 6:
                        break
                if images:
                    current_ref = job_reference_latest.get(job_display)
                    if not current_ref or (reel_timestamp and reel_timestamp > current_ref.get("time", datetime.min)):
                        job_reference_latest[job_display] = {"time": reel_timestamp, "images": images}

            # Mask applications
            masks_in_window = [
                mask for mask in (reel.masks or []) if mask.timestamp and window_start <= mask.timestamp <= window_end
            ]
            for mask in masks_in_window:
                detail = {
                    "xml_id": mask.xml_id,
                    "sensitivity_id": mask.sensitivitysetid,
                    "format_value": _to_float(mask.format_value),
                }
                mask_label = (
                    (mask.xml_id or "").strip()
                    or (mask.sensitivitysetid or "").strip()
                    or "Mask"
                )
                job_order_entry["mask_count"] += 1
                job_summary_entry["mask_count"] += 1
                if mask_label:
                    job_order_entry["mask_counter"][mask_label] += 1
                    job_summary_entry["mask_counter"][mask_label] += 1
                record_event(
                    job_name,
                    mask.timestamp,
                    EVENT_MASK,
                    detail=detail,
                    reel_code=reel.reel_code,
                )

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

            monpoints = _extract_monpoints(reel.rlm_config.config_json) if reel.rlm_config else []
            if monpoints:
                job_order_entry.setdefault("rlm_points", []).extend(monpoints)
                job_summary_entry.setdefault("rlm_points", []).extend(monpoints)

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

            span_start = reel.time_start or window_start
            span_end = reel.time_end or window_end
            if span_start and span_end:
                # store raw span; padding applied client-side
                rlm_reel_spans.append(
                    {
                        "start": _iso(span_start),
                        "end": _iso(span_end),
                        "reel_code": reel.reel_code,
                        "reel_id": reel.reel_id,
                        "job_name": job_name,
                        "order_number": reel.order_number,
                    }
                )

            for monitor in reel.rlm_monitoring or []:
                ts = monitor.timestamp
                if not ts or ts < window_start or ts > window_end:
                    continue
                rlm_trend_points.append(
                    {
                        "time": _iso(ts),
                        "webspeed": _to_float(monitor.webspeed),
                        "repeat_length": _to_float(monitor.curlength),
                        "reel_code": reel.reel_code,
                        "reel_id": reel.reel_id,
                        "job_name": job_name,
                        "order_number": reel.order_number,
                    }
                )

            monitor_count = sum(
                1
                for monitor in reel.rlm_monitoring or []
                if monitor.timestamp and window_start <= monitor.timestamp <= window_end
            )
            if monitor_count:
                job_order_entry["rlm_monitor_count"] += monitor_count
                job_summary_entry["rlm_monitor_count"] += monitor_count

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
            defects, window_start, window_end
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

        job_defects_timeline = [
            {"job": job, "time": _iso(bucket), "count": int(count)}
            for (job, bucket), count in sorted(
                job_defect_timeline.items(), key=lambda item: (item[0][1], item[0][0])
            )
        ]
        job_reel_defects_timeline = [
            {
                "job": job,
                "reel_code": reel_code,
                "reel_id": reel_id,
                "time": _iso(bucket),
                "count": int(count),
            }
            for (job, reel_code, reel_id, bucket), count in sorted(
                job_reel_defect_timeline.items(),
                key=lambda item: (item[0][3], item[0][0], item[0][1]),
            )
        ]
        job_reel_operations_timeline = [
            entry
            for entry in sorted(
                reel_operations_timeline_points,
                key=lambda item: (item.get("time") or "", item.get("job") or "", item.get("reel_code") or "", item.get("event_type") or ""),
            )
        ]

        job_operations_timeline = []
        for (job, bucket), payload in sorted(
            job_operations_timeline_map.items(),
            key=lambda item: (item[1]["time"], item[0][0]),
        ):
            counts = payload["event_counts"]
            total = int(sum(counts.values()))
            if not total:
                continue
            events = []
            reels_by_type = payload["reels_by_type"]
            details_by_type = payload.get("details_by_type", {})
            if isinstance(details_by_type, defaultdict):
                details_by_type = {key: list(value) for key, value in details_by_type.items()}
            for event_type, cnt in sorted(counts.items()):
                reels = sorted({code for code in reels_by_type.get(event_type, set()) if code})
                events.append(
                    {
                        "event_type": event_type,
                        "count": int(cnt),
                        "reel_codes": reels,
                        "details": details_by_type.get(event_type, [])[:5],
                    }
                )
            job_operations_timeline.append(
                {
                    "job": job,
                    "time": _iso(payload["time"]),
                    "total": total,
                    "events": events,
                }
            )

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

        for job_name in job_set:
            display = job_label(job_name)
            job_reference_latest.setdefault(display, {"time": None, "images": []})

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

        job_heatmap_payload: List[Dict[str, Any]] = []
        for (job_display, order_key), entries in sorted(job_heatmap_records.items()):
            dims = job_heatmap_dims.get((job_display, order_key)) or {}
            refs = (job_reference_latest.get(job_display) or {}).get("images", [])
            first_ref = None
            for ref in refs:
                if ref.get("image_src"):
                    first_ref = ref["image_src"]
                    break
            job_heatmap_payload.append(
                {
                    "job": job_display,
                    "order": None if order_key == SENTINEL_NONE else order_key,
                    "format_width": dims.get("format_width"),
                    "format_length": dims.get("format_length"),
                    "defects": entries,
                    "reference_images": refs,
                    "reference_background": first_ref,
                }
            )

        rlm_trend_points_sorted = sorted(
            rlm_trend_points,
            key=lambda entry: (entry.get("time") or ""),
        )
        rlm_reel_spans_sorted = sorted(
            rlm_reel_spans,
            key=lambda entry: (entry.get("start") or ""),
        )

        def _rlm_reel_row(span: Dict[str, object]) -> Dict[str, object]:
            meters = None
            reel_id = span.get("reel_id")
            reel_code = span.get("reel_code")
            if reel_id:
                try:
                    reel_obj = next((r for r in reels_sorted if r.reel_id == reel_id), None)
                except Exception:
                    reel_obj = None
                if reel_obj and reel_obj.reel_start is not None and reel_obj.reel_end is not None:
                    meters = max(
                        (_to_float(reel_obj.reel_end) or 0.0) - (_to_float(reel_obj.reel_start) or 0.0),
                        0.0,
                    )
            return {
                "reel_code": reel_code,
                "reel_id": reel_id,
                "job_name": span.get("job_name"),
                "order_number": span.get("order_number"),
                "start": span.get("start"),
                "end": span.get("end"),
                "meters": meters,
            }

        rlm_reel_table = [_rlm_reel_row(span) for span in rlm_reel_spans_sorted]

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
            "jobs_defects_timeline": job_defects_timeline,
            "job_reel_defects_timeline": job_reel_defects_timeline,
            "job_operations_timeline": job_operations_timeline,
            "job_reel_operations_timeline": job_reel_operations_timeline,
            "job_order_metrics": job_order_metrics_payload,
            "job_metrics": job_metrics_payload,
            "job_heatmaps": job_heatmap_payload,
            "rlm_trend": {
                "points": rlm_trend_points_sorted,
                "reel_spans": rlm_reel_spans_sorted,
                "table": rlm_reel_table,
            },
        }
    return jsonify(response)


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


@dashboard_bp.route("/api/job-explorer")
def api_job_explorer():
    with SessionLocal() as session:
        try:
            filters = _validate_filters(session)
        except ValueError as exc:
            return jsonify({"error": str(exc)}), 400

        page, page_size = _paginate()
        base_query = _apply_reel_filters(session.query(Reel), filters, include_reel_code=False)

        raw_status_filters = request.args.getlist("review_status")
        valid_statuses = {"pass", "fail", "uninspected"}
        status_filter = None
        for raw_value in raw_status_filters:
            normalized = (raw_value or "").strip().lower()
            if normalized in valid_statuses:
                status_filter = normalized
                break

        REVIEW_DECISION_COLLATION = "utf8mb4_unicode_ci"
        review_code_expr = ReelReview.reel_code.collate(REVIEW_DECISION_COLLATION)
        latest_review_subq = (
            session.query(
                review_code_expr.label("lrr_code"),
                func.max(ReelReview.review_id).label("lrr_review_id"),
            )
            .group_by(review_code_expr)
            .subquery()
        )

        base_query = (
            base_query.outerjoin(
                latest_review_subq,
                Reel.reel_code.collate(REVIEW_DECISION_COLLATION) == latest_review_subq.c.lrr_code,
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

        total = base_query.count()
        reels = (
            base_query.order_by(Reel.time_start.desc())
            .offset((page - 1) * page_size)
            .limit(page_size)
            .options(
                selectinload(Reel.reference_images),
                selectinload(Reel.inspection_phases),
                selectinload(Reel.sensitivity_sets),
                selectinload(Reel.masks),
                selectinload(Reel.rlm_phases),
                selectinload(Reel.rlm_monitoring),
                selectinload(Reel.rlm_config),
                selectinload(Reel.defects),
            )
            .all()
        )

        baseline_cache: Dict[Tuple[str, str], Optional[Reel]] = {}
        reel_code_to_review: Dict[str, ReelReview] = {}
        reel_codes = [reel.reel_code for reel in reels if reel and reel.reel_code]
        if reel_codes:
            review_rows = (
                session.query(ReelReview)
                .filter(ReelReview.reel_code.in_(reel_codes))
                .order_by(ReelReview.reel_code.asc(), ReelReview.created_at.desc(), ReelReview.review_id.desc())
                .all()
            )
            for review in review_rows:
                code = review.reel_code
                if code and code not in reel_code_to_review:
                    reel_code_to_review[code] = review
        items: List[Dict[str, object]] = []

        for reel in reels:
            job_key = reel.job_name or SENTINEL_NONE
            order_key = reel.order_number or SENTINEL_NONE
            cache_key = (job_key, order_key)
            if cache_key not in baseline_cache:
                baseline_cache[cache_key] = _baseline_for_job_order(
                    session, filters, reel.job_name, reel.order_number
                )
            baseline = baseline_cache[cache_key]

            reel_meters = 0.0
            if reel.reel_start is not None and reel.reel_end is not None:
                start_val = _to_float(reel.reel_start) or 0.0
                end_val = _to_float(reel.reel_end) or 0.0
                reel_meters = max(end_val - start_val, 0.0)

            ordered_refs = _ordered_reference_images(reel.reference_images)
            ref_images = [
                {
                    "filename": img.filename,
                    "image_src": (img.image_src or "").replace("\\", "/"),
                }
                for img in ordered_refs
            ]

            ref_change_pairs = _reference_change_pairs(ordered_refs)
            ref_change_count = len(ref_change_pairs)
            ref_change_times: List[str] = []

            current_std = _standard_map(reel.sensitivity_sets)
            baseline_std = _standard_map(baseline.sensitivity_sets) if baseline else {}
            sens_changes = []
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
                        "thres_delta": round(curr_thresh - prev_thresh, 3) if prev_thresh is not None and curr_thresh is not None else None,
                        "warn_delta": round(curr_warn - prev_warn, 3) if prev_warn is not None and curr_warn is not None else None,
                    }
                )

            rlm_enabled = bool(reel.rlm_config or (reel.rlm_phases or []))
            rlm_seconds = _phase_seconds(reel.rlm_phases or [], filters["start"], filters["end"])
            rlm_active_seconds = rlm_seconds.get("active", 0.0)
            rlm_total_seconds = sum(rlm_seconds.values())
            rlm_active_pct = round(rlm_active_seconds / rlm_total_seconds * 100, 1) if rlm_total_seconds else 0.0
            rlm_monitor_count = sum(
                1
                for mon in reel.rlm_monitoring or []
                if mon.timestamp and filters["start"] <= mon.timestamp <= filters["end"]
            )

            baseline_config_flat = _flatten_config(baseline.rlm_config.config_json) if baseline and baseline.rlm_config else {}
            current_config_flat = _flatten_config(reel.rlm_config.config_json) if reel.rlm_config else {}
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

            phase_mix = _phase_mix_for_reel(reel, filters["start"], filters["end"])
            total_phase_seconds = sum(entry.get("seconds", 0.0) for entry in phase_mix.values())
            phase_mix_pct = {
                key: round(entry.get("seconds", 0.0) / total_phase_seconds * 100, 1)
                for key, entry in phase_mix.items()
                if total_phase_seconds
            }
            active_inspection_pct = phase_mix_pct.get("active", 0.0) if phase_mix_pct else 0.0

            defects_visible = [
                d
                for d in reel.defects or []
                if _defect_within_window(d, filters["start"], filters["end"])
            ]

            latest_review_obj = reel_code_to_review.get(reel.reel_code or "")
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
                "order_number": reel.order_number,
                "time_start": _iso(reel.time_start),
                "time_end": _iso(reel.time_end),
                "meters": round(reel_meters, 2),
                "format_length": _to_float(reel.format_length),
                "format_width": _to_float(reel.format_width),
                "ref_images": ref_images,
                "ref_change_count": ref_change_count,
                "ref_change_times": [ts for ts in ref_change_times if ts],
                "sens_standard_changed": bool(sens_changes),
                "sens_changed_classes": sens_changes,
                "mask_count": len(reel.masks or []),
                "rlm_enabled": rlm_enabled,
                "rlm_active_pct": rlm_active_pct,
                "rlm_monitor_count": rlm_monitor_count,
                "rlm_config_drift": rlm_drift,
                "defect_count": len(defects_visible),
                "defect_types": len({d.class_name for d in defects_visible if d.class_name}),
                "phase_mix_pct": phase_mix_pct,
                "active_inspection_pct": active_inspection_pct,
                "review": serialized_review,
                "review_status": review_status,
            }
            items.append(item)

        total_pages = (total + page_size - 1) // page_size if total else 1
        return jsonify(
            {
                "items": items,
                "total": total,
                "page_info": {
                    "page": page,
                    "page_size": page_size,
                    "total": total,
                    "total_pages": total_pages or 1,
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
                selectinload(Reel.rlm_monitoring),
                selectinload(Reel.defects),
            )
            .first()
        )
        if not reel:
            return jsonify({"error": "Reel not found"}), 404

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
            }
            for mask in sorted(reel.masks or [], key=lambda x: x.timestamp or datetime.min)
        ]

        inspection_phases = [
            {
                "phase": phase.phase,
                "start_time": _iso(phase.start_time),
                "end_time": _iso(phase.end_time),
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
            }
            for defect in sorted(reel.defects or [], key=lambda x: x.defect_time or datetime.min)
        ]

        response = {
            "reel": {
                "reel_id": reel.reel_id,
                "reel_code": reel.reel_code,
                "machine": reel.machine.name if reel.machine else None,
                "job_name": reel.job_name,
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
            "inspection_phases": inspection_phases,
            "rlm": {
                "config": reel.rlm_config.config_json if reel.rlm_config else None,
                "phases": rlm_phases,
                "monitor_count": len(reel.rlm_monitoring or []),
                "points": _extract_monpoints(reel.rlm_config.config_json) if reel.rlm_config else [],
                "tolerances": _extract_tolerances(reel.rlm_config.config_json) if reel.rlm_config else None,
            },
            "defects_summary": defects_summary,
            "defects": defects_payload,
        }
        if reel.reel_code:
            latest_review = (
                session.query(ReelReview)
                .filter(ReelReview.reel_code == reel.reel_code)
                .order_by(ReelReview.created_at.desc(), ReelReview.review_id.desc())
                .first()
            )
        else:
            latest_review = None
        response["review"] = _serialize_review(latest_review)
        return jsonify(response)


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
                .filter(ReelReview.reel_code == reel.reel_code)
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


@dashboard_bp.route("/api/defects")
def api_defects():
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
        size_min = request.args.get("size_min", type=float)
        size_max = request.args.get("size_max", type=float)

        raw_size_buckets = request.args.getlist("size_bucket")
        if len(raw_size_buckets) == 1 and "," in raw_size_buckets[0]:
            raw_size_buckets = [
                entry.strip()
                for entry in raw_size_buckets[0].split(",")
                if entry.strip()
            ]

        bucket_none_selected = False
        size_bucket_keys: List[str] = []
        for key in raw_size_buckets:
            if key == SIZE_BUCKET_SENTINEL_NONE:
                bucket_none_selected = True
                size_bucket_keys = []
                break
            if key in HEATMAP_BUCKET_MAP and key not in size_bucket_keys:
                size_bucket_keys.append(key)
        if size_bucket_keys and len(size_bucket_keys) >= len(HEATMAP_BUCKETS):
            size_bucket_keys = []
        size_filter_active = (
            bucket_none_selected
            or bool(size_bucket_keys)
            or size_min is not None
            or size_max is not None
        )

        phase_filter = request.args.get("phase")
        if phase_filter not in (None, "", "active", "inactive", "learn"):
            return jsonify({"error": "Invalid phase filter"}), 400

        base_query = _build_defect_query(
            session,
            filters,
            class_names,
            numeric_filters,
            phase_filter or None,
        )

        if size_filter_active:
            if bucket_none_selected:
                base_query = base_query.filter(false())
            else:
                allowed_ranges = _resolve_size_ranges(size_bucket_keys, size_min, size_max)
                if not allowed_ranges:
                    base_query = base_query.filter(false())
                else:
                    area_rows = base_query.with_entities(Defect.defect_id, Defect.coords_json).all()
                    matching_ids = {
                        defect_id
                        for defect_id, coords in area_rows
                        if _matches_size_ranges(coords, allowed_ranges)
                    }
                    if not matching_ids:
                        base_query = base_query.filter(false())
                    else:
                        base_query = base_query.filter(Defect.defect_id.in_(matching_ids))

        page, page_size = _paginate()
        rows_query = base_query.options(
            selectinload(Defect.reel).selectinload(Reel.masks),
            selectinload(Defect.reel).selectinload(Reel.reference_images),
        )
        total = rows_query.count()
        rows = (
            rows_query.order_by(Defect.defect_time.desc())
            .offset((page - 1) * page_size)
            .limit(page_size)
            .all()
        )

        result_rows = []
        mask_entries: List[Dict[str, Optional[str]]] = []
        seen_mask_ids: Set[int] = set()
        reference_images: List[Dict[str, Optional[str]]] = []
        seen_reference_ids: Set[int] = set()
        format_lengths: List[float] = []
        format_widths: List[float] = []
        if rows:
            reel_ids = {row.reel_id for row in rows}
            phase_map: Dict[int, List[InspectionPhase]] = defaultdict(list)
            if reel_ids:
                for phase in (
                    session.query(InspectionPhase)
                    .filter(InspectionPhase.reel_id.in_(reel_ids))
                    .all()
                ):
                    phase_map[phase.reel_id].append(phase)

            for defect in rows:
                reel = defect.reel
                phase_name = None
                if defect.defect_time:
                    phase_name = _phase_for_timestamp(phase_map.get(defect.reel_id, []), defect.defect_time)
                format_length = _to_float(reel.format_length) if reel else None
                format_width = _to_float(reel.format_width) if reel else None
                if format_length is not None:
                    format_lengths.append(format_length)
                if format_width is not None:
                    format_widths.append(format_width)
                if reel and reel.masks:
                    for mask in reel.masks:
                        mask_id = getattr(mask, "mask_id", None)
                        if mask_id is not None and mask_id in seen_mask_ids:
                            continue
                        if mask_id is not None:
                            seen_mask_ids.add(mask_id)
                        mask_entries.append(
                            {
                                "timestamp": _iso(mask.timestamp),
                                "coords": mask.coords,
                                "format_value": _to_float(mask.format_value),
                                "xml_id": mask.xml_id,
                                "sensitivitysetid": mask.sensitivitysetid,
                            }
                        )
                if reel and reel.reference_images and len(reference_images) < 4:
                    ordered_refs = sorted(
                        reel.reference_images,
                        key=lambda img: getattr(img, "ref_image_id", 0) or 0,
                        reverse=True,
                    )
                    for ref in ordered_refs:
                        if len(reference_images) >= 4:
                            break
                        ref_id = getattr(ref, "ref_image_id", None)
                        if ref_id is not None and ref_id in seen_reference_ids:
                            continue
                        if ref_id is not None:
                            seen_reference_ids.add(ref_id)
                        reference_images.append(
                            {
                                "ref_image_id": ref_id,
                                "filename": ref.filename,
                                "image_src": (ref.image_src or "").replace("\\", "/"),
                            }
                        )
                result_rows.append(
                    {
                        "defect_id": defect.defect_id,
                        "reel_id": reel.reel_id if reel else defect.reel_id,
                        "reel_code": reel.reel_code if reel else None,
                        "defect_time": _iso(defect.defect_time),
                        "order_number": reel.order_number if reel else None,
                        "job_name": reel.job_name if reel else None,
                        "class_name": defect.class_name,
                        "magnitude_value": _to_float(defect.magnitude_value),
                        "severity_value": _to_float(defect.severity_value),
                        "format_position": _to_float(defect.format_position),
                        "phase": phase_name,
                        "image_src": (defect.image_src or "").replace("\\", "/"),
                        "coords": defect.coords_json or [],
                        "format_length": format_length,
                        "format_width": format_width,
                        "qc_decision": (defect.qc_decision or "").lower() or None,
                    }
                )

        heatmap_rows: List[Dict[str, Any]] = []
        for (
            defect_id,
            reel_id,
            magnitude_value,
            severity_value,
            coords_json,
        ) in (
            base_query.with_entities(
                Defect.defect_id,
                Defect.reel_id,
                Defect.magnitude_value,
                Defect.severity_value,
                Defect.coords_json,
            )
            .filter(Defect.coords_json.isnot(None))
            .order_by(Defect.defect_time.desc())
            .all()
        ):
            if not coords_json:
                continue
            heatmap_rows.append(
                {
                    "defect_id": defect_id,
                    "reel_id": reel_id,
                    "magnitude_value": _to_float(magnitude_value),
                    "severity_value": _to_float(severity_value),
                    "coords": coords_json,
                }
            )

        # Aggregations
        by_type = (
            base_query.with_entities(Defect.class_name, func.count())
            .group_by(Defect.class_name)
            .order_by(func.count().desc())
            .all()
        )
        trend_query = base_query.filter(Defect.defect_time.isnot(None))
        trend = (
            trend_query.with_entities(
                func.date_format(Defect.defect_time, "%Y-%m-%d %H:00:00").label("bucket"),
                func.count(),
            )
            .group_by(text("bucket"))
            .order_by(text("bucket"))
            .all()
        )

        bins_magnitude = [
            (0.0, 0.2, "0-0.2"),
            (0.2, 0.4, "0.2-0.4"),
            (0.4, 0.6, "0.4-0.6"),
            (0.6, 0.8, "0.6-0.8"),
            (0.8, 1.0, "0.8-1.0"),
            (1.0, 1e9, ">1.0"),
        ]
        bins_severity = [
            (0.0, 5.0, "0-5"),
            (5.0, 20.0, "5-20"),
            (20.0, 50.0, "20-50"),
            (50.0, 100.0, "50-100"),
            (100.0, 250.0, "100-250"),
            (250.0, 500.0, "250-500"),
            (500.0, 1e9, ">500"),
        ]

        value_subquery = base_query.with_entities(
            Defect.magnitude_value.label("magnitude_value"),
            Defect.severity_value.label("severity_value"),
            Defect.format_position.label("format_position"),
        ).subquery()

        magnitude_hist = _histogram_from_subquery(
            session,
            value_subquery,
            value_subquery.c.magnitude_value,
            bins_magnitude,
        )
        severity_hist = _histogram_from_subquery(
            session,
            value_subquery,
            value_subquery.c.severity_value,
            bins_severity,
        )

        position_rows = (
            session.query(
                func.floor(value_subquery.c.format_position / 100).label("bucket"),
                func.count(),
            )
            .select_from(value_subquery)
            .filter(value_subquery.c.format_position.isnot(None))
            .group_by(text("bucket"))
            .order_by(text("bucket"))
            .limit(150)
            .all()
        )
        position_hist = [
            {
                "bin": f"{int(bucket)*100}-{int(bucket)*100 + 100}",
                "count": int(count),
            }
            for bucket, count in position_rows
        ]

        decision_rows = (
            base_query.with_entities(Defect.qc_decision, func.count())
            .group_by(Defect.qc_decision)
            .all()
        )
        pass_count = 0
        fail_count = 0
        for decision_value, decision_total in decision_rows:
            if not decision_value:
                continue
            normalized = str(decision_value).strip().lower()
            if normalized == "pass":
                pass_count += int(decision_total or 0)
            elif normalized == "fail":
                fail_count += int(decision_total or 0)
        unidentified_count = int(total or 0) - pass_count - fail_count
        if unidentified_count < 0:
            unidentified_count = 0

        total_pages = (total + page_size - 1) // page_size if total else 1
        return jsonify(
            {
                "rows": result_rows,
                "by_type": [
                    {"class": cls, "count": int(count)}
                    for cls, count in by_type
                ],
                "trend": [
                    {"time": bucket, "count": int(count)}
                    for bucket, count in trend
                ],
                "magnitude_hist": magnitude_hist,
                "severity_hist": severity_hist,
                "position_hist": position_hist,
                "masks": mask_entries,
                "reference_images": reference_images,
                "format_length": format_lengths[0] if format_lengths else None,
                "format_width": format_widths[0] if format_widths else None,
                "heatmap_rows": heatmap_rows,
                "decision_summary": {
                    "total": int(total or 0),
                    "pass": pass_count,
                    "fail": fail_count,
                    "unidentified": unidentified_count,
                },
                "page_info": {
                    "page": page,
                    "page_size": page_size,
                    "total": total,
                    "total_pages": total_pages or 1,
                },
            }
        )


@dashboard_bp.route("/api/defects/<int:defect_id>/decision", methods=["POST"])
def api_defect_decision(defect_id: int):
    payload = request.get_json(silent=True) or {}
    raw_decision = payload.get("decision")
    decision: Optional[str] = None
    if raw_decision is not None:
        decision = str(raw_decision).strip().lower()
        if decision not in {"pass", "fail"}:
            return jsonify({"error": "Decision must be 'pass' or 'fail'."}), 400

    with SessionLocal() as session:
        defect = session.query(Defect).filter(Defect.defect_id == defect_id).first()
        if not defect:
            return jsonify({"error": "Defect not found."}), 404

        defect.qc_decision = decision
        session.commit()
        return jsonify(
            {
                "defect_id": defect.defect_id,
                "decision": decision,
            }
        )
