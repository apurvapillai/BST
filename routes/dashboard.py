from flask import Blueprint, render_template, request, jsonify
from db.connection import SessionLocal
from db.models import Machine, Reel, Defect
from sqlalchemy import func
from datetime import timedelta


dashboard_bp = Blueprint("dashboard", __name__)

@dashboard_bp.route("/")
def dashboard_home():
    from db.connection import SessionLocal
    from db.models import Machine, Reel
    from sqlalchemy import func

    session = SessionLocal()

    # Machines
    machines = session.query(Machine).all()
    default_machine = session.query(Machine).filter_by(name="Press 5").first()

    # Latest time
    default_end = session.query(func.max(Reel.time_end)).scalar()
    # Start = last reel - 1 day (if default_end exists)
    default_start = default_end - timedelta(hours=6) if default_end else None

    session.close()

    return render_template(
        "dashboard.html",
        machines=machines,
        default_machine_id=default_machine.machine_id if default_machine else None,
        default_start=default_start,   # pass datetime
        default_end=default_end        # pass datetime
    )


@dashboard_bp.route("/api/data")
def api_data():
    db = SessionLocal()

    # --- Query params ---
    machine_id = request.args.get("machine_id", type=int)
    start_date = request.args.get("start_date")
    end_date = request.args.get("end_date")
    status = request.args.get("status")

    # --- Base query ---
    reels_query = db.query(Reel)
    if machine_id:
        reels_query = reels_query.filter(Reel.machine_id == machine_id)
    if start_date:
        reels_query = reels_query.filter(Reel.time_start >= start_date)
    if end_date:
        reels_query = reels_query.filter(Reel.time_end <= end_date)
    if status:
        reels_query = reels_query.filter(Reel.inspection_state == status)

    reels = reels_query.all()
    reel_ids = [r.reel_id for r in reels]
    

    # --- Defects ---
    defects_query = db.query(Defect).filter(Defect.reel_id.in_(reel_ids))
    defect_type = request.args.get("defect_type")
    if defect_type:
        defects_query = defects_query.filter(Defect.class_name == defect_type)

    all_defects = defects_query.all()         # full set for charts & KPIs

    # --- KPIs ---
    total_length = sum([(float(r.reel_end or 0) - float(r.reel_start or 0)) for r in reels])

    # Length by inspection state
    active_length = sum((float(r.reel_end or 0) - float(r.reel_start or 0))
                        for r in reels if r.inspection_state == "active")
    inactive_length = sum((float(r.reel_end or 0) - float(r.reel_start or 0))
                          for r in reels if r.inspection_state == "inactive")
    learn_length = sum((float(r.reel_end or 0) - float(r.reel_start or 0))
                       for r in reels if r.inspection_state == "learn")

    # Reel counts
    active_reels = sum(1 for r in reels if r.inspection_state == "active")
    inactive_reels = sum(1 for r in reels if r.inspection_state == "inactive")
    learn_reels = sum(1 for r in reels if r.inspection_state == "learn")
    total_reels = active_reels + inactive_reels + learn_reels

    # Percentages
    active_pct = round((active_reels / total_reels * 100), 1) if total_reels else 0
    inactive_pct = round((inactive_reels / total_reels * 100), 1) if total_reels else 0
    learn_pct = round((learn_reels / total_reels * 100), 1) if total_reels else 0

    total_defects = len(all_defects)
    defect_classes = len(set([d.class_name for d in all_defects]))
    total_jobs = len(set([r.job_name for r in reels]))

    # --- Defaults for filters ---
    first_time = min((r.time_start for r in reels if r.time_start), default=None)
    last_time = max((r.time_end for r in reels if r.time_end), default=None)

    # --- Build JSON response ---
    return jsonify({
        "active_pct": active_pct,
        "inactive_pct": inactive_pct,
        "learn_pct": learn_pct,
        "total_length": total_length,
        "active_length": active_length,
        "inactive_length": inactive_length,
        "learn_length": learn_length,
        "total_defects": total_defects,
        "defect_classes": defect_classes,
        "total_jobs": total_jobs,
        "default_machine": machine_id or None,
        "default_start": first_time.isoformat() if first_time else None,
        "default_end": last_time.isoformat() if last_time else None,

        # Reels for charts
        "reels": [{
            "time_start": r.time_start.isoformat() if r.time_start else None,
            "time_end": r.time_end.isoformat() if r.time_end else None,
            "inspection_state": r.inspection_state,
            "job_name": r.job_name,
            "reel_start": float(r.reel_start or 0),
            "reel_end": float(r.reel_end or 0),
        } for r in reels],

        # All defects for charts
        "defects_all": [{
            "defect_time": d.defect_time.isoformat() if d.defect_time else None,
            "class_name": d.class_name,
            "magnitude_value": float(d.magnitude_value or 0),
            "severity_value": float(d.severity_value or 0),
            "format_position": float(d.format_position or 0),
            "job_name": d.reel.job_name if d.reel else None,
            "order_number": d.reel.order_number if d.reel else None,
            "reel_number": d.reel.reel_id if d.reel else None,
            "inspection_state": d.reel.inspection_state if d.reel else None,
            "image_src": d.image_src.replace("\\", "/") if d.image_src else None
        } for d in all_defects],

        "defects_table": [{
            "defect_time": d.defect_time.isoformat() if d.defect_time else None,
            "class_name": d.class_name,
            "magnitude_value": float(d.magnitude_value or 0),
            "severity_value": float(d.severity_value or 0),
            "format_position": float(d.format_position or 0),
            "job_name": d.reel.job_name if d.reel else None,
            "order_number": d.reel.order_number if d.reel else None,
            "reel_number": d.reel.reel_id if d.reel else None,
            "inspection_state": d.reel.inspection_state if d.reel else None,
            "image_src": d.image_src.replace("\\", "/") if d.image_src else None
        } for d in all_defects]
    })

