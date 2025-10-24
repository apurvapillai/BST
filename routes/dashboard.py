from __future__ import annotations

from collections import defaultdict
from datetime import datetime, timedelta
from decimal import Decimal
from typing import Dict, Iterable, List, Optional, Tuple

from flask import Blueprint, jsonify, render_template, request
from sqlalchemy import and_, case, exists, func, or_, text
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
)


DAYS_DEFAULT_RANGE = 7
MAX_PAGE_SIZE = 500
SENTINEL_NONE = "__NONE__"

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


def _validate_filters(session: Session) -> Dict[str, Optional[str]]:
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

    filters = {
        "machine_id": machine_id,
        "start": start,
        "end": end,
        "job": args.get("job") or None,
        "order": args.get("order") or None,
        "reel_code": args.get("reel_code") or None,
    }
    return filters


def _apply_reel_filters(query, filters: Dict[str, Optional[str]], include_reel_code: bool = True):
    start = filters["start"]
    end = filters["end"]

    query = query.filter(Reel.machine_id == filters["machine_id"])
    query = query.filter(Reel.time_start <= end).filter(Reel.time_end >= start)

    if include_reel_code and filters.get("reel_code"):
        query = query.filter(Reel.reel_code == filters["reel_code"])
    if filters.get("job"):
        query = query.filter(Reel.job_name == filters["job"])
    if filters.get("order"):
        query = query.filter(Reel.order_number == filters["order"])
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
        if not defect.defect_time:
            continue
        if defect.defect_time < window_start or defect.defect_time > window_end:
            continue
        total += 1
        if defect.class_name:
            by_type[defect.class_name] += 1
            unique_classes.add(defect.class_name)
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
        default_machine_id = machines[0].machine_id if machines else None

    return render_template(
        "dashboard.html",
        machines=machines,
        default_machine_id=default_machine_id,
        default_start=default_start,
        default_end=default_end,
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

        jobs = (
            base_query.with_entities(
                Reel.job_name,
                func.max(Reel.time_end).label("latest"),
            )
            .filter(Reel.job_name.isnot(None))
            .group_by(Reel.job_name)
            .order_by(func.max(Reel.time_end).desc())
            .all()
        )

        order_query = base_query
        if filters.get("job"):
            order_query = order_query.filter(Reel.job_name == filters["job"])
        orders = (
            order_query.with_entities(
                Reel.order_number,
                func.max(Reel.time_end).label("latest"),
            )
            .filter(Reel.order_number.isnot(None))
            .group_by(Reel.order_number)
            .order_by(func.max(Reel.time_end).desc())
            .all()
        )

        reel_query = order_query
        if filters.get("order"):
            reel_query = reel_query.filter(Reel.order_number == filters["order"])
        reels = (
            reel_query.with_entities(
                Reel.reel_code,
                func.max(Reel.time_end).label("latest"),
            )
            .filter(Reel.reel_code.isnot(None))
            .group_by(Reel.reel_code)
            .order_by(func.max(Reel.time_end).desc())
            .all()
        )

        return jsonify(
            {
                "jobs": [job for job, _ in jobs],
                "orders": [order for order, _ in orders],
                "reel_codes": [code for code, _ in reels],
            }
        )


@dashboard_bp.route("/api/overview")
def api_overview():
    with SessionLocal() as session:
        try:
            filters = _validate_filters(session)
        except ValueError as exc:
            return jsonify({"error": str(exc)}), 400

        reels = (
            _apply_reel_filters(session.query(Reel), filters)
            .options(
                selectinload(Reel.inspection_phases),
                selectinload(Reel.defects),
            )
            .all()
        )

        job_set = set()
        jobs_meters = defaultdict(float)
        jobs_time = defaultdict(lambda: {"active": 0.0, "inactive": 0.0, "learn": 0.0})
        jobs_defects = defaultdict(int)

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
        for reel in reels:
            meters = 0.0
            if reel.reel_start is not None and reel.reel_end is not None:
                meters = max(
                    (_to_float(reel.reel_end) or 0.0) - (_to_float(reel.reel_start) or 0.0),
                    0.0,
                )
            totals["length"] += meters
            if reel.job_name:
                job_set.add(reel.job_name)
                jobs_meters[reel.job_name] += meters

            phase_mix = _phase_mix_for_reel(reel, filters["start"], filters["end"])
            for key in ("active", "inactive", "learn"):
                seconds = phase_mix.get(key, {}).get("seconds", 0.0)
                length = phase_mix.get(key, {}).get("length", 0.0)
                totals[f"{key}_seconds"] += seconds
                totals[f"{key}_length"] += length
                if reel.job_name:
                    jobs_time[reel.job_name][key] += seconds / 60.0  # minutes

            for defect in reel.defects or []:
                defects.append(defect)
                if reel.job_name and defect.defect_time and filters["start"] <= defect.defect_time <= filters["end"]:
                    jobs_defects[reel.job_name] += 1

        defects_by_type, defects_trend, defect_classes, total_defects = _defect_buckets(
            defects, filters["start"], filters["end"]
        )

        total_seconds = (
            totals["active_seconds"] + totals["inactive_seconds"] + totals["learn_seconds"]
        )

        def pct(value: float) -> float:
            return round(value / total_seconds * 100, 1) if total_seconds else 0.0

        response = {
            "kpis": {
                "total_jobs": len(job_set),
                "total_length": round(totals["length"], 2),
                "active_pct": pct(totals["active_seconds"]),
                "inactive_pct": pct(totals["inactive_seconds"]),
                "learn_pct": pct(totals["learn_seconds"]),
                "active_length": round(totals["active_length"], 2),
                "inactive_length": round(totals["inactive_length"], 2),
                "learn_length": round(totals["learn_length"], 2),
                "total_defects": total_defects,
                "defect_classes": defect_classes,
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
                }
                for job, mix in jobs_time.items()
            ],
            "jobs_defects": [
                {"job": job, "count": count}
                for job, count in sorted(jobs_defects.items(), key=lambda item: item[1], reverse=True)
            ],
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

    query = _apply_reel_filters(
        session.query(Reel), baseline_filters, include_reel_code=False
    )
    if job:
        query = query.filter(Reel.job_name == job)
    else:
        query = query.filter(Reel.job_name.is_(None))
    if order:
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
        base_query = _apply_reel_filters(session.query(Reel), filters)

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

            ref_images = [
                {
                    "filename": img.filename,
                    "image_src": (img.image_src or "").replace("\\", "/"),
                }
                for img in sorted(reel.reference_images or [], key=lambda x: x.filename or "")
            ]

            # Reference change detection
            ref_change_count = 0
            ref_change_times: List[str] = []
            last_ref = None
            for phase in sorted(reel.inspection_phases or [], key=lambda p: p.start_time or datetime.min):
                ref_id = phase.refimgid
                if ref_id and last_ref and ref_id != last_ref:
                    ref_change_count += 1
                    ref_change_times.append(_iso(phase.start_time))
                if ref_id:
                    last_ref = ref_id

            current_std = _standard_map(reel.sensitivity_sets)
            baseline_std = _standard_map(baseline.sensitivity_sets) if baseline else {}
            sens_changes = []
            for cls in sorted(set(current_std) | set(baseline_std)):
                cur = current_std.get(cls, (None, None))
                base = baseline_std.get(cls, (None, None))
                if cur == base:
                    continue
                thres_delta = (cur[0] or 0.0) - (base[0] or 0.0)
                warn_delta = (cur[1] or 0.0) - (base[1] or 0.0)
                sens_changes.append(
                    {
                        "name": cls,
                        "thres_delta": round(thres_delta, 3),
                        "warn_delta": round(warn_delta, 3),
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

            defect_within_window = [
                d for d in reel.defects or []
                if d.defect_time and filters["start"] <= d.defect_time <= filters["end"]
            ]

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
                "defect_count": len(defect_within_window),
                "defect_types": len({d.class_name for d in defect_within_window if d.class_name}),
                "phase_mix_pct": phase_mix_pct,
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
            for img in sorted(reel.reference_images or [], key=lambda x: x.filename or "")
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
        }

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
            },
            "defects_summary": defects_summary,
        }
        return jsonify(response)


def _build_defect_query(
    session: Session,
    filters: Dict[str, Optional[str]],
    class_names: List[str],
    numeric_filters: Dict[str, Optional[float]],
    phase_filter: Optional[str],
):
    query = session.query(Defect).join(Reel, Defect.reel_id == Reel.reel_id)
    query = _apply_reel_filters(query, filters)
    query = query.filter(Defect.defect_time >= filters["start"])
    query = query.filter(Defect.defect_time <= filters["end"])

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

        page, page_size = _paginate()
        rows_query = base_query.options(selectinload(Defect.reel))
        total = rows_query.count()
        rows = (
            rows_query.order_by(Defect.defect_time.desc())
            .offset((page - 1) * page_size)
            .limit(page_size)
            .all()
        )

        result_rows = []
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
                result_rows.append(
                    {
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
                    }
                )

        # Aggregations
        by_type = (
            base_query.with_entities(Defect.class_name, func.count())
            .group_by(Defect.class_name)
            .order_by(func.count().desc())
            .all()
        )
        trend = (
            base_query.with_entities(
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
                "page_info": {
                    "page": page,
                    "page_size": page_size,
                    "total": total,
                    "total_pages": total_pages or 1,
                },
            }
        )
