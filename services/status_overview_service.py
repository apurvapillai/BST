from __future__ import annotations

from collections import defaultdict
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from typing import Any, Dict, Iterable, List, Optional, Tuple
from zoneinfo import ZoneInfo

from sqlalchemy import case, inspect, text
from sqlalchemy.orm import selectinload

from db.connection import SessionLocal, engine
from db.models import Machine, Reel, StatusOverviewAlert, StatusOverviewSetting
from db.rlm_connection import RLMSessionLocal
from db.rlm_live_models import RLMLiveMachineThreshold
from db.rlm_models import RLMMachine, RLMReel
from services.dashboard_live_service import DashboardLiveService
from services.rlm_live_service import RLMLiveService

BST_LOOKBACK_DAYS = 3
RLM_LOOKBACK_DAYS = 7
RECENT_REEL_LIMIT = 12
DEFAULT_ACTOR = "unknown"
CENTRAL_TZ = ZoneInfo("America/Chicago")

DEFAULT_SETTINGS = {
    "bst_green_pct": 25.0,
    "bst_yellow_pct": 10.0,
    "bst_critical_active_pct": 5.0,
    "bst_red_logic": "Red when latest reliable reel active inspection % is below the red threshold.",
    "rlm_min_qualifying_feet": 300.0,
    "rlm_green_pts_per_1000_ft": 20.0,
    "rlm_yellow_pts_per_1000_ft": 12.0,
    "rlm_min_points_per_1000_ft": 8.0,
    "rlm_red_logic": "Red when the latest qualifying reel has zero monitoring or points per 1k ft below the red threshold.",
    "stale_no_reel_minutes": 60,
    "resolved_recent_hours": 24,
}

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


class StatusOverviewService:
    def __init__(self) -> None:
        self.dashboard_live_service = DashboardLiveService()
        self.rlm_live_service = RLMLiveService()
        self._ensure_tables()

    def get_board_payload(self) -> Dict[str, Any]:
        now = self._central_now()
        with SessionLocal() as session:
            global_settings, overrides = self._get_settings_map(session)
            settings_summary = self._serialize_settings(global_settings)
            bst_data = self._load_bst_machine_data(now)
            rlm_data = self._load_rlm_machine_data(now, bst_data, global_settings, overrides)
            cards, candidates = self._build_cards(now, global_settings, overrides, bst_data, rlm_data)
            self._sync_alerts(session, candidates, now)
            self._attach_active_alert_state(session, cards)
            alerts = self._load_alert_sections(session, global_settings, now)

        cards.sort(key=self._card_sort_key)
        return {
            "generatedAt": self._iso(now),
            "settingsSummary": settings_summary,
            "cards": cards,
            "alerts": alerts,
            "bannerAlerts": alerts["new"] + alerts["acknowledged"],
        }

    def get_settings_payload(self) -> Dict[str, Any]:
        with SessionLocal() as session:
            global_settings, overrides = self._get_settings_map(session)
            machines = session.query(Machine).order_by(Machine.name.asc()).all()
        return {
            "global": self._serialize_settings(global_settings),
            "overrides": {str(machine_id): self._serialize_settings(row) for machine_id, row in overrides.items()},
            "machines": [
                {
                    "id": machine.machine_id,
                    "name": machine.name,
                }
                for machine in machines
            ],
            "defaults": DEFAULT_SETTINGS.copy(),
        }

    def save_settings(self, machine_id: Optional[int], values: Dict[str, Any], updated_by: str) -> Tuple[bool, str]:
        updated_by = (updated_by or DEFAULT_ACTOR).strip() or DEFAULT_ACTOR
        clean_values = self._clean_settings_values(values)
        with SessionLocal() as session:
            row = self._get_or_create_settings_row(session, machine_id)
            if machine_id:
                machine = session.query(Machine).filter(Machine.machine_id == machine_id).first()
                if not machine:
                    return False, "Machine not found."
                row.machine_name = machine.name
            for key, value in clean_values.items():
                setattr(row, key, value)
            row.updated_by = updated_by
            session.commit()
        return True, "Settings saved."

    def apply_to_all(self, values: Dict[str, Any], updated_by: str) -> Tuple[bool, str]:
        updated_by = (updated_by or DEFAULT_ACTOR).strip() or DEFAULT_ACTOR
        clean_values = self._clean_settings_values(values)
        with SessionLocal() as session:
            global_row = self._get_or_create_settings_row(session, None)
            for key, value in clean_values.items():
                setattr(global_row, key, value)
            global_row.updated_by = updated_by
            session.query(StatusOverviewSetting).filter(StatusOverviewSetting.machine_id.isnot(None)).delete()
            session.commit()
        return True, "Applied to all machines."

    def reset_settings(self, machine_id: Optional[int], updated_by: str) -> Tuple[bool, str]:
        updated_by = (updated_by or DEFAULT_ACTOR).strip() or DEFAULT_ACTOR
        with SessionLocal() as session:
            if machine_id:
                session.query(StatusOverviewSetting).filter(StatusOverviewSetting.machine_id == machine_id).delete()
                session.commit()
                return True, "Machine override reset."
            session.query(StatusOverviewSetting).delete()
            row = StatusOverviewSetting(updated_by=updated_by, **DEFAULT_SETTINGS)
            session.add(row)
            session.commit()
        return True, "Defaults restored."

    def get_alert(self, alert_id: int) -> Optional[Dict[str, Any]]:
        with SessionLocal() as session:
            row = session.query(StatusOverviewAlert).filter(StatusOverviewAlert.id == alert_id).first()
            return self._serialize_alert(row) if row else None

    def acknowledge_alert(self, alert_id: int, actor: str, comment: str) -> Tuple[bool, str]:
        actor = (actor or DEFAULT_ACTOR).strip() or DEFAULT_ACTOR
        comment = (comment or "").strip()
        if not comment:
            return False, "Acknowledgment comment is required."
        with SessionLocal() as session:
            row = session.query(StatusOverviewAlert).filter(StatusOverviewAlert.id == alert_id).first()
            if not row:
                return False, "Alert not found."
            row.alert_state = "ACKNOWLEDGED"
            row.acknowledged_at = datetime.utcnow()
            row.acknowledged_by = actor
            row.acknowledge_comment = comment
            row.is_active = True
            session.commit()
        return True, "Alert acknowledged."

    def resolve_alert(self, alert_id: int, actor: str, comment: str) -> Tuple[bool, str]:
        actor = (actor or DEFAULT_ACTOR).strip() or DEFAULT_ACTOR
        comment = (comment or "").strip()
        if not comment:
            return False, "Resolution comment is required."
        with SessionLocal() as session:
            row = session.query(StatusOverviewAlert).filter(StatusOverviewAlert.id == alert_id).first()
            if not row:
                return False, "Alert not found."
            row.alert_state = "RESOLVED"
            row.resolved_at = datetime.utcnow()
            row.resolved_by = actor
            row.resolved_comment = comment
            row.is_active = False
            session.commit()
        return True, "Alert resolved."

    def _ensure_tables(self) -> None:
        StatusOverviewSetting.__table__.create(bind=engine, checkfirst=True)
        StatusOverviewAlert.__table__.create(bind=engine, checkfirst=True)
        self._upgrade_settings_table()
        with SessionLocal() as session:
            self._get_or_create_settings_row(session, None)
            session.commit()

    def _upgrade_settings_table(self) -> None:
        inspector = inspect(engine)
        columns = {column["name"] for column in inspector.get_columns("status_overview_settings")}
        ddl = {
            "machine_id": "ALTER TABLE status_overview_settings ADD COLUMN machine_id INTEGER NULL",
            "machine_name": "ALTER TABLE status_overview_settings ADD COLUMN machine_name VARCHAR(100) NULL",
            "bst_green_pct": "ALTER TABLE status_overview_settings ADD COLUMN bst_green_pct FLOAT NOT NULL DEFAULT 25.0",
            "bst_yellow_pct": "ALTER TABLE status_overview_settings ADD COLUMN bst_yellow_pct FLOAT NOT NULL DEFAULT 10.0",
            "bst_red_logic": "ALTER TABLE status_overview_settings ADD COLUMN bst_red_logic VARCHAR(255) NOT NULL DEFAULT 'Red when latest reliable reel active inspection % is below the red threshold.'",
            "rlm_green_pts_per_1000_ft": "ALTER TABLE status_overview_settings ADD COLUMN rlm_green_pts_per_1000_ft FLOAT NOT NULL DEFAULT 20.0",
            "rlm_yellow_pts_per_1000_ft": "ALTER TABLE status_overview_settings ADD COLUMN rlm_yellow_pts_per_1000_ft FLOAT NOT NULL DEFAULT 12.0",
            "rlm_red_logic": "ALTER TABLE status_overview_settings ADD COLUMN rlm_red_logic VARCHAR(255) NOT NULL DEFAULT 'Red when the latest qualifying reel has zero monitoring or points per 1k ft below the red threshold.'",
        }
        with engine.begin() as conn:
            for column_name, statement in ddl.items():
                if column_name in columns:
                    continue
                conn.execute(text(statement))

    def _get_settings_map(self, session) -> Tuple[StatusOverviewSetting, Dict[int, StatusOverviewSetting]]:
        rows = (
            session.query(StatusOverviewSetting)
            .order_by(
                case((StatusOverviewSetting.machine_id.is_(None), 0), else_=1),
                StatusOverviewSetting.machine_id.asc(),
                StatusOverviewSetting.id.asc(),
            )
            .all()
        )
        global_row = next((row for row in rows if row.machine_id is None), None)
        if not global_row:
            global_row = StatusOverviewSetting(**DEFAULT_SETTINGS)
            session.add(global_row)
            session.flush()
        overrides = {int(row.machine_id): row for row in rows if row.machine_id is not None}
        return global_row, overrides

    def _get_or_create_settings_row(self, session, machine_id: Optional[int]) -> StatusOverviewSetting:
        if machine_id is None:
            row = session.query(StatusOverviewSetting).filter(StatusOverviewSetting.machine_id.is_(None)).order_by(StatusOverviewSetting.id.asc()).first()
            if row:
                return row
            row = StatusOverviewSetting(**DEFAULT_SETTINGS)
            session.add(row)
            session.flush()
            return row
        row = session.query(StatusOverviewSetting).filter(StatusOverviewSetting.machine_id == machine_id).order_by(StatusOverviewSetting.id.asc()).first()
        if row:
            return row
        global_row = self._get_or_create_settings_row(session, None)
        machine = session.query(Machine).filter(Machine.machine_id == machine_id).first()
        values = self._serialize_settings(global_row)
        row = StatusOverviewSetting(machine_id=machine_id, machine_name=machine.name if machine else None, **values)
        session.add(row)
        session.flush()
        return row

    def _settings_for_machine(
        self,
        machine_id: Optional[int],
        global_settings: StatusOverviewSetting,
        overrides: Dict[int, StatusOverviewSetting],
    ) -> StatusOverviewSetting:
        if machine_id and machine_id in overrides:
            return overrides[machine_id]
        return global_settings

    def _serialize_settings(self, row: StatusOverviewSetting) -> Dict[str, Any]:
        return {
            "bst_green_pct": float(row.bst_green_pct),
            "bst_yellow_pct": float(row.bst_yellow_pct),
            "bst_critical_active_pct": float(row.bst_critical_active_pct),
            "bst_red_logic": row.bst_red_logic,
            "rlm_min_qualifying_feet": float(row.rlm_min_qualifying_feet),
            "rlm_green_pts_per_1000_ft": float(row.rlm_green_pts_per_1000_ft),
            "rlm_yellow_pts_per_1000_ft": float(row.rlm_yellow_pts_per_1000_ft),
            "rlm_min_points_per_1000_ft": float(row.rlm_min_points_per_1000_ft),
            "rlm_red_logic": row.rlm_red_logic,
            "stale_no_reel_minutes": int(row.stale_no_reel_minutes),
            "resolved_recent_hours": int(row.resolved_recent_hours),
        }

    def _clean_settings_values(self, values: Dict[str, Any]) -> Dict[str, Any]:
        numeric_fields = {
            "bst_green_pct": float,
            "bst_yellow_pct": float,
            "bst_critical_active_pct": float,
            "rlm_min_qualifying_feet": float,
            "rlm_green_pts_per_1000_ft": float,
            "rlm_yellow_pts_per_1000_ft": float,
            "rlm_min_points_per_1000_ft": float,
            "stale_no_reel_minutes": int,
            "resolved_recent_hours": int,
        }
        text_fields = {"bst_red_logic", "rlm_red_logic"}
        out: Dict[str, Any] = {}
        for key, caster in numeric_fields.items():
            raw = values.get(key, DEFAULT_SETTINGS[key])
            out[key] = caster(raw)
        for key in text_fields:
            out[key] = str(values.get(key, DEFAULT_SETTINGS[key]) or DEFAULT_SETTINGS[key]).strip()
        return out

    def _load_bst_machine_data(self, now: datetime) -> Dict[str, Dict[str, Any]]:
        lookback_start = now.replace(tzinfo=None) - timedelta(days=BST_LOOKBACK_DAYS)
        with SessionLocal() as session:
            machines = session.query(Machine).order_by(Machine.name.asc()).all()
            reels = (
                session.query(Reel)
                .options(selectinload(Reel.inspection_phases))
                .filter(Reel.machine_id.in_([m.machine_id for m in machines]))
                .filter((Reel.time_end.is_(None)) | (Reel.time_end >= lookback_start))
                .order_by(Reel.machine_id.asc(), Reel.time_end.desc(), Reel.time_start.desc(), Reel.reel_id.desc())
                .all()
            )

        reels_by_machine: Dict[int, List[Reel]] = defaultdict(list)
        for reel in reels:
            if len(reels_by_machine[reel.machine_id]) < RECENT_REEL_LIMIT:
                reels_by_machine[reel.machine_id].append(reel)

        out: Dict[str, Dict[str, Any]] = {}
        for machine in machines:
            machine_reels = reels_by_machine.get(machine.machine_id, [])
            latest_reel = machine_reels[0] if machine_reels else None
            latest_activity = self._bst_local_time(latest_reel.time_end or latest_reel.time_start) if latest_reel else None
            reliable_rows = []
            for reel in machine_reels:
                metrics = self._bst_reel_metrics(reel)
                if metrics["phaseSeconds"] > 0:
                    reliable_rows.append({"reel": reel, "metrics": metrics})
            out[(machine.name or "").strip().lower()] = {
                "machineId": machine.machine_id,
                "machineName": machine.name,
                "latestActivity": latest_activity,
                "latestReel": latest_reel,
                "latestReliable": reliable_rows[0] if reliable_rows else None,
                "previousReliable": reliable_rows[1] if len(reliable_rows) > 1 else None,
                "reliableRows": reliable_rows,
            }
        return out

    def _load_rlm_machine_data(
        self,
        now: datetime,
        bst_data: Dict[str, Dict[str, Any]],
        global_settings: StatusOverviewSetting,
        overrides: Dict[int, StatusOverviewSetting],
    ) -> Dict[str, Dict[str, Any]]:
        lookback_start = now.astimezone(timezone.utc) - timedelta(days=RLM_LOOKBACK_DAYS)
        with RLMSessionLocal() as session:
            machines = session.query(RLMMachine).filter(RLMMachine.machine_name.isnot(None)).order_by(RLMMachine.machine_name.asc()).all()
            machine_ids = [machine.machine_id for machine in machines]
            recent_reels = self.rlm_live_service._recent_reels_by_machine(session, machine_ids, lookback_start)
            threshold_map = self._build_rlm_thresholds(machines, bst_data, global_settings, overrides)
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
            for row in rows:
                health = health_map.get(row.reel_db_id)
                if health and health.is_qualifying_reel:
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
                "latestQualifying": qualifying[0] if qualifying else None,
                "previousQualifying": qualifying[1] if len(qualifying) > 1 else None,
                "qualifyingRows": qualifying,
            }
        return out

    def _build_rlm_thresholds(
        self,
        machines: Iterable[RLMMachine],
        bst_data: Dict[str, Dict[str, Any]],
        global_settings: StatusOverviewSetting,
        overrides: Dict[int, StatusOverviewSetting],
    ) -> Dict[int, RLMLiveMachineThreshold]:
        out: Dict[int, RLMLiveMachineThreshold] = {}
        for machine in machines:
            bst_machine_id = bst_data.get((machine.machine_name or "").strip().lower(), {}).get("machineId")
            machine_settings = self._settings_for_machine(bst_machine_id, global_settings, overrides)
            out[machine.machine_id] = RLMLiveMachineThreshold(
                machine_id=machine.machine_id,
                machine_name=machine.machine_name,
                min_qualifying_feet=machine_settings.rlm_min_qualifying_feet,
                min_feet_for_zero_monitoring=machine_settings.rlm_min_qualifying_feet,
                min_points_per_1000_ft_warn=machine_settings.rlm_min_points_per_1000_ft,
                min_points_per_1000_ft_critical=machine_settings.rlm_min_points_per_1000_ft,
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
                stale_after_minutes=max(machine_settings.stale_no_reel_minutes, 20),
                cycle_panel_seconds=8,
            )
        return out

    def _build_cards(
        self,
        now: datetime,
        global_settings: StatusOverviewSetting,
        overrides: Dict[int, StatusOverviewSetting],
        bst_data: Dict[str, Dict[str, Any]],
        rlm_data: Dict[str, Dict[str, Any]],
    ) -> Tuple[List[Dict[str, Any]], List[Dict[str, Any]]]:
        keys = sorted(set(bst_data.keys()) | set(rlm_data.keys()), key=self._board_machine_sort)
        cards: List[Dict[str, Any]] = []
        candidates: List[Dict[str, Any]] = []

        with SessionLocal() as session:
            active_alerts = session.query(StatusOverviewAlert).filter(StatusOverviewAlert.is_active.is_(True)).all()
        active_by_machine = defaultdict(list)
        for row in active_alerts:
            active_by_machine[(row.machine_name or "").strip().lower()].append(row)

        for key in keys:
            bst = bst_data.get(key, {})
            rlm = rlm_data.get(key, {})
            machine_name = bst.get("machineName") or rlm.get("machineName") or key.title()
            machine_id = bst.get("machineId")
            machine_settings = self._settings_for_machine(machine_id, global_settings, overrides)

            bst_latest = bst.get("latestReliable")
            rlm_latest = rlm.get("latestQualifying")
            bst_reel = bst_latest["reel"] if bst_latest else bst.get("latestReel")
            rlm_reel = rlm_latest["reel"] if rlm_latest else rlm.get("latestReel")
            bst_metrics = bst_latest["metrics"] if bst_latest else None
            rlm_health = rlm_latest["health"] if rlm_latest else None

            bst_off = bool(bst_metrics and bst_metrics["activePct"] < machine_settings.bst_critical_active_pct)
            bst_warn = bool(
                bst_metrics
                and not bst_off
                and bst_metrics["activePct"] < machine_settings.bst_green_pct
            )

            rlm_density = float(rlm_health.points_per_1000_ft or 0.0) if rlm_health else 0.0
            rlm_off = bool(
                rlm_health
                and rlm_health.is_qualifying_reel
                and (
                    rlm_health.monitoring_points_total == 0
                    or rlm_density < machine_settings.rlm_min_points_per_1000_ft
                )
            )
            rlm_warn = bool(
                rlm_health
                and rlm_health.is_qualifying_reel
                and not rlm_off
                and rlm_density < machine_settings.rlm_green_pts_per_1000_ft
            )

            bst_streak = self._count_bst_off_streak(bst.get("reliableRows", []), machine_settings.bst_critical_active_pct)
            rlm_streak = self._count_rlm_off_streak(rlm.get("qualifyingRows", []), machine_settings.rlm_min_points_per_1000_ft)

            last_activity = bst.get("latestActivity") or rlm.get("latestActivity")
            minutes_since_activity = self._minutes_since(last_activity, now)

            title = ""
            source = ""
            state = "healthy"
            is_alertable = False
            if minutes_since_activity is None or minutes_since_activity >= machine_settings.stale_no_reel_minutes:
                minutes_value = max(int(minutes_since_activity or machine_settings.stale_no_reel_minutes), machine_settings.stale_no_reel_minutes)
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

            display_reel = self._display_reel_info(bst_reel, rlm_reel, last_activity, bst.get("latestActivity"), rlm.get("latestActivity"))
            feet_value = self._display_feet_value(bst_reel, rlm_health)
            description, metadata = self._build_alert_detail(
                now=now,
                title=title,
                source=source,
                machine_name=machine_name,
                bst=bst,
                rlm=rlm,
                machine_settings=machine_settings,
                bst_off=bst_off,
                rlm_off=rlm_off,
                bst_streak=bst_streak,
                rlm_streak=rlm_streak,
                last_activity=last_activity,
            )
            metadata["jobName"] = self._display_job_name(bst_reel, rlm_reel)
            metadata["lastReelFeet"] = self._format_feet(feet_value)

            active_rows = active_by_machine.get(key, [])
            workflow_badge = None
            workflow_rank = 3
            active_row = None
            if title and is_alertable:
                active_row = next((row for row in active_rows if row.alert_title == title), active_rows[0] if active_rows else None)
                if active_row:
                    workflow_badge = "Being Addressed" if active_row.alert_state == "ACKNOWLEDGED" else "New"
                    workflow_rank = 1 if active_row.alert_state == "ACKNOWLEDGED" else 0
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
                "statusText": title or "All Systems Active",
                "state": state,
                "workflowBadge": workflow_badge,
                "metrics": {
                    "lastReelFeet": self._format_feet(feet_value),
                },
                "bstBox": self._build_bst_box(bst_metrics, machine_settings, bst_off, bst_warn),
                "rlmBox": self._build_rlm_box(rlm_health, machine_settings, rlm_off, rlm_warn),
                "alertId": active_row.id if active_row and is_alertable else None,
                "issueKey": f"{key}|{title}" if title and is_alertable else None,
                "sortPriority": self._sort_priority(state, workflow_rank),
            }
            cards.append(card)

            if title and is_alertable:
                candidates.append(
                    {
                        "issueKey": f"{key}|{title}",
                        "machineId": machine_id,
                        "machineName": machine_name,
                        "reelId": bst_reel.reel_id if source in {"BST", "BOTH"} and bst_reel else None,
                        "reelNumber": display_reel["reelNumber"],
                        "jobNumber": display_reel["jobNumber"],
                        "alertTitle": title,
                        "alertDescription": description,
                        "alertSource": source,
                        "metadata": metadata,
                    }
                )
        return cards, candidates

    def _build_bst_box(self, metrics: Optional[Dict[str, float]], settings: StatusOverviewSetting, is_off: bool, is_warn: bool) -> Dict[str, Any]:
        if not metrics:
            return {"label": "BST STATUS", "state": "neutral", "detail": "No data", "subdetail": ""}
        state = "off" if is_off else "warn" if is_warn else "healthy"
        return {
            "label": "BST STATUS",
            "state": state,
            "detail": "Inactive" if is_off else "Active",
            "subdetail": f"{metrics['activePct']:.1f}% inspection",
        }

    def _build_rlm_box(self, health, settings: StatusOverviewSetting, is_off: bool, is_warn: bool) -> Dict[str, Any]:
        if not health:
            return {"label": "RLM STATUS", "state": "neutral", "detail": "No data", "subdetail": ""}
        pts = int(health.monitoring_points_total or 0)
        density = float(health.points_per_1000_ft or 0.0)
        state = "off" if is_off else "warn" if is_warn else "healthy"
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
        machine_settings: StatusOverviewSetting,
        bst_off: bool,
        rlm_off: bool,
        bst_streak: int,
        rlm_streak: int,
        last_activity: Optional[datetime],
    ) -> Tuple[str, Dict[str, Any]]:
        lines: List[str] = []
        metadata: Dict[str, Any] = {
            "machineName": machine_name,
            "thresholds": self._serialize_settings(machine_settings),
            "bst": {},
            "rlm": {},
        }

        bst_latest = bst.get("latestReliable")
        bst_prev = bst.get("previousReliable")
        if bst_latest:
            reel = bst_latest["reel"]
            metrics = bst_latest["metrics"]
            metadata["bst"] = {
                "reelNumber": reel.reel_code,
                "jobNumber": reel.order_number or reel.job_name,
                "activePct": round(metrics["activePct"], 2),
                "consecutiveOffReels": bst_streak,
            }
            if bst_off:
                if bst_prev and bst_prev["metrics"]["activePct"] >= machine_settings.bst_critical_active_pct:
                    lines.append("changed from previous reel good to current reel bad")
                lines.append(f"BST OFF for {bst_streak} consecutive reels")
                lines.append(f"current reel number {reel.reel_code or 'Unknown'}")
                lines.append(f"current job number {reel.order_number or reel.job_name or 'Unknown'}")
                lines.append(f"inspection active {metrics['activePct']:.1f}%")

        rlm_latest = rlm.get("latestQualifying")
        rlm_prev = rlm.get("previousQualifying")
        if rlm_latest:
            reel = rlm_latest["reel"]
            health = rlm_latest["health"]
            density = float(health.points_per_1000_ft or 0.0)
            metadata["rlm"] = {
                "reelNumber": reel.reel_id,
                "jobNumber": reel.job_name,
                "pointsPer1000Ft": round(density, 2),
                "monitoringPointsTotal": int(health.monitoring_points_total or 0),
                "consecutiveOffReels": rlm_streak,
                "feetTotal": round(float(health.feet_total or 0.0), 2),
            }
            if rlm_off:
                if rlm_prev and float(rlm_prev["health"].points_per_1000_ft or 0.0) >= machine_settings.rlm_min_points_per_1000_ft:
                    lines.append("changed from previous reel good to current reel bad")
                lines.append(f"Repeat length Monitoring OFF for {rlm_streak} consecutive reels")
                lines.append(f"current reel number {reel.reel_id or 'Unknown'}")
                lines.append(f"current job number {reel.job_name or 'Unknown'}")
                lines.append(f"monitoring points {int(health.monitoring_points_total or 0)}")
                lines.append(f"points per 1k feet {density:.1f}")
                lines.append(f"red threshold {machine_settings.rlm_min_points_per_1000_ft:.1f} per 1k feet")

        if source == "SYSTEM":
            minutes = int(self._minutes_since(last_activity, now) or 0)
            metadata["minutesSinceActivity"] = minutes

        description = "\n".join(dict.fromkeys(lines)) if lines else title
        return description, metadata

    def _sync_alerts(self, session, candidates: List[Dict[str, Any]], now: datetime) -> None:
        active_rows = session.query(StatusOverviewAlert).filter(StatusOverviewAlert.is_active.is_(True)).all()
        active_by_key = {row.issue_key: row for row in active_rows}
        candidate_keys = {row["issueKey"] for row in candidates}

        for candidate in candidates:
            row = active_by_key.get(candidate["issueKey"])
            if row:
                row.machine_id = candidate["machineId"]
                row.machine_name = candidate["machineName"]
                row.reel_id = candidate["reelId"]
                row.reel_number = candidate["reelNumber"]
                row.job_number = candidate["jobNumber"]
                row.alert_title = candidate["alertTitle"]
                row.alert_description = candidate["alertDescription"]
                row.alert_source = candidate["alertSource"]
                row.metadata_json = candidate["metadata"]
            else:
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
            if row.issue_key in candidate_keys:
                continue
            row.alert_state = "RESOLVED"
            row.is_active = False
            row.resolved_at = now
            if not row.resolved_by:
                row.resolved_by = "system"
            if not row.resolved_comment:
                row.resolved_comment = "Condition cleared."
        session.commit()

    def _attach_active_alert_state(self, session, cards: List[Dict[str, Any]]) -> None:
        rows = session.query(StatusOverviewAlert).filter(StatusOverviewAlert.is_active.is_(True)).all()
        by_key = {row.issue_key: row for row in rows}
        for card in cards:
            row = by_key.get(card.get("issueKey"))
            if not row:
                continue
            card["alertId"] = row.id
            card["workflowBadge"] = "Being Addressed" if row.alert_state == "ACKNOWLEDGED" else "New"

    def _load_alert_sections(self, session, settings: StatusOverviewSetting, now: datetime) -> Dict[str, List[Dict[str, Any]]]:
        resolved_cutoff = now.replace(hour=0, minute=0, second=0, microsecond=0)
        new_rows = (
            session.query(StatusOverviewAlert)
            .filter(StatusOverviewAlert.is_active.is_(True))
            .filter(StatusOverviewAlert.alert_state == "NEW")
            .order_by(StatusOverviewAlert.created_at.desc())
            .all()
        )
        ack_rows = (
            session.query(StatusOverviewAlert)
            .filter(StatusOverviewAlert.is_active.is_(True))
            .filter(StatusOverviewAlert.alert_state == "ACKNOWLEDGED")
            .order_by(StatusOverviewAlert.acknowledged_at.desc(), StatusOverviewAlert.created_at.desc())
            .all()
        )
        resolved_rows = (
            session.query(StatusOverviewAlert)
            .filter(StatusOverviewAlert.alert_state == "RESOLVED")
            .filter(StatusOverviewAlert.resolved_at.isnot(None))
            .filter(StatusOverviewAlert.resolved_at >= resolved_cutoff)
            .order_by(StatusOverviewAlert.resolved_at.desc())
            .limit(24)
            .all()
        )
        return {
            "new": [self._serialize_alert(row) for row in new_rows],
            "acknowledged": [self._serialize_alert(row) for row in ack_rows],
            "resolved": [self._serialize_alert(row) for row in resolved_rows],
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

    def _bst_reel_metrics(self, reel: Reel) -> Dict[str, float]:
        window_start = reel.time_start or reel.time_end or datetime.utcnow()
        window_end = reel.time_end or reel.time_start or window_start
        phase_seconds = defaultdict(float)
        self.dashboard_live_service._accumulate_phase_seconds(phase_seconds, reel.inspection_phases or [], window_start, window_end)
        mix = self.dashboard_live_service._inspection_mix(phase_seconds)
        return {
            "activePct": mix["active_pct"],
            "inactivePct": mix["inactive_pct"],
            "learnPct": mix["learn_pct"],
            "phaseSeconds": sum(phase_seconds.values()),
        }

    def _count_bst_off_streak(self, rows: List[Dict[str, Any]], red_threshold: float) -> int:
        count = 0
        for row in rows:
            if row["metrics"]["activePct"] < red_threshold:
                count += 1
            else:
                break
        return count

    def _count_rlm_off_streak(self, rows: List[Dict[str, Any]], red_threshold: float) -> int:
        count = 0
        for row in rows:
            health = row["health"]
            density = float(health.points_per_1000_ft or 0.0)
            if int(health.monitoring_points_total or 0) == 0 or density < red_threshold:
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
            return {"reelNumber": rlm_reel.reel_id, "jobNumber": rlm_reel.job_name}
        if bst_reel:
            return {"reelNumber": bst_reel.reel_code, "jobNumber": bst_reel.order_number or bst_reel.job_name}
        if rlm_reel:
            return {"reelNumber": rlm_reel.reel_id, "jobNumber": rlm_reel.job_name}
        return {"reelNumber": None, "jobNumber": None}

    def _display_feet_value(self, bst_reel: Optional[Reel], rlm_health) -> Optional[float]:
        bst_feet = self._feet_from_bst_reel(bst_reel) if bst_reel else None
        rlm_feet = float(rlm_health.feet_total or 0.0) if rlm_health else None
        if rlm_feet and rlm_feet > 0:
            return rlm_feet
        return bst_feet

    def _display_job_name(self, bst_reel: Optional[Reel], rlm_reel: Optional[RLMReel]) -> Optional[str]:
        return (bst_reel.job_name if bst_reel and bst_reel.job_name else None) or (rlm_reel.job_name if rlm_reel else None)

    def _feet_from_bst_reel(self, reel: Optional[Reel]) -> Optional[float]:
        if not reel:
            return None
        start = self._to_float(reel.reel_start)
        end = self._to_float(reel.reel_end)
        if start is None or end is None:
            return None
        return abs(end - start)

    def _format_feet(self, value: Optional[float]) -> str:
        if value is None:
            return "--"
        return f"{value:,.0f} ft"

    def _sort_priority(self, state: str, workflow_rank: int) -> int:
        if state == "critical":
            return workflow_rank
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
