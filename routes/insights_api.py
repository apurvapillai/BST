from __future__ import annotations

import math
from collections import Counter, defaultdict
from datetime import datetime, timedelta
from typing import Dict, Iterable, List, Optional, Tuple

from flask import Blueprint, jsonify, request
from sqlalchemy import and_, func
from sqlalchemy.orm import Session

from db.connection import SessionLocal
from db.models import Defect, Mask, ReferenceImage, Reel, RLMMonitoring, ReelReview


insights_api = Blueprint("insights_api", __name__)

DAYS_DEFAULT_RANGE = 7
MM_TO_METER = 0.001


def _parse_datetime(raw: Optional[str]) -> Optional[datetime]:
    if not raw:
        return None
    try:
        if len(raw) == 16:
            raw = f"{raw}:00"
        return datetime.fromisoformat(raw)
    except ValueError:
        return None


def _default_window() -> Tuple[datetime, datetime]:
    end = datetime.utcnow()
    start = end - timedelta(days=DAYS_DEFAULT_RANGE)
    return start, end


def _iso(dt: Optional[datetime]) -> Optional[str]:
    return dt.isoformat() if dt else None


def _to_float(value) -> Optional[float]:
    if value is None:
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _meters_for_reel(reel: Reel) -> float:
    start_val = _to_float(reel.reel_start) or 0.0
    end_val = _to_float(reel.reel_end) or 0.0
    return max(end_val - start_val, 0.0)


def _normalize_mode(value: Optional[str]) -> str:
    if not value:
        return "job"
    value = value.lower()
    if value in {"job", "roll", "period"}:
        return value
    return "job"


def _base_reel_query(session: Session, start: datetime, end: datetime):
    return (
        session.query(Reel)
        .filter(Reel.time_start.isnot(None))
        .filter(Reel.time_end.isnot(None))
        .filter(Reel.time_start <= end)
        .filter(Reel.time_end >= start)
    )


def _defects_in_window(session: Session, start: datetime, end: datetime, reel_ids: Iterable[int]):
    if not reel_ids:
        return []
    return (
        session.query(Defect)
        .filter(Defect.reel_id.in_(reel_ids))
        .filter(Defect.defect_time.isnot(None))
        .filter(Defect.defect_time >= start)
        .filter(Defect.defect_time <= end)
        .all()
    )


def _bucket_hour(dt: datetime) -> datetime:
    return dt.replace(minute=0, second=0, microsecond=0)


def _bucket_meter(meter_value: float, bucket_size: float = 100.0) -> float:
    if bucket_size <= 0:
        return meter_value
    return math.floor(meter_value / bucket_size) * bucket_size


def _meters_for_bucket(reel: Reel, bucket_start: datetime, bucket_end: datetime) -> float:
    if not reel.time_start or not reel.time_end:
        return 0.0
    overlap_start = max(reel.time_start, bucket_start)
    overlap_end = min(reel.time_end, bucket_end)
    if overlap_end <= overlap_start:
        return 0.0
    reel_duration = (reel.time_end - reel.time_start).total_seconds() or 1.0
    overlap_seconds = (overlap_end - overlap_start).total_seconds()
    return _meters_for_reel(reel) * (overlap_seconds / reel_duration)


def _rate(defects: float, meters: float) -> float:
    if meters <= 0:
        return 0.0
    return (defects / meters) * 1000.0


def _compute_baseline_window(start: datetime) -> Tuple[datetime, datetime]:
    end = start
    baseline_start = end - timedelta(days=14)
    return baseline_start, end


def _serialize_top_defects(counter: Counter) -> List[Dict[str, object]]:
    return [
        {"type": name, "count": count}
        for name, count in counter.most_common()
        if name is not None
    ]


def _summary_payload(primary_counts, primary_meters, secondary_counts, secondary_meters):
    total_defects = primary_counts
    total_meters = primary_meters
    defects_per_km = _rate(primary_counts, primary_meters)
    rate_secondary = _rate(secondary_counts, secondary_meters) if secondary_meters else 0.0
    defect_delta = (
        ((primary_counts - secondary_counts) / secondary_counts * 100.0)
        if secondary_counts
        else 0.0
    )
    meter_delta = (
        ((primary_meters - secondary_meters) / secondary_meters * 100.0)
        if secondary_meters
        else 0.0
    )
    rate_delta = (
        ((defects_per_km - rate_secondary) / rate_secondary * 100.0)
        if rate_secondary
        else 0.0
    )
    return {
        "totalDefects": total_defects,
        "totalMeters": total_meters,
        "defectsPerKm": defects_per_km,
        "defectDelta": defect_delta,
        "meterDelta": meter_delta,
        "rateDelta": rate_delta,
        "secondary": {
            "totalDefects": secondary_counts,
            "totalMeters": secondary_meters,
            "defectsPerKm": rate_secondary,
        },
    }


@insights_api.route("/summary")
def insights_summary():
    raw_start = request.args.get("start")
    raw_end = request.args.get("end")
    mode = _normalize_mode(request.args.get("mode"))
    primary = request.args.get("primary")
    secondary = request.args.get("secondary")

    start = _parse_datetime(raw_start)
    end = _parse_datetime(raw_end)
    if not start or not end or start >= end:
        start, end = _default_window()

    normalize = request.args.get("normalize", "").lower() in {"1", "true", "yes", "on"}

    with SessionLocal() as session:
        base_reels = _base_reel_query(session, start, end)

        def _filter_reels(value: Optional[str]):
            if not value:
                return []
            q = base_reels
            if mode == "job":
                q = q.filter(Reel.job_name == value)
            elif mode == "roll":
                q = q.filter(Reel.reel_code == value)
            else:
                q = q.filter(Reel.job_name == value)
            return q.all()

        primary_reels = _filter_reels(primary) if primary else base_reels.all()
        secondary_reels = _filter_reels(secondary) if secondary else []

        def _metrics(reels: List[Reel]):
            meters = sum(_meters_for_reel(r) for r in reels)
            defects = (
                session.query(func.count(Defect.defect_id))
                .filter(Defect.reel_id.in_([r.reel_id for r in reels]))
                .filter(Defect.defect_time >= start)
                .filter(Defect.defect_time <= end)
                .scalar()
                if reels
                else 0
            )
            defect_counts = Counter()
            if reels:
                for name, count in (
                    session.query(Defect.class_name, func.count(Defect.defect_id))
                    .filter(Defect.reel_id.in_([r.reel_id for r in reels]))
                    .filter(Defect.defect_time >= start)
                    .filter(Defect.defect_time <= end)
                    .group_by(Defect.class_name)
                    .all()
                ):
                    defect_counts[name] = count
            return defects, meters, defect_counts

        primary_defects, primary_meters, primary_top = _metrics(primary_reels)

        if secondary:
            secondary_defects, secondary_meters, secondary_top = _metrics(secondary_reels)
        else:
            baseline_start, baseline_end = _compute_baseline_window(start)
            baseline_reels = _base_reel_query(session, baseline_start, baseline_end).all()
            secondary_defects, secondary_meters, secondary_top = _metrics(baseline_reels)

        payload = _summary_payload(primary_defects, primary_meters, secondary_defects, secondary_meters)
        payload["topDefects"] = _serialize_top_defects(primary_top)
        payload["secondaryTopDefects"] = _serialize_top_defects(secondary_top)
        return jsonify(payload)


@insights_api.route("/filters")
def insights_filters():
    raw_start = request.args.get("start")
    raw_end = request.args.get("end")
    start = _parse_datetime(raw_start)
    end = _parse_datetime(raw_end)
    if not start or not end or start >= end:
        start, end = _default_window()

    with SessionLocal() as session:
        reels = _base_reel_query(session, start, end).all()

        jobs = []
        rolls = []
        if reels:
            jobs = [
                row[0]
                for row in (
                    session.query(Reel.job_name, func.max(Reel.time_end).label("latest"))
                    .filter(Reel.job_name.isnot(None))
                    .group_by(Reel.job_name)
                    .order_by(func.max(Reel.time_end).desc())
                    .all()
                )
                if row[0]
            ]
            rolls = [
                row[0]
                for row in (
                    session.query(Reel.reel_code, func.max(Reel.time_end).label("latest"))
                    .filter(Reel.reel_code.isnot(None))
                    .group_by(Reel.reel_code)
                    .order_by(func.max(Reel.time_end).desc())
                    .all()
                )
                if row[0]
            ]

        defect_rows = (
            session.query(Defect.class_name)
            .filter(Defect.reel_id.in_([r.reel_id for r in reels]))
            .filter(Defect.defect_time >= start)
            .filter(Defect.defect_time <= end)
            .distinct()
            .all()
            if reels
            else []
        )
        defect_types = sorted({row[0] for row in defect_rows if row and row[0]})
        return jsonify({"jobs": jobs, "reels": rolls, "defectTypes": defect_types})


@insights_api.route("/trend")
def insights_trend():
    raw_start = request.args.get("start")
    raw_end = request.args.get("end")
    mode = _normalize_mode(request.args.get("mode"))
    primary = request.args.get("primary")
    secondary = request.args.get("secondary")

    start = _parse_datetime(raw_start)
    end = _parse_datetime(raw_end)
    if not start or not end or start >= end:
        start, end = _default_window()

    with SessionLocal() as session:
        base_reels = _base_reel_query(session, start, end)

        def _filter_reels(value: Optional[str]):
            if not value:
                return []
            q = base_reels
            if mode == "job":
                q = q.filter(Reel.job_name == value)
            elif mode == "roll":
                q = q.filter(Reel.reel_code == value)
            else:
                q = q.filter(Reel.job_name == value)
            return q.all()

        primary_reels = _filter_reels(primary) if primary else base_reels.all()
        secondary_reels = _filter_reels(secondary) if secondary else []
        if not secondary_reels and not secondary:
            baseline_start, baseline_end = _compute_baseline_window(start)
            secondary_reels = _base_reel_query(session, baseline_start, baseline_end).all()
            secondary_start, secondary_end = baseline_start, baseline_end
        else:
            secondary_start, secondary_end = start, end

        def _series(label: str, reels: List[Reel], window_start: datetime, window_end: datetime):
            if not reels:
                return {"label": label, "points": [], "total": 0, "max_meter": 0, "cumulative": []}
            reel_map = {r.reel_id: r for r in reels if r.reel_id}
            reel_ids = list(reel_map.keys())
            defects = (
                session.query(Defect.reel_id, Defect.format_position, Defect.defect_time, Defect.class_name)
                .filter(Defect.reel_id.in_(reel_ids))
                .filter(Defect.defect_time >= window_start)
                .filter(Defect.defect_time <= window_end)
                .all()
            )
            bucket_counts: Dict[float, int] = defaultdict(int)
            bucket_meters: Dict[float, float] = defaultdict(float)
            BUCKET_SIZE = 100.0
            max_meter = 0.0
            for reel in reels:
                if reel.reel_id is None:
                    continue
                start_m = _to_float(reel.reel_start) or 0.0
                end_m = _to_float(reel.reel_end) or start_m
                total_m = max(end_m - start_m, 0.0)
                if total_m <= 0:
                    continue
                if end_m > max_meter:
                    max_meter = end_m
                current = _bucket_meter(start_m, BUCKET_SIZE)
                last_bucket = _bucket_meter(end_m, BUCKET_SIZE)
                while current <= last_bucket:
                    bucket_start_m = current
                    bucket_end_m = current + BUCKET_SIZE
                    segment_start = max(start_m, bucket_start_m)
                    segment_end = min(end_m, bucket_end_m)
                    segment_len = max(segment_end - segment_start, 0.0)
                    if segment_len > 0:
                        bucket_meters[current] += segment_len
                    current += BUCKET_SIZE
            defect_meters: List[float] = []
            defect_meters_by_type: Dict[str, List[float]] = defaultdict(list)
            for reel_id, fmt_pos, _dt, cls_name in defects:
                reel = reel_map.get(reel_id)
                if not reel:
                    continue
                base = _to_float(reel.reel_start) or 0.0
                pos = _to_float(fmt_pos)
                meter_val = base + (pos if pos is not None else 0.0)
                bucket = _bucket_meter(meter_val)
                bucket_counts[bucket] += 1
                defect_meters.append(meter_val)
                key = cls_name or "Unknown"
                defect_meters_by_type[key].append(meter_val)

            points = []
            if bucket_meters:
                all_buckets = sorted(bucket_meters.keys())
                start_bucket = all_buckets[0]
                end_bucket = all_buckets[-1]
                current = start_bucket
                while current <= end_bucket:
                    meters = bucket_meters.get(current, BUCKET_SIZE) or BUCKET_SIZE
                    count = bucket_counts.get(current, 0)
                    points.append(
                        {
                            "meter": current,
                            "count": count,
                            "rate": _rate(count, meters),
                        }
                    )
                    current += BUCKET_SIZE
            total_count = len(defect_meters)
            cumulative_points = []
            if defect_meters:
                running = 0
                for mv in sorted(defect_meters):
                    running += 1
                    cumulative_points.append({"meter": mv, "total": running})
                if max_meter and (not cumulative_points or cumulative_points[-1]["meter"] < max_meter):
                    cumulative_points.append({"meter": max_meter, "total": running})
            cumulative_by_type = []
            for cls_name, meters in defect_meters_by_type.items():
                running = 0
                points_cls = []
                for mv in sorted(meters):
                    running += 1
                    points_cls.append({"meter": mv, "total": running})
                if max_meter and points_cls and points_cls[-1]["meter"] < max_meter:
                    points_cls.append({"meter": max_meter, "total": running})
                cumulative_by_type.append({"type": cls_name, "points": points_cls})

            return {
                "label": label,
                "points": points,
                "total": total_count,
                "max_meter": max_meter,
                "cumulative": cumulative_points,
                "cumulative_by_type": cumulative_by_type,
            }

        series = [
            _series("Primary", primary_reels, start, end),
            _series("Comparison", secondary_reels, secondary_start, secondary_end),
        ]
        deviation_zones: List[Dict[str, object]] = []
        if series and series[0]["points"]:
            first_point = series[0]["points"][0]
            last_point = series[0]["points"][-1]
            start_val = first_point.get("meter") or first_point.get("time")
            end_val = last_point.get("meter") or last_point.get("time")
            if start_val is not None and end_val is not None:
                deviation_zones.append({"start": start_val, "end": end_val})
        return jsonify({"series": series, "deviationZones": deviation_zones})


@insights_api.route("/comparison")
def insights_comparison():
    mode = _normalize_mode(request.args.get("mode"))
    primary = request.args.get("primary")
    secondary = request.args.get("secondary")
    raw_start = request.args.get("start")
    raw_end = request.args.get("end")
    start = _parse_datetime(raw_start)
    end = _parse_datetime(raw_end)
    if not start or not end or start >= end:
        start, end = _default_window()

    with SessionLocal() as session:
        base_reels = _base_reel_query(session, start, end)

        def _filter_reels(value: Optional[str]):
            if not value:
                return []
            q = base_reels
            if mode == "job":
                q = q.filter(Reel.job_name == value)
            elif mode == "roll":
                q = q.filter(Reel.reel_code == value)
            else:
                q = q.filter(Reel.job_name == value)
            return q.all()

        primary_reels = _filter_reels(primary) if primary else []
        secondary_reels = _filter_reels(secondary) if secondary else []

        def _defect_mix(reels: List[Reel]):
            if not reels:
                return {}
            rows = (
                session.query(Defect.class_name, func.count(Defect.defect_id))
                .filter(Defect.reel_id.in_([r.reel_id for r in reels]))
                .filter(Defect.defect_time >= start)
                .filter(Defect.defect_time <= end)
                .group_by(Defect.class_name)
                .all()
            )
            return {name or "Unknown": count for name, count in rows}

        primary_mix = _defect_mix(primary_reels)
        secondary_mix = _defect_mix(secondary_reels)
        labels = sorted(set(primary_mix) | set(secondary_mix))
        mix_payload = {
            "labels": labels,
            "primary": [primary_mix.get(lbl, 0) for lbl in labels],
            "secondary": [secondary_mix.get(lbl, 0) for lbl in labels],
        }

        overlay = []
        for label, reels in (("Primary", primary_reels), ("Comparison", secondary_reels)):
            if not reels:
                overlay.append({"label": label, "points": []})
                continue
            reel_ids = [r.reel_id for r in reels]
            defects = (
                session.query(Defect.defect_time)
                .filter(Defect.reel_id.in_(reel_ids))
                .filter(Defect.defect_time >= start)
                .filter(Defect.defect_time <= end)
                .all()
            )
            bucket_counts: Dict[datetime, int] = defaultdict(int)
            for (dt,) in defects:
                if not dt:
                    continue
                bucket_counts[_bucket_hour(dt)] += 1
            overlay.append(
                {
                    "label": label,
                    "points": [{"time": _iso(bucket), "count": count} for bucket, count in sorted(bucket_counts.items())],
                }
            )

        return jsonify({"mix": mix_payload, "types": mix_payload, "overlay": overlay})


@insights_api.route("/impact")
def insights_impact():
    raw_start = request.args.get("start")
    raw_end = request.args.get("end")
    start = _parse_datetime(raw_start)
    end = _parse_datetime(raw_end)
    if not start or not end or start >= end:
        start, end = _default_window()

    with SessionLocal() as session:
        reels = _base_reel_query(session, start, end).all()
        reel_ids = [r.reel_id for r in reels]

        masks = (
            session.query(Mask.timestamp)
            .filter(Mask.reel_id.in_(reel_ids))
            .filter(Mask.timestamp >= start)
            .filter(Mask.timestamp <= end)
            .order_by(Mask.timestamp)
            .all()
            if reel_ids
            else []
        )
        # ReferenceImage has no timestamp column in this schema; leave empty for now.
        refs: List[Tuple[Optional[datetime]]] = []

        first_event_time = masks[0][0] if masks else refs[0][0] if refs else None
        if first_event_time:
            defects_before = (
                session.query(func.count(Defect.defect_id))
                .filter(Defect.reel_id.in_(reel_ids))
                .filter(Defect.defect_time >= start)
                .filter(Defect.defect_time < first_event_time)
                .scalar()
            )
            meters_before = sum(
                _meters_for_bucket(
                    r, start, first_event_time
                )
                for r in reels
            )
            defects_after = (
                session.query(func.count(Defect.defect_id))
                .filter(Defect.reel_id.in_(reel_ids))
                .filter(Defect.defect_time >= first_event_time)
                .filter(Defect.defect_time <= end)
                .scalar()
            )
            meters_after = sum(_meters_for_bucket(r, first_event_time, end) for r in reels)
        else:
            defects_before = defects_after = 0
            meters_before = meters_after = 0.0

        before_rate = _rate(defects_before, meters_before)
        after_rate = _rate(defects_after, meters_after)
        delta = after_rate - before_rate

        payload = {
            "maskTimeline": [{"time": _iso(ts), "label": "Mask Applied"} for (ts,) in masks if ts],
            "referenceChanges": [{"time": _iso(ts), "label": "Reference Change"} for (ts,) in refs if ts],
            "correlation": {"beforeRate": before_rate, "afterRate": after_rate, "delta": delta},
            "events": [],
        }
        for ts_tuple in masks:
            ts = ts_tuple[0]
            if ts:
                payload["events"].append({"time": _iso(ts), "label": "Mask Applied", "effect": ""})
        return jsonify(payload)


def _defect_polygon_areas(coords_data) -> List[float]:
    if coords_data is None:
        return []
    if isinstance(coords_data, str):
        try:
            import json

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
        xs = [float(x) for x in xs_raw if _to_float(x) is not None]
        ys = [float(y) for y in ys_raw if _to_float(y) is not None]
        count = min(len(xs), len(ys))
        if count < 3:
            continue
        area = 0.0
        last_index = count - 1
        for idx in range(count):
            area += (xs[last_index] + xs[idx]) * (ys[last_index] - ys[idx])
            last_index = idx
        areas.append(abs(area) / 2.0)
    return areas


@insights_api.route("/maps")
def insights_maps():
    raw_start = request.args.get("start")
    raw_end = request.args.get("end")
    primary = request.args.get("primary")
    secondary = request.args.get("secondary")
    start = _parse_datetime(raw_start)
    end = _parse_datetime(raw_end)
    if not start or not end or start >= end:
        start, end = _default_window()

    with SessionLocal() as session:
        base_reels = _base_reel_query(session, start, end)

        def _filter_reels(value: Optional[str]) -> List[Reel]:
            if not value:
                return []
            return (
                base_reels.filter(Reel.job_name == value)
                .all()
            )

        primary_reels = _filter_reels(primary)
        secondary_reels = _filter_reels(secondary)

        def _collect(reels: List[Reel]):
            if not reels:
                return [], [], []
            reel_ids = [r.reel_id for r in reels]
            defects = (
                session.query(Defect)
                .filter(Defect.reel_id.in_(reel_ids))
                .filter(Defect.defect_time >= start)
                .filter(Defect.defect_time <= end)
                .all()
            )
            severities = [_to_float(d.severity_value) for d in defects if _to_float(d.severity_value) is not None]
            positions = [_to_float(d.format_position) for d in defects if _to_float(d.format_position) is not None]
            return defects, severities, positions

        def _severity_counts(values: List[float]):
            bins = ["Low", "Med", "High", "Critical"]
            counts = [0, 0, 0, 0]
            for s in values:
                if s < 10000:
                    counts[0] += 1
                elif s < 100000:
                    counts[1] += 1
                elif s < 450000:
                    counts[2] += 1
                else:
                    counts[3] += 1
            return bins, counts

        _, primary_sev, primary_pos = _collect(primary_reels)
        _, secondary_sev, secondary_pos = _collect(secondary_reels)
        bins, primary_counts = _severity_counts(primary_sev)
        _, secondary_counts = _severity_counts(secondary_sev)

        return jsonify(
            {
                "severity": {
                    "bins": bins,
                    "primary": primary_counts,
                    "secondary": secondary_counts,
                },
                "positions": {
                    "primary": primary_pos,
                    "secondary": secondary_pos,
                },
            }
        )


@insights_api.route("/actions")
def insights_actions():
    raw_start = request.args.get("start")
    raw_end = request.args.get("end")
    start = _parse_datetime(raw_start)
    end = _parse_datetime(raw_end)
    if not start or not end or start >= end:
        start, end = _default_window()

    with SessionLocal() as session:
        reviews = (
            session.query(ReelReview)
            .filter(ReelReview.created_at >= start)
            .filter(ReelReview.created_at <= end)
            .order_by(ReelReview.created_at.desc())
            .all()
        )
        actions = []
        for review in reviews:
            actions.append(
                {
                    "action": review.decision or "Review",
                    "owner": review.reviewer_name or review.reviewer_id or "Unassigned",
                    "status": "Done" if review.decision else "Pending",
                    "due": review.created_at.date().isoformat() if review.created_at else "",
                }
            )

        reels = _base_reel_query(session, start, end).all()
        reel_ids = [r.reel_id for r in reels]
        defects_total = (
            session.query(func.count(Defect.defect_id))
            .filter(Defect.reel_id.in_(reel_ids))
            .filter(Defect.defect_time >= start)
            .filter(Defect.defect_time <= end)
            .scalar()
            if reel_ids
            else 0
        )
        meters_total = sum(_meters_for_reel(r) for r in reels)
        before_start, before_end = _compute_baseline_window(start)
        baseline_reels = _base_reel_query(session, before_start, before_end).all()
        baseline_ids = [r.reel_id for r in baseline_reels]
        defects_baseline = (
            session.query(func.count(Defect.defect_id))
            .filter(Defect.reel_id.in_(baseline_ids))
            .filter(Defect.defect_time >= before_start)
            .filter(Defect.defect_time <= before_end)
            .scalar()
            if baseline_ids
            else 0
        )
        meters_baseline = sum(_meters_for_reel(r) for r in baseline_reels)

        before_rate = _rate(defects_baseline, meters_baseline)
        after_rate = _rate(defects_total, meters_total)
        verification = [
            {"label": "Before defects / 1000m", "value": before_rate},
            {"label": "After defects / 1000m", "value": after_rate},
            {"label": "Delta", "value": after_rate - before_rate},
        ]

        return jsonify({"actions": actions, "verification": verification})
