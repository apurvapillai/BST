from __future__ import annotations

from flask import Blueprint, jsonify, request

from db.rlm_connection import RLMSessionLocal
from db.rlm_models import RLMReel
from routes.rlm import _normalize_filters, _apply_reel_filters


rlm_jobs_bp = Blueprint("rlm_jobs", __name__)


@rlm_jobs_bp.route("/jobs")
def rlm_jobs():
    filters = _normalize_filters(request.args)
    filters_no_job = dict(filters)
    filters_no_job["job_names"] = []
    with RLMSessionLocal() as session:
        query = _apply_reel_filters(
            session.query(RLMReel.job_name)
            .filter(RLMReel.job_name.isnot(None))
            .filter(RLMReel.job_name != ""),
            filters_no_job,
        )
        jobs = (
            query.group_by(RLMReel.job_name)
            .order_by(RLMReel.job_name.asc())
            .limit(200)
            .all()
        )
    job_list = [job_name for (job_name,) in jobs if job_name]
    return jsonify({"jobs": job_list})
