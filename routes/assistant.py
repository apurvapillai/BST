from __future__ import annotations

from datetime import datetime
from typing import Any, Dict

from flask import Blueprint, jsonify, render_template, request

from db.connection import SessionLocal
from db.models import Machine
from db.rlm_connection import RLMSessionLocal
from services.rlm_assistant_service import (
    EXECUTION_MODE_DETERMINISTIC,
    EXECUTION_MODE_LLM,
    KNOWN_MACHINE_ID_TO_PRESS_LABEL,
    RLMAssistantService,
)
from services.rlm_press_intelligence_service import PressIntelligenceFilters
from services.rlm_reel_footage import compute_reel_feet_from_range


assistant_bp = Blueprint("assistant", __name__)
assistant_service = RLMAssistantService()


def _default_window() -> tuple[str, str]:
    today = datetime.utcnow().date()
    return today.isoformat(), today.isoformat()


def _format_feet(value: Any) -> str:
    try:
        feet = float(value or 0.0)
    except (TypeError, ValueError):
        return "--"
    return f"{feet:,.0f} ft"


def _format_pct(value: Any) -> str:
    try:
        pct = float(value)
    except (TypeError, ValueError):
        return "--"
    return f"{pct:.2f}%"


def _assistant_press_rankings_today() -> list[Dict[str, Any]]:
    now = datetime.utcnow()
    start = now.replace(hour=0, minute=0, second=0, microsecond=0)
    try:
        filters = PressIntelligenceFilters(start=start, end=now)
        intelligence = assistant_service.press_service.get_press_intelligence(filters)
        with RLMSessionLocal() as session:
            reels = assistant_service.press_service._get_reels(session, filters)
            repeat_length = assistant_service.press_service._get_repeat_length_batch(
                session,
                [row.reel_db_id for row in reels],
            )
    except Exception:
        return []

    active_feet_by_machine: Dict[int, float] = {}
    total_feet_by_machine: Dict[int, float] = {}
    for reel in reels:
        machine_id = int(reel.machine_id or 0)
        feet = compute_reel_feet_from_range(reel.reel_start, reel.reel_end)
        if feet is None:
            continue
        total_feet_by_machine[machine_id] = float(total_feet_by_machine.get(machine_id) or 0.0) + float(feet)
        reel_repeat = repeat_length.get(reel.reel_db_id, {})
        if int(reel_repeat.get("monitoringPointsTotal") or 0) > 0:
            active_feet_by_machine[machine_id] = float(active_feet_by_machine.get(machine_id) or 0.0) + float(feet)

    rows = list(intelligence.get("pressRankings") or [])
    rows.sort(
        key=lambda row: (
            row.get("estimatedBadFeetPct") is None,
            float(row.get("estimatedBadFeetPct") or 0.0),
            str(row.get("machineName") or ""),
        )
    )

    cards: list[Dict[str, Any]] = []
    for index, row in enumerate(rows[:10], start=1):
        machine_id = int(row.get("machineId") or 0) if row.get("machineId") is not None else None
        press_label = str(row.get("machineName") or "").strip() or KNOWN_MACHINE_ID_TO_PRESS_LABEL.get(machine_id, f"Press {machine_id}")
        cards.append(
            {
                "rank": index,
                "press_label": press_label,
                "feet_total": _format_feet(row.get("feetTotal")),
                "bad_feet_pct": _format_pct(row.get("estimatedBadFeetPct")),
                "active_pct": _format_pct(
                    (
                        float(active_feet_by_machine.get(machine_id) or 0.0)
                        / float(total_feet_by_machine.get(machine_id) or 0.0)
                        * 100.0
                    )
                    if machine_id is not None and float(total_feet_by_machine.get(machine_id) or 0.0) > 0.0
                    else None
                ),
            }
        )
    return cards


def _base_filters(filters: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "machine_id": filters.get("machine_id"),
        "start": filters.get("start") or "",
        "end": filters.get("end") or "",
        "job": filters.get("job") or "",
        "order": filters.get("order") or "",
        "reel_ids": filters.get("reel_ids") or [],
    }


def _coming_soon_response(filters: Dict[str, Any], data_mode: str, requested_mode: str) -> Dict[str, Any]:
    return {
        "answer": {
            "title": f"{data_mode.replace('-', ' ').title()} mode is coming soon.",
            "summary": "This standalone assistant currently supports RLM-only analysis. Defects-only and Combined modes are not enabled yet.",
            "sections": [
                {
                    "label": "Available now",
                    "text": "Use RLM Only for status, comparison, ranking, reel summary, and trend questions.",
                }
            ],
        },
        "evidence": {
            "metrics": [{"label": "Mode", "value": "Coming soon"}],
            "chart": None,
        },
        "toolsUsed": [{"tool": "unsupported-mode", "ok": False}],
        "suggestedPrompts": [
            "Compare Press 6 vs Press 8",
            "Why is Press 11 ranked low?",
        ],
        "context": {
            "mode": "assistant-workspace",
            "filtersApplied": _base_filters(filters),
            "dataSemantics": "coming-soon",
            "requestedMode": requested_mode if requested_mode in {EXECUTION_MODE_DETERMINISTIC, EXECUTION_MODE_LLM} else EXECUTION_MODE_DETERMINISTIC,
            "executionMode": EXECUTION_MODE_DETERMINISTIC,
        },
    }


def build_assistant_chat_response(
    payload: Dict[str, Any],
    *,
    service: RLMAssistantService | None = None,
) -> Dict[str, Any]:
    active_service = service or assistant_service
    message = payload.get("message") or ""
    filters = payload.get("filters") or {}
    history = payload.get("history") or []
    mode = payload.get("mode") or EXECUTION_MODE_DETERMINISTIC
    diagnostic = bool(payload.get("diagnostic"))
    data_mode = str(payload.get("data_mode") or "rlm-only").strip().lower()

    if data_mode != "rlm-only":
        return _coming_soon_response(filters, data_mode, mode)

    return active_service.handle_chat(
        message=message,
        filters=filters,
        history=history,
        mode=mode,
        diagnostic=diagnostic,
    )


@assistant_bp.route("/")
def assistant_home():
    start_date, end_date = _default_window()
    with SessionLocal() as session:
        machines = session.query(Machine).order_by(Machine.name.asc()).all()
    today_press_rankings = _assistant_press_rankings_today()
    return render_template(
        "assistant.html",
        machines=machines,
        default_start_date=start_date,
        default_end_date=end_date,
        today_press_rankings=today_press_rankings,
    )


@assistant_bp.route("/api/chat", methods=["POST"])
def assistant_chat():
    payload = request.get_json(silent=True) or {}
    if not isinstance(payload, dict):
        return jsonify({"error": "Invalid JSON payload."}), 400
    return jsonify(build_assistant_chat_response(payload, service=assistant_service))
