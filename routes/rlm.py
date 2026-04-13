from __future__ import annotations

from collections import defaultdict
from datetime import datetime, timedelta
from decimal import Decimal
from typing import Dict, Optional
from zoneinfo import ZoneInfo

from flask import Blueprint, jsonify, render_template, request
from sqlalchemy import and_, func, or_
from sqlalchemy.orm import selectinload

from db.rlm_connection import RLMSessionLocal
from db.rlm_models import (
    RLMMachine,
    RLMMonitoring,
    RLMPhaseEvent,
    RLMPhaseInterval,
    RLMReel,
    RLMTolerance,
)
from services.rlm_reel_footage import RLM_REEL_FEET_PER_RANGE_UNIT
from services.rlm_repeat_length_service import RLMRepeatLengthService

RLM_DEFAULT_RANGE_DAYS = 1
RLM_MAX_MONITORING_POINTS = 2000
RLM_MAX_REEL_ROWS = 60
RLM_MAX_TOLERANCE_ROWS = 200

rlm_bp = Blueprint("rlm", __name__)
repeat_length_service = RLMRepeatLengthService()
RLM_UI_TIMEZONE = ZoneInfo("America/Chicago")


def _parse_date(raw: Optional[str]) -> Optional[datetime]:
    if not raw:
        return None
    try:
        if len(raw) == 10:
            return datetime.strptime(raw, "%Y-%m-%d")
        return datetime.fromisoformat(raw)
    except ValueError:
        return None


def _default_window() -> Dict[str, datetime]:
    end = datetime.utcnow()
    start = end - timedelta(days=RLM_DEFAULT_RANGE_DAYS)
    return {"start": start, "end": end}


def _utc_to_ui_local(dt: Optional[datetime]) -> Optional[datetime]:
    if not dt:
        return None
    aware = dt.replace(tzinfo=ZoneInfo("UTC"))
    return aware.astimezone(RLM_UI_TIMEZONE)


def _ui_local_to_utc_naive(dt: Optional[datetime]) -> Optional[datetime]:
    if not dt:
        return None
    aware = dt.replace(tzinfo=RLM_UI_TIMEZONE)
    return aware.astimezone(ZoneInfo("UTC")).replace(tzinfo=None)


def _format_ui_datetime_input(dt: Optional[datetime]) -> str:
    local_dt = _utc_to_ui_local(dt)
    return local_dt.strftime("%Y-%m-%dT%H:%M") if local_dt else ""


def _job_key(job_name: Optional[str], order_number: Optional[str]) -> Optional[str]:
    cleaned_job = str(job_name or "").strip()
    if not cleaned_job:
        return None
    cleaned_order = str(order_number or "").strip()
    return f"{cleaned_job}|||{cleaned_order}"


def _parse_job_key(value: Optional[str]) -> Optional[tuple[str, Optional[str]]]:
    cleaned = str(value or "").strip()
    if not cleaned:
        return None
    if "|||" not in cleaned:
        return (cleaned, None)
    job_name, order_number = cleaned.split("|||", 1)
    job_name = job_name.strip()
    order_number = order_number.strip()
    if not job_name:
        return None
    return (job_name, order_number or None)


def _normalize_filters(args) -> Dict[str, Optional[object]]:
    window = _default_window()
    start = _parse_date(args.get("start")) or window["start"]
    end = _parse_date(args.get("end")) or window["end"]
    if end:
        end = end.replace(hour=23, minute=59, second=59, microsecond=999999)
    if start > end:
        start, end = end - timedelta(days=RLM_DEFAULT_RANGE_DAYS), start
    machine_id = args.get("machine_id")
    try:
        machine_id = int(machine_id) if machine_id else None
    except ValueError:
        machine_id = None

    reel_id = args.get("reel_db_id") or args.get("reel_id")
    try:
        reel_id = int(reel_id) if reel_id else None
    except ValueError:
        reel_id = None

    job_keys_raw = args.getlist("job_key")
    if not job_keys_raw:
        single_job_key = args.get("job_key")
        if single_job_key:
            job_keys_raw = [single_job_key]
    job_pairs = []
    for value in job_keys_raw:
        parsed = _parse_job_key(value)
        if parsed:
            job_pairs.append(parsed)

    job_names_raw = args.getlist("job_name")
    if not job_names_raw:
        single_job = args.get("job_name") or args.get("job")
        if single_job:
            job_names_raw = [single_job]
    job_names = []
    for value in job_names_raw:
        if value:
            cleaned = value.strip()
            if cleaned:
                job_names.append(cleaned)

    min_feet_raw = args.get("min_feet")
    try:
        min_feet = float(min_feet_raw) if min_feet_raw else None
    except (TypeError, ValueError):
        min_feet = None

    return {
        "start": start,
        "end": end,
        "machine_id": machine_id,
        "reel_db_id": reel_id,
        "job_pairs": job_pairs,
        "job_names": job_names,
        "min_feet": min_feet,
    }


def _normalize_window_payload(source) -> Dict[str, datetime]:
    window = _default_window()
    raw_start = (source.get("start") if source else None) or ""
    raw_end = (source.get("end") if source else None) or ""
    parsed_start = _parse_date(raw_start)
    parsed_end = _parse_date(raw_end)
    start = _ui_local_to_utc_naive(parsed_start) if parsed_start else window["start"]
    end = _ui_local_to_utc_naive(parsed_end) if parsed_end else window["end"]
    if raw_end and len(str(raw_end)) == 10:
        end = end.replace(hour=23, minute=59, second=59, microsecond=999999)
    if start > end:
        start, end = end - timedelta(days=RLM_DEFAULT_RANGE_DAYS), end
    return {"start": start, "end": end}


def _parse_min_feet_value(value) -> Optional[float]:
    try:
        parsed = float(value) if value not in {None, ""} else None
    except (TypeError, ValueError):
        return None
    if parsed is None or parsed <= 0:
        return None
    return parsed


def _selection_job_clause(job_pairs):
    pair_clauses = []
    for job_name, order_number in job_pairs:
        if order_number:
            pair_clauses.append(and_(RLMReel.job_name == job_name, RLMReel.order_number == order_number))
        else:
            pair_clauses.append(
                and_(
                    RLMReel.job_name == job_name,
                    or_(RLMReel.order_number.is_(None), RLMReel.order_number == ""),
                )
            )
    return or_(*pair_clauses) if pair_clauses else None


def _normalize_machine_job_selections(payload) -> list[dict[str, object]]:
    raw_items = []
    if isinstance(payload, dict):
        raw_items = payload.get("selections") or []
    elif isinstance(payload, list):
        raw_items = payload
    selections = []
    seen_machine_ids = set()
    for item in raw_items:
        if not isinstance(item, dict):
            continue
        try:
            machine_id = int(item.get("machineId"))
        except (TypeError, ValueError):
            continue
        if machine_id in seen_machine_ids:
            continue
        if item.get("enabled") is False:
            continue
        job_pairs = []
        for value in item.get("jobKeys") or []:
            parsed = _parse_job_key(value)
            if parsed and parsed not in job_pairs:
                job_pairs.append(parsed)
        selections.append(
            {
                "machine_id": machine_id,
                "job_pairs": job_pairs,
                "job_keys": [_job_key(job_name, order_number) for job_name, order_number in job_pairs if _job_key(job_name, order_number)],
                "job_labels": [_format_job_label(job_name, order_number) for job_name, order_number in job_pairs],
            }
        )
        seen_machine_ids.add(machine_id)
    return selections


def _apply_machine_job_selections(query, selections):
    if not selections:
        return query
    machine_clauses = []
    for selection in selections:
        clause = [RLMReel.machine_id == selection["machine_id"]]
        job_clause = _selection_job_clause(selection.get("job_pairs") or [])
        if job_clause is not None:
            clause.append(job_clause)
        machine_clauses.append(and_(*clause))
    if machine_clauses:
        query = query.filter(or_(*machine_clauses))
    return query


def _format_job_label(job_name: Optional[str], order_number: Optional[str]) -> str:
    cleaned_job = str(job_name or "").strip() or "Unknown Job"
    cleaned_order = str(order_number or "").strip()
    return f"{cleaned_job} - {cleaned_order}" if cleaned_order else cleaned_job


def _build_delta_trend_options(session, start: datetime, end: datetime, min_feet: Optional[float] = None):
    reel_ids_in_window = (
        session.query(RLMMonitoring.reel_db_id.label("reel_db_id"))
        .filter(RLMMonitoring.monitoring_ts >= start)
        .filter(RLMMonitoring.monitoring_ts <= end)
        .distinct()
        .subquery()
    )
    rows = (
        session.query(
            RLMMachine.machine_id,
            RLMMachine.machine_name,
            RLMReel.job_name,
            RLMReel.order_number,
            func.count(RLMReel.reel_db_id).label("reel_count"),
        )
        .join(reel_ids_in_window, reel_ids_in_window.c.reel_db_id == RLMReel.reel_db_id)
        .join(RLMMachine, RLMReel.machine_id == RLMMachine.machine_id)
        .filter(RLMReel.job_name.isnot(None))
        .filter(RLMReel.job_name != "")
        .filter(
            True
            if not min_feet
            else and_(
                RLMReel.reel_start.isnot(None),
                RLMReel.reel_end.isnot(None),
                RLMReel.reel_end >= RLMReel.reel_start,
                (RLMReel.reel_end - RLMReel.reel_start) * RLM_REEL_FEET_PER_RANGE_UNIT >= min_feet,
            )
        )
        .group_by(RLMMachine.machine_id, RLMMachine.machine_name, RLMReel.job_name, RLMReel.order_number)
        .order_by(RLMMachine.machine_name.asc(), RLMReel.job_name.asc(), RLMReel.order_number.asc())
        .all()
    )
    grouped = {}
    for machine_id, machine_name, job_name, order_number, reel_count in rows:
        entry = grouped.setdefault(
            machine_id,
            {
                "machineId": machine_id,
                "machineName": machine_name or f"Press {machine_id}",
                "reelCount": 0,
                "jobOptions": [],
            },
        )
        entry["reelCount"] += int(reel_count or 0)
        entry["jobOptions"].append(
            {
                "value": _job_key(job_name, order_number),
                "label": _format_job_label(job_name, order_number),
                "jobName": job_name,
                "orderNumber": order_number,
                "reelCount": int(reel_count or 0),
            }
        )
    return sorted(grouped.values(), key=lambda item: item["machineName"].lower())


def _serialize_delta_trend_point(reel, point: Dict[str, object]):
    return {
        "id": point.get("monitoringId"),
        "timestamp": point.get("timestamp"),
        "delta": point.get("delta"),
        "reelDbId": reel.reel_db_id,
        "reelId": reel.reel_id,
        "machineId": reel.machine_id,
        "machineName": reel.machine.machine_name if reel.machine else None,
        "jobName": reel.job_name,
        "orderNumber": reel.order_number,
        "jobLabel": _format_job_label(reel.job_name, reel.order_number),
        "nominalLength": point.get("appliedNominalLength"),
        "lowerBound": point.get("lowerBound"),
        "upperBound": point.get("upperBound"),
        "outOfRange": bool(point.get("outOfRange")),
    }


def _build_delta_trend_dataset(session, start: datetime, end: datetime, selections: list[dict[str, object]], min_feet: Optional[float] = None):
    monitoring_query = (
        session.query(func.distinct(RLMMonitoring.reel_db_id))
        .join(RLMReel, RLMMonitoring.reel_db_id == RLMReel.reel_db_id)
        .filter(RLMMonitoring.monitoring_ts >= start)
        .filter(RLMMonitoring.monitoring_ts <= end)
    )
    if min_feet:
        monitoring_query = monitoring_query.filter(RLMReel.reel_start.isnot(None))
        monitoring_query = monitoring_query.filter(RLMReel.reel_end.isnot(None))
        monitoring_query = monitoring_query.filter(RLMReel.reel_end >= RLMReel.reel_start)
        monitoring_query = monitoring_query.filter((RLMReel.reel_end - RLMReel.reel_start) * RLM_REEL_FEET_PER_RANGE_UNIT >= min_feet)
    monitoring_query = _apply_machine_job_selections(monitoring_query, selections)
    reel_ids = [int(row[0]) for row in monitoring_query.all() if row and row[0] is not None]
    if not reel_ids:
        return []

    reels = (
        session.query(RLMReel)
        .options(selectinload(RLMReel.machine))
        .filter(RLMReel.reel_db_id.in_(reel_ids))
        .all()
    )
    reels_by_id = {int(reel.reel_db_id): reel for reel in reels}
    repeat_length = repeat_length_service.fetch_reel_batch(session, reel_ids)

    selected_jobs_by_machine = {
        int(selection["machine_id"]): {
            "keys": selection.get("job_keys") or [],
            "labels": selection.get("job_labels") or [],
        }
        for selection in selections
    }
    grouped = defaultdict(
        lambda: {
            "machineId": None,
            "machineName": "",
            "selectionMode": "all_jobs",
            "selectedJobs": [],
            "reelIds": set(),
            "points": [],
        }
    )
    for reel_id in reel_ids:
        reel = reels_by_id.get(int(reel_id))
        if not reel:
            continue
        machine_id = int(reel.machine_id)
        machine_bucket = grouped[machine_id]
        machine_bucket["machineId"] = machine_id
        machine_bucket["machineName"] = reel.machine.machine_name if reel.machine else f"Press {machine_id}"
        selected_jobs = selected_jobs_by_machine.get(machine_id) or {"keys": [], "labels": []}
        machine_bucket["selectionMode"] = "selected_jobs" if selected_jobs["keys"] else "all_jobs"
        machine_bucket["selectedJobs"] = selected_jobs["labels"]
        machine_bucket["reelIds"].add(int(reel.reel_db_id))
        raw_points = repeat_length.get(int(reel.reel_db_id), {}).get("points") or []
        for point in raw_points:
            timestamp = _parse_date(point.get("timestamp"))
            if not timestamp or timestamp < start or timestamp > end:
                continue
            delta = point.get("delta")
            if delta is None:
                continue
            if not point.get("matchedTolerance"):
                continue
            machine_bucket["points"].append(_serialize_delta_trend_point(reel, point))

    payload = []
    for machine_bucket in grouped.values():
        points = sorted(machine_bucket["points"], key=lambda item: (item.get("timestamp") or "", int(item.get("id") or 0)))
        if not points:
            continue
        payload.append(
            {
                "machineId": machine_bucket["machineId"],
                "machineName": machine_bucket["machineName"],
                "selectionMode": machine_bucket["selectionMode"],
                "selectedJobs": machine_bucket["selectedJobs"],
                "reelCount": len(machine_bucket["reelIds"]),
                "pointCount": len(points),
                "points": points,
            }
        )
    return sorted(payload, key=lambda item: item["machineName"].lower())


def _apply_reel_filters(query, filters):
    if filters.get("machine_id"):
        query = query.filter(RLMReel.machine_id == filters["machine_id"])
    if filters.get("reel_db_id"):
        query = query.filter(RLMReel.reel_db_id == filters["reel_db_id"])
    job_pairs = filters.get("job_pairs") or []
    if job_pairs:
        pair_clauses = []
        for job_name, order_number in job_pairs:
            if order_number:
                pair_clauses.append(and_(RLMReel.job_name == job_name, RLMReel.order_number == order_number))
            else:
                pair_clauses.append(
                    and_(
                        RLMReel.job_name == job_name,
                        or_(RLMReel.order_number.is_(None), RLMReel.order_number == ""),
                    )
                )
        query = query.filter(or_(*pair_clauses))
    else:
        job_names = filters.get("job_names") or []
        if job_names:
            query = query.filter(RLMReel.job_name.in_(job_names))
    start = filters.get("start")
    if start:
        query = query.filter(RLMReel.production_start_dt.isnot(None))
        query = query.filter(RLMReel.production_start_dt >= start)
    end = filters.get("end")
    if end:
        query = query.filter(RLMReel.production_start_dt.isnot(None))
        query = query.filter(RLMReel.production_start_dt <= end)
    min_feet = filters.get("min_feet")
    if min_feet:
        query = query.filter(RLMReel.reel_start.isnot(None))
        query = query.filter(RLMReel.reel_end.isnot(None))
        query = query.filter(RLMReel.reel_end >= RLMReel.reel_start)
        query = query.filter((RLMReel.reel_end - RLMReel.reel_start) * RLM_REEL_FEET_PER_RANGE_UNIT >= min_feet)
    return query


def _monitorings_query(session, filters):
    query = (
        session.query(RLMMonitoring)
        .join(RLMReel, RLMMonitoring.reel_db_id == RLMReel.reel_db_id)
        .outerjoin(RLMMachine, RLMReel.machine_id == RLMMachine.machine_id)
    )
    if filters.get("machine_id"):
        query = query.filter(RLMReel.machine_id == filters["machine_id"])
    if filters.get("reel_db_id"):
        query = query.filter(RLMMonitoring.reel_db_id == filters["reel_db_id"])
    job_pairs = filters.get("job_pairs") or []
    if job_pairs:
        pair_clauses = []
        for job_name, order_number in job_pairs:
            if order_number:
                pair_clauses.append(and_(RLMReel.job_name == job_name, RLMReel.order_number == order_number))
            else:
                pair_clauses.append(
                    and_(
                        RLMReel.job_name == job_name,
                        or_(RLMReel.order_number.is_(None), RLMReel.order_number == ""),
                    )
                )
        query = query.filter(or_(*pair_clauses))
    else:
        job_names = filters.get("job_names") or []
        if job_names:
            query = query.filter(RLMReel.job_name.in_(job_names))
    start = filters.get("start")
    if start:
        query = query.filter(RLMMonitoring.monitoring_ts >= start)
    end = filters.get("end")
    if end:
        query = query.filter(RLMMonitoring.monitoring_ts <= end)
    min_feet = filters.get("min_feet")
    if min_feet:
        query = query.filter(RLMReel.reel_start.isnot(None))
        query = query.filter(RLMReel.reel_end.isnot(None))
        query = query.filter(RLMReel.reel_end >= RLMReel.reel_start)
        query = query.filter((RLMReel.reel_end - RLMReel.reel_start) * RLM_REEL_FEET_PER_RANGE_UNIT >= min_feet)
    return query


def _to_float(value: Optional[object]) -> Optional[float]:
    if value is None:
        return None
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, Decimal):
        return float(value)
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _iso(dt: Optional[datetime]) -> Optional[str]:
    return dt.isoformat() if dt else None


def _serialize_reel_payload(reel, reel_summary: Dict[str, object], latest_monitoring_ts: Optional[datetime] = None):
    return {
        "reelDbId": reel.reel_db_id,
        "machineId": reel.machine_id,
        "machineName": reel.machine.machine_name if reel.machine else None,
        "reelId": reel.reel_id,
        "orderNumber": reel.order_number,
        "jobName": reel.job_name,
        "productionStart": _iso(reel.production_start_dt),
        "productionEnd": _iso(reel.production_end_dt),
        "reelStart": _to_float(reel.reel_start),
        "reelEnd": _to_float(reel.reel_end),
        "monitorCount": int(reel_summary.get("total_monitoring_points") or 0),
        "totalMonitoringPoints": int(reel_summary.get("total_monitoring_points") or 0),
        "matchedMonitoringPoints": int(reel_summary.get("matched_monitoring_points") or 0),
        "unmatchedMonitoringPoints": int(reel_summary.get("unmatched_monitoring_points") or 0),
        "goodMonitoringPoints": int(reel_summary.get("good_monitoring_points") or 0),
        "badMonitoringPoints": int(reel_summary.get("bad_monitoring_points") or 0),
        "badPointPct": reel_summary.get("bad_point_pct"),
        "goodPointPct": reel_summary.get("good_point_pct"),
        "feetTotal": reel_summary.get("feet_total"),
        "estimatedBadFeet": reel_summary.get("estimated_bad_feet"),
        "estimatedGoodFeet": reel_summary.get("estimated_good_feet"),
        "toleranceSegmentCount": int(reel_summary.get("tolerance_segment_count") or 0),
        "latestMonitoringTs": _iso(latest_monitoring_ts),
    }


def _serialize_monitoring_point(reel, point: Dict[str, object]):
    return {
        "id": point.get("monitoringId"),
        "reelDbId": reel.reel_db_id,
        "timestamp": point.get("timestamp"),
        "curlength": point.get("curlength"),
        "webspeed": point.get("webspeed"),
        "formatValue": point.get("formatValue"),
        "jobName": reel.job_name,
        "orderNumber": reel.order_number,
        "reelId": reel.reel_id,
        "productionStart": _iso(reel.production_start_dt),
        "machineId": reel.machine_id,
        "machineName": reel.machine.machine_name if reel.machine else None,
        "matchedTolerance": bool(point.get("matchedTolerance")),
        "matchReason": point.get("matchReason"),
        "segmentIndex": point.get("segmentIndex"),
        "appliedToleranceId": point.get("appliedToleranceId"),
        "appliedNominalLength": point.get("appliedNominalLength"),
        "appliedErrShrink": point.get("appliedErrShrink"),
        "appliedErrExpand": point.get("appliedErrExpand"),
        "delta": point.get("delta"),
        "lowerBound": point.get("lowerBound"),
        "upperBound": point.get("upperBound"),
        "outOfRange": point.get("outOfRange"),
    }


def _serialize_tolerance_payload(tolerance, job_name, order_number, reel_code):
    return {
        "toleranceId": tolerance.tolerance_id,
        "reelDbId": tolerance.reel_db_id,
        "sequence": tolerance.tol_sequence,
        "formatValue": _to_float(tolerance.tol_format),
        "nominalLength": _to_float(tolerance.nom_length),
        "warnShrink": _to_float(tolerance.wrn_shrink),
        "warnExpand": _to_float(tolerance.wrn_expand),
        "errShrink": _to_float(tolerance.err_shrink),
        "errExpand": _to_float(tolerance.err_expand),
        "timestamp": _iso(tolerance.tolerance_time),
        "jobName": job_name,
        "orderNumber": order_number,
        "reelId": reel_code,
    }


def _build_summary_payload(
    *,
    filtered_reels,
    job_names,
    tolerance_avg,
    total_monitorings,
    avg_curlength,
    min_curlength,
    max_curlength,
    avg_webspeed,
    min_webspeed,
    max_webspeed,
    latest_ts,
    reel_summaries,
    phase_rows,
):
    active_reel_count = 0
    inactive_reel_count = 0
    active_feet = 0.0
    inactive_feet = 0.0
    for reel in filtered_reels:
        reel_summary = reel_summaries.get(int(reel.reel_db_id), {})
        feet_total = float(reel_summary.get("feet_total") or 0.0)
        total_points = int(reel_summary.get("total_monitoring_points") or 0)
        if total_points > 0:
            active_reel_count += 1
            active_feet += feet_total
        else:
            inactive_reel_count += 1
            inactive_feet += feet_total

    phase_seconds = {"active": 0.0, "inactive": 0.0, "other": 0.0}
    for _reel_id, phase_name, duration_seconds in phase_rows:
        key = str(phase_name or "").strip().lower()
        duration = max(float(duration_seconds or 0.0), 0.0)
        if key == "active":
            phase_seconds["active"] += duration
        elif key == "inactive":
            phase_seconds["inactive"] += duration
        else:
            phase_seconds["other"] += duration

    total_reels = len(filtered_reels)
    known_phase_seconds = phase_seconds["active"] + phase_seconds["inactive"]
    total_feet = active_feet + inactive_feet
    return {
        "totalReels": total_reels,
        "totalJobs": len(job_names),
        "jobNames": job_names,
        "totalMonitoringPoints": total_monitorings,
        "avgCurlength": avg_curlength,
        "minCurlength": min_curlength,
        "maxCurlength": max_curlength,
        "avgWebspeed": avg_webspeed,
        "minWebspeed": min_webspeed,
        "maxWebspeed": max_webspeed,
        "latestMonitoringTs": _iso(latest_ts),
        "avgNominalLength": _to_float(tolerance_avg),
        "rlmStatus": {
            "activeMinutes": round(phase_seconds["active"] / 60.0, 2),
            "inactiveMinutes": round(phase_seconds["inactive"] / 60.0, 2),
            "knownPhaseMinutes": round(known_phase_seconds / 60.0, 2),
            "activePhasePct": round((phase_seconds["active"] / known_phase_seconds * 100.0), 2) if known_phase_seconds > 0 else None,
            "inactivePhasePct": round((phase_seconds["inactive"] / known_phase_seconds * 100.0), 2) if known_phase_seconds > 0 else None,
            "activeReelCount": active_reel_count,
            "inactiveReelCount": inactive_reel_count,
            "activeReelPct": round((active_reel_count / total_reels * 100.0), 2) if total_reels > 0 else None,
            "inactiveReelPct": round((inactive_reel_count / total_reels * 100.0), 2) if total_reels > 0 else None,
            "activeFeet": round(active_feet, 3),
            "inactiveFeet": round(inactive_feet, 3),
            "activeFeetPct": round((active_feet / total_feet * 100.0), 2) if total_feet > 0 else None,
            "inactiveFeetPct": round((inactive_feet / total_feet * 100.0), 2) if total_feet > 0 else None,
        },
    }


def _build_rlm_dataset(session, filters, include_tolerances: bool = False):
    filtered_reels = (
        _apply_reel_filters(
            session.query(RLMReel).options(selectinload(RLMReel.machine)),
            filters,
        )
        .all()
    )
    reel_ids = [int(reel.reel_db_id) for reel in filtered_reels]
    repeat_length = repeat_length_service.fetch_reel_batch(session, reel_ids)
    reel_summaries = repeat_length_service.build_reel_summary_batch(filtered_reels, repeat_length)

    job_rows = (
        _apply_reel_filters(
            session.query(RLMReel.job_name, RLMReel.order_number)
            .filter(RLMReel.job_name.isnot(None))
            .filter(RLMReel.job_name != ""),
            filters,
        )
        .group_by(RLMReel.job_name, RLMReel.order_number)
        .order_by(RLMReel.job_name.asc(), RLMReel.order_number.asc())
        .all()
    )
    job_names = [key for job_name, order_number in job_rows for key in [_job_key(job_name, order_number)] if key]

    tolerance_avg = (
        _apply_reel_filters(
            session.query(func.avg(RLMTolerance.nom_length))
            .join(RLMReel, RLMTolerance.reel_db_id == RLMReel.reel_db_id),
            filters,
        )
        .scalar()
    )

    monitoring_query = _monitorings_query(session, filters)
    stats = monitoring_query.with_entities(
        func.count(RLMMonitoring.monitoring_id),
        func.avg(RLMMonitoring.curlength),
        func.min(RLMMonitoring.curlength),
        func.max(RLMMonitoring.curlength),
        func.avg(RLMMonitoring.webspeed),
        func.min(RLMMonitoring.webspeed),
        func.max(RLMMonitoring.webspeed),
        func.max(RLMMonitoring.monitoring_ts),
    ).first()

    phase_rows = []
    if reel_ids:
        phase_rows = (
            session.query(
                RLMPhaseInterval.reel_db_id,
                RLMPhaseInterval.phase_name,
                RLMPhaseInterval.duration_seconds,
            )
            .filter(RLMPhaseInterval.reel_db_id.in_(reel_ids))
            .all()
        )

    tolerance_rows = []
    if include_tolerances:
        tolerance_rows = (
            _apply_reel_filters(
                session.query(RLMTolerance, RLMReel.job_name, RLMReel.order_number, RLMReel.reel_id)
                .join(RLMReel, RLMTolerance.reel_db_id == RLMReel.reel_db_id),
                filters,
            )
            .order_by(RLMTolerance.tolerance_time.is_(None), RLMTolerance.tolerance_time.desc())
            .all()
        )

    summary = _build_summary_payload(
        filtered_reels=filtered_reels,
        job_names=job_names,
        tolerance_avg=tolerance_avg,
        total_monitorings=stats[0] if stats else 0,
        avg_curlength=_to_float(stats[1]) if stats else None,
        min_curlength=_to_float(stats[2]) if stats else None,
        max_curlength=_to_float(stats[3]) if stats else None,
        avg_webspeed=_to_float(stats[4]) if stats else None,
        min_webspeed=_to_float(stats[5]) if stats else None,
        max_webspeed=_to_float(stats[6]) if stats else None,
        latest_ts=stats[7] if stats else None,
        reel_summaries=reel_summaries,
        phase_rows=phase_rows,
    )
    return {
        "filtered_reels": filtered_reels,
        "repeat_length": repeat_length,
        "reel_summaries": reel_summaries,
        "summary": summary,
        "tolerance_rows": tolerance_rows,
    }


def _build_reels_payload(filtered_reels, repeat_length, reel_summaries, limit: Optional[int] = None, reverse: bool = True):
    rows = sorted(
        filtered_reels,
        key=lambda reel: reel.production_start_dt or reel.production_end_dt or datetime.min,
        reverse=reverse,
    )
    if limit is not None:
        rows = rows[:limit]
    return [
        _serialize_reel_payload(
            reel,
            reel_summaries.get(reel.reel_db_id, {}),
            _parse_date((repeat_length.get(reel.reel_db_id, {}).get("points") or [{}])[-1].get("timestamp"))
            if (repeat_length.get(reel.reel_db_id, {}).get("points"))
            else None,
        )
        for reel in rows
    ]


def _build_monitorings_payload(filtered_reels, repeat_length, reel_summaries, limit: Optional[int] = None):
    per_reel = []
    payload = []
    for reel in filtered_reels:
        reel_repeat = repeat_length.get(reel.reel_db_id, {})
        reel_summary = reel_summaries.get(reel.reel_db_id, {})
        per_reel.append(
            {
                "reelDbId": reel.reel_db_id,
                "monitorCount": int(reel_summary.get("total_monitoring_points") or 0),
                "totalMonitoringPoints": int(reel_summary.get("total_monitoring_points") or 0),
                "matchedMonitoringPoints": int(reel_summary.get("matched_monitoring_points") or 0),
                "unmatchedMonitoringPoints": int(reel_summary.get("unmatched_monitoring_points") or 0),
                "goodMonitoringPoints": int(reel_summary.get("good_monitoring_points") or 0),
                "badMonitoringPoints": int(reel_summary.get("bad_monitoring_points") or 0),
                "badPointPct": reel_summary.get("bad_point_pct"),
                "goodPointPct": reel_summary.get("good_point_pct"),
                "feetTotal": reel_summary.get("feet_total"),
                "estimatedBadFeet": reel_summary.get("estimated_bad_feet"),
                "estimatedGoodFeet": reel_summary.get("estimated_good_feet"),
                "avgCurlength": reel_repeat.get("avgCurlength"),
                "avgWebspeed": reel_repeat.get("avgWebspeed"),
                "toleranceSegmentCount": int(reel_summary.get("tolerance_segment_count") or 0),
            }
        )
        payload.extend(_serialize_monitoring_point(reel, point) for point in (reel_repeat.get("points") or []))
    payload.sort(key=lambda row: (row.get("timestamp") or "", int(row.get("id") or 0)))
    if limit is not None:
        payload = payload[:limit]
    return {"points": payload, "perReel": per_reel}


@rlm_bp.route("/")
def rlm_home():
    window = _default_window()
    default_start_str = window["start"].strftime("%Y-%m-%d")
    default_end_str = window["end"].strftime("%Y-%m-%d")
    with RLMSessionLocal() as session:
        machines = (
            session.query(RLMMachine)
            .order_by(RLMMachine.machine_name.asc())
            .all()
        )
        default_machine = next(
            (
                machine
                for machine in machines
                if (machine.machine_name or "").strip().lower() == "press 11"
            ),
            machines[0] if machines else None,
        )
        machine_options = [
            {
                "machine_id": machine.machine_id,
                "machine_name": machine.machine_name or f"Machine {machine.machine_id}",
            }
            for machine in machines
        ]
        default_machine_id = default_machine.machine_id if default_machine else None
    return render_template(
        "rlm.html",
        machines=machine_options,
        default_machine_id=default_machine_id,
        default_start=window["start"],
        default_end=window["end"],
        default_start_str=default_start_str,
        default_end_str=default_end_str,
    )


@rlm_bp.route("/delta-trends")
def rlm_delta_trends_home():
    window = _default_window()
    default_start_str = _format_ui_datetime_input(window["start"])
    default_end_str = _format_ui_datetime_input(window["end"])
    return render_template(
        "rlm_delta_trends.html",
        default_start_str=default_start_str,
        default_end_str=default_end_str,
    )


@rlm_bp.route("/api/delta-trends/options")
def rlm_delta_trend_options():
    window = _normalize_window_payload(request.args)
    min_feet = _parse_min_feet_value(request.args.get("min_feet"))
    with RLMSessionLocal() as session:
        machines = _build_delta_trend_options(session, window["start"], window["end"], min_feet=min_feet)
    return jsonify(
        {
            "start": _iso(window["start"]),
            "end": _iso(window["end"]),
            "minFeet": min_feet,
            "machines": machines,
        }
    )


@rlm_bp.route("/api/delta-trends/data", methods=["POST"])
def rlm_delta_trend_data():
    payload = request.get_json(silent=True) or {}
    window = _normalize_window_payload(payload)
    min_feet = _parse_min_feet_value(payload.get("min_feet") if isinstance(payload, dict) else None)
    selections = _normalize_machine_job_selections(payload)
    raw_selections = payload.get("selections") if isinstance(payload, dict) else None
    if isinstance(raw_selections, list) and not selections:
        return jsonify(
            {
                "start": _iso(window["start"]),
                "end": _iso(window["end"]),
                "machines": [],
            }
        )
    with RLMSessionLocal() as session:
        machines = _build_delta_trend_dataset(session, window["start"], window["end"], selections, min_feet=min_feet)
    return jsonify(
        {
            "start": _iso(window["start"]),
            "end": _iso(window["end"]),
            "minFeet": min_feet,
            "machines": machines,
        }
    )


@rlm_bp.route("/api/summary")
def rlm_summary():
    filters = _normalize_filters(request.args)
    with RLMSessionLocal() as session:
        dataset = _build_rlm_dataset(session, filters, include_tolerances=False)
    return jsonify(dataset["summary"])


@rlm_bp.route("/api/page-data")
def rlm_page_data():
    filters = _normalize_filters(request.args)
    with RLMSessionLocal() as session:
        dataset = _build_rlm_dataset(session, filters, include_tolerances=True)

    return jsonify(
        {
            "summary": dataset["summary"],
            "reels": _build_reels_payload(
                dataset["filtered_reels"],
                dataset["repeat_length"],
                dataset["reel_summaries"],
                limit=None,
                reverse=True,
            ),
            "timelineReels": _build_reels_payload(
                dataset["filtered_reels"],
                dataset["repeat_length"],
                dataset["reel_summaries"],
                limit=None,
                reverse=False,
            ),
            "monitorings": _build_monitorings_payload(
                dataset["filtered_reels"],
                dataset["repeat_length"],
                dataset["reel_summaries"],
                limit=None,
            ),
            "tolerances": [
                _serialize_tolerance_payload(tolerance, job_name, order_number, reel_code)
                for tolerance, job_name, order_number, reel_code in dataset["tolerance_rows"]
            ],
        }
    )


@rlm_bp.route("/api/reels")
def rlm_reels():
    filters = _normalize_filters(request.args)
    limit_raw = request.args.get("limit")
    no_limit = False
    default_limit = 40
    limit = default_limit
    if limit_raw:
        if str(limit_raw).strip().lower() in {"all", "unlimited", "none"}:
            no_limit = True
        else:
            try:
                limit_val = int(limit_raw)
                if limit_val <= 0:
                    no_limit = True
                else:
                    limit = min(max(limit_val, 10), RLM_MAX_REEL_ROWS)
            except ValueError:
                limit = default_limit

    with RLMSessionLocal() as session:
        dataset = _build_rlm_dataset(session, filters, include_tolerances=False)
    return jsonify(
        {
            "reels": _build_reels_payload(
                dataset["filtered_reels"],
                dataset["repeat_length"],
                dataset["reel_summaries"],
                limit=None if no_limit else limit,
                reverse=True,
            )
        }
    )


@rlm_bp.route("/api/monitorings")
def rlm_monitorings():
    filters = _normalize_filters(request.args)
    limit_raw = request.args.get("limit", RLM_MAX_MONITORING_POINTS)
    limit = RLM_MAX_MONITORING_POINTS
    if isinstance(limit_raw, str) and limit_raw.lower() in {"all", "none", "unlimited"}:
        limit = None
    else:
        try:
            limit = int(limit_raw)
            if limit <= 0:
                limit = None
            else:
                limit = max(100, min(limit, RLM_MAX_MONITORING_POINTS))
        except (TypeError, ValueError):
            limit = RLM_MAX_MONITORING_POINTS

    with RLMSessionLocal() as session:
        dataset = _build_rlm_dataset(session, filters, include_tolerances=False)
    return jsonify(
        _build_monitorings_payload(
            dataset["filtered_reels"],
            dataset["repeat_length"],
            dataset["reel_summaries"],
            limit=limit,
        )
    )


@rlm_bp.route("/api/tolerances")
def rlm_tolerances():
    filters = _normalize_filters(request.args)
    limit_raw = request.args.get("limit", RLM_MAX_TOLERANCE_ROWS)
    limit = RLM_MAX_TOLERANCE_ROWS
    if isinstance(limit_raw, str) and limit_raw.lower() in {"all", "none", "unlimited"}:
        limit = None
    else:
        try:
            limit = int(limit_raw)
            if limit <= 0:
                limit = None
            else:
                limit = max(20, min(limit, RLM_MAX_TOLERANCE_ROWS))
        except (TypeError, ValueError):
            limit = RLM_MAX_TOLERANCE_ROWS

    with RLMSessionLocal() as session:
        query = (
            session.query(RLMTolerance, RLMReel.job_name, RLMReel.order_number, RLMReel.reel_id)
            .join(RLMReel, RLMTolerance.reel_db_id == RLMReel.reel_db_id)
        )
        query = _apply_reel_filters(query, filters)
        rows = (
            query.order_by(RLMTolerance.tolerance_time.is_(None), RLMTolerance.tolerance_time.desc())
        )
        if limit:
            rows = rows.limit(limit)
        rows = rows.all()

    payload = [
        _serialize_tolerance_payload(tolerance, job_name, order_number, reel_code)
        for tolerance, job_name, order_number, reel_code in rows
    ]
    return jsonify({"tolerances": payload})


@rlm_bp.route("/api/reels/<int:reel_db_id>")
def rlm_reel_detail(reel_db_id: int):
    with RLMSessionLocal() as session:
        reel = (
            session.query(RLMReel)
            .options(selectinload(RLMReel.machine))
            .filter(RLMReel.reel_db_id == reel_db_id)
            .first()
        )
        if not reel:
            return jsonify({"error": "Reel not found"}), 404

        phase_events = (
            session.query(RLMPhaseEvent)
            .filter(RLMPhaseEvent.reel_db_id == reel_db_id)
            .order_by(RLMPhaseEvent.event_sequence.asc())
            .all()
        )
        phase_intervals = (
            session.query(RLMPhaseInterval)
            .filter(RLMPhaseInterval.reel_db_id == reel_db_id)
            .order_by(RLMPhaseInterval.start_time.asc())
            .all()
        )
        tolerances = (
            session.query(RLMTolerance)
            .filter(RLMTolerance.reel_db_id == reel_db_id)
            .order_by(RLMTolerance.tol_sequence.asc())
            .all()
        )
        repeat_length = repeat_length_service.fetch_reel_batch(session, [reel_db_id]).get(reel_db_id, {})

    reel_payload = {
        "reelDbId": reel.reel_db_id,
        "machineId": reel.machine_id,
        "machineName": reel.machine.machine_name if reel.machine else None,
        "reelId": reel.reel_id,
        "jobName": reel.job_name,
        "orderNumber": reel.order_number,
        "productionStart": _iso(reel.production_start_dt),
        "productionEnd": _iso(reel.production_end_dt),
    }

    monitoring_payload = [
        {
            "id": point.get("monitoringId"),
            "timestamp": point.get("timestamp"),
            "curlength": point.get("curlength"),
            "webspeed": point.get("webspeed"),
            "formatValue": point.get("formatValue"),
            "matchedTolerance": bool(point.get("matchedTolerance")),
            "matchReason": point.get("matchReason"),
            "segmentIndex": point.get("segmentIndex"),
            "appliedToleranceId": point.get("appliedToleranceId"),
            "appliedNominalLength": point.get("appliedNominalLength"),
            "appliedErrShrink": point.get("appliedErrShrink"),
            "appliedErrExpand": point.get("appliedErrExpand"),
            "delta": point.get("delta"),
            "lowerBound": point.get("lowerBound"),
            "upperBound": point.get("upperBound"),
            "outOfRange": point.get("outOfRange"),
        }
        for point in (repeat_length.get("points") or [])
    ]
    phase_event_payload = [
        {
            "id": event.id,
            "sequence": event.event_sequence,
            "phaseName": event.phase_name,
            "timestamp": _iso(event.phase_time),
            "formatValue": _to_float(event.phase_format),
        }
        for event in phase_events
    ]
    phase_interval_payload = [
        {
            "id": interval.id,
            "phaseName": interval.phase_name,
            "startTime": _iso(interval.start_time),
            "endTime": _iso(interval.end_time),
            "durationSeconds": _to_float(interval.duration_seconds),
            "startFormat": _to_float(interval.start_format),
            "endFormat": _to_float(interval.end_format),
        }
        for interval in phase_intervals
    ]
    tolerance_payload = [
        {
            "id": tol.tolerance_id,
            "sequence": tol.tol_sequence,
            "formatValue": _to_float(tol.tol_format),
            "nominalLength": _to_float(tol.nom_length),
            "warnShrink": _to_float(tol.wrn_shrink),
            "warnExpand": _to_float(tol.wrn_expand),
            "errShrink": _to_float(tol.err_shrink),
            "errExpand": _to_float(tol.err_expand),
            "timestamp": _iso(tol.tolerance_time),
        }
        for tol in tolerances
    ]

    detail_summary = repeat_length_service.build_reel_summary(reel, repeat_length)
    return jsonify(
        {
            "reel": reel_payload,
            "monitorings": monitoring_payload,
            "monitoringSummary": {
                "totalMonitoringPoints": int(detail_summary.get("total_monitoring_points") or 0),
                "matchedMonitoringPoints": int(detail_summary.get("matched_monitoring_points") or 0),
                "unmatchedMonitoringPoints": int(detail_summary.get("unmatched_monitoring_points") or 0),
                "goodMonitoringPoints": int(detail_summary.get("good_monitoring_points") or 0),
                "badMonitoringPoints": int(detail_summary.get("bad_monitoring_points") or 0),
                "badPointPct": detail_summary.get("bad_point_pct"),
                "goodPointPct": detail_summary.get("good_point_pct"),
                "feetTotal": detail_summary.get("feet_total"),
                "estimatedBadFeet": detail_summary.get("estimated_bad_feet"),
                "estimatedGoodFeet": detail_summary.get("estimated_good_feet"),
                "toleranceSegmentCount": int(detail_summary.get("tolerance_segment_count") or 0),
                "segmentBreakdown": detail_summary.get("segment_breakdown") or [],
            },
            "phaseEvents": phase_event_payload,
            "phaseIntervals": phase_interval_payload,
            "tolerances": tolerance_payload,
        }
    )
