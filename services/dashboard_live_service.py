from __future__ import annotations

from collections import Counter, defaultdict
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import Any, Dict, Iterable, List, Optional, Set, Tuple

from sqlalchemy import func, or_
from sqlalchemy.exc import OperationalError
from sqlalchemy.orm import selectinload

from db.connection import SessionLocal, engine
from db.models import (
    BSTLiveAlertEvent,
    BSTLiveAlertThreshold,
    Defect,
    InspectionPhase,
    Machine,
    Mask,
    Reel,
    ReelReview,
)

# --------------------------------------------------------------------------- #
# Tunable live thresholds / windows
# --------------------------------------------------------------------------- #
LOOKBACK_DEFAULT_HOURS = 8
LOOKBACK_CHOICES = (2, 4, 8, 12, 24)
NO_RECENT_DATA_MINUTES = 90
ACTIVE_WINDOW_MINUTES = 20
DEFECT_SPIKE_15_MIN_THRESHOLD = 10
DEFECT_SPIKE_60_MIN_THRESHOLD = 25
REVIEW_BACKLOG_REEL_THRESHOLD = 3
INSPECTION_OFF_ACTIVE_PCT = 5.0
HIGH_LEARN_PCT = 40.0
MASK_SPIKE_THRESHOLD = 5
REFERENCE_CHANGE_ALERT_THRESHOLD = 1


@dataclass
class MachineSnapshot:
    machine: Machine
    phase_seconds: Dict[str, float] = field(default_factory=lambda: defaultdict(float))
    total_length_m: float = 0.0
    last_activity: Optional[datetime] = None
    last_defect_time: Optional[datetime] = None
    last_reel_time: Optional[datetime] = None
    job_name: Optional[str] = None
    order_number: Optional[str] = None
    reel_code: Optional[str] = None
    inspection_state: Optional[str] = None
    latest_phase_label: Optional[str] = None
    defects_total: int = 0
    defects_15m: int = 0
    defects_60m: int = 0
    severity_counter: Counter = field(default_factory=Counter)
    pending_reel_codes: Set[str] = field(default_factory=set)
    latest_review: Optional[ReelReview] = None
    review_fail_recent: bool = False
    mask_recent_count: int = 0
    reference_changes: int = 0
    events: List[Dict[str, Any]] = field(default_factory=list)
    status: str = "idle"
    status_note: str = "No recent activity"
    status_priority: int = 0


class DashboardLiveService:
    """Aggregates live BST machine data for the supervisor / control room page."""

    def __init__(self) -> None:
        self._ensure_tables()

    def get_live_payload(
        self,
        *,
        machine_ids: Optional[Iterable[int]] = None,
        lookback_hours: Optional[int] = None,
    ) -> Dict[str, Any]:
        now = datetime.utcnow()
        lookback_hours = self._normalize_lookback(lookback_hours)
        window_end = now
        window_start = now - timedelta(hours=lookback_hours)
        window_15 = now - timedelta(minutes=15)
        window_60 = now - timedelta(minutes=60)
        day_start = now.replace(hour=0, minute=0, second=0, microsecond=0)

        with SessionLocal() as session:
            machine_query = session.query(Machine).order_by(Machine.name.asc())
            if machine_ids:
                machine_query = machine_query.filter(Machine.machine_id.in_(machine_ids))
            machines = machine_query.all()
            if not machines:
                return self._empty_payload(now, lookback_hours)

            snapshots = {machine.machine_id: MachineSnapshot(machine=machine) for machine in machines}

            reels_query = (
                session.query(Reel)
                .options(
                    selectinload(Reel.defects),
                    selectinload(Reel.inspection_phases),
                    selectinload(Reel.masks),
                    selectinload(Reel.reference_images),
                    selectinload(Reel.reviews),
                )
                .filter(or_(Reel.time_start.is_(None), Reel.time_start <= window_end))
                .filter(or_(Reel.time_end.is_(None), Reel.time_end >= window_start))
            )
            if machine_ids:
                reels_query = reels_query.filter(Reel.machine_id.in_(machine_ids))
            reels = reels_query.all()

            review_rows = (
                session.query(ReelReview)
                .options(selectinload(ReelReview.reel).selectinload(Reel.machine))
                .order_by(ReelReview.created_at.desc())
                .limit(200)
                .all()
            )
            failed_reels_today = (
                session.query(func.count(ReelReview.review_id))
                .filter(ReelReview.decision == "fail")
                .filter(ReelReview.created_at >= day_start)
                .scalar()
                or 0
            )

        timeline_counts: Dict[datetime, int] = defaultdict(int)
        alert_candidates: List[Dict[str, Any]] = []
        global_events: List[Dict[str, Any]] = []
        pending_reel_codes: Set[str] = set()
        defects_last_60 = 0

        for reel in reels:
            snapshot = snapshots.get(reel.machine_id)
            if not snapshot:
                continue
            self._ingest_reel(
                snapshot,
                reel,
                window_start,
                window_end,
                window_15,
                window_60,
                timeline_counts,
                pending_reel_codes,
                global_events,
            )

        machine_payload: List[Dict[str, Any]] = []
        backlog_by_machine: List[Dict[str, Any]] = []
        defects_by_machine: List[Dict[str, Any]] = []
        inspection_mix_rows: List[Dict[str, Any]] = []

        machines_active_now = 0
        machines_attention = 0
        inspection_off_machines = 0
        machines_no_recent = 0

        for snapshot in snapshots.values():
            self._finalize_snapshot(snapshot, now)
            machine_payload.append(self._serialize_machine(snapshot))
            backlog_by_machine.append(
                {
                    "machine_id": snapshot.machine.machine_id,
                    "machine_name": snapshot.machine.name,
                    "pending_reels": len(snapshot.pending_reel_codes),
                }
            )
            defects_by_machine.append(
                {
                    "machine_id": snapshot.machine.machine_id,
                    "machine_name": snapshot.machine.name,
                    "defects_60m": snapshot.defects_60m,
                    "defects_total": snapshot.defects_total,
                }
            )

            mix = self._inspection_mix(snapshot.phase_seconds)
            inspection_mix_rows.append(
                {
                    "machine_id": snapshot.machine.machine_id,
                    "machine_name": snapshot.machine.name,
                    **mix,
                }
            )

            defects_last_60 += snapshot.defects_60m
            if snapshot.last_activity and (now - snapshot.last_activity) <= timedelta(minutes=ACTIVE_WINDOW_MINUTES):
                machines_active_now += 1
            if snapshot.status in {"critical_alert", "warning", "attention"}:
                machines_attention += 1
            if mix["active_pct"] < INSPECTION_OFF_ACTIVE_PCT and (mix["active_pct"] + mix["inactive_pct"] + mix["learn_pct"]) > 0:
                inspection_off_machines += 1
            if not snapshot.last_activity or (now - snapshot.last_activity) >= timedelta(minutes=NO_RECENT_DATA_MINUTES):
                machines_no_recent += 1

            alert_candidates.extend(self._build_machine_alerts(snapshot, now, lookback_hours))

        order_lookup = {name.lower(): idx for idx, name in enumerate(["press 5","press 6","press 7","press 8","press 9","press 11","press 12","press 13","press 14","press 15"])}
        def _machine_order(entry: Dict[str, Any]) -> Tuple[int, str]:
            name = (entry.get("machine_name") or "").lower()
            return (order_lookup.get(name, len(order_lookup)), entry.get("machine_name") or "")
        machine_payload.sort(key=_machine_order)
        backlog_by_machine.sort(key=lambda entry: entry["pending_reels"], reverse=True)
        defects_by_machine.sort(key=lambda entry: entry["defects_60m"], reverse=True)
        inspection_mix_rows.sort(key=lambda entry: entry["machine_name"])
        recent_events_rows = sorted(
            global_events,
            key=lambda entry: entry.get("timestamp") or datetime.min,
            reverse=True,
        )[:60]
        recent_events = [
            {
                **entry,
                "timestamp": self._iso(entry.get("timestamp")),
            }
            for entry in recent_events_rows
        ]
        alerts = self._sync_alert_events(alert_candidates, now)
        trends = {
            "defects_by_machine": defects_by_machine,
            "defect_timeline": self._serialize_timeline(timeline_counts),
            "inspection_mix": inspection_mix_rows,
            "review_backlog": backlog_by_machine[:12],
        }
        review_summary = self._build_review_summary(pending_reel_codes, backlog_by_machine, review_rows)

        kpis = {
            "total_machines": len(machines),
            "machines_active": machines_active_now,
            "machines_attention": machines_attention,
            "defects_last_60m": defects_last_60,
            "failed_reels_today": int(failed_reels_today),
            "pending_review_reels": len(pending_reel_codes),
            "inspection_off": inspection_off_machines,
            "machines_no_recent": machines_no_recent,
        }

        payload = {
            "generated_at": self._iso(now),
            "lookback_hours": lookback_hours,
            "kpis": kpis,
            "machines": machine_payload,
            "alerts": alerts,
            "trends": trends,
            "recent_events": recent_events,
            "review_summary": review_summary,
        }
        return payload

    # ------------------------------------------------------------------ #
    # Snapshot helpers
    # ------------------------------------------------------------------ #

    def _ingest_reel(
        self,
        snapshot: MachineSnapshot,
        reel: Reel,
        window_start: datetime,
        window_end: datetime,
        window_15: datetime,
        window_60: datetime,
        timeline_counts: Dict[datetime, int],
        pending_reel_codes: Set[str],
        global_events: List[Dict[str, Any]],
    ) -> None:
        clip = self._clip_interval(reel.time_start, reel.time_end, window_start, window_end)
        if not clip:
            return
        clip_start, clip_end = clip
        candidate_times = [reel.time_end, reel.time_start, clip_end]
        newest_time = max((ts for ts in candidate_times if ts), default=None)
        if newest_time:
            if not snapshot.last_activity or newest_time > snapshot.last_activity:
                snapshot.last_activity = newest_time
        reel_time_marker = reel.time_end or reel.time_start or clip_end
        if reel_time_marker:
            if not snapshot.last_reel_time or reel_time_marker >= snapshot.last_reel_time:
                snapshot.last_reel_time = reel_time_marker
                snapshot.reel_code = reel.reel_code
                snapshot.job_name = reel.job_name
                snapshot.order_number = reel.order_number

        reel_meters = self._reel_length_meters(reel)
        if reel_meters is not None:
            snapshot.total_length_m += reel_meters

        self._accumulate_phase_seconds(snapshot.phase_seconds, reel.inspection_phases or [], window_start, window_end)
        snapshot.latest_phase_label = self._latest_phase_label(reel.inspection_phases)

        for phase_event in self._reference_change_events(reel.inspection_phases or []):
            if window_start <= phase_event["timestamp"] <= window_end:
                snapshot.reference_changes += 1
                global_events.append(self._event_payload("reference_change_recent", snapshot, phase_event))

        for mask in reel.masks or []:
            if not mask.timestamp or mask.timestamp < window_start or mask.timestamp > window_end:
                continue
            snapshot.mask_recent_count += 1
            event = {
                "type": "mask_activity",
                "title": "Mask applied",
                "description": f"Mask {mask.xml_id or ''} at format {mask.format_value or ''}",
                "timestamp": mask.timestamp,
                "severity": "info",
                "machine_name": snapshot.machine.name,
                "reel_code": reel.reel_code,
                "job_name": reel.job_name,
                "order_number": reel.order_number,
            }
            snapshot.events.append(event)
            global_events.append(event)

        for defect in reel.defects or []:
            if not defect.defect_time or defect.defect_time < window_start or defect.defect_time > window_end:
                continue
            snapshot.defects_total += 1
            if defect.defect_time >= window_15:
                snapshot.defects_15m += 1
            if defect.defect_time >= window_60:
                snapshot.defects_60m += 1
            snapshot.last_defect_time = max(snapshot.last_defect_time or defect.defect_time, defect.defect_time)

            bucket = defect.defect_time.replace(minute=0, second=0, microsecond=0)
            timeline_counts[bucket] += 1

            severity = self._normalize_int(defect.severity_score)
            snapshot.severity_counter[str(severity) if severity is not None else "unlabeled"] += 1
            if severity is None or defect.severity_uncertain:
                code = reel.reel_code or f"Reel-{reel.reel_id}"
                snapshot.pending_reel_codes.add(code)
                pending_reel_codes.add(code)

            event = {
                "type": "defect",
                "title": defect.class_name or "Defect",
                "description": f"Severity {severity if severity is not None else 'N/A'} at {defect.format_position or ''}",
                "timestamp": defect.defect_time,
                "severity": "warning" if severity and severity >= 3 else "info",
                "machine_name": snapshot.machine.name,
                "reel_code": reel.reel_code,
                "job_name": reel.job_name,
                "order_number": reel.order_number,
            }
            snapshot.events.append(event)
            global_events.append(event)

        latest_review = self._latest_review(reel.reviews or [])
        if latest_review and (not snapshot.latest_review or latest_review.created_at > snapshot.latest_review.created_at):
            snapshot.latest_review = latest_review

        for review in reel.reviews or []:
            if not review.created_at:
                continue
            if review.decision == "fail" and review.created_at >= window_start:
                snapshot.review_fail_recent = True
            if review.created_at >= window_start:
                event = {
                    "type": "review",
                    "title": f"Review {review.decision.title()}",
                    "description": review.comments or "",
                    "timestamp": review.created_at,
                    "severity": "critical" if review.decision == "fail" else "info",
                    "machine_name": snapshot.machine.name,
                    "reel_code": reel.reel_code or review.reel_code,
                    "job_name": reel.job_name,
                    "order_number": reel.order_number,
                }
                snapshot.events.append(event)
                global_events.append(event)

    def _finalize_snapshot(self, snapshot: MachineSnapshot, now: datetime) -> None:
        mix = self._inspection_mix(snapshot.phase_seconds)
        snapshot.inspection_state = (
            "active"
            if mix["active_pct"] >= max(mix["inactive_pct"], mix["learn_pct"])
            else "inactive"
            if mix["inactive_pct"] >= mix["learn_pct"]
            else "learn"
        )

        if not snapshot.last_activity:
            snapshot.status = "idle"
            snapshot.status_note = "No recorded activity"
            snapshot.status_priority = 0
            return

        minutes_since_activity = (now - snapshot.last_activity).total_seconds() / 60.0

        if snapshot.review_fail_recent:
            snapshot.status = "critical_alert"
            snapshot.status_note = "Recent failed reel"
            snapshot.status_priority = 4
            return

        if snapshot.defects_15m >= DEFECT_SPIKE_15_MIN_THRESHOLD:
            snapshot.status = "critical_alert"
            snapshot.status_note = f"{snapshot.defects_15m} defects in last 15m"
            snapshot.status_priority = 4
            return

        if snapshot.defects_60m >= DEFECT_SPIKE_60_MIN_THRESHOLD:
            snapshot.status = "warning"
            snapshot.status_note = f"{snapshot.defects_60m} defects in last hour"
            snapshot.status_priority = 3
            return

        if len(snapshot.pending_reel_codes) >= REVIEW_BACKLOG_REEL_THRESHOLD:
            snapshot.status = "warning"
            snapshot.status_note = "Review backlog growing"
            snapshot.status_priority = 3
            return

        if minutes_since_activity >= NO_RECENT_DATA_MINUTES:
            snapshot.status = "attention"
            snapshot.status_note = "No recent data"
            snapshot.status_priority = 2
            return

        if snapshot.inspection_state == "learn" and mix["learn_pct"] >= HIGH_LEARN_PCT:
            snapshot.status = "attention"
            snapshot.status_note = "High learn time"
            snapshot.status_priority = 2
            return

        if minutes_since_activity <= ACTIVE_WINDOW_MINUTES:
            snapshot.status = "healthy"
            snapshot.status_note = "Running normally"
            snapshot.status_priority = 1
        else:
            snapshot.status = "idle"
            snapshot.status_note = "Waiting for production"
            snapshot.status_priority = 0

    def _serialize_machine(self, snapshot: MachineSnapshot) -> Dict[str, Any]:
        mix = self._inspection_mix(snapshot.phase_seconds)
        latest_review = (
            {
                "decision": snapshot.latest_review.decision,
                "reviewer": snapshot.latest_review.reviewer_id,
                "timestamp": self._iso(snapshot.latest_review.created_at),
                "reel_code": snapshot.latest_review.reel_code,
            }
            if snapshot.latest_review
            else None
        )
        info_badge, warning_badge, critical_badge = self._severity_badge_counts(snapshot)
        return {
            "machine_id": snapshot.machine.machine_id,
            "machine_name": snapshot.machine.name,
            "status": snapshot.status,
            "status_note": snapshot.status_note,
            "status_priority": snapshot.status_priority,
            "job_name": snapshot.job_name or "Unassigned",
            "order_number": snapshot.order_number or "",
            "reel_code": snapshot.reel_code or "",
            "last_reel_time": self._iso(snapshot.last_reel_time),
            "last_defect_time": self._iso(snapshot.last_defect_time),
            "inspection_state": snapshot.inspection_state,
            "latest_phase": snapshot.latest_phase_label or "Unknown",
            "defects_15m": snapshot.defects_15m,
            "defects_60m": snapshot.defects_60m,
            "pending_reviews": len(snapshot.pending_reel_codes),
            "latest_review": latest_review,
            "phase_mix": mix,
            "info_defects": info_badge,
            "warning_defects": warning_badge,
            "critical_defects": critical_badge,
        }

    def _severity_badge_counts(self, snapshot: MachineSnapshot) -> Tuple[int, int, int]:
        info = warning = critical = 0
        for key, count in snapshot.severity_counter.items():
            try:
                score = int(key)
            except (TypeError, ValueError):
                info += count
                continue
            if score >= 4:
                critical += count
            elif score == 3:
                warning += count
            else:
                info += count
        return info, warning, critical

    def _build_machine_alerts(self, snapshot: MachineSnapshot, now: datetime, lookback_hours: int) -> List[Dict[str, Any]]:
        alerts: List[Dict[str, Any]] = []
        mix = self._inspection_mix(snapshot.phase_seconds)
        minutes_since_activity = (now - snapshot.last_activity).total_seconds() / 60.0 if snapshot.last_activity else None

        def base_alert(alert_type: str, title: str, message: str, severity: str, timestamp: Optional[datetime]) -> Dict[str, Any]:
            return {
                "alert_key": self._alert_key(alert_type, snapshot.machine.machine_id, snapshot.reel_code),
                "type": alert_type,
                "title": title,
                "message": message,
                "machine_id": snapshot.machine.machine_id,
                "machine_name": snapshot.machine.name,
                "severity": severity,
                "timestamp": timestamp,
                "reel_code": snapshot.reel_code,
                "job_name": snapshot.job_name,
                "order_number": snapshot.order_number,
                "lookback_hours": lookback_hours,
            }

        if snapshot.review_fail_recent:
            alerts.append(
                base_alert(
                    "failed_reel",
                    "Failed reel",
                    "Recent reel review marked as fail",
                    "critical",
                    snapshot.last_reel_time,
                )
            )

        if snapshot.defects_15m >= DEFECT_SPIKE_15_MIN_THRESHOLD:
            alerts.append(
                base_alert(
                    "defect_spike",
                    "Defect spike",
                    f"{snapshot.defects_15m} defects in last 15 min",
                    "critical",
                    snapshot.last_defect_time,
                )
            )
        elif snapshot.defects_60m >= DEFECT_SPIKE_60_MIN_THRESHOLD:
            alerts.append(
                base_alert(
                    "defect_spike",
                    "Defect spike",
                    f"{snapshot.defects_60m} defects in last 60 min",
                    "warning",
                    snapshot.last_defect_time,
                )
            )

        if mix["active_pct"] < INSPECTION_OFF_ACTIVE_PCT and snapshot.defects_total > 0:
            alerts.append(
                base_alert(
                    "inspection_off_while_running",
                    "Inspection off",
                    "Inspection inactive while defects logged",
                    "warning",
                    snapshot.last_activity,
                )
            )

        if mix["learn_pct"] >= HIGH_LEARN_PCT:
            alerts.append(
                base_alert(
                    "high_learn_time",
                    "Excessive learn time",
                    f"Learn state at {mix['learn_pct']:.0f}%",
                    "attention",
                    snapshot.last_activity,
                )
            )

        if snapshot.mask_recent_count >= MASK_SPIKE_THRESHOLD:
            alerts.append(
                base_alert(
                    "mask_activity_spike",
                    "Mask adjustments",
                    f"{snapshot.mask_recent_count} masks in live window",
                    "attention",
                    snapshot.last_activity,
                )
            )

        if snapshot.reference_changes >= REFERENCE_CHANGE_ALERT_THRESHOLD:
            alerts.append(
                base_alert(
                    "reference_change_recent",
                    "Reference changes",
                    f"{snapshot.reference_changes} reference changes detected",
                    "info",
                    snapshot.last_activity,
                )
            )

        return alerts

    def _build_review_summary(
        self,
        pending_reel_codes: Set[str],
        backlog_by_machine: List[Dict[str, Any]],
        review_rows: List[ReelReview],
    ) -> Dict[str, Any]:
        decisions_today = {"pass": 0, "fail": 0}
        decisions_by_machine: Dict[str, Counter] = defaultdict(Counter)
        recent_reviews: List[Dict[str, Any]] = []
        now = datetime.utcnow()
        today_start = now.replace(hour=0, minute=0, second=0, microsecond=0)
        for review in review_rows:
            if review.decision in ("pass", "fail") and review.created_at and review.created_at >= today_start:
                decisions_today[review.decision] += 1
                machine_label = review.reel.machine.name if review.reel and review.reel.machine else "Unknown"
                decisions_by_machine[machine_label][review.decision] += 1
            machine_name = None
            if review.reel and review.reel.machine:
                machine_name = review.reel.machine.name
            recent_reviews.append(
                {
                    "decision": review.decision,
                    "reviewer": review.reviewer_id,
                    "reel_code": review.reel_code,
                    "machine_name": machine_name,
                    "timestamp": self._iso(review.created_at),
                }
            )
        return {
            "pending_reels": len(pending_reel_codes),
            "backlog_by_machine": backlog_by_machine[:8],
            "decisions_today": decisions_today,
            "recent_reviews": recent_reviews[:10],
            "decisions_by_machine": [
                {
                    "machine_name": name,
                    "pass": counts.get("pass", 0),
                    "fail": counts.get("fail", 0),
                }
                for name, counts in decisions_by_machine.items()
            ],
        }

    # ------------------------------------------------------------------ #
    # Alert persistence helpers
    # ------------------------------------------------------------------ #

    def _ensure_tables(self) -> None:
        try:
            BSTLiveAlertEvent.__table__.create(bind=engine, checkfirst=True)
            BSTLiveAlertThreshold.__table__.create(bind=engine, checkfirst=True)
        except OperationalError:
            # Table creation failed; runtime operations will raise clearer errors later.
            pass

    def _sync_alert_events(self, candidates: List[Dict[str, Any]], now: datetime) -> List[Dict[str, Any]]:
        keys = [c["alert_key"] for c in candidates if c.get("alert_key")]
        with SessionLocal() as session:
            existing_rows: Dict[str, BSTLiveAlertEvent] = {}
            if keys:
                rows = (
                    session.query(BSTLiveAlertEvent)
                    .filter(BSTLiveAlertEvent.alert_key.in_(keys))
                    .all()
                )
                existing_rows = {row.alert_key: row for row in rows}

            for candidate in candidates:
                key = candidate["alert_key"]
                row = existing_rows.get(key)
                detail_payload = self._alert_detail(candidate)
                if row:
                    row.alert_type = candidate["type"]
                    row.severity = candidate["severity"]
                    row.title = candidate["title"]
                    row.message = candidate["message"]
                    row.detail_json = detail_payload
                    row.machine_id = candidate.get("machine_id")
                    row.machine_name = candidate.get("machine_name")
                    row.reel_code = candidate.get("reel_code")
                    row.job_name = candidate.get("job_name")
                    row.order_number = candidate.get("order_number")
                    row.last_seen_at = now
                    if row.status == "resolved":
                        row.status = "active"
                        row.resolved_at = None
                        row.acknowledged_at = None
                        row.acknowledged_by = None
                else:
                    row = BSTLiveAlertEvent(
                        alert_key=key,
                        alert_type=candidate["type"],
                        severity=candidate["severity"],
                        status="active",
                        machine_id=candidate.get("machine_id"),
                        reel_id=candidate.get("reel_id"),
                        machine_name=candidate.get("machine_name"),
                        reel_code=candidate.get("reel_code"),
                        job_name=candidate.get("job_name"),
                        order_number=candidate.get("order_number"),
                        title=candidate["title"],
                        message=candidate["message"],
                        detail_json=detail_payload,
                        first_seen_at=now,
                        last_seen_at=now,
                    )
                    session.add(row)
                    existing_rows[key] = row

            open_statuses = ("active", "acknowledged")
            stale_query = session.query(BSTLiveAlertEvent).filter(BSTLiveAlertEvent.status.in_(open_statuses))
            if keys:
                stale_query = stale_query.filter(~BSTLiveAlertEvent.alert_key.in_(keys))
            stale_rows = stale_query.all()
            for row in stale_rows:
                row.status = "resolved"
                row.resolved_at = now

            session.commit()

            open_rows = (
                session.query(BSTLiveAlertEvent)
                .filter(BSTLiveAlertEvent.status.in_(open_statuses))
                .order_by(BSTLiveAlertEvent.severity.desc(), BSTLiveAlertEvent.last_seen_at.desc())
                .limit(80)
                .all()
            )
            return [self._serialize_alert_row(row) for row in open_rows]

    def get_alerts(
        self,
        *,
        status: Optional[str] = None,
        machine_id: Optional[int] = None,
        lookback_hours: Optional[int] = None,
    ) -> List[Dict[str, Any]]:
        now = datetime.utcnow()
        lookback_hours = lookback_hours or 24
        since = now - timedelta(hours=lookback_hours)
        with SessionLocal() as session:
            query = session.query(BSTLiveAlertEvent).filter(BSTLiveAlertEvent.created_at >= since)
            if status and status != "all":
                if status == "open":
                    query = query.filter(BSTLiveAlertEvent.status.in_(("active", "acknowledged")))
                else:
                    query = query.filter(BSTLiveAlertEvent.status == status)
            if machine_id:
                query = query.filter(BSTLiveAlertEvent.machine_id == machine_id)
            rows = query.order_by(BSTLiveAlertEvent.last_seen_at.desc()).limit(200).all()
            return [self._serialize_alert_row(row) for row in rows]

    def acknowledge_alert(self, alert_id: int, acknowledged_by: str) -> bool:
        now = datetime.utcnow()
        with SessionLocal() as session:
            row = session.query(BSTLiveAlertEvent).filter(BSTLiveAlertEvent.alert_event_id == alert_id).first()
            if not row:
                return False
            row.status = "acknowledged"
            row.acknowledged_at = now
            row.acknowledged_by = acknowledged_by
            session.commit()
            return True

    def unacknowledge_alert(self, alert_id: int) -> bool:
        with SessionLocal() as session:
            row = session.query(BSTLiveAlertEvent).filter(BSTLiveAlertEvent.alert_event_id == alert_id).first()
            if not row:
                return False
            if row.status != "acknowledged":
                return True
            row.status = "active"
            row.acknowledged_at = None
            row.acknowledged_by = None
            session.commit()
            return True

    def acknowledge_all_alerts(
        self,
        acknowledged_by: str,
        *,
        status: Optional[str] = None,
        machine_id: Optional[int] = None,
    ) -> int:
        now = datetime.utcnow()
        target_statuses = ["active"]
        with SessionLocal() as session:
            query = session.query(BSTLiveAlertEvent).filter(BSTLiveAlertEvent.status.in_(target_statuses))
            if machine_id:
                query = query.filter(BSTLiveAlertEvent.machine_id == machine_id)
            rows = query.all()
            count = 0
            for row in rows:
                row.status = "acknowledged"
                row.acknowledged_at = now
                row.acknowledged_by = acknowledged_by
                count += 1
            session.commit()
            return count

    def _serialize_alert_row(self, row: BSTLiveAlertEvent) -> Dict[str, Any]:
        return {
            "alert_event_id": row.alert_event_id,
            "alert_key": row.alert_key,
            "alert_type": row.alert_type,
            "severity": row.severity,
            "status": row.status,
            "machine_id": row.machine_id,
            "machine_name": row.machine_name,
            "reel_id": row.reel_id,
            "reel_code": row.reel_code,
            "job_name": row.job_name,
            "order_number": row.order_number,
            "title": row.title,
            "message": row.message,
            "detail": row.detail_json or {},
            "first_seen_at": self._iso(row.first_seen_at),
            "last_seen_at": self._iso(row.last_seen_at),
            "acknowledged_at": self._iso(row.acknowledged_at),
            "acknowledged_by": row.acknowledged_by,
            "resolved_at": self._iso(row.resolved_at),
        }

    # ------------------------------------------------------------------ #
    # Utility helpers
    # ------------------------------------------------------------------ #

    def _normalize_lookback(self, value: Optional[int]) -> int:
        if value is None:
            return LOOKBACK_DEFAULT_HOURS
        try:
            hours = int(value)
        except (TypeError, ValueError):
            return LOOKBACK_DEFAULT_HOURS
        return max(min(hours, max(LOOKBACK_CHOICES)), min(LOOKBACK_CHOICES))

    def _empty_payload(self, now: datetime, lookback_hours: int) -> Dict[str, Any]:
        return {
            "generated_at": self._iso(now),
            "lookback_hours": lookback_hours,
            "kpis": {},
            "machines": [],
            "alerts": [],
            "trends": {"defects_by_machine": [], "defect_timeline": [], "inspection_mix": [], "review_backlog": []},
            "recent_events": [],
            "review_summary": {"pending_reels": 0, "backlog_by_machine": [], "decisions_today": {}, "recent_reviews": []},
        }

    def _clip_interval(
        self,
        start: Optional[datetime],
        end: Optional[datetime],
        window_start: datetime,
        window_end: datetime,
    ) -> Optional[Tuple[datetime, datetime]]:
        if not start:
            start = window_start
        if not end:
            end = window_end
        clipped_start = max(start, window_start)
        clipped_end = min(end, window_end)
        if clipped_end <= clipped_start:
            return None
        return clipped_start, clipped_end

    def _accumulate_phase_seconds(
        self,
        accumulator: Dict[str, float],
        phases: Iterable[InspectionPhase],
        window_start: datetime,
        window_end: datetime,
    ) -> None:
        for phase in phases:
            clipped = self._clip_interval(phase.start_time, phase.end_time, window_start, window_end)
            if not clipped:
                continue
            start, end = clipped
            key = (phase.phase or "unknown").strip().lower()
            accumulator[key] += max((end - start).total_seconds(), 0.0)

    def _latest_phase_label(self, phases: Iterable[InspectionPhase]) -> Optional[str]:
        latest = None
        latest_time = datetime.min
        for phase in phases or []:
            start = phase.start_time or datetime.min
            if start >= latest_time:
                latest_time = start
                latest = phase.phase
        return latest

    def _reference_change_events(self, phases: Iterable[InspectionPhase]) -> List[Dict[str, Any]]:
        events: List[Dict[str, Any]] = []
        prev_ref = None
        for phase in sorted(phases or [], key=lambda entry: entry.start_time or datetime.min):
            ref = (phase.refimgid or "").strip()
            if prev_ref is None:
                prev_ref = ref
                continue
            if ref and ref != prev_ref:
                events.append(
                    {
                        "type": "reference_change_recent",
                        "title": "Reference change",
                        "description": f"Reference switched to {ref}",
                        "timestamp": phase.start_time or datetime.utcnow(),
                    }
                )
            prev_ref = ref
        return events

    def _latest_review(self, reviews: Iterable[ReelReview]) -> Optional[ReelReview]:
        latest = None
        latest_time = datetime.min
        for review in reviews or []:
            if review.created_at and review.created_at >= latest_time:
                latest_time = review.created_at
                latest = review
        return latest

    def _inspection_mix(self, phase_seconds: Dict[str, float]) -> Dict[str, float]:
        total = sum(phase_seconds.values()) or 1.0
        return {
            "active_pct": round((phase_seconds.get("active", 0.0) / total) * 100.0, 1),
            "inactive_pct": round((phase_seconds.get("inactive", 0.0) / total) * 100.0, 1),
            "learn_pct": round((phase_seconds.get("learn", 0.0) / total) * 100.0, 1),
        }

    def _serialize_timeline(self, timeline_counts: Dict[datetime, int]) -> List[Dict[str, Any]]:
        return [
            {"time": self._iso(timestamp), "count": count}
            for timestamp, count in sorted(timeline_counts.items())
        ]

    def _reel_length_meters(self, reel: Reel) -> Optional[float]:
        if reel.reel_start is None or reel.reel_end is None:
            return None
        start_val = self._to_float(reel.reel_start) or 0.0
        end_val = self._to_float(reel.reel_end) or 0.0
        return max(end_val - start_val, 0.0)

    def _to_float(self, value: Optional[object]) -> Optional[float]:
        if value is None:
            return None
        if isinstance(value, (int, float)):
            return float(value)
        try:
            return float(value)
        except (TypeError, ValueError):
            return None

    def _normalize_int(self, value: Optional[object]) -> Optional[int]:
        if value is None:
            return None
        try:
            return int(value)
        except (TypeError, ValueError):
            return None

    def _iso(self, value: Optional[datetime]) -> Optional[str]:
        return value.isoformat() if value else None

    def _event_payload(self, event_type: str, snapshot: MachineSnapshot, meta: Dict[str, Any]) -> Dict[str, Any]:
        return {
            "type": event_type,
            "title": meta.get("title") or "Event",
            "description": meta.get("description") or "",
            "timestamp": meta.get("timestamp"),
            "severity": meta.get("severity") or "info",
            "machine_name": snapshot.machine.name,
            "reel_code": snapshot.reel_code,
            "job_name": snapshot.job_name,
            "order_number": snapshot.order_number,
        }

    def _alert_key(self, alert_type: str, machine_id: Optional[int], reel_code: Optional[str] = None) -> str:
        key_parts = [alert_type or "unknown"]
        if machine_id:
            key_parts.append(f"machine_{machine_id}")
        if reel_code:
            key_parts.append(f"reel_{reel_code}")
        return ":".join(key_parts)

    def _alert_detail(self, candidate: Dict[str, Any]) -> Dict[str, Any]:
        detail = dict(candidate)
        ts = detail.get("timestamp")
        if isinstance(ts, datetime):
            detail["timestamp"] = self._iso(ts)
        return detail
