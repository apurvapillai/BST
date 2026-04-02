from __future__ import annotations

from flask import Blueprint, jsonify, render_template, request

from services.status_overview_service import StatusOverviewService

status_overview_bp = Blueprint("status_overview", __name__)
service = StatusOverviewService()


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


@status_overview_bp.route("/statusOverview/api/overview")
def status_overview_api():
    return jsonify(service.get_board_payload())


@status_overview_bp.route("/statusOverview/api/settings")
def status_overview_settings():
    return jsonify(service.get_settings_payload())


@status_overview_bp.route("/statusOverview/api/settings/save", methods=["POST"])
def status_overview_settings_save():
    payload = request.get_json(silent=True) or {}
    machine_id = payload.get("machineId")
    try:
        machine_id = int(machine_id) if machine_id not in (None, "", "all") else None
    except (TypeError, ValueError):
        return jsonify({"ok": False, "message": "Invalid machine selection."}), 400
    ok, message = service.save_settings(machine_id, payload.get("values") or {}, _request_actor(payload))
    return jsonify({"ok": ok, "message": message}), (200 if ok else 400)


@status_overview_bp.route("/statusOverview/api/settings/apply-all", methods=["POST"])
def status_overview_settings_apply_all():
    payload = request.get_json(silent=True) or {}
    ok, message = service.apply_to_all(payload.get("values") or {}, _request_actor(payload))
    return jsonify({"ok": ok, "message": message}), (200 if ok else 400)


@status_overview_bp.route("/statusOverview/api/settings/reset", methods=["POST"])
def status_overview_settings_reset():
    payload = request.get_json(silent=True) or {}
    machine_id = payload.get("machineId")
    try:
        machine_id = int(machine_id) if machine_id not in (None, "", "all") else None
    except (TypeError, ValueError):
        return jsonify({"ok": False, "message": "Invalid machine selection."}), 400
    ok, message = service.reset_settings(machine_id, _request_actor(payload))
    return jsonify({"ok": ok, "message": message}), (200 if ok else 400)


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
    return jsonify({"ok": ok, "message": message}), (200 if ok else 400 if "required" in message else 404)


@status_overview_bp.route("/statusOverview/api/alerts/<int:alert_id>/resolve", methods=["POST"])
def status_overview_resolve(alert_id: int):
    payload = request.get_json(silent=True) or {}
    ok, message = service.resolve_alert(alert_id, _request_actor(payload), payload.get("comment", ""))
    return jsonify({"ok": ok, "message": message}), (200 if ok else 400 if "required" in message else 404)
