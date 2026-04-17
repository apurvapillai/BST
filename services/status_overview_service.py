from __future__ import annotations

from collections import defaultdict
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from typing import Any, Dict, Iterable, List, Optional, Tuple
from zoneinfo import ZoneInfo

from sqlalchemy import case, inspect, or_, text
from sqlalchemy.orm import selectinload

from db.connection import SessionLocal, engine
from db.models import Machine, Reel, StatusOverviewAlert
from db.rlm_connection import RLMSessionLocal
from db.rlm_live_models import RLMLiveMachineThreshold
from db.rlm_models import RLMMachine, RLMReel
from services.dashboard_live_service import DashboardLiveService
from services.rlm_live_service import RLMLiveService
from services.rlm_reel_footage import compute_feet_per_range_unit

BST_LOOKBACK_DAYS = 3
RLM_LOOKBACK_DAYS = 7
RECENT_REEL_LIMIT = 12
DEFAULT_ACTOR = "unknown"
CENTRAL_TZ = ZoneInfo("America/Chicago")
MAKE_READY_FEET_LIMIT = 5000.0
BST_OFF_ACTIVE_PCT = 0.0
RLM_OFF_MONITORING_POINTS = 0
STALE_NO_REEL_MINUTES = 60

STATUS_OVERVIEW_MACHINE_ORDER = [
    "press 5",
    "press 6",
    "press 7",
    "press 8",
    "press 9",
    "press 11",
    "press 12",
    "press 13",
    "press 14",
    "press 15",
]

# BST reel footage is machine-specific. Keep current behavior as the default for
# every press, then override individual presses here as conversion rules change.
BST_FEET_MULTIPLIER_DEFAULT = 2.0
BST_FEET_MULTIPLIERS_BY_MACHINE = {
    machine_name: BST_FEET_MULTIPLIER_DEFAULT
    for machine_name in STATUS_OVERVIEW_MACHINE_ORDER
}
BST_FEET_MULTIPLIERS_BY_MACHINE["press 6"] = 3.7718
BST_FEET_MULTIPLIERS_BY_MACHINE["press 7"] = 4.1666
BST_FEET_MULTIPLIERS_BY_MACHINE["press 8"] = 2.958
BST_FEET_MULTIPLIERS_BY_MACHINE["press 9"] = 3.0
BST_FEET_MULTIPLIERS_BY_MACHINE["press 11"] = 3.292
BST_FEET_MULTIPLIERS_BY_MACHINE["press 12"] = 3.0
BST_FEET_MULTIPLIERS_BY_MACHINE["press 13"] = 3.0
BST_FEET_MULTIPLIERS_BY_MACHINE["press 14"] = 3.0
BST_FEET_MULTIPLIERS_BY_MACHINE["press 15"] = 3.0


class StatusOverviewService:
    def __init__(self) -> None:
        self.dashboard_live_service = DashboardLiveService()
        self.rlm_live_service = RLMLiveService()
        self._ensure_tables()

    def get_board_payload(self, sync_alerts: bool = False) -> Dict[str, Any]:
        now = self._central_now()
        with SessionLocal() as session:
            bst_data = self._load_bst_machine_data(now)
            rlm_data = self._load_rlm_machine_data(now)
            keys = sorted(set(bst_data.keys()) | set(rlm_data.keys()), key=self._board_machine_sort)
            _, candidates, current_reels = self._build_cards(now, bst_data, rlm_data, keys=keys)
            alert_context = (
                self._sync_alerts(session, candidates, now, current_reels)
                if sync_alerts
                else self._load_alert_context(session, candidates)
            )
            history_by_machine = self._load_alert_reel_histories(session, keys, bst_data, rlm_data, limit=10)
            cards, _, _ = self._build_cards(
                now,
                bst_data,
                rlm_data,
                keys=keys,
                alert_context=alert_context,
                history_by_machine=history_by_machine,
            )
            alerts = self._load_alert_sections(session, now)

        cards.sort(key=self._card_sort_key)
        return {
            "generatedAt": self._iso(now),
            "cards": cards,
            "alerts": alerts,
            "bannerAlerts": alerts["new"],
        }

    def get_alert(self, alert_id: int) -> Optional[Dict[str, Any]]:
        with SessionLocal() as session:
            row = session.query(StatusOverviewAlert).filter(StatusOverviewAlert.id == alert_id).first()
            if not row:
                return None
            return self._serialize_alert(row)

    def acknowledge_alert(self, alert_id: int, actor: str, comment: str) -> Tuple[bool, str]:
        actor = (actor or DEFAULT_ACTOR).strip() or DEFAULT_ACTOR
        comment = (comment or "").strip()
        with SessionLocal() as session:
            row = session.query(StatusOverviewAlert).filter(StatusOverviewAlert.id == alert_id).first()
            if not row:
                return False, "Alert not found."
            row.alert_state = "ACKNOWLEDGED"
            row.acknowledged_at = datetime.utcnow()
            row.acknowledged_by = actor
            row.acknowledge_comment = comment
            row.is_active = False
            session.commit()
        return True, "Alert acknowledged."

    def resolve_alert(self, alert_id: int, actor: str, comment: str) -> Tuple[bool, str]:
        return self.acknowledge_alert(alert_id, actor, comment)

    def make_ready_alert(self, alert_id: int, actor: str, comment: str) -> Tuple[bool, str]:
        actor = (actor or DEFAULT_ACTOR).strip() or DEFAULT_ACTOR
        comment = (comment or "").strip()
        with SessionLocal() as session:
            row = session.query(StatusOverviewAlert).filter(StatusOverviewAlert.id == alert_id).first()
            if not row:
                return False, "Alert not found."
            row.alert_state = "MAKE_READY"
            row.resolved_at = datetime.utcnow()
            row.resolved_by = actor
            row.resolved_comment = comment
            row.is_active = False
            session.commit()
        return True, "Marked as Make Ready."

    def _ensure_tables(self) -> None:
        StatusOverviewAlert.__table__.create(bind=engine, checkfirst=True)
        self._ensure_alert_indexes()

    def _ensure_alert_indexes(self) -> None:
        existing = {index["name"] for index in inspect(engine).get_indexes(StatusOverviewAlert.__tablename__)}
        ddl = {
            "idx_status_alert_active_state_created": (
                "CREATE INDEX idx_status_alert_active_state_created "
                "ON status_overview_alerts (is_active, alert_state, created_at)"
            ),
            "idx_status_alert_state_updated": (
                "CREATE INDEX idx_status_alert_state_updated "
                "ON status_overview_alerts (alert_state, updated_at)"
            ),
            "idx_status_alert_machine_reel": (
                "CREATE INDEX idx_status_alert_machine_reel "
                "ON status_overview_alerts (machine_name, reel_number)"
            ),
            "idx_status_alert_reel_updated": (
                "CREATE INDEX idx_status_alert_reel_updated "
                "ON status_overview_alerts (reel_id, updated_at)"
            ),
        }
        with engine.begin() as conn:
            for name, statement in ddl.items():
                if name not in existing:
                    conn.execute(text(statement))

    def _load_bst_machine_data(self, now: datetime) -> Dict[str, Dict[str, Any]]:
        lookback_start = now.replace(tzinfo=None) - timedelta(days=BST_LOOKBACK_DAYS)
        with SessionLocal() as session:
            machines = session.query(Machine).order_by(Machine.name.asc()).all()
            reels = (
                session.query(Reel)
                .options(selectinload(Reel.inspection_phases))
                .filter(Reel.machine_id.in_([m.machine_id for m in machines]))
                .filter((Reel.time_end.is_(None)) | (Reel.time_end >= lookback_start))
                .order_by(
                    Reel.machine_id.asc(),
                    case((Reel.time_end.is_(None), Reel.time_start), else_=Reel.time_end).desc(),
                    Reel.reel_id.desc(),
                )
                .all()
            )

        reels_by_machine: Dict[int, List[Reel]] = defaultdict(list)
        for reel in reels:
            if len(reels_by_machine[reel.machine_id]) < RECENT_REEL_LIMIT:
                reels_by_machine[reel.machine_id].append(reel)

        out: Dict[str, Dict[str, Any]] = {}
        for machine in machines:
            machine_reels = reels_by_machine.get(machine.machine_id, [])
            for reel in machine_reels:
                setattr(reel, "_status_overview_machine_name", machine.name)
            latest_reel = machine_reels[0] if machine_reels else None
            latest_activity = self._bst_local_time(latest_reel.time_end or latest_reel.time_start) if latest_reel else None
            latest_metrics = self._bst_reel_metrics(latest_reel) if latest_reel else None
            metrics_by_reel_id = {}
            reliable_rows = []
            for index, reel in enumerate(machine_reels):
                metrics = latest_metrics if index == 0 and latest_metrics else self._bst_reel_metrics(reel)
                metrics_by_reel_id[reel.reel_id] = metrics
                if metrics["phaseSeconds"] > 0:
                    reliable_rows.append({"reel": reel, "metrics": metrics})
            out[(machine.name or "").strip().lower()] = {
                "machineId": machine.machine_id,
                "machineName": machine.name,
                "latestActivity": latest_activity,
                "latestReel": latest_reel,
                "latestMetrics": latest_metrics,
                "recentReels": machine_reels,
                "recentMetrics": metrics_by_reel_id,
                "latestReliable": reliable_rows[0] if reliable_rows else None,
                "previousReliable": reliable_rows[1] if len(reliable_rows) > 1 else None,
                "reliableRows": reliable_rows,
            }
        return out

    def _load_rlm_machine_data(
        self,
        now: datetime,
    ) -> Dict[str, Dict[str, Any]]:
        lookback_start = now.astimezone(timezone.utc) - timedelta(days=RLM_LOOKBACK_DAYS)
        with RLMSessionLocal() as session:
            machines = session.query(RLMMachine).filter(RLMMachine.machine_name.isnot(None)).order_by(RLMMachine.machine_name.asc()).all()
            machine_ids = [machine.machine_id for machine in machines]
            recent_reels = self.rlm_live_service._recent_reels_by_machine(session, machine_ids, lookback_start)
            threshold_map = self._build_rlm_thresholds(machines)
            reel_ids = [row.reel_db_id for rows in recent_reels.values() for row in rows]
            health_map = self.rlm_live_service._compute_reel_health_batch(session, reel_ids, threshold_map)

        out: Dict[str, Dict[str, Any]] = {}
        for machine in machines:
            rows = recent_reels.get(machine.machine_id, [])
            rows = sorted(
                rows,
                key=lambda row: row.production_end_dt or row.production_start_dt or datetime.min.replace(tzinfo=timezone.utc),
                reverse=True,
            )[:RECENT_REEL_LIMIT]
            qualifying = []
            latest_health = None
            for index, row in enumerate(rows):
                health = health_map.get(row.reel_db_id)
                if index == 0:
                    latest_health = health
                if health:
                    qualifying.append({"reel": row, "health": health})
            latest_reel = rows[0] if rows else None
            latest_activity = (
                self._central_time(latest_reel.production_end_dt or latest_reel.production_start_dt)
                if latest_reel and (latest_reel.production_end_dt or latest_reel.production_start_dt)
                else None
            )
            out[(machine.machine_name or "").strip().lower()] = {
                "machineName": machine.machine_name,
                "latestActivity": latest_activity,
                "latestReel": latest_reel,
                "latestHealth": latest_health,
                "recentRows": rows,
                "healthMap": {row.reel_db_id: health_map.get(row.reel_db_id) for row in rows},
                "latestQualifying": qualifying[0] if qualifying else None,
                "previousQualifying": qualifying[1] if len(qualifying) > 1 else None,
                "qualifyingRows": qualifying,
            }
        return out

    def _build_rlm_thresholds(
        self,
        machines: Iterable[RLMMachine],
    ) -> Dict[int, RLMLiveMachineThreshold]:
        out: Dict[int, RLMLiveMachineThreshold] = {}
        for machine in machines:
            out[machine.machine_id] = RLMLiveMachineThreshold(
                machine_id=machine.machine_id,
                machine_name=machine.machine_name,
                min_qualifying_feet=0.0,
                min_feet_for_zero_monitoring=0.0,
                min_points_per_1000_ft_warn=1.0,
                min_points_per_1000_ft_critical=1.0,
                bad_reel_warn_oob_pct=2.0,
                bad_reel_critical_oob_pct=10.0,
                rolling_bad_feet_warn_pct=5.0,
                rolling_bad_feet_critical_pct=15.0,
                rolling_oob_warn_pct=2.0,
                rolling_oob_critical_pct=10.0,
                consecutive_bad_warn_count=2,
                consecutive_bad_critical_count=3,
                delta_std_warn=1.5,
                delta_std_critical=3.0,
                webspeed_range_warn=20.0,
                webspeed_range_critical=35.0,
                refresh_seconds=30,
                stale_after_minutes=max(STALE_NO_REEL_MINUTES, 20),
                cycle_panel_seconds=8,
            )
        return out

    def _build_cards(
        self,
        now: datetime,
        bst_data: Dict[str, Dict[str, Any]],
        rlm_data: Dict[str, Dict[str, Any]],
        *,
        keys: Optional[List[str]] = None,
        alert_context: Optional[Dict[str, Any]] = None,
        history_by_machine: Optional[Dict[str, List[Dict[str, Any]]]] = None,
    ) -> Tuple[List[Dict[str, Any]], List[Dict[str, Any]], Dict[str, Dict[str, Any]]]:
        keys = keys or sorted(set(bst_data.keys()) | set(rlm_data.keys()), key=self._board_machine_sort)
        cards: List[Dict[str, Any]] = []
        candidates: List[Dict[str, Any]] = []
        current_reels: Dict[str, Dict[str, Any]] = {}

        alert_context = alert_context or {}
        active_by_machine = alert_context.get("activeByMachine") or defaultdict(list)
        active_by_reel_key = alert_context.get("activeByReelKey") or {}
        latest_by_key = alert_context.get("latestByKey") or {}
        latest_by_reel_id = alert_context.get("latestByReelId") or {}
        latest_by_reel_key = alert_context.get("latestByReelKey") or {}
        history_by_machine = history_by_machine or {}

        for key in keys:
            bst = bst_data.get(key, {})
            rlm = rlm_data.get(key, {})
            machine_name = bst.get("machineName") or rlm.get("machineName") or key.title()
            machine_id = bst.get("machineId")

            rlm_latest = {"reel": rlm.get("latestReel"), "health": rlm.get("latestHealth")} if rlm.get("latestReel") else None
            bst_reel = bst.get("latestReel")
            rlm_reel = rlm_latest["reel"] if rlm_latest else rlm.get("latestReel")
            bst_latest_metrics = bst.get("latestMetrics")
            bst_metrics = bst_latest_metrics if bst_latest_metrics and bst_latest_metrics["phaseSeconds"] > 0 else None
            rlm_health = rlm_latest["health"] if rlm_latest else None

            bst_activity = bst.get("latestActivity")
            rlm_activity = rlm.get("latestActivity")
            last_activity = self._latest_activity(bst_activity, rlm_activity)
            display_reel = self._display_reel_info(bst_reel, rlm_reel, last_activity, bst_activity, rlm_activity)
            if self._display_needs_synced_bst_fallback(display_reel, bst_reel, bst_metrics, bst, rlm_reel):
                fallback = bst.get("latestReliable")
                if fallback:
                    bst_reel = fallback["reel"]
                    bst_metrics = fallback["metrics"]
                    bst_activity = self._bst_local_time(bst_reel.time_end or bst_reel.time_start)
                    last_activity = self._latest_activity(bst_activity, None)
                    display_reel = self._display_reel_info(bst_reel, None, last_activity, bst_activity, None)
                    rlm_reel = None
                    rlm_health = None
            bst_is_current = self._bst_reel_is_current_display(bst_reel, display_reel)
            rlm_is_current = self._rlm_reel_is_current_display(rlm_reel, display_reel)

            bst_feet = self._feet_from_bst_reel(bst_reel, machine_name) if bst_reel else None
            rlm_feet = float(rlm_health.feet_total or 0.0) if rlm_health else None
            if bst_is_current:
                display_feet = bst_feet
            elif rlm_is_current:
                display_feet = rlm_feet
            else:
                display_feet = bst_feet if bst_feet is not None else rlm_feet
            meets_min_feet = bool(display_feet is not None and display_feet >= MAKE_READY_FEET_LIMIT)
            auto_make_ready = bool(display_feet is not None and display_feet < MAKE_READY_FEET_LIMIT)
            bst_display_off = bool(bst_is_current and bst_metrics and bst_metrics["activePct"] <= BST_OFF_ACTIVE_PCT)
            bst_off = bool(bst_display_off and meets_min_feet)

            rlm_points = int(rlm_health.monitoring_points_total or 0) if rlm_health else 0
            rlm_display_off = bool(
                rlm_is_current
                and
                rlm_health
                and rlm_points <= RLM_OFF_MONITORING_POINTS
            )
            rlm_off = bool(
                rlm_display_off
                and meets_min_feet
            )

            bst_streak = self._count_bst_off_streak(bst.get("reliableRows", []), machine_name)
            rlm_streak = self._count_rlm_off_streak(rlm.get("qualifyingRows", []))

            minutes_since_activity = self._minutes_since(last_activity, now)

            title = ""
            source = ""
            state = "healthy"
            is_alertable = False
            if auto_make_ready:
                title = "Make Ready"
                source = "SYSTEM"
                state = "make-ready"
            elif minutes_since_activity is None or minutes_since_activity >= STALE_NO_REEL_MINUTES:
                minutes_value = max(int(minutes_since_activity or STALE_NO_REEL_MINUTES), STALE_NO_REEL_MINUTES)
                title = f"Standby for {minutes_value}m"
                source = "SYSTEM"
                state = "stale"
            elif bst_off and rlm_off:
                title = "BST AND RLM OFF"
                source = "BOTH"
                state = "critical"
                is_alertable = True
            elif bst_off:
                title = "BST OFF"
                source = "BST"
                state = "critical"
                is_alertable = True
            elif rlm_off:
                title = "Repeat length Monitoring OFF"
                source = "RLM"
                state = "critical"
                is_alertable = True

            alert_reel = self._alert_reel_info(source, bst_reel, rlm_reel, display_reel)
            current_reels[key] = {
                "machineName": machine_name,
                "bstReelId": bst_reel.reel_id if bst_reel else None,
                "bstReelNumber": bst_reel.reel_code if bst_reel else None,
                "rlmReelNumber": rlm_reel.reel_id if rlm_reel else None,
                "displayReelNumber": display_reel["reelNumber"],
            }
            feet_value = display_feet
            description, metadata = self._build_alert_detail(
                now=now,
                title=title,
                source=source,
                machine_name=machine_name,
                bst=bst,
                rlm=rlm,
                bst_off=bst_off,
                rlm_off=rlm_off,
                bst_is_current=bst_is_current,
                rlm_is_current=rlm_is_current,
                bst_streak=bst_streak,
                rlm_streak=rlm_streak,
                last_activity=last_activity,
            )
            metadata["jobName"] = display_reel["jobNumber"]
            metadata["lastReelFeet"] = self._format_feet(feet_value)

            active_rows = active_by_machine.get(key, [])
            workflow_badge = None
            workflow_rank = 3
            active_row = None
            issue_key = f"{key}|{title}" if title and is_alertable else None
            status_text = title or "All Systems Active"
            candidate_preview = {
                "issueKey": issue_key,
                "reelId": alert_reel["reelId"],
                "reelNumber": alert_reel["reelNumber"],
                "jobNumber": alert_reel["jobNumber"],
                "machineName": machine_name,
            } if issue_key else None
            if title and is_alertable:
                reel_key = self._alert_reel_key(machine_name, alert_reel["reelNumber"], alert_reel["jobNumber"])
                if not self._alert_reel_is_current_display(alert_reel, display_reel):
                    is_alertable = False
                if candidate_preview and candidate_preview.get("reelId") is not None:
                    active_row = next((row for row in active_rows if row.reel_id == candidate_preview["reelId"]), None)
                if not active_row and reel_key:
                    active_row = active_by_reel_key.get(reel_key)
                if not active_row:
                    issue_row = next((row for row in active_rows if row.issue_key == issue_key), None)
                    if issue_row and candidate_preview and self._should_update_same_issue_row(issue_row, candidate_preview):
                        active_row = issue_row
                if active_row:
                    workflow_badge = "New"
                    workflow_rank = 0
                else:
                    latest_row = latest_by_key.get(issue_key) if issue_key else None
                    reel_row = latest_by_reel_id.get(int(candidate_preview["reelId"])) if candidate_preview and candidate_preview.get("reelId") is not None else None
                    reel_key_row = latest_by_reel_key.get(reel_key) if reel_key else None
                    existing_row = reel_row or reel_key_row or latest_row
                    if candidate_preview and self._should_suppress_reopen(existing_row, candidate_preview):
                        active_row = existing_row
                        if existing_row and existing_row.alert_state == "RESOLVED":
                            workflow_badge = "Resolved"
                            workflow_rank = 2
                            state = "resolved"
                            status_text = f"{title} (RESOLVED)"
                        elif existing_row and existing_row.alert_state == "ACKNOWLEDGED":
                            workflow_badge = "Acknowledged"
                            workflow_rank = 2
                            state = "critical"
                            status_text = f"{title} (Acked)"
                            is_alertable = False
                        elif existing_row and existing_row.alert_state == "MAKE_READY":
                            workflow_badge = "Make Ready"
                            workflow_rank = 2
                            state = "make-ready"
                            status_text = "Make Ready"
                            is_alertable = False
                        elif existing_row and existing_row.alert_state == "SUPERSEDED":
                            workflow_badge = "Superseded"
                            workflow_rank = 2
                            state = "superseded"
                            status_text = f"{title} (SUPERSEDED)"
                            is_alertable = False
                        else:
                            workflow_badge = "New"
                            workflow_rank = 0
                    else:
                        workflow_badge = "New"
                        workflow_rank = 0

            card = {
                "machineId": machine_id,
                "machineKey": key,
                "machineName": machine_name,
                "reelNumber": display_reel["reelNumber"] or "",
                "jobNumber": display_reel["jobNumber"] or "",
                "lastUpdated": self._iso_local(last_activity),
                "statusText": status_text,
                "state": state,
                "workflowBadge": workflow_badge,
                "metrics": {
                    "lastReelFeet": self._format_feet(feet_value),
                },
                "bstBox": self._build_bst_box(bst_metrics if bst_is_current else None, bst_display_off),
                "rlmBox": self._build_rlm_box(rlm_health if rlm_is_current else None, rlm_display_off, rlm_reel if rlm_is_current else None),
                "reelHistory": history_by_machine.get(key, []),
                "alertId": active_row.id if active_row and is_alertable else None,
                "issueKey": issue_key,
                "sortPriority": self._sort_priority(state, workflow_rank),
            }
            cards.append(card)

            if issue_key and is_alertable:
                candidates.append(
                    {
                        "issueKey": f"{key}|{title}",
                        "machineId": machine_id,
                        "machineName": machine_name,
                        "reelId": alert_reel["reelId"],
                        "reelNumber": alert_reel["reelNumber"],
                        "jobNumber": alert_reel["jobNumber"],
                        "alertTitle": title,
                        "alertDescription": description,
                        "alertSource": source,
                        "metadata": metadata,
                    }
                )
        return cards, candidates, current_reels

    def _build_bst_box(self, metrics: Optional[Dict[str, float]], is_off: bool) -> Dict[str, Any]:
        if not metrics:
            return {"label": "BST STATUS", "state": "neutral", "detail": "No data", "subdetail": ""}
        state = "off" if is_off else "healthy"
        return {
            "label": "BST STATUS",
            "state": state,
            "detail": "Inactive" if is_off else "Active",
            "subdetail": f"{metrics['activePct']:.1f}% inspection",
        }

    def _build_rlm_box(self, health, is_off: bool, reel: Optional[RLMReel] = None) -> Dict[str, Any]:
        if not health:
            return {"label": "RLM STATUS", "state": "neutral", "detail": "No data", "subdetail": ""}
        pts = int(health.monitoring_points_total or 0)
        density = float(health.points_per_1000_ft or 0.0)
        state = "off" if is_off else "healthy"
        return {
            "label": "RLM STATUS",
            "state": state,
            "detail": "Inactive" if is_off else "Active",
            "subdetail": f"{pts} pts | {density:.1f}/1k ft",
        }

    def _build_alert_detail(
        self,
        *,
        now: datetime,
        title: str,
        source: str,
        machine_name: str,
        bst: Dict[str, Any],
        rlm: Dict[str, Any],
        bst_off: bool,
        rlm_off: bool,
        bst_is_current: bool,
        rlm_is_current: bool,
        bst_streak: int,
        rlm_streak: int,
        last_activity: Optional[datetime],
    ) -> Tuple[str, Dict[str, Any]]:
        lines: List[str] = []
        metadata: Dict[str, Any] = {
            "machineName": machine_name,
            "thresholds": {
                "bst_off_active_pct": BST_OFF_ACTIVE_PCT,
                "rlm_off_monitoring_points": RLM_OFF_MONITORING_POINTS,
                "make_ready_feet_limit": MAKE_READY_FEET_LIMIT,
                "stale_no_reel_minutes": STALE_NO_REEL_MINUTES,
            },
            "bst": {},
            "rlm": {},
        }

        bst_reel = bst.get("latestReel")
        bst_metrics = bst.get("latestMetrics")
        bst_prev = bst.get("previousReliable")
        if bst_is_current and bst_reel and bst_metrics and bst_metrics["phaseSeconds"] > 0:
            metadata["bst"] = {
                "reelNumber": bst_reel.reel_id,
                "reelCode": bst_reel.reel_code,
                "jobNumber": bst_reel.order_number or bst_reel.job_name,
                "activePct": round(bst_metrics["activePct"], 2),
                "consecutiveOffReels": bst_streak,
            }
            if bst_off:
                if bst_prev and bst_prev["metrics"]["activePct"] > BST_OFF_ACTIVE_PCT:
                    lines.append("changed from previous reel good to current reel bad")
                lines.append(f"BST OFF for {bst_streak} consecutive reels")
                lines.append(f"current reel id {bst_reel.reel_id or 'Unknown'}")
                if bst_reel.reel_code:
                    lines.append(f"current reel code {bst_reel.reel_code}")
                lines.append(f"current job number {bst_reel.order_number or bst_reel.job_name or 'Unknown'}")
                lines.append(f"inspection active {bst_metrics['activePct']:.1f}%")

        rlm_reel = rlm.get("latestReel")
        rlm_health = rlm.get("latestHealth")
        rlm_prev = rlm.get("previousQualifying")
        if rlm_is_current and rlm_reel and rlm_health:
            density = float(rlm_health.points_per_1000_ft or 0.0)
            metadata["rlm"] = {
                "reelNumber": rlm_reel.reel_id,
                "jobNumber": rlm_reel.job_name,
                "pointsPer1000Ft": round(density, 2),
                "monitoringPointsTotal": int(rlm_health.monitoring_points_total or 0),
                "consecutiveOffReels": rlm_streak,
                "feetTotal": round(float(rlm_health.feet_total or 0.0), 2),
            }
            if rlm_off:
                if rlm_prev and int(rlm_prev["health"].monitoring_points_total or 0) > RLM_OFF_MONITORING_POINTS:
                    lines.append("changed from previous reel good to current reel bad")
                lines.append(f"Repeat length Monitoring OFF for {rlm_streak} consecutive reels")
                lines.append(f"current reel number {rlm_reel.reel_id or 'Unknown'}")
                lines.append(f"current job number {rlm_reel.job_name or 'Unknown'}")
                lines.append(f"monitoring points {int(rlm_health.monitoring_points_total or 0)}")
                lines.append(f"points per 1k feet {density:.1f}")

        if source == "SYSTEM":
            minutes = int(self._minutes_since(last_activity, now) or 0)
            metadata["minutesSinceActivity"] = minutes

        description = "\n".join(dict.fromkeys(lines)) if lines else title
        return description, metadata

    def _sync_alerts(
        self,
        session,
        candidates: List[Dict[str, Any]],
        now: datetime,
        current_reels: Dict[str, Dict[str, Any]],
    ) -> Dict[str, Any]:
        for candidate in candidates:
            self._normalize_alert_candidate_reel(session, candidate)

        alert_context = self._load_alert_context(session, candidates)
        active_rows = alert_context["activeRows"]
        active_by_key = alert_context["activeByKey"]
        active_by_reel_id = alert_context["activeByReelId"]
        active_by_reel_key = alert_context["activeByReelKey"]
        latest_by_key = alert_context["latestByKey"]
        latest_by_reel_id = alert_context["latestByReelId"]
        latest_by_reel_key = alert_context["latestByReelKey"]
        handled_active_ids = set()
        for candidate in candidates:
            if candidate.get("reelId") is None and not candidate.get("reelNumber"):
                continue
            reel_key = self._alert_reel_key(candidate.get("machineName"), candidate.get("reelNumber"), candidate.get("jobNumber"))
            row = None
            if candidate.get("reelId") is not None:
                row = active_by_reel_id.get(int(candidate["reelId"]))
            if not row and reel_key:
                row = active_by_reel_key.get(reel_key)
            if not row:
                keyed_row = active_by_key.get(candidate["issueKey"])
                if keyed_row and self._should_update_same_issue_row(keyed_row, candidate):
                    row = keyed_row
            if row:
                self._apply_alert_candidate(row, candidate)
                handled_active_ids.add(row.id)
            else:
                latest_row = latest_by_key.get(candidate["issueKey"])
                reel_row = latest_by_reel_id.get(int(candidate["reelId"])) if candidate.get("reelId") is not None else None
                reel_key_row = latest_by_reel_key.get(reel_key) if reel_key else None
                if self._should_suppress_reopen(reel_row or reel_key_row or latest_row, candidate):
                    continue
                session.add(
                    StatusOverviewAlert(
                        issue_key=candidate["issueKey"],
                        machine_id=candidate["machineId"],
                        machine_name=candidate["machineName"],
                        reel_id=candidate["reelId"],
                        reel_number=candidate["reelNumber"],
                        job_number=candidate["jobNumber"],
                        alert_title=candidate["alertTitle"],
                        alert_description=candidate["alertDescription"],
                        alert_source=candidate["alertSource"],
                        alert_state="NEW",
                        is_active=True,
                        created_at=now,
                        metadata_json=candidate["metadata"],
                    )
                )

        for row in active_rows:
            if row.id in handled_active_ids:
                continue
            current_reel = current_reels.get((row.machine_name or "").strip().lower())
            if not current_reel:
                continue
            if self._active_row_is_current_reel(row, current_reel):
                row.alert_state = "RESOLVED"
                row.resolved_comment = "Current reel is no longer alerting."
            else:
                row.alert_state = "SUPERSEDED"
                row.resolved_comment = "Superseded by newer reel."
            row.is_active = False
            row.resolved_at = now
            row.resolved_by = "system"

        session.commit()
        return self._load_alert_context(session, candidates)

    def _load_alert_context(self, session, candidates: Optional[List[Dict[str, Any]]] = None) -> Dict[str, Any]:
        active_rows = session.query(StatusOverviewAlert).filter(StatusOverviewAlert.is_active.is_(True)).all()
        active_by_machine = defaultdict(list)
        active_by_key = {}
        active_by_reel_id = {}
        active_by_reel_key = {}
        for row in active_rows:
            active_by_machine[(row.machine_name or "").strip().lower()].append(row)
            active_by_key[row.issue_key] = row
            if row.reel_id is not None:
                active_by_reel_id[int(row.reel_id)] = row
            reel_key = self._alert_reel_key_from_row(row)
            if reel_key:
                active_by_reel_key[reel_key] = row

        latest_rows = self._load_relevant_latest_alert_rows(session, candidates or [])
        latest_by_key: Dict[str, StatusOverviewAlert] = {}
        latest_by_reel_id: Dict[int, StatusOverviewAlert] = {}
        latest_by_reel_key: Dict[str, StatusOverviewAlert] = {}
        for row in latest_rows:
            latest_by_key.setdefault(row.issue_key, row)
            if row.reel_id is not None:
                latest_by_reel_id.setdefault(int(row.reel_id), row)
            reel_key = self._alert_reel_key_from_row(row)
            if reel_key:
                latest_by_reel_key.setdefault(reel_key, row)

        return {
            "activeRows": active_rows,
            "activeByMachine": active_by_machine,
            "activeByKey": active_by_key,
            "activeByReelId": active_by_reel_id,
            "activeByReelKey": active_by_reel_key,
            "latestRows": latest_rows,
            "latestByKey": latest_by_key,
            "latestByReelId": latest_by_reel_id,
            "latestByReelKey": latest_by_reel_key,
        }

    def _load_relevant_latest_alert_rows(self, session, candidates: List[Dict[str, Any]]) -> List[StatusOverviewAlert]:
        if not candidates:
            return []
        issue_keys = {candidate["issueKey"] for candidate in candidates if candidate.get("issueKey")}
        reel_ids = {int(candidate["reelId"]) for candidate in candidates if candidate.get("reelId") is not None}
        reel_key_filters = [
            (StatusOverviewAlert.machine_name == candidate["machineName"])
            & (StatusOverviewAlert.reel_number == str(candidate["reelNumber"]))
            for candidate in candidates
            if candidate.get("machineName") and candidate.get("reelNumber")
        ]
        filters = []
        if issue_keys:
            filters.append(StatusOverviewAlert.issue_key.in_(issue_keys))
        if reel_ids:
            filters.append(StatusOverviewAlert.reel_id.in_(reel_ids))
        filters.extend(reel_key_filters)
        if not filters:
            return []
        return (
            session.query(StatusOverviewAlert)
            .filter(or_(*filters))
            .order_by(StatusOverviewAlert.updated_at.desc(), StatusOverviewAlert.id.desc())
            .all()
        )

    def _repair_missing_alert_reel_ids(self, session) -> None:
        rows = (
            session.query(StatusOverviewAlert)
            .filter(StatusOverviewAlert.reel_id.is_(None))
            .filter(StatusOverviewAlert.reel_number.isnot(None))
            .all()
        )
        for row in rows:
            reel = self._find_bst_reel_for_alert_candidate(
                session,
                {
                    "machineId": row.machine_id,
                    "machineName": row.machine_name,
                    "reelNumber": row.reel_number,
                    "jobNumber": row.job_number,
                },
            )
            if not reel:
                continue
            row.reel_id = reel.reel_id
            row.reel_number = reel.reel_code or str(reel.reel_id)
            row.job_number = reel.order_number or reel.job_name or row.job_number

    def _normalize_alert_candidate_reel(self, session, candidate: Dict[str, Any]) -> None:
        reel_id = candidate.get("reelId")
        if reel_id is None:
            return
        reel = session.query(Reel).filter(Reel.reel_id == int(reel_id)).first()
        if not reel:
            return
        candidate["reelId"] = reel.reel_id
        candidate["reelNumber"] = reel.reel_code or str(reel.reel_id)
        candidate["jobNumber"] = reel.order_number or reel.job_name or candidate.get("jobNumber")

    def _find_bst_reel_for_alert_candidate(self, session, candidate: Dict[str, Any]) -> Optional[Reel]:
        reel_number = self._normalize_reel_token(candidate.get("reelNumber"))
        if not reel_number:
            return None

        machine_id = candidate.get("machineId")
        if not machine_id:
            machine_name = (candidate.get("machineName") or "").strip()
            machine = session.query(Machine).filter(Machine.name.ilike(machine_name)).first() if machine_name else None
            machine_id = machine.machine_id if machine else None
        if not machine_id:
            return None

        rows = (
            session.query(Reel)
            .filter(Reel.machine_id == int(machine_id))
            .filter(Reel.reel_code.ilike(str(candidate.get("reelNumber"))))
            .order_by(
                case((Reel.time_end.is_(None), Reel.time_start), else_=Reel.time_end).desc(),
                Reel.reel_id.desc(),
            )
            .all()
        )
        if not rows:
            return None

        job_number = self._normalize_reel_token(candidate.get("jobNumber"))
        if job_number:
            for row in rows:
                if job_number in {
                    self._normalize_reel_token(row.order_number),
                    self._normalize_reel_token(row.job_name),
                }:
                    return row
        return rows[0]

    def _active_row_is_current_reel(self, row: StatusOverviewAlert, current_reel: Optional[Dict[str, Any]]) -> bool:
        if not current_reel:
            return True
        if row.reel_id is not None:
            current_bst_reel_id = current_reel.get("bstReelId")
            if current_bst_reel_id is None or int(row.reel_id) != int(current_bst_reel_id):
                return False
            current_display_reel = self._normalize_reel_token(current_reel.get("displayReelNumber"))
            if not current_display_reel:
                return True
            row_reel = self._normalize_reel_token(row.reel_number)
            current_bst_reel = self._normalize_reel_token(current_reel.get("bstReelNumber"))
            return bool(row_reel == current_display_reel or current_bst_reel == current_display_reel)
        row_reel = self._normalize_reel_token(row.reel_number)
        current_rlm_reel = self._normalize_reel_token(current_reel.get("rlmReelNumber"))
        current_display_reel = self._normalize_reel_token(current_reel.get("displayReelNumber"))
        if current_display_reel:
            return row_reel == current_display_reel
        if current_rlm_reel:
            return row_reel == current_rlm_reel
        return True

    def _apply_alert_candidate(self, row: StatusOverviewAlert, candidate: Dict[str, Any]) -> None:
        row.issue_key = candidate["issueKey"]
        row.machine_id = candidate["machineId"]
        row.machine_name = candidate["machineName"]
        row.reel_id = candidate["reelId"]
        row.reel_number = candidate["reelNumber"]
        row.job_number = candidate["jobNumber"]
        row.alert_title = candidate["alertTitle"]
        row.alert_description = candidate["alertDescription"]
        row.alert_source = candidate["alertSource"]
        row.metadata_json = candidate["metadata"]

    def _should_update_same_issue_row(self, row: StatusOverviewAlert, candidate: Dict[str, Any]) -> bool:
        candidate_reel_id = candidate.get("reelId")
        if row.reel_id is not None and candidate_reel_id is not None:
            return row.reel_id == candidate_reel_id
        row_key = self._alert_reel_key_from_row(row)
        candidate_key = self._alert_reel_key(
            candidate.get("machineName"),
            candidate.get("reelNumber"),
            candidate.get("jobNumber"),
        )
        return bool(row_key and candidate_key and row_key == candidate_key)

    def _should_suppress_reopen(
        self,
        row: Optional[StatusOverviewAlert],
        candidate: Dict[str, Any],
    ) -> bool:
        if not row:
            return False
        candidate_reel_id = candidate.get("reelId")
        if row.reel_id is not None and candidate_reel_id is not None:
            return row.reel_id == candidate_reel_id
        same_machine = self._normalize_reel_token(row.machine_name) == self._normalize_reel_token(candidate.get("machineName"))
        same_reel = self._normalize_reel_token(row.reel_number) == self._normalize_reel_token(candidate.get("reelNumber"))
        return bool(same_machine and same_reel)

    def _alert_reel_key_from_row(self, row: StatusOverviewAlert) -> str:
        return self._alert_reel_key(row.machine_name, row.reel_number, row.job_number)

    def _alert_reel_key(
        self,
        machine_name: Optional[str],
        reel_number: Optional[Any],
        job_number: Optional[Any],
    ) -> str:
        machine = self._normalize_reel_token(machine_name)
        reel = self._normalize_reel_token(reel_number)
        if not machine or not reel:
            return ""
        return f"{machine}|{reel}"

    def _attach_active_alert_state(self, session, cards: List[Dict[str, Any]]) -> None:
        rows = session.query(StatusOverviewAlert).filter(StatusOverviewAlert.is_active.is_(True)).all()
        by_key = {row.issue_key: row for row in rows}
        for card in cards:
            row = by_key.get(card.get("issueKey"))
            if not row:
                continue
            card["alertId"] = row.id
            card["workflowBadge"] = "New"

    def _load_alert_sections(self, session, now: datetime) -> Dict[str, List[Dict[str, Any]]]:
        resolved_cutoff = now.replace(hour=0, minute=0, second=0, microsecond=0)
        new_rows = (
            session.query(StatusOverviewAlert)
            .filter(StatusOverviewAlert.is_active.is_(True))
            .filter(StatusOverviewAlert.alert_state == "NEW")
            .order_by(StatusOverviewAlert.created_at.desc())
            .all()
        )
        closed_rows = (
            session.query(StatusOverviewAlert)
            .filter(StatusOverviewAlert.alert_state.in_(("ACKNOWLEDGED", "MAKE_READY", "SUPERSEDED", "RESOLVED")))
            .filter(StatusOverviewAlert.updated_at >= resolved_cutoff)
            .order_by(StatusOverviewAlert.updated_at.desc())
            .limit(24)
            .all()
        )
        return {
            "new": [self._serialize_alert(row) for row in new_rows],
            "acknowledged": [],
            "resolved": [self._serialize_alert(row) for row in closed_rows],
        }

    def _serialize_alert(self, row: StatusOverviewAlert) -> Dict[str, Any]:
        metadata = row.metadata_json if isinstance(row.metadata_json, dict) else {}
        return {
            "id": row.id,
            "machineId": row.machine_id,
            "machineName": row.machine_name,
            "reelNumber": row.reel_number,
            "jobNumber": row.job_number,
            "alertTitle": row.alert_title,
            "alertDescription": row.alert_description,
            "alertSource": row.alert_source,
            "alertState": row.alert_state,
            "isActive": row.is_active,
            "createdAt": self._iso_local(row.created_at),
            "acknowledgedAt": self._iso_local(row.acknowledged_at),
            "acknowledgedBy": row.acknowledged_by,
            "acknowledgeComment": row.acknowledge_comment,
            "resolvedAt": self._iso_local(row.resolved_at),
            "resolvedBy": row.resolved_by,
            "resolvedComment": row.resolved_comment,
            "metadata": metadata,
        }

    def _load_alert_reel_histories(
        self,
        session,
        keys: List[str],
        bst_data: Dict[str, Dict[str, Any]],
        rlm_data: Dict[str, Dict[str, Any]],
        limit: int = 4,
    ) -> Dict[str, List[Dict[str, Any]]]:
        limit = max(int(limit or 4), 1)
        machine_names = set()
        reel_ids = set()
        reel_numbers = set()
        for key in keys:
            bst = bst_data.get(key, {})
            rlm = rlm_data.get(key, {})
            machine_name = bst.get("machineName") or rlm.get("machineName") or key.title()
            if machine_name:
                machine_names.add(machine_name)
            for reel in (bst.get("recentReels") or [])[:limit]:
                if reel.reel_id is not None:
                    reel_ids.add(int(reel.reel_id))
                if reel.reel_code:
                    reel_numbers.add(str(reel.reel_code))
            for reel in (rlm.get("recentRows") or [])[:limit]:
                if reel.reel_id:
                    reel_numbers.add(str(reel.reel_id))

        alert_rows = []
        alert_filters = []
        if reel_ids:
            alert_filters.append(StatusOverviewAlert.reel_id.in_(reel_ids))
        if reel_numbers:
            alert_filters.append(StatusOverviewAlert.reel_number.in_(reel_numbers))
        if machine_names and alert_filters:
            alert_rows = (
                session.query(StatusOverviewAlert)
                .filter(StatusOverviewAlert.machine_name.in_(machine_names))
                .filter(or_(*alert_filters))
                .all()
            )

        alerts_by_machine = defaultdict(list)
        for row in alert_rows:
            alerts_by_machine[(row.machine_name or "").strip().lower()].append(row)

        histories: Dict[str, List[Dict[str, Any]]] = {}
        for key in keys:
            bst = bst_data.get(key, {})
            rlm = rlm_data.get(key, {})
            machine_name = bst.get("machineName") or rlm.get("machineName") or key.title()
            alert_rows_for_machine = alerts_by_machine.get((machine_name or "").strip().lower(), [])
            bst_reels = (bst.get("recentReels") or [])[:limit]
            bst_metrics_by_id = bst.get("recentMetrics") or {}
            rlm_reels = rlm.get("recentRows") or []
            rlm_health_map = rlm.get("healthMap") or {}
            display_reel = self._display_reel_info(
                bst.get("latestReel"),
                rlm.get("latestReel"),
                self._latest_activity(bst.get("latestActivity"), rlm.get("latestActivity")),
                bst.get("latestActivity"),
                rlm.get("latestActivity"),
            )
            bst_latest = bst.get("latestReel")
            bst_latest_metrics = bst.get("latestMetrics")
            usable_bst_metrics = bst_latest_metrics if bst_latest_metrics and bst_latest_metrics["phaseSeconds"] > 0 else None
            if self._display_needs_synced_bst_fallback(display_reel, bst_latest, usable_bst_metrics, bst, rlm.get("latestReel")):
                fallback = bst.get("latestReliable")
                if fallback:
                    display_reel = self._display_reel_info(
                        fallback["reel"],
                        None,
                        self._bst_local_time(fallback["reel"].time_end or fallback["reel"].time_start),
                        self._bst_local_time(fallback["reel"].time_end or fallback["reel"].time_start),
                        None,
                    )

            rows: List[Dict[str, Any]] = []
            if bst_reels:
                for index, bst_reel in enumerate(bst_reels):
                    metrics = bst_metrics_by_id.get(bst_reel.reel_id) or self._bst_reel_metrics(bst_reel)
                    rlm_reel = self._match_rlm_reel(bst_reel, rlm_reels, index)
                    rlm_health = rlm_health_map.get(rlm_reel.reel_db_id) if rlm_reel else None
                    rows.append(
                        self._serialize_reel_history_row(
                            index,
                            bst_reel,
                            metrics,
                            rlm_reel,
                            rlm_health,
                            alert_rows_for_machine,
                            machine_name,
                        )
                    )
            else:
                for index, rlm_reel in enumerate(rlm_reels[:limit]):
                    rows.append(
                        self._serialize_reel_history_row(
                            index,
                            None,
                            None,
                            rlm_reel,
                            rlm_health_map.get(rlm_reel.reel_db_id),
                            alert_rows_for_machine,
                            machine_name,
                        )
                    )
            rows = self._ensure_display_reel_history_first(rows, bst, rlm, display_reel, alert_rows_for_machine, machine_name)
            histories[key] = rows
        return histories

    def _ensure_display_reel_history_first(
        self,
        rows: List[Dict[str, Any]],
        bst: Dict[str, Any],
        rlm: Dict[str, Any],
        display_reel: Dict[str, Optional[str]],
        alert_rows: List[StatusOverviewAlert],
        machine_name: Optional[str],
    ) -> List[Dict[str, Any]]:
        display_key = self._normalize_reel_token(display_reel.get("reelNumber"))
        if not display_key:
            return rows
        if rows and self._normalize_reel_token(rows[0].get("reelNumber")) == display_key:
            return rows

        bst_reel = bst.get("latestReel")
        rlm_reel = rlm.get("latestReel")
        current_bst_reel = bst_reel if self._bst_reel_is_current_display(bst_reel, display_reel) else None
        current_rlm_reel = rlm_reel if self._rlm_reel_is_current_display(rlm_reel, display_reel) else None
        if not current_bst_reel and not current_rlm_reel:
            return rows

        bst_metrics = None
        if current_bst_reel:
            bst_metrics = (bst.get("recentMetrics") or {}).get(current_bst_reel.reel_id) or bst.get("latestMetrics")
        rlm_health = None
        if current_rlm_reel:
            rlm_health = (rlm.get("healthMap") or {}).get(current_rlm_reel.reel_db_id) or rlm.get("latestHealth")

        current_row = self._serialize_reel_history_row(
            0,
            current_bst_reel,
            bst_metrics,
            current_rlm_reel,
            rlm_health,
            alert_rows,
            machine_name,
        )
        remaining_rows = [
            row
            for row in rows
            if self._normalize_reel_token(row.get("reelNumber")) != display_key
        ]
        for index, row in enumerate(remaining_rows, start=1):
            row["label"] = f"Prior {index}"
        return [current_row] + remaining_rows

    def _load_alert_reel_history(self, machine_id: Optional[int], machine_name: Optional[str], limit: int = 4) -> List[Dict[str, Any]]:
        machine_key = (machine_name or "").strip().lower()
        limit = max(int(limit or 4), 1)
        with SessionLocal() as session:
            bst_machine = session.query(Machine).filter(Machine.machine_id == machine_id).first() if machine_id else None
            if not bst_machine and machine_key:
                bst_machine = session.query(Machine).filter(Machine.name.ilike(machine_name)).first()
            effective_machine_id = bst_machine.machine_id if bst_machine else machine_id
            bst_reels = []
            if effective_machine_id:
                bst_reels = (
                    session.query(Reel)
                    .options(selectinload(Reel.inspection_phases))
                    .filter(Reel.machine_id == effective_machine_id)
                    .order_by(
                        case((Reel.time_end.is_(None), Reel.time_start), else_=Reel.time_end).desc(),
                        Reel.reel_id.desc(),
                    )
                    .limit(limit)
                    .all()
                )
                for reel in bst_reels:
                    setattr(reel, "_status_overview_machine_name", machine_name)
            alert_rows = (
                session.query(StatusOverviewAlert)
                .filter(StatusOverviewAlert.machine_name.ilike(machine_name))
                .all()
                if machine_name
                else []
            )

        with RLMSessionLocal() as rlm_session:
            rlm_machine = None
            if machine_key:
                rlm_machine = rlm_session.query(RLMMachine).filter(RLMMachine.machine_name.ilike(machine_name)).first()
            rlm_reels = []
            health_map = {}
            if rlm_machine:
                rlm_reels = (
                    rlm_session.query(RLMReel)
                    .filter(RLMReel.machine_id == rlm_machine.machine_id)
                    .order_by(
                        case(
                            (RLMReel.production_end_dt.is_(None), RLMReel.production_start_dt),
                            else_=RLMReel.production_end_dt,
                        ).desc(),
                        RLMReel.reel_db_id.desc(),
                    )
                    .limit(max(limit * 3, 12))
                    .all()
                )
                threshold = RLMLiveMachineThreshold(
                    machine_id=rlm_machine.machine_id,
                    machine_name=rlm_machine.machine_name,
                    min_qualifying_feet=0.0,
                    min_feet_for_zero_monitoring=0.0,
                    min_points_per_1000_ft_warn=1.0,
                    min_points_per_1000_ft_critical=1.0,
                    bad_reel_warn_oob_pct=2.0,
                    bad_reel_critical_oob_pct=10.0,
                    rolling_bad_feet_warn_pct=5.0,
                    rolling_bad_feet_critical_pct=15.0,
                    rolling_oob_warn_pct=2.0,
                    rolling_oob_critical_pct=10.0,
                    consecutive_bad_warn_count=2,
                    consecutive_bad_critical_count=3,
                    delta_std_warn=1.5,
                    delta_std_critical=3.0,
                    webspeed_range_warn=20.0,
                    webspeed_range_critical=35.0,
                    refresh_seconds=30,
                    stale_after_minutes=max(STALE_NO_REEL_MINUTES, 20),
                    cycle_panel_seconds=8,
                )
                reel_ids = [row.reel_db_id for row in rlm_reels]
                health_map = self.rlm_live_service._compute_reel_health_batch(
                    rlm_session,
                    reel_ids,
                    {rlm_machine.machine_id: threshold},
                )

        rows: List[Dict[str, Any]] = []
        if bst_reels:
            for index, bst_reel in enumerate(bst_reels):
                metrics = self._bst_reel_metrics(bst_reel)
                rlm_reel = self._match_rlm_reel(bst_reel, rlm_reels, index)
                rlm_health = health_map.get(rlm_reel.reel_db_id) if rlm_reel else None
                rows.append(self._serialize_reel_history_row(index, bst_reel, metrics, rlm_reel, rlm_health, alert_rows, machine_name))
        else:
            for index, rlm_reel in enumerate(rlm_reels[:limit]):
                rows.append(self._serialize_reel_history_row(index, None, None, rlm_reel, health_map.get(rlm_reel.reel_db_id), alert_rows, machine_name))
        return rows

    def _match_rlm_reel(self, bst_reel: Reel, rlm_reels: List[RLMReel], index: int) -> Optional[RLMReel]:
        bst_code = self._normalize_reel_token(bst_reel.reel_code)
        for rlm_reel in rlm_reels:
            if bst_code and self._normalize_reel_token(rlm_reel.reel_id) == bst_code:
                return rlm_reel
        return None

    def _serialize_reel_history_row(
        self,
        index: int,
        bst_reel: Optional[Reel],
        bst_metrics: Optional[Dict[str, float]],
        rlm_reel: Optional[RLMReel],
        rlm_health,
        alert_rows: List[StatusOverviewAlert],
        machine_name: Optional[str],
    ) -> Dict[str, Any]:
        feet = self._feet_from_bst_reel(bst_reel, machine_name) if bst_reel else None
        if feet is None and rlm_health:
            feet = float(rlm_health.feet_total or 0.0)
        bst_pct = bst_metrics["activePct"] if bst_metrics and bst_metrics["phaseSeconds"] > 0 else None
        rlm_points = int(rlm_health.monitoring_points_total or 0) if rlm_health else None
        rlm_density = float(rlm_health.points_per_1000_ft or 0.0) if rlm_health else None
        last_updated = self._latest_activity(
            self._bst_local_time((bst_reel.time_end or bst_reel.time_start) if bst_reel else None),
            self._central_time((rlm_reel.production_end_dt or rlm_reel.production_start_dt) if rlm_reel else None),
        )
        time_end = self._latest_activity(
            self._bst_local_time(bst_reel.time_end if bst_reel else None),
            self._central_time(rlm_reel.production_end_dt if rlm_reel else None),
        )
        reel_number = (bst_reel.reel_code if bst_reel and bst_reel.reel_code else None) or (rlm_reel.reel_id if rlm_reel else None)
        job_number = (bst_reel.order_number or bst_reel.job_name if bst_reel else None) or (rlm_reel.job_name if rlm_reel else None)
        history_state = self._reel_history_state(alert_rows, machine_name, reel_number, bst_reel.reel_id if bst_reel else None, feet)
        return {
            "label": "Current" if index == 0 else f"Prior {index}",
            "reelNumber": reel_number,
            "bstReelId": bst_reel.reel_id if bst_reel else None,
            "jobNumber": job_number,
            "feet": self._format_feet(feet),
            "bstPct": f"{bst_pct:.1f}%" if bst_pct is not None else "--",
            "rlmPoints": f"{rlm_points} pts" if rlm_points is not None else "--",
            "rlmDensity": f"{rlm_density:.1f}/1k ft" if rlm_density is not None else "--",
            "lastUpdated": self._iso_local(last_updated),
            "timeEnd": self._iso_local(time_end),
            "state": history_state,
        }

    def _reel_history_state(
        self,
        alert_rows: List[StatusOverviewAlert],
        machine_name: Optional[str],
        reel_number: Optional[Any],
        reel_id: Optional[int],
        feet: Optional[float],
    ) -> str:
        if feet is not None and feet < MAKE_READY_FEET_LIMIT:
            return "make-ready"
        matching = []
        reel_key = self._alert_reel_key(machine_name, reel_number, None)
        for row in alert_rows:
            if reel_id is not None and row.reel_id is not None and int(row.reel_id) == int(reel_id):
                matching.append(row)
                continue
            if reel_key and self._alert_reel_key_from_row(row) == reel_key:
                matching.append(row)
        if not matching:
            return "healthy"
        if any(row.alert_state == "MAKE_READY" for row in matching):
            return "make-ready"
        return "alert"

    def _normalize_reel_token(self, value: Optional[Any]) -> str:
        return str(value or "").strip().lower()

    def _bst_reel_metrics(self, reel: Reel) -> Dict[str, float]:
        phase_seconds = defaultdict(float)
        self._accumulate_bst_phase_seconds(phase_seconds, reel.inspection_phases or [])
        mix = self.dashboard_live_service._inspection_mix(phase_seconds)
        return {
            "activePct": mix["active_pct"],
            "inactivePct": mix["inactive_pct"],
            "learnPct": mix["learn_pct"],
            "activeSeconds": phase_seconds.get("active", 0.0),
            "inactiveSeconds": phase_seconds.get("inactive", 0.0),
            "learnSeconds": phase_seconds.get("learn", 0.0),
            "phaseSeconds": sum(phase_seconds.values()),
        }

    def _accumulate_bst_phase_seconds(self, accumulator: Dict[str, float], phases: Iterable[Any]) -> None:
        for phase in phases:
            if not phase.start_time or not phase.end_time or phase.end_time <= phase.start_time:
                continue
            key = (phase.phase or "unknown").strip().lower()
            accumulator[key] += max((phase.end_time - phase.start_time).total_seconds(), 0.0)

    def _count_bst_off_streak(self, rows: List[Dict[str, Any]], machine_name: Optional[str]) -> int:
        count = 0
        for row in rows:
            feet = self._feet_from_bst_reel(row.get("reel"), machine_name)
            if feet is not None and feet < MAKE_READY_FEET_LIMIT:
                break
            if row["metrics"]["activePct"] <= BST_OFF_ACTIVE_PCT:
                count += 1
            else:
                break
        return count

    def _count_rlm_off_streak(self, rows: List[Dict[str, Any]]) -> int:
        count = 0
        for row in rows:
            health = row["health"]
            feet = float(health.feet_total or 0.0)
            if feet < MAKE_READY_FEET_LIMIT:
                break
            if int(health.monitoring_points_total or 0) <= RLM_OFF_MONITORING_POINTS:
                count += 1
            else:
                break
        return count

    def _display_reel_info(
        self,
        bst_reel: Optional[Reel],
        rlm_reel: Optional[RLMReel],
        last_activity: Optional[datetime],
        bst_time: Optional[datetime],
        rlm_time: Optional[datetime],
    ) -> Dict[str, Optional[str]]:
        if last_activity and rlm_time and last_activity == rlm_time and rlm_reel:
            return {"reelNumber": rlm_reel.reel_id, "jobNumber": self._rlm_reel_job_display(rlm_reel)}
        if bst_reel:
            return {"reelNumber": bst_reel.reel_code or str(bst_reel.reel_id), "jobNumber": self._bst_reel_job_display(bst_reel)}
        if rlm_reel:
            return {"reelNumber": rlm_reel.reel_id, "jobNumber": self._rlm_reel_job_display(rlm_reel)}
        return {"reelNumber": None, "jobNumber": None}

    def _display_needs_synced_bst_fallback(
        self,
        display_reel: Dict[str, Optional[str]],
        bst_reel: Optional[Reel],
        bst_metrics: Optional[Dict[str, float]],
        bst: Dict[str, Any],
        rlm_reel: Optional[RLMReel],
    ) -> bool:
        if not rlm_reel or not bst.get("latestReliable"):
            return False
        display_key = self._normalize_reel_token(display_reel.get("reelNumber"))
        rlm_key = self._normalize_reel_token(rlm_reel.reel_id)
        if not display_key or display_key != rlm_key:
            return False
        if not bst_reel:
            return True
        bst_keys = {
            self._normalize_reel_token(bst_reel.reel_code),
            self._normalize_reel_token(bst_reel.reel_id),
        }
        return display_key not in bst_keys or not bst_metrics

    def _alert_reel_is_current_display(
        self,
        alert_reel: Dict[str, Optional[Any]],
        display_reel: Dict[str, Optional[str]],
    ) -> bool:
        alert_reel_number = self._normalize_reel_token(alert_reel.get("reelNumber"))
        display_reel_number = self._normalize_reel_token(display_reel.get("reelNumber"))
        if not alert_reel_number or not display_reel_number:
            return False
        return alert_reel_number == display_reel_number

    def _bst_reel_is_current_display(self, reel: Optional[Reel], display_reel: Dict[str, Optional[str]]) -> bool:
        if not reel:
            return False
        display_reel_number = self._normalize_reel_token(display_reel.get("reelNumber"))
        return display_reel_number in {
            self._normalize_reel_token(reel.reel_code),
            self._normalize_reel_token(reel.reel_id),
        }

    def _rlm_reel_is_current_display(self, reel: Optional[RLMReel], display_reel: Dict[str, Optional[str]]) -> bool:
        if not reel:
            return False
        return self._normalize_reel_token(reel.reel_id) == self._normalize_reel_token(display_reel.get("reelNumber"))

    def _alert_reel_info(
        self,
        source: str,
        bst_reel: Optional[Reel],
        rlm_reel: Optional[RLMReel],
        display_reel: Dict[str, Optional[str]],
    ) -> Dict[str, Optional[Any]]:
        if source in {"BST", "BOTH"} and bst_reel:
            return {
                "reelId": bst_reel.reel_id,
                "reelNumber": bst_reel.reel_code or str(bst_reel.reel_id),
                "jobNumber": bst_reel.order_number or bst_reel.job_name,
            }
        if source == "RLM" and rlm_reel:
            return {
                "reelId": None,
                "reelNumber": rlm_reel.reel_id,
                "jobNumber": rlm_reel.job_name or rlm_reel.order_number,
            }
        return {
            "reelId": None,
            "reelNumber": display_reel.get("reelNumber"),
            "jobNumber": display_reel.get("jobNumber"),
        }

    def _latest_activity(self, bst_time: Optional[datetime], rlm_time: Optional[datetime]) -> Optional[datetime]:
        if bst_time and rlm_time:
            return max(bst_time, rlm_time)
        return bst_time or rlm_time

    def _display_feet_value(self, bst_reel: Optional[Reel], rlm_health, machine_name: Optional[str] = None) -> Optional[float]:
        bst_feet = self._feet_from_bst_reel(bst_reel, machine_name) if bst_reel else None
        rlm_feet = float(rlm_health.feet_total or 0.0) if rlm_health else None
        if rlm_feet and rlm_feet > 0:
            return rlm_feet
        return bst_feet

    def _display_job_name(self, bst_reel: Optional[Reel], rlm_reel: Optional[RLMReel]) -> Optional[str]:
        return (self._bst_reel_job_display(bst_reel) if bst_reel else None) or (self._rlm_reel_job_display(rlm_reel) if rlm_reel else None)

    def _bst_reel_job_display(self, reel: Optional[Reel]) -> Optional[str]:
        if not reel:
            return None
        return self._format_job_display(reel.order_number, reel.job_name)

    def _rlm_reel_job_display(self, reel: Optional[RLMReel]) -> Optional[str]:
        if not reel:
            return None
        return self._format_job_display(getattr(reel, "order_number", None), getattr(reel, "job_name", None))

    def _format_job_display(self, order_number: Optional[Any], job_name: Optional[Any]) -> Optional[str]:
        order = str(order_number or "").strip()
        job = str(job_name or "").strip()
        if order and job and order.lower() != job.lower():
            return f"{order} - {job}"
        return order or job or None

    def _feet_from_bst_reel(self, reel: Optional[Reel], machine_name: Optional[str] = None) -> Optional[float]:
        if not reel:
            return None
        start = self._to_float(reel.reel_start)
        end = self._to_float(reel.reel_end)
        if start is None or end is None:
            return None
        return abs(end - start) * self._bst_feet_multiplier(reel, machine_name)

    def _bst_feet_multiplier(self, reel: Optional[Reel], machine_name: Optional[str] = None) -> float:
        if reel is not None:
            format_length = self._to_float(getattr(reel, "format_length", None))
            computed = compute_feet_per_range_unit(format_length)
            if computed is not None:
                return float(computed)
        normalized = self._normalize_reel_token(machine_name)
        if not normalized and reel is not None:
            normalized = self._normalize_reel_token(getattr(reel, "_status_overview_machine_name", None))
        if not normalized and reel is not None:
            try:
                normalized = self._normalize_reel_token(getattr(getattr(reel, "machine", None), "name", None))
            except Exception:
                normalized = ""
        return float(BST_FEET_MULTIPLIERS_BY_MACHINE.get(normalized, BST_FEET_MULTIPLIER_DEFAULT))

    def _format_feet(self, value: Optional[float]) -> str:
        if value is None:
            return "--"
        return f"{value:,.0f} ft"

    def _sort_priority(self, state: str, workflow_rank: int) -> int:
        if state == "critical":
            return workflow_rank
        if state == "resolved":
            return 2
        if state in {"acknowledged", "superseded"}:
            return 2
        if state == "stale":
            return 2
        return 3

    def _card_sort_key(self, card: Dict[str, Any]) -> Tuple[int, Any]:
        return self._board_machine_sort(card.get("machineKey") or card.get("machineName") or "")

    def _board_machine_sort(self, name: str) -> Tuple[int, Any]:
        normalized = (name or "").strip().lower()
        try:
            return (0, STATUS_OVERVIEW_MACHINE_ORDER.index(normalized))
        except ValueError:
            return (1, self._machine_name_sort(normalized))

    def _machine_name_sort(self, name: str) -> Tuple[int, str]:
        text = (name or "").lower()
        digits = "".join(ch for ch in text if ch.isdigit())
        return (int(digits) if digits else 999, text)

    def _minutes_since(self, dt: Optional[datetime], now: datetime) -> Optional[float]:
        if not dt:
            return None
        local_dt = self._central_time(dt)
        local_now = self._central_time(now)
        if not local_dt or not local_now:
            return None
        return max((local_now - local_dt).total_seconds() / 60.0, 0.0)

    def _latest_dt(self, *values: Optional[datetime]) -> Optional[datetime]:
        cleaned = [self._central_time(value) for value in values if value]
        cleaned = [value for value in cleaned if value]
        return max(cleaned) if cleaned else None

    def _to_float(self, value: Optional[Decimal]) -> Optional[float]:
        if value is None:
            return None
        try:
            return float(value)
        except (TypeError, ValueError):
            return None

    def _naive_utc(self, value: datetime) -> datetime:
        if value.tzinfo:
            return value.astimezone(timezone.utc).replace(tzinfo=None)
        return value

    def _central_time(self, value: Optional[datetime]) -> Optional[datetime]:
        if not value:
            return None
        if value.tzinfo:
            return value.astimezone(CENTRAL_TZ)
        return value.replace(tzinfo=CENTRAL_TZ)

    def _bst_local_time(self, value: Optional[datetime]) -> Optional[datetime]:
        if not value:
            return None
        if value.tzinfo:
            return value.astimezone(CENTRAL_TZ)
        return value.replace(tzinfo=CENTRAL_TZ)

    def _iso(self, value: Optional[datetime]) -> Optional[str]:
        local = self._central_time(value)
        if not local:
            return None
        return local.isoformat()

    def _iso_local(self, value: Optional[datetime]) -> Optional[str]:
        return self._iso(value)

    def _central_now(self) -> datetime:
        return datetime.now(CENTRAL_TZ)
