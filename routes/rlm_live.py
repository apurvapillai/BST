from __future__ import annotations

from flask import Blueprint, jsonify, render_template, request

from services.rlm_live_service import RLMLiveService

rlm_live_bp = Blueprint("rlm_live", __name__)
service = RLMLiveService()


@rlm_live_bp.route("/")
def live_home():
    return render_template("rlm_live.html")


@rlm_live_bp.route("/api/overview")
def live_overview():
    # Optional: generate alerts during each refresh.
    service.run_alert_scan()
    return jsonify(service.get_overview())


@rlm_live_bp.route("/api/alerts/history")
def alert_history():
    machine_id = request.args.get("machine_id", type=int)
    limit = request.args.get("limit", default=200, type=int)
    return jsonify({"alerts": service.get_alert_history(machine_id=machine_id, limit=limit)})


@rlm_live_bp.route("/api/alerts/<int:alert_id>/acknowledge", methods=["POST"])
def acknowledge_alert(alert_id: int):
    payload = request.get_json(silent=True) or {}
    acknowledged_by = payload.get("acknowledged_by") or "control-room"
    ok = service.acknowledge_alert(alert_id=alert_id, acknowledged_by=acknowledged_by)
    return jsonify({"ok": ok}), (200 if ok else 404)


@rlm_live_bp.route("/api/alerts/bulk_acknowledge", methods=["POST"])
def acknowledge_alerts_bulk():
    payload = request.get_json(silent=True) or {}
    alert_ids = payload.get("alert_ids") or []
    acknowledged_by = payload.get("acknowledged_by") or "control-room"
    try:
        count = service.acknowledge_alerts_bulk(alert_ids=alert_ids, acknowledged_by=acknowledged_by)
    except (ValueError, LookupError) as exc:
        return jsonify({"ok": False, "message": str(exc)}), 400
    return jsonify({"acknowledged": count})


@rlm_live_bp.route("/api/alerts/acknowledge_all", methods=["POST"])
def acknowledge_all_alerts():
    payload = request.get_json(silent=True) or {}
    password = payload.get("password", "")
    machine_id = payload.get("machine_id")
    severity = payload.get("severity")
    alert_ids = payload.get("alert_ids")
    acknowledged_by = payload.get("acknowledged_by", "bulk")
    ok, message, count = service.acknowledge_all_alerts(
        password=password,
        machine_id=machine_id,
        severity=severity,
        alert_ids=alert_ids,
        acknowledged_by=acknowledged_by,
    )
    return jsonify({"ok": ok, "message": message, "acknowledged": count}), (200 if ok else 400)


@rlm_live_bp.route("/api/thresholds")
def get_thresholds():
    return jsonify(service.get_thresholds())


@rlm_live_bp.route("/api/thresholds/<machine_id>", methods=["POST"])
def update_thresholds(machine_id: str):
    payload = request.get_json(silent=True) or {}
    password = payload.get("password", "")
    updated_by = payload.get("updated_by", "engineer")
    values = payload.get("values", {})
    try:
        target_id = 0 if machine_id == "all" else int(machine_id)
    except ValueError:
        return jsonify({"ok": False, "message": "Invalid machine ID"}), 400
    ok, message = service.update_thresholds(password=password, machine_id=target_id, values=values, updated_by=updated_by)
    return jsonify({"ok": ok, "message": message}), (200 if ok else 400)


@rlm_live_bp.route("/api/alert-config")
def get_alert_config():
    return jsonify(service.get_alert_config_view())


@rlm_live_bp.route("/api/alert-config", methods=["POST"])
def update_alert_config():
    payload = request.get_json(silent=True) or {}
    password = payload.get("password", "")
    updated_by = payload.get("updated_by", "admin")
    updates = payload.get("alerts", [])
    ok, message = service.update_alert_config(password=password, updates=updates, updated_by=updated_by)
    return jsonify({"ok": ok, "message": message}), (200 if ok else 400)


@rlm_live_bp.route("/api/windows/<int:machine_id>/<window_label>")
def window_details(machine_id: int, window_label: str):
    try:
        data = service.get_window_reels(machine_id=machine_id, window_label=window_label)
    except ValueError as exc:
        return jsonify({"ok": False, "message": str(exc)}), 400
    except LookupError as exc:
        return jsonify({"ok": False, "message": str(exc)}), 404
    return jsonify(data)
