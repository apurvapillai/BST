from __future__ import annotations

from datetime import datetime, timedelta
from decimal import Decimal
from typing import Dict, Optional

from flask import Blueprint, jsonify, render_template, request
from sqlalchemy import func
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

RLM_DEFAULT_RANGE_DAYS = 1
RLM_MAX_MONITORING_POINTS = 2000
RLM_MAX_REEL_ROWS = 60
RLM_MAX_TOLERANCE_ROWS = 200
RLM_FEET_CONVERSION = 3.0417

rlm_bp = Blueprint("rlm", __name__)


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
        "job_names": job_names,
        "min_feet": min_feet,
    }


def _apply_reel_filters(query, filters):
    if filters.get("machine_id"):
        query = query.filter(RLMReel.machine_id == filters["machine_id"])
    if filters.get("reel_db_id"):
        query = query.filter(RLMReel.reel_db_id == filters["reel_db_id"])
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
        query = query.filter(
            func.abs(RLMReel.reel_end - RLMReel.reel_start) * RLM_FEET_CONVERSION >= min_feet
        )
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
        query = query.filter(
            func.abs(RLMReel.reel_end - RLMReel.reel_start) * RLM_FEET_CONVERSION >= min_feet
        )
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


@rlm_bp.route("/api/summary")
def rlm_summary():
    filters = _normalize_filters(request.args)
    with RLMSessionLocal() as session:
        reels_query = _apply_reel_filters(session.query(RLMReel), filters)
        total_reels = reels_query.count()

        job_rows = (
            _apply_reel_filters(
                session.query(RLMReel.job_name)
                .filter(RLMReel.job_name.isnot(None))
                .filter(RLMReel.job_name != ""),
                filters,
            )
            .group_by(RLMReel.job_name)
            .order_by(RLMReel.job_name.asc())
            .all()
        )
        job_names = [job_name for (job_name,) in job_rows if job_name]

        tolerance_query = (
            session.query(func.avg(RLMTolerance.nom_length))
            .join(RLMReel, RLMTolerance.reel_db_id == RLMReel.reel_db_id)
        )
        tolerance_query = _apply_reel_filters(tolerance_query, filters)
        tolerance_avg = tolerance_query.scalar()

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
        total_monitorings = stats[0] if stats else 0
        avg_curlength = _to_float(stats[1]) if stats else None
        min_curlength = _to_float(stats[2]) if stats else None
        max_curlength = _to_float(stats[3]) if stats else None
        avg_webspeed = _to_float(stats[4]) if stats else None
        min_webspeed = _to_float(stats[5]) if stats else None
        max_webspeed = _to_float(stats[6]) if stats else None
        latest_ts = stats[7] if stats else None

    return jsonify(
        {
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
        monitor_subq = (
            session.query(
                RLMMonitoring.reel_db_id.label("reel_db_id"),
                func.count(RLMMonitoring.monitoring_id).label("monitor_count"),
                func.max(RLMMonitoring.monitoring_ts).label("latest_monitoring_ts"),
            )
            .group_by(RLMMonitoring.reel_db_id)
            .subquery()
        )
        query = (
            session.query(RLMReel, monitor_subq.c.monitor_count, monitor_subq.c.latest_monitoring_ts)
            .outerjoin(monitor_subq, RLMReel.reel_db_id == monitor_subq.c.reel_db_id)
        )
        query = _apply_reel_filters(query, filters)
        query = query.options(selectinload(RLMReel.machine))
        rows_query = query.order_by(
            func.coalesce(RLMReel.production_start_dt, RLMReel.production_end_dt).desc()
        )
        if not no_limit:
            rows_query = rows_query.limit(limit)
        rows = rows_query.all()

    payload = []
    for reel, monitor_count, latest_monitoring_ts in rows:
        payload.append(
            {
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
                "monitorCount": int(monitor_count or 0),
                "latestMonitoringTs": _iso(latest_monitoring_ts),
            }
        )

    return jsonify({"reels": payload})


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
        monitoring_query = _monitorings_query(session, filters)
        per_reel_rows = (
            monitoring_query.with_entities(
                RLMMonitoring.reel_db_id,
                func.count(RLMMonitoring.monitoring_id),
                func.avg(RLMMonitoring.curlength),
                func.avg(RLMMonitoring.webspeed),
            )
            .group_by(RLMMonitoring.reel_db_id)
            .all()
        )
        per_reel = [
            {
                "reelDbId": reel_id,
                "monitorCount": int(count or 0),
                "avgCurlength": _to_float(avg_cl),
                "avgWebspeed": _to_float(avg_ws),
            }
            for reel_id, count, avg_cl, avg_ws in per_reel_rows
        ]

        points = (
            monitoring_query.with_entities(
                RLMMonitoring.monitoring_id,
                RLMMonitoring.reel_db_id,
                RLMMonitoring.monitoring_ts,
                RLMMonitoring.curlength,
                RLMMonitoring.webspeed,
                RLMMonitoring.format_value,
                RLMReel.job_name,
                RLMReel.order_number,
                RLMReel.reel_id,
                RLMReel.production_start_dt,
                RLMMachine.machine_id,
                RLMMachine.machine_name,
            )
            .order_by(RLMMonitoring.monitoring_ts.asc())
        )
        if limit:
            points = points.limit(limit)
        points = points.all()

    payload = [
        {
            "id": mid,
            "reelDbId": reel_id,
            "timestamp": _iso(ts),
            "curlength": _to_float(curlength),
            "webspeed": _to_float(webspeed),
            "formatValue": _to_float(fmt_value),
            "jobName": job_name,
            "orderNumber": order_number,
            "reelId": reel_code,
            "productionStart": _iso(prod_start),
            "machineId": machine_id,
            "machineName": machine_name,
        }
        for mid, reel_id, ts, curlength, webspeed, fmt_value, job_name, order_number, reel_code, prod_start, machine_id, machine_name in points
    ]

    return jsonify({"points": payload, "perReel": per_reel})


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
        {
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

        monitorings = (
            session.query(RLMMonitoring)
            .filter(RLMMonitoring.reel_db_id == reel_db_id)
            .order_by(RLMMonitoring.monitoring_ts.asc())
            .limit(RLM_MAX_MONITORING_POINTS)
            .all()
        )
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
            "id": mon.monitoring_id,
            "timestamp": _iso(mon.monitoring_ts),
            "curlength": _to_float(mon.curlength),
            "webspeed": _to_float(mon.webspeed),
            "formatValue": _to_float(mon.format_value),
        }
        for mon in monitorings
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

    return jsonify(
        {
            "reel": reel_payload,
            "monitorings": monitoring_payload,
            "phaseEvents": phase_event_payload,
            "phaseIntervals": phase_interval_payload,
            "tolerances": tolerance_payload,
        }
    )
