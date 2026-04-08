from __future__ import annotations

from datetime import datetime, timedelta
from typing import Optional

from flask import Blueprint, jsonify, render_template, request

from services.rlm_press_intelligence_service import (
    PressIntelligenceFilters,
    RLMPressIntelligenceService,
    default_filters,
)


rlm_press_intelligence_bp = Blueprint("rlm_press_intelligence", __name__)
service = RLMPressIntelligenceService()


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
