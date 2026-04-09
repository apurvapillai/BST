from __future__ import annotations

from datetime import datetime, timedelta
from typing import Any, Dict

from flask import Blueprint, jsonify, render_template, request

from db.connection import SessionLocal
from db.models import Machine
from services.rlm_assistant_service import (
    EXECUTION_MODE_DETERMINISTIC,
    EXECUTION_MODE_LLM,
    RLMAssistantService,
)


assistant_bp = Blueprint("assistant", __name__)
assistant_service = RLMAssistantService()


def _default_window() -> tuple[str, str]:
    end = datetime.utcnow().date()
    start = end - timedelta(days=2)
    return start.isoformat(), end.isoformat()


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
    return render_template(
        "assistant.html",
        machines=machines,
        default_start_date=start_date,
        default_end_date=end_date,
    )


@assistant_bp.route("/api/chat", methods=["POST"])
def assistant_chat():
    payload = request.get_json(silent=True) or {}
    if not isinstance(payload, dict):
        return jsonify({"error": "Invalid JSON payload."}), 400
    return jsonify(build_assistant_chat_response(payload, service=assistant_service))
