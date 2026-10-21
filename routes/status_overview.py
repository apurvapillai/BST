from __future__ import annotations

from flask import Blueprint, jsonify, render_template, request

from services.bst_change_flags_service import BSTChangeFlagsService
from services.bst_overview_service import BSTOverviewService
from services.status_overview_service import StatusOverviewService

status_overview_bp = Blueprint("status_overview", __name__)
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
