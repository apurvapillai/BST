from __future__ import annotations

from datetime import datetime, timedelta
from typing import Optional

from flask import Blueprint, jsonify, render_template, request

from db.rlm_connection import RLMSessionLocal
from db.rlm_models import RLMMachine
from services.rlm_job_comparison_service import (
    JobComparisonSideFilters,
    RLMJobComparisonService,
    default_side_filters,
)
from services.rlm_press_intelligence_service import (
    PressIntelligenceFilters,
    RLMPressIntelligenceService,
    default_filters,
)


rlm_press_intelligence_bp = Blueprint("rlm_press_intelligence", __name__)
service = RLMPressIntelligenceService()
job_comparison_service = RLMJobComparisonService()


def _parse_date(value: Optional[str]) -> Optional[datetime]:
    """Parse API date filters without mutating database state."""
    if not value:
        return None
    try:
        if len(value) == 10:
            return datetime.strptime(value, "%Y-%m-%d")
        return datetime.fromisoformat(value)
    except ValueError:
        return None


def _parse_filters(args) -> PressIntelligenceFilters:
    """Normalize read-only Press Intelligence filters from query args."""
    defaults = default_filters()
    start = _parse_date(args.get("start_date") or args.get("start")) or defaults.start
    end = _parse_date(args.get("end_date") or args.get("end")) or defaults.end
    if len(args.get("end_date") or args.get("end") or "") == 10:
        end = end.replace(hour=23, minute=59, second=59, microsecond=999999)
    if start > end:
        start, end = end - timedelta(days=2), end

    job = (args.get("job") or args.get("job_name") or "").strip() or None
    min_feet = None
    raw_min_feet = args.get("min_feet")
    if raw_min_feet:
        try:
            min_feet = float(raw_min_feet)
        except (TypeError, ValueError):
            min_feet = None

    return PressIntelligenceFilters(start=start, end=end, job=job, min_feet=min_feet)


def _parse_side_filters(args, prefix: str) -> JobComparisonSideFilters:
    defaults = default_side_filters()
    start = _parse_date(args.get(f"{prefix}_start_date") or args.get(f"{prefix}_start")) or defaults.start
    end = _parse_date(args.get(f"{prefix}_end_date") or args.get(f"{prefix}_end")) or defaults.end
    raw_end = args.get(f"{prefix}_end_date") or args.get(f"{prefix}_end") or ""
    if len(raw_end) == 10:
        end = end.replace(hour=23, minute=59, second=59, microsecond=999999)
    if start > end:
        start, end = end - timedelta(days=2), end

    raw_machine_id = args.get(f"{prefix}_machine_id") or args.get(f"{prefix}_machine")
    try:
        machine_id = int(raw_machine_id) if raw_machine_id else None
    except (TypeError, ValueError):
        machine_id = None

    raw_job_machine_id = args.get(f"{prefix}_job_machine_id")
    try:
        job_machine_id = int(raw_job_machine_id) if raw_job_machine_id else None
    except (TypeError, ValueError):
        job_machine_id = None

    job = (args.get(f"{prefix}_job") or args.get(f"{prefix}_job_name") or "").strip() or None
    raw_min_feet = args.get(f"{prefix}_min_feet")
    try:
        min_feet = float(raw_min_feet) if raw_min_feet else None
    except (TypeError, ValueError):
        min_feet = None

    return JobComparisonSideFilters(
        machine_id=machine_id,
        start=start,
        end=end,
        job=job,
        job_machine_id=job_machine_id,
        min_feet=min_feet,
    )


@rlm_press_intelligence_bp.route("/press-intelligence")
def press_intelligence_home():
    """Render the executive page shell.

    This route is intentionally separate from the deep-dive /rlm page. The
    blueprint must be registered by the app before this route is reachable.
    """
    filters = default_filters()
    return render_template(
        "rlm_press_intelligence.html",
        default_start_str=filters.start.strftime("%Y-%m-%d"),
        default_end_str=filters.end.strftime("%Y-%m-%d"),
    )


@rlm_press_intelligence_bp.route("/api/press-intelligence")
def press_intelligence_api():
    """Return read-only executive press intelligence aggregates as JSON."""
    filters = _parse_filters(request.args)
    return jsonify(service.get_press_intelligence(filters))


@rlm_press_intelligence_bp.route("/job-comparison")
def job_comparison_home():
    filters = default_side_filters()
    with RLMSessionLocal() as session:
        machines = (
            session.query(RLMMachine)
            .order_by(RLMMachine.machine_name.asc())
            .all()
        )
    return render_template(
        "rlm_job_comparison.html",
        default_start_str=filters.start.strftime("%Y-%m-%d"),
        default_end_str=filters.end.strftime("%Y-%m-%d"),
        machines=[
            {"machine_id": machine.machine_id, "machine_name": machine.machine_name or f"Machine {machine.machine_id}"}
            for machine in machines
        ],
    )


@rlm_press_intelligence_bp.route("/api/job-comparison")
def job_comparison_api():
    left_filters = _parse_side_filters(request.args, "job1")
    right_filters = _parse_side_filters(request.args, "job2")
    return jsonify(job_comparison_service.get_job_comparison(left_filters, right_filters))
