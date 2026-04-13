from __future__ import annotations

from sqlalchemy import func

from flask import Blueprint, jsonify, request

from db.rlm_connection import RLMSessionLocal
from db.rlm_models import RLMMachine, RLMReel
from routes.rlm import _normalize_filters, _apply_reel_filters


rlm_jobs_bp = Blueprint("rlm_jobs", __name__)


@rlm_jobs_bp.route("/jobs")
def rlm_jobs():
    filters = _normalize_filters(request.args)
    structured = (request.args.get("structured") or "").strip().lower() in {"1", "true", "yes"}
    filters_no_job = dict(filters)
    filters_no_job["job_names"] = []
    filters_no_job["job_pairs"] = []
    with RLMSessionLocal() as session:
        if structured:
            query = _apply_reel_filters(
                session.query(
                    RLMReel.job_name,
                    RLMReel.order_number,
                    RLMReel.machine_id,
                    RLMMachine.machine_name,
                    func.count(RLMReel.reel_db_id),
                )
                .outerjoin(RLMMachine, RLMReel.machine_id == RLMMachine.machine_id)
                .filter(RLMReel.job_name.isnot(None))
                .filter(RLMReel.job_name != ""),
                filters_no_job,
            )
            rows = (
                query.group_by(RLMReel.job_name, RLMReel.order_number, RLMReel.machine_id, RLMMachine.machine_name)
                .order_by(RLMMachine.machine_name.asc(), RLMReel.job_name.asc(), RLMReel.order_number.asc())
                .limit(400)
                .all()
            )
            job_options = []
            for job_name, order_number, machine_id, machine_name, reel_count in rows:
                if not job_name:
                    continue
                machine_label = (machine_name or f"Press {machine_id}" if machine_id else "Unknown press").strip()
                order_label = (order_number or "").strip() or "No order"
                job_label = f"{job_name} - {order_label}"
                count_label = f"{int(reel_count or 0)} reels"
                label = (
                    f'{job_label} · {count_label}'
                    if filters.get("machine_id")
                    else f'{machine_label} - "{job_label}" · {count_label}'
                )
                job_options.append(
                    {
                        "value": f"{job_name}|||{order_number or ''}",
                        "label": label,
                        "jobName": job_name,
                        "orderNumber": order_number,
                        "machineId": machine_id,
                        "machineName": machine_label,
                        "reelCount": int(reel_count or 0),
                    }
                )
            return jsonify(
                {
                    "jobs": [option["value"] for option in job_options],
                    "jobOptions": job_options,
                }
            )

        query = _apply_reel_filters(
            session.query(RLMReel.job_name, RLMReel.order_number)
            .filter(RLMReel.job_name.isnot(None))
            .filter(RLMReel.job_name != ""),
            filters_no_job,
        )
        jobs = (
            query.group_by(RLMReel.job_name, RLMReel.order_number)
            .order_by(RLMReel.job_name.asc(), RLMReel.order_number.asc())
            .limit(200)
            .all()
        )
    job_options = []
    for job_name, order_number in jobs:
        if not job_name:
            continue
        order_label = (order_number or "").strip() or "No order"
        job_options.append(
            {
                "value": f"{job_name}|||{order_number or ''}",
                "label": f"{job_name} - {order_label}",
                "jobName": job_name,
                "orderNumber": order_number,
            }
        )
    return jsonify({"jobs": [option["value"] for option in job_options], "jobOptions": job_options})
