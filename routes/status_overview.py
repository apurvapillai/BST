from __future__ import annotations

import logging

from flask import Blueprint, jsonify, render_template, request

from services.bst_change_flags_service import BSTChangeFlagsService
from services.bst_overview_service import BSTOverviewService
from services.status_overview_service import (
    OVERVIEW_SETTING_DEFAULTS,
    OVERVIEW_SETTING_LIMITS,
    StatusOverviewService,
    get_overview_settings,
    save_overview_settings,
)

status_overview_bp = Blueprint("status_overview", __name__)
logger = logging.getLogger(__name__)
service = StatusOverviewService()
change_flags_service = BSTChangeFlagsService()
overview_service = BSTOverviewService(service, change_flags_service)


def _request_actor(payload: dict) -> str:
    return (
        payload.get("actor")
        or request.headers.get("X-Forwarded-User")
        or request.headers.get("X-Remote-User")
        or request.headers.get("Remote-User")
        or "unknown"
    )


@status_overview_bp.route("/statusOverview")
def status_overview_home():
    return render_template("status_overview.html")


@status_overview_bp.route("/bst/overview")
def bst_overview_home():
    return render_template("status_overview.html")


@status_overview_bp.route("/bst/change-flags")
def bst_change_flags_home():
    return render_template("bst_change_flags.html")


@status_overview_bp.route("/statusOverview/api/overview")
def status_overview_api():
    return jsonify(overview_service.get_payload())


@status_overview_bp.route("/bst/change-flags/api")
def bst_change_flags_api():
    return jsonify(change_flags_service.get_payload())


@status_overview_bp.route("/statusOverview/api/overview/refresh", methods=["POST"])
def status_overview_refresh_api():
    return jsonify(overview_service.get_payload(sync_alerts=True))


@status_overview_bp.route("/statusOverview/api/alerts/<int:alert_id>")
def status_overview_alert(alert_id: int):
    alert = service.get_alert(alert_id)
    if not alert:
        return jsonify({"ok": False, "message": "Alert not found"}), 404
    return jsonify({"ok": True, "alert": alert})


@status_overview_bp.route("/statusOverview/api/alerts/<int:alert_id>/acknowledge", methods=["POST"])
def status_overview_acknowledge(alert_id: int):
    payload = request.get_json(silent=True) or {}
    ok, message = service.acknowledge_alert(alert_id, _request_actor(payload), payload.get("comment", ""))
    return jsonify({"ok": ok, "message": message}), (200 if ok else 404)


@status_overview_bp.route("/statusOverview/api/alerts/<int:alert_id>/resolve", methods=["POST"])
def status_overview_resolve(alert_id: int):
    payload = request.get_json(silent=True) or {}
    ok, message = service.acknowledge_alert(alert_id, _request_actor(payload), payload.get("comment", ""))
    return jsonify({"ok": ok, "message": message}), (200 if ok else 404)


@status_overview_bp.route("/statusOverview/api/alerts/<int:alert_id>/make-ready", methods=["POST"])
def status_overview_make_ready(alert_id: int):
    payload = request.get_json(silent=True) or {}
    ok, message = service.make_ready_alert(alert_id, _request_actor(payload), payload.get("comment", ""))
    return jsonify({"ok": ok, "message": message}), (200 if ok else 404)


def _settings_response(settings: dict) -> dict:
    return {
        "ok": True,
        "settings": settings,
        "defaults": OVERVIEW_SETTING_DEFAULTS,
        "limits": {key: {"min": low, "max": high} for key, (low, high, _) in OVERVIEW_SETTING_LIMITS.items()},
    }


@status_overview_bp.route("/statusOverview/api/settings")
def status_overview_settings():
    try:
        return jsonify(_settings_response(get_overview_settings(force=True)))
    except Exception as exc:
        logger.exception("Could not load overview settings")
        return jsonify({"ok": False, "message": f"Server error: {exc}"}), 500


@status_overview_bp.route("/statusOverview/api/settings", methods=["POST"])
def status_overview_save_settings():
    payload = request.get_json(silent=True) or {}
    try:
        settings = save_overview_settings(payload.get("settings") or {}, _request_actor(payload))
    except ValueError as exc:
        return jsonify({"ok": False, "message": str(exc)}), 400
    except Exception as exc:
        # Return the real reason (e.g. a database error) so the dialog can show it.
        logger.exception("Could not save overview settings")
        return jsonify({"ok": False, "message": f"Server error: {exc}"}), 500
    # Rebuild the board with the new settings right away.
    overview_service.invalidate()
    return jsonify(_settings_response(settings))