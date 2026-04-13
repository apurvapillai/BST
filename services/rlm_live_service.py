from __future__ import annotations

import logging
from collections import defaultdict
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from math import sqrt
from typing import Dict, Iterable, List, Optional, Set, Tuple

from sqlalchemy import func
from werkzeug.security import check_password_hash
from zoneinfo import ZoneInfo

from db.rlm_connection import RLMSessionLocal, rlm_engine
from db.rlm_models import RLMMachine, RLMMonitoring, RLMReel, RLMTolerance
from db.rlm_live_models import (
    RLMLiveAlertEvent,
    RLMLiveAlertConfig,
    RLMLiveMachineThreshold,
    RLMLiveScanState,
    RLMLiveSystemConfig,
    RLMBase,
)
from services.rlm_reel_footage import compute_reel_feet_from_range
from services.rlm_repeat_length_service import RLMRepeatLengthService

SEVERITY_ORDER = {"healthy": 0, "info": 1, "warning": 2, "critical": 3, "idle": 0, "stale": 2}
LOCAL_TIMEZONE = ZoneInfo("America/Chicago")
STATE_LABELS = {
    "healthy": "Healthy",
    "info": "Info",
    "warning": "Warning",
    "critical": "Critical",
    "idle": "Idle",
    "stale": "Recently Inactive",
}
ROLLING_WINDOW_REELS = 4
ALERT_REEL_LOOKBACK = 2
WINDOWS = {
    "1h": timedelta(hours=1),
    "6h": timedelta(hours=6),
    "12h": timedelta(hours=12),
    "24h": timedelta(hours=24),
}


@dataclass
class ReelHealth:
    machine_id: int
    machine_name: str
    reel_db_id: int
    reel_id: str
    job_name: str
    production_start: Optional[datetime]
    feet_total: float
    monitoring_points_total: int
    matched_monitoring_points: int
    unmatched_monitoring_points: int
    monitoring_points_bad: int
    monitoring_points_good: int
    oob_point_pct: float
    good_point_pct: float
    bad_feet_pct: float
    feet_bad: float
    feet_good: float
    avg_delta: Optional[float]
    avg_abs_delta: Optional[float]
    delta_std: Optional[float]
    avg_webspeed: Optional[float]
    min_webspeed: Optional[float]
    max_webspeed: Optional[float]
    webspeed_range: Optional[float]
    nominal_value: Optional[float]
    err_shrink: Optional[float]
    err_expand: Optional[float]
    points_per_1000_ft: Optional[float]
    is_qualifying_reel: bool
    is_bad_reel: bool
    has_zero_monitoring: bool
    has_low_density_warn: bool
    has_low_density_critical: bool
    webspeed_contributing: bool
    monitoring_valid: bool = True


def initialize_live_tables() -> None:
    RLMBase.metadata.create_all(
        bind=rlm_engine,
        tables=[
            RLMLiveMachineThreshold.__table__,
            RLMLiveSystemConfig.__table__,
            RLMLiveAlertEvent.__table__,
            RLMLiveScanState.__table__,
        ],
    )


class RLMLiveService:
    def __init__(self) -> None:
        self.repeat_length_service = RLMRepeatLengthService()
        initialize_live_tables()
        self.focus_window_minutes = 30
        self.logger = logging.getLogger(__name__)
        with RLMSessionLocal() as session:
            self._ensure_alert_config(session)

    def get_overview(self) -> Dict[str, object]:
        """Builds the complete payload consumed by /rlm/live.

        Payload keys:
            plantSummary: aggregate press counts + last updated time
            machineCards: per-press cards with latest reel metrics and alert counters
            activeAlerts: open RLMLiveAlertEvent rows (latest first)
            windowSummary: trailing-window stats for each machine's current job
            attentionSummary: worst presses in the recent attention window
            systemConfig: refresh / focus timing defaults
            focusPanel: ordered items that the UI rotates through for attention
        """
        start = datetime.now(timezone.utc)
        now = start
        with RLMSessionLocal() as session:
            machines = (
                session.query(RLMMachine)
                .filter(func.lower(RLMMachine.machine_name).like("press %"))
                .order_by(RLMMachine.machine_name.asc())
                .all()
            )
            thresholds = self._ensure_threshold_rows(session, machines)
            latest_reels = self._latest_reels_by_machine(session, [m.machine_id for m in machines])
            latest_reel_ids = [r.reel_db_id for r in latest_reels.values() if r]
            recent_reels = self._recent_reels_by_machine(session, [m.machine_id for m in machines], now - WINDOWS["24h"])
            recent_reel_ids = [r.reel_db_id for rows in recent_reels.values() for r in rows]
            # Compute health once for every reel we care about (latest + recent window) so downstream helpers reuse it.
            health_reel_ids = list({*latest_reel_ids, *recent_reel_ids})
            reel_health_map = self._compute_reel_health_batch(session, health_reel_ids, thresholds)
            machine_cards = []
            active_alert_rows = self._active_alerts(session)
            alert_index = self._alerts_by_machine(active_alert_rows)
            machine_lookup = {m.machine_id: m for m in machines}
            window_summary = self._build_window_summary(machine_lookup, recent_reels, thresholds, reel_health_map)
            today_rankings = self._build_today_rankings(machine_lookup, recent_reels, reel_health_map)
            aggregated_alerts = self._group_active_alerts(active_alert_rows)

            for machine in machines:
                latest_reel = latest_reels.get(machine.machine_id)
                latest_health = reel_health_map.get(latest_reel.reel_db_id) if latest_reel else None
                current_job = latest_reel.job_name if latest_reel else None
                machine_recent = [r for r in recent_reels.get(machine.machine_id, []) if (r.job_name or "") == (current_job or "")]
                card = self._build_machine_card(
                    now=now,
                    machine=machine,
                    latest_reel=latest_reel,
                    latest_health=latest_health,
                    thresholds=thresholds[machine.machine_id],
                    machine_recent=machine_recent,
                    active_alerts=alert_index.get(machine.machine_id, []),
                    health_lookup=reel_health_map,
                )
                machine_cards.append(card)

            card_order = [5, 6, 7, 8, 9, 11, 12, 13, 14, 15]
            order_index = {mid: idx for idx, mid in enumerate(card_order)}
            machine_cards.sort(key=lambda x: order_index.get(x["machineId"], len(card_order)))
            summary_counts = self._build_summary_counts(machine_cards)
            plant_summary = {
                **summary_counts,
                "lastUpdatedUtc": self._iso(now),
            }
            system_config = self._get_system_config(session)
            focus_panel = self._build_focus_panel(now, machine_cards, aggregated_alerts, today_rankings, system_config)

        payload = {
            "plantSummary": plant_summary,
            "machineCards": machine_cards,
            "activeAlerts": aggregated_alerts,
            "windowSummary": window_summary,
            "attentionSummary": today_rankings,
            "trendSignals": self._build_trend_signals(window_summary),
            "systemConfig": {
                "refreshSeconds": system_config.default_refresh_seconds,
                "cyclePanelSeconds": system_config.default_cycle_panel_seconds,
            },
            "focusPanel": focus_panel,
        }
        duration_ms = int((datetime.now(timezone.utc) - start).total_seconds() * 1000)
        self.logger.info(
            "overview.duration",
            extra={
                "duration_ms": duration_ms,
                "machine_count": len(machine_cards),
                "active_alert_groups": len(aggregated_alerts),
            },
        )
        return payload

    def get_alert_history(self, machine_id: Optional[int] = None, limit: int = 200) -> List[Dict[str, object]]:
        with RLMSessionLocal() as session:
            query = session.query(RLMLiveAlertEvent).order_by(RLMLiveAlertEvent.triggered_at.desc())
            if machine_id:
                query = query.filter(RLMLiveAlertEvent.machine_id == machine_id)
            rows = query.limit(limit).all()
            return [self._serialize_alert(row) for row in rows]

    def acknowledge_alert(self, alert_id: int, acknowledged_by: str) -> bool:
        with RLMSessionLocal() as session:
            alert = session.query(RLMLiveAlertEvent).filter(RLMLiveAlertEvent.id == alert_id).first()
            if not alert:
                return False
            alert.status = "acknowledged"
            alert.acknowledged_at = datetime.now(timezone.utc)
            alert.acknowledged_by = acknowledged_by
            session.commit()
            return True

    def acknowledge_alerts_bulk(self, alert_ids: List[int], acknowledged_by: str) -> int:
        clean_ids = self._clean_id_list(alert_ids)
        if not clean_ids:
            raise ValueError("No valid alert IDs provided")
        with RLMSessionLocal() as session:
            rows = (
                session.query(RLMLiveAlertEvent)
                .filter(RLMLiveAlertEvent.id.in_(clean_ids))
                .filter(RLMLiveAlertEvent.status == "open")
                .all()
            )
            if not rows:
                return 0
            for alert in rows:
                alert.status = "acknowledged"
                alert.acknowledged_at = datetime.now(timezone.utc)
                alert.acknowledged_by = acknowledged_by
            session.commit()
            return len(rows)

    def acknowledge_all_alerts(
        self,
        password: str,
        machine_id: Optional[int],
        severity: Optional[str],
        alert_ids: Optional[List[int]],
        acknowledged_by: str = "bulk",
    ) -> Tuple[bool, str, int]:
        with RLMSessionLocal() as session:
            config = self._get_system_config(session)
            if not check_password_hash(config.admin_password_hash, password):
                return False, "Invalid password", 0
            query = session.query(RLMLiveAlertEvent).filter(RLMLiveAlertEvent.status == "open")
            ids = self._clean_id_list(alert_ids)
            if alert_ids and not ids:
                return False, "No valid alert IDs provided", 0
            if ids:
                query = query.filter(RLMLiveAlertEvent.id.in_(ids))
            else:
                if machine_id:
                    query = query.filter(RLMLiveAlertEvent.machine_id == machine_id)
                if severity:
                    query = query.filter(RLMLiveAlertEvent.severity == severity)
            count = 0
            rows = query.all()
            if not rows:
                return False, "No open alerts matched the selection", 0
            for alert in rows:
                alert.status = "acknowledged"
                alert.acknowledged_at = datetime.now(timezone.utc)
                alert.acknowledged_by = acknowledged_by
                count += 1
            session.commit()
            return True, f"Acknowledged {count} alerts.", count

    def get_thresholds(self) -> Dict[str, object]:
        with RLMSessionLocal() as session:
            rows = session.query(RLMLiveMachineThreshold).order_by(RLMLiveMachineThreshold.machine_name.asc()).all()
            machines = []
            seen_ids = set()
            for row in rows:
                if row.machine_id in seen_ids:
                    continue
                seen_ids.add(row.machine_id)
                machines.append(self._serialize_threshold(row))
            config = self._get_system_config(session)
            return {
                "machines": machines,
                "system": {
                    "refreshSeconds": config.default_refresh_seconds,
                    "cyclePanelSeconds": config.default_cycle_panel_seconds,
                },
            }

    def update_thresholds(
        self,
        password: str,
        machine_id: int,
        values: Dict[str, object],
        updated_by: str,
    ) -> Tuple[bool, str]:
        with RLMSessionLocal() as session:
            config = self._get_system_config(session)
            if not check_password_hash(config.admin_password_hash, password):
                return False, "Invalid password"
            query = session.query(RLMLiveMachineThreshold)
            target_rows: List[RLMLiveMachineThreshold]
            if machine_id == 0:
                target_rows = query.all()
                if not target_rows:
                    return False, "No machine thresholds to update"
            else:
                row = query.filter(RLMLiveMachineThreshold.machine_id == machine_id).first()
                if not row:
                    return False, "Machine threshold row not found"
                target_rows = [row]
            allowed = {
                "enabled",
                "min_qualifying_feet",
                "min_feet_for_zero_monitoring",
                "min_points_per_1000_ft_warn",
                "min_points_per_1000_ft_critical",
                "bad_reel_warn_oob_pct",
                "bad_reel_critical_oob_pct",
                "rolling_bad_feet_warn_pct",
                "rolling_bad_feet_critical_pct",
                "rolling_oob_warn_pct",
                "rolling_oob_critical_pct",
                "consecutive_bad_warn_count",
                "consecutive_bad_critical_count",
                "delta_std_warn",
                "delta_std_critical",
                "webspeed_range_warn",
                "webspeed_range_critical",
                "refresh_seconds",
                "stale_after_minutes",
                "cycle_panel_seconds",
            }
            updated = 0
            for row in target_rows:
                changed = False
                for key, value in values.items():
                    if key in allowed:
                        setattr(row, key, value)
                        changed = True
                if changed:
                    row.updated_at = datetime.utcnow()
                    row.updated_by = updated_by
                    updated += 1
            session.commit()
            if machine_id == 0:
                return True, f"Thresholds updated for {updated} machines"
            return True, "Thresholds updated"

    def run_alert_scan(self) -> Dict[str, int]:
        scan_started = datetime.now(timezone.utc)
        now = datetime.now(timezone.utc)
        created = 0
        with RLMSessionLocal() as session:
            scan_state = self._get_scan_state(session)
            latest_reel_id = session.query(func.max(RLMReel.reel_db_id)).scalar() or 0
            last_processed = scan_state.last_reel_db_id or 0
            if latest_reel_id == 0 or latest_reel_id <= last_processed:
                # No new reel data since the previous scan; simply record the check time.
                scan_state.last_checked_at = datetime.utcnow()
                session.commit()
                duration_ms = int((datetime.now(timezone.utc) - scan_started).total_seconds() * 1000)
                self.logger.info(
                    "scan.skip",
                    extra={
                        "duration_ms": duration_ms,
                        "latest_reel_id": latest_reel_id,
                        "last_processed_reel_id": last_processed,
                    },
                )
                return {"created": 0}
            machines = (
                session.query(RLMMachine)
                .filter(func.lower(RLMMachine.machine_name).like("press %"))
                .all()
            )
            thresholds = self._ensure_threshold_rows(session, machines)
            recent_reels = self._recent_reels_by_machine(session, [m.machine_id for m in machines], now - WINDOWS["24h"])
            all_reels = [r for rows in recent_reels.values() for r in rows]
            health_map = self._compute_reel_health_batch(session, [r.reel_db_id for r in all_reels], thresholds)
            alert_config = self._alert_config(session)
            machine_ids = [m.machine_id for m in machines]
            existing_keys: Set[Tuple[int, int, str]] = {
                (row.machine_id, row.reel_db_id, row.alert_type)
                for row in session.query(
                    RLMLiveAlertEvent.machine_id,
                    RLMLiveAlertEvent.reel_db_id,
                    RLMLiveAlertEvent.alert_type,
                ).filter(RLMLiveAlertEvent.machine_id.in_(machine_ids)).all()
            }

            for machine in machines:
                machine_reels = sorted(recent_reels.get(machine.machine_id, []), key=lambda x: x.production_start_dt or datetime.min)
                job_groups = defaultdict(list)
                for reel in machine_reels:
                    job_groups[reel.job_name or ""].append(reel)
                current_job = machine_reels[-1].job_name if machine_reels else ""
                current_job_reels = job_groups.get(current_job, [])
                threshold = thresholds[machine.machine_id]
                bad_streak = 0
                qualifying_history: List[ReelHealth] = []
                auto_closed = False
                process_start_idx = max(0, len(current_job_reels) - ALERT_REEL_LOOKBACK)
                for idx, reel in enumerate(current_job_reels):
                    health = health_map.get(reel.reel_db_id)
                    if not health:
                        continue
                    if health.is_qualifying_reel:
                        qualifying_history.append(health)
                    if health.is_qualifying_reel and health.is_bad_reel:
                        bad_streak += 1
                    elif health.is_qualifying_reel:
                        bad_streak = 0

                    should_process = idx >= process_start_idx
                    if not should_process:
                        continue
                    events = self._events_for_reel(machine.machine_name, health, threshold, bad_streak)
                    if health.is_qualifying_reel:
                        rolling_window = qualifying_history[-ROLLING_WINDOW_REELS:]
                        events.extend(self._rolling_events(machine.machine_name, rolling_window, threshold))
                    if (
                        not auto_closed
                        and not health.is_bad_reel
                        and not health.has_zero_monitoring
                        and self._auto_close_recovered_alerts(
                            session,
                            machine_id=machine.machine_id,
                            recovery_cutoff=health.production_start,
                        )
                    ):
                        auto_closed = True
                    for alert_type, severity, message, hint in events:
                        if not alert_config.get(alert_type, True):
                            continue
                        key = (machine.machine_id, health.reel_db_id, alert_type)
                        if key in existing_keys:
                            continue
                        payload = self._build_alert_payload(health, threshold, bad_streak)
                        session.add(
                            RLMLiveAlertEvent(
                                machine_id=machine.machine_id,
                                machine_name=machine.machine_name,
                                reel_db_id=health.reel_db_id,
                                reel_id=health.reel_id,
                                job_name=health.job_name,
                                alert_type=alert_type,
                                severity=severity,
                                status="open",
                                root_cause_hint=hint,
                                message=message,
                                production_start_dt=health.production_start,
                                feet_total=health.feet_total,
                                feet_bad=health.feet_bad,
                                feet_good=health.feet_good,
                                bad_feet_pct=health.bad_feet_pct,
                                monitoring_points_total=health.monitoring_points_total,
                                monitoring_points_bad=health.monitoring_points_bad,
                                monitoring_points_good=health.monitoring_points_good,
                                oob_point_pct=health.oob_point_pct,
                                points_per_1000_ft=health.points_per_1000_ft,
                                nominal_value=health.nominal_value,
                                err_shrink=health.err_shrink,
                                err_expand=health.err_expand,
                                avg_delta=health.avg_delta,
                                avg_abs_delta=health.avg_abs_delta,
                                delta_std=health.delta_std,
                                avg_webspeed=health.avg_webspeed,
                                min_webspeed=health.min_webspeed,
                                max_webspeed=health.max_webspeed,
                                webspeed_range=health.webspeed_range,
                                event_payload=payload,
                            )
                        )
                        existing_keys.add(key)
                        created += 1
            scan_state.last_reel_db_id = latest_reel_id
            scan_state.last_checked_at = datetime.utcnow()
            session.commit()
        duration_ms = int((datetime.now(timezone.utc) - scan_started).total_seconds() * 1000)
        self.logger.info(
            "scan.complete",
            extra={
                "duration_ms": duration_ms,
                "latest_reel_id": latest_reel_id,
                "last_processed_reel_id": last_processed,
                "reels_considered": len(all_reels),
                "alerts_created": created,
            },
        )
        return {"created": created}

    def _events_for_reel(self, machine_name: str, health: ReelHealth, threshold: RLMLiveMachineThreshold, bad_streak: int) -> List[Tuple[str, str, str, str]]:
        events: List[Tuple[str, str, str, str]] = []
        # "Latest reel" refers to the newest spool regardless of length; "latest qualifying reel"
        # must meet min_qualifying_feet so alert logic only fires on meaningful footage.
        if not health.is_qualifying_reel:
            return events

        if (
            health.has_zero_monitoring
            and health.feet_total >= threshold.min_feet_for_zero_monitoring
        ):
            events.append((
                "ZERO_MONITORING",
                "critical",
                f"{machine_name} reel {health.reel_id} has 0 monitoring points on {health.feet_total:.0f} ft.",
                "Repeat length measuring may be off.",
            ))
            return events
        if health.has_low_density_critical:
            events.append((
                "LOW_MONITORING_DENSITY",
                "critical",
                f"{machine_name} reel {health.reel_id} has low monitoring density: {health.points_per_1000_ft:.1f} pts/1000ft.",
                "Instrumentation density is critically low.",
            ))
            return events
        elif health.has_low_density_warn:
            events.append((
                "LOW_MONITORING_DENSITY",
                "warning",
                f"{machine_name} reel {health.reel_id} has low monitoring density: {health.points_per_1000_ft:.1f} pts/1000ft.",
                "Instrumentation density is lower than target.",
            ))
            return events
        if not health.monitoring_valid:
            return events
        if health.is_bad_reel:
            severity = "critical" if health.oob_point_pct >= threshold.bad_reel_critical_oob_pct else "warning" if health.oob_point_pct >= threshold.bad_reel_warn_oob_pct else "info"
            events.append((
                "BAD_DELTA_REEL",
                severity,
                f"{machine_name} reel {health.reel_id} is bad with {health.monitoring_points_bad}/{health.monitoring_points_total} OOB points and {health.bad_feet_pct:.1f}% bad feet.",
                "Delta exceeded current job error band.",
            ))
        if bad_streak >= threshold.consecutive_bad_critical_count:
            events.append((
                "CONSECUTIVE_BAD_REELS",
                "critical",
                f"{machine_name} has {bad_streak} qualifying bad reels in a row on job {health.job_name}.",
                "Recurring repeat length issue on current job.",
            ))
        elif bad_streak >= threshold.consecutive_bad_warn_count:
            events.append((
                "CONSECUTIVE_BAD_REELS",
                "warning",
                f"{machine_name} has {bad_streak} qualifying bad reels in a row on job {health.job_name}.",
                "Issue is repeating across consecutive reels.",
            ))
        if health.delta_std is not None and health.delta_std >= threshold.delta_std_critical:
            events.append((
                "ROLLING_DELTA_DEVIATION",
                "critical",
                f"{machine_name} reel {health.reel_id} delta std dev is {health.delta_std:.2f} mm.",
                "Rolling delta variation is critically high.",
            ))
        elif health.delta_std is not None and health.delta_std >= threshold.delta_std_warn:
            events.append((
                "ROLLING_DELTA_DEVIATION",
                "warning",
                f"{machine_name} reel {health.reel_id} delta std dev is {health.delta_std:.2f} mm.",
                "Rolling delta variation is elevated.",
            ))
        if health.webspeed_contributing:
            sev = "warning" if (health.webspeed_range or 0.0) >= threshold.webspeed_range_warn else "info"
            events.append((
                "WEBSPEED_CONTRIBUTION",
                sev,
                f"{machine_name} reel {health.reel_id} shows webspeed range {health.webspeed_range:.2f} with unstable delta.",
                "Webspeed instability likely contributed to delta swings.",
            ))
        return events

    def _rolling_events(
        self,
        machine_name: str,
        window: List[ReelHealth],
        threshold: RLMLiveMachineThreshold,
    ) -> List[Tuple[str, str, str, str]]:
        events: List[Tuple[str, str, str, str]] = []
        if not window:
            return events
        qualifying = [h for h in window if h.is_qualifying_reel and h.monitoring_valid]
        if not qualifying:
            return events
        feet_total = sum(h.feet_total for h in qualifying)
        feet_bad = sum(h.feet_bad for h in qualifying)
        bad_pct = (feet_bad / feet_total * 100.0) if feet_total else 0.0
        points_total = sum(h.monitoring_points_total for h in qualifying)
        points_bad = sum(h.monitoring_points_bad for h in qualifying)
        oob_pct = (points_bad / points_total * 100.0) if points_total else 0.0
        reel_count = len(qualifying)

        if bad_pct >= threshold.rolling_bad_feet_critical_pct:
            events.append((
                "ROLLING_BAD_FEET",
                "critical",
                f"{machine_name} last {reel_count} qualifying reels average {bad_pct:.1f}% bad feet.",
                "Bad feet percentage trending critically high.",
            ))
        elif bad_pct >= threshold.rolling_bad_feet_warn_pct:
            events.append((
                "ROLLING_BAD_FEET",
                "warning",
                f"{machine_name} last {reel_count} qualifying reels average {bad_pct:.1f}% bad feet.",
                "Bad feet percentage trending high.",
            ))

        if oob_pct >= threshold.rolling_oob_critical_pct:
            events.append((
                "ROLLING_OOB_POINTS",
                "critical",
                f"{machine_name} last {reel_count} qualifying reels average {oob_pct:.1f}% OOB points.",
                "Out-of-bounds monitoring points remain high across reels.",
            ))
        elif oob_pct >= threshold.rolling_oob_warn_pct:
            events.append((
                "ROLLING_OOB_POINTS",
                "warning",
                f"{machine_name} last {reel_count} qualifying reels average {oob_pct:.1f}% OOB points.",
                "Out-of-bounds monitoring points increasing.",
            ))
        return events

    def _build_alert_payload(self, health: ReelHealth, threshold: RLMLiveMachineThreshold, bad_streak: int) -> Dict[str, object]:
        return {
            "reelId": health.reel_id,
            "jobName": health.job_name,
            "feetTotal": health.feet_total,
            "feetBad": health.feet_bad,
            "feetGood": health.feet_good,
            "estimatedBadFeet": health.feet_bad,
            "estimatedGoodFeet": health.feet_good,
            "badFeetPct": health.bad_feet_pct,
            "monitoringPointsTotal": health.monitoring_points_total,
            "matchedMonitoringPoints": health.matched_monitoring_points,
            "unmatchedMonitoringPoints": health.unmatched_monitoring_points,
            "monitoringPointsBad": health.monitoring_points_bad,
            "monitoringPointsGood": health.monitoring_points_good,
            "oobPointPct": health.oob_point_pct,
            "badPointPct": health.oob_point_pct,
            "goodPointPct": health.good_point_pct,
            "pointsPer1000Ft": health.points_per_1000_ft,
            "avgDelta": health.avg_delta,
            "avgAbsDelta": health.avg_abs_delta,
            "deltaStd": health.delta_std,
            "avgWebspeed": health.avg_webspeed,
            "minWebspeed": health.min_webspeed,
            "maxWebspeed": health.max_webspeed,
            "webspeedRange": health.webspeed_range,
            "nominalValue": health.nominal_value,
            "errShrink": health.err_shrink,
            "errExpand": health.err_expand,
            "badStreak": bad_streak,
            "thresholds": self._serialize_threshold(threshold),
            "monitoringValid": health.monitoring_valid,
        }

    def _build_window_summary(
        self,
        machine_lookup: Dict[int, RLMMachine],
        recent_reels: Dict[int, List[RLMReel]],
        thresholds: Dict[int, RLMLiveMachineThreshold],
        health_lookup: Dict[int, ReelHealth],
    ) -> List[Dict[str, object]]:
        out = []
        now = datetime.now(timezone.utc)
        for machine_id in sorted(machine_lookup.keys()):
            rows_for_machine = recent_reels.get(machine_id, [])
            latest_job = rows_for_machine[-1].job_name if rows_for_machine else ""
            filtered_rows = [r for r in rows_for_machine if (r.job_name or "") == (latest_job or "")]
            threshold = thresholds.get(machine_id)
            windows = {}
            for label, delta in WINDOWS.items():
                start = now - delta
                subset = []
                for r in filtered_rows:
                    prod = self._ensure_aware(r.production_start_dt)
                    health = health_lookup.get(r.reel_db_id)
                    if prod and prod >= start and health:
                        subset.append(health)
                if not subset:
                    windows[label] = {
                        "reelsRun": 0,
                        "qualifyingReels": 0,
                        "monitoredReels": 0,
                        "badReels": 0,
                        "badFeetPct": 0.0,
                        "open": False,
                        "status": "idle",
                        "statusLabel": "No activity",
                    }
                    continue
                qualifying = [x for x in subset if x.is_qualifying_reel]
                valid_quality = [x for x in qualifying if x.monitoring_valid]
                bad_reels = [x for x in valid_quality if x.is_bad_reel]
                monitored_reels = len(valid_quality)
                if not valid_quality:
                    windows[label] = {
                        "reelsRun": len(subset),
                        "qualifyingReels": len(qualifying),
                        "monitoredReels": monitored_reels,
                        "badReels": 0,
                        "badFeetPct": 0.0,
                        "open": True,
                        "badReelRate": 0.0,
                        "status": "unknown",
                        "statusLabel": "No monitoring",
                    }
                    continue
                total_feet = max(sum(x.feet_total for x in valid_quality) or 0, 1e-9)
                bad_feet_pct = round(sum(x.feet_bad for x in valid_quality) / total_feet * 100.0, 2)
                status, status_label = self._window_status(len(qualifying), monitored_reels, bad_feet_pct)
                windows[label] = {
                    "reelsRun": len(subset),
                    "qualifyingReels": len(qualifying),
                    "monitoredReels": monitored_reels,
                    "badReels": len(bad_reels),
                    "badFeetPct": bad_feet_pct,
                    "open": True,
                    "badReelRate": round((len(bad_reels) / max(len(qualifying), 1)) * 100.0, 2),
                    "status": status,
                    "statusLabel": status_label,
                }
            machine = machine_lookup.get(machine_id)
            out.append({
                "machineId": machine_id,
                "machineName": machine.machine_name if machine else f"Press {machine_id}",
                "currentJob": latest_job or "",
                "windows": windows,
            })
        return out

    def _build_focus_panel(
        self,
        now: datetime,
        machine_cards: List[Dict[str, object]],
        active_alerts: List[Dict[str, object]],
        today_rankings: Dict[str, object],
        system_config: RLMLiveSystemConfig,
    ) -> Dict[str, object]:
        cutoff = now - timedelta(minutes=self.focus_window_minutes)
        alerts_by_machine: Dict[int, List[Dict[str, object]]] = defaultdict(list)
        for alert in active_alerts:
            triggered = self._parse_iso(alert.get("triggeredAt"))
            if triggered and triggered >= cutoff:
                alerts_by_machine[alert["machineId"]].append(alert)

        machine_focus: List[Dict[str, object]] = []
        for card in machine_cards:
            machine_id = card.get("machineId")
            latest_ts = self._parse_iso(card.get("latestReel", {}).get("productionStart"))
            if latest_ts and latest_ts < cutoff and not alerts_by_machine.get(machine_id):
                continue
            summary = self._machine_focus_summary(card, alerts_by_machine.get(machine_id, []), cutoff)
            if summary:
                machine_focus.append(summary)

        machine_focus.sort(key=lambda x: (-SEVERITY_ORDER.get(x["severity"], 0), x["timestamp"] or ""))
        items = machine_focus[:3]

        if not items:
            items.append({
                "type": "info",
                "severity": "healthy",
                "title": "All presses are stable right now",
                "subtitle": "No pressing issues in the last 30 minutes.",
                "body": "Monitoring continues.",
                "timestamp": self._iso(now),
            })

        return {
            "items": items,
            "cycleSeconds": system_config.default_cycle_panel_seconds,
        }

    def _build_summary_counts(self, machine_cards: List[Dict[str, object]]) -> Dict[str, int]:
        return {
            "totalPresses": len(machine_cards),
            "criticalPresses": sum(1 for c in machine_cards if c["status"] == "critical"),
            "warningPresses": sum(1 for c in machine_cards if c["status"] == "warning"),
            "healthyPresses": sum(1 for c in machine_cards if c["status"] == "healthy"),
            "idleOrStalePresses": sum(1 for c in machine_cards if c["status"] in ("idle", "stale")),
            "zeroMonitoringPresses": sum(1 for c in machine_cards if c.get("flags", {}).get("hasZeroMonitoring")),
            "recoveredPresses": sum(1 for c in machine_cards if c.get("flags", {}).get("isRecovered")),
        }

    def _focus_alert_callout(self, alert: Dict[str, object]) -> str:
        machine = alert.get("machineName") or "Press"
        alert_type = alert.get("alertType") or ""
        payload = alert.get("payload") or {}
        reel = alert.get("reelId") or "latest reel"
        if alert_type == "ZERO_MONITORING":
            return f"{machine} has zero monitoring on {reel}"
        if alert_type == "BAD_DELTA_REEL":
            return f"{machine} is running a bad reel"
        if alert_type == "CONSECUTIVE_BAD_REELS":
            streak = payload.get("badStreak") or ""
            return f"{machine} has {streak or 'multiple'} bad reels in a row"
        if alert_type == "ROLLING_BAD_FEET":
            return f"{machine} has a rolling bad-feet issue (recent reels)"
        if alert_type == "ROLLING_OOB_POINTS":
            return f"{machine} has elevated out-of-bounds points (recent reels)"
        if alert_type == "ROLLING_DELTA_DEVIATION":
            return f"{machine} delta variation is unstable (recent reels)"
        if alert_type == "LOW_MONITORING_DENSITY":
            return f"{machine} has low monitoring density on {reel}"
        if alert_type == "WEBSPEED_CONTRIBUTION":
            return f"{machine} is unstable due to webspeed swings"
        type_label = alert_type.replace("_", " ").lower()
        return f"{machine} has an active {type_label} alert"

    def _focus_machine_callout(self, card: Dict[str, object]) -> str:
        machine = card.get("machineName") or "Press"
        message = (card.get("statusMessage") or "").strip()
        if not message:
            return f"{machine} status update"
        lower = message.lower()
        if lower.startswith("healthy"):
            return f"{machine} is healthy on the latest reel"
        if lower.startswith("no monitoring"):
            return f"{machine} has zero monitoring on the latest qualifying reel"
        if lower.startswith("recovered"):
            return f"{machine} recovered on the latest reel"
        if "bad reel" in lower:
            text = message.lower() if message and message[0].isalpha() else message
            return f"{machine} has {text}"
        return f"{machine} — {message}"

    def _machine_focus_summary(
        self,
        card: Dict[str, object],
        recent_alerts: List[Dict[str, object]],
        cutoff: datetime,
    ) -> Optional[Dict[str, object]]:
        machine_id = card.get("machineId")
        base_severity = card.get("status") or "healthy"
        latest_reel = card.get("latestReel") or {}
        latest_time = self._parse_iso(latest_reel.get("productionStart"))
        latest_display = latest_reel.get("productionStartLocal")
        metrics = card.get("metrics") or {}
        body_lines = []
        focus_timestamp = None
        alert_focus: Optional[Dict[str, object]] = None
        if recent_alerts:
            alert_focus = max(
                recent_alerts,
                key=lambda x: (
                    SEVERITY_ORDER.get(x.get("severity"), 0),
                    x.get("triggeredAt") or "",
                ),
            )
            focus_timestamp = alert_focus.get("triggeredAt")
            latest_display = alert_focus.get("triggeredAtLocal") or latest_display

        if metrics.get("consecutiveBad"):
            body_lines.append(f"{metrics['consecutiveBad']} bad reels in a row")
        if metrics.get("hasZeroMonitoring"):
            body_lines.append("Zero monitoring on latest reel")
        if metrics.get("webspeedContributing"):
            body_lines.append("Webspeed contributing to delta swings")
        if recent_alerts:
            body_lines.append(f"{len(recent_alerts)} recent alerts")
        title = f"{card.get('machineName')} needs attention" if base_severity in ("critical", "warning") else f"{card.get('machineName')} recovered"
        subtitle = card.get("statusMessage") or ""
        if not body_lines and base_severity == "healthy" and latest_time and latest_time < cutoff and not alert_focus:
            return None
        if not focus_timestamp and latest_time:
            focus_timestamp = self._iso(latest_time)
        severity = base_severity
        body_text = " · ".join(body_lines) if body_lines else "Monitoring latest reel."
        timestamp_display = latest_display
        if alert_focus:
            alert_severity = alert_focus.get("severity") or "warning"
            if SEVERITY_ORDER.get(alert_severity, 0) >= SEVERITY_ORDER.get(severity, 0):
                severity = alert_severity
            subtitle = alert_focus.get("message") or self._focus_alert_callout(alert_focus)
            body_text = self._focus_alert_callout(alert_focus)
            title = f"{card.get('machineName')} alert"
            timestamp_display = None
        return {
            "type": "machine",
            "machineId": machine_id,
            "severity": severity,
            "title": title,
            "subtitle": subtitle,
            "body": body_text,
            "timestamp": focus_timestamp,
            "timestampDisplay": timestamp_display,
        }

    def _alert_is_current(self, alert: RLMLiveAlertEvent, latest_reel: Optional[RLMReel], cutoff: datetime) -> bool:
        if latest_reel and alert.reel_db_id == latest_reel.reel_db_id:
            return True
        triggered = self._ensure_aware(alert.triggered_at)
        if triggered and triggered >= cutoff:
            return True
        return False

    def _severity_from_bad_reel(self, health: ReelHealth, threshold: RLMLiveMachineThreshold) -> str:
        if health.oob_point_pct >= threshold.bad_reel_critical_oob_pct:
            return "critical"
        if health.oob_point_pct >= threshold.bad_reel_warn_oob_pct:
            return "warning"
        return "info"

    def _build_today_rankings(
        self,
        machine_lookup: Dict[int, RLMMachine],
        recent_reels: Dict[int, List[RLMReel]],
        health_lookup: Dict[int, ReelHealth],
    ) -> Dict[str, object]:
        now = datetime.now(timezone.utc)
        window_start = now - timedelta(hours=6)
        rows = []
        for machine_id, reels in recent_reels.items():
            subset = []
            for r in reels:
                prod = self._ensure_aware(r.production_start_dt)
                health = health_lookup.get(r.reel_db_id)
                if not prod or not health:
                    continue
                if prod >= window_start:
                    subset.append(health)
            if not subset:
                continue
            bad_feet_pct = sum(x.feet_bad for x in subset) / max(sum(x.feet_total for x in subset), 1e-9) * 100.0
            rows.append({
                "machineId": machine_id,
                "machineName": subset[-1].machine_name if subset[-1].machine_name else (machine_lookup.get(machine_id).machine_name if machine_lookup.get(machine_id) else f"Press {machine_id}"),
                "badFeetPct": round(bad_feet_pct, 2),
                "badReels": sum(1 for x in subset if x.is_bad_reel),
                "deltaStd": round(self._mean([x.delta_std for x in subset if x.delta_std is not None]) or 0.0, 2),
                "zeroMonitoring": sum(1 for x in subset if x.has_zero_monitoring),
            })
        rows_sorted_bad = sorted(rows, key=lambda x: (-x["badFeetPct"], -x["badReels"], x["machineName"]))
        return {
            "worst": rows_sorted_bad[:3],
            "windowLabel": "Last 6 hours",
        }

    def _build_machine_card(
        self,
        now: datetime,
        machine: RLMMachine,
        latest_reel: Optional[RLMReel],
        latest_health: Optional[ReelHealth],
        thresholds: RLMLiveMachineThreshold,
        machine_recent: List[RLMReel],
        active_alerts: List[RLMLiveAlertEvent],
        health_lookup: Dict[int, ReelHealth],
    ) -> Dict[str, object]:
        stale_window_minutes = max(thresholds.stale_after_minutes or 0, 120)
        stale_cutoff = now - timedelta(minutes=stale_window_minutes)
        status = "idle"
        latest_start = self._ensure_aware(latest_reel.production_start_dt) if latest_reel else None
        if latest_start:
            status = "healthy"
            if latest_start < stale_cutoff:
                status = "stale"
        counts = {"info": 0, "warning": 0, "critical": 0}
        recent_cutoff = now - timedelta(minutes=stale_window_minutes)
        recent_alert_severity = "healthy"
        for alert in active_alerts:
            counts[alert.severity] = counts.get(alert.severity, 0) + 1
            if self._alert_is_current(alert, latest_reel, recent_cutoff):
                if SEVERITY_ORDER.get(alert.severity, 0) > SEVERITY_ORDER.get(recent_alert_severity, 0):
                    recent_alert_severity = alert.severity

        consecutive_bad = 0
        previous_bad = False
        if latest_reel and latest_health and machine_recent:
            # Reuse the overview health cache instead of recomputing per machine.
            machine_health = {r.reel_db_id: health_lookup.get(r.reel_db_id) for r in machine_recent if health_lookup.get(r.reel_db_id)}
            first_seen = False
            for r in reversed(machine_recent):
                h = machine_health.get(r.reel_db_id)
                if not h or not h.is_qualifying_reel or not h.monitoring_valid:
                    continue
                if not first_seen:
                    first_seen = True
                    continue
                previous_bad = h.is_bad_reel
                break
            for r in reversed(machine_recent):
                h = machine_health.get(r.reel_db_id)
                if not h or not h.is_qualifying_reel or not h.monitoring_valid:
                    continue
                if h.is_bad_reel:
                    consecutive_bad += 1
                else:
                    break

        status_message = "Idle"
        base_state = status
        is_recovered = False
        has_alert = SEVERITY_ORDER.get(recent_alert_severity, 0) > SEVERITY_ORDER.get("healthy", 0)
        is_stale = bool(latest_reel and latest_health and latest_start and latest_start < stale_cutoff)
        if not has_alert and is_stale:
            base_state = "stale"
            status_message = "No recent activity"
        elif latest_reel and latest_health:
            if not latest_health.is_qualifying_reel:
                base_state = "healthy"
                status_message = f"Make-ready / test reel (<{thresholds.min_qualifying_feet:.0f} ft)"
            elif latest_health.has_zero_monitoring:
                base_state = "critical"
                status_message = "No monitoring on latest qualifying reel"
            elif latest_health.has_low_density_warn or latest_health.has_low_density_critical:
                base_state = "warning" if latest_health.has_low_density_warn else "critical"
                points = latest_health.points_per_1000_ft or 0
                status_message = f"Low monitoring density ({points:.1f} pts/1000ft)"
            elif latest_health.is_bad_reel and consecutive_bad > 1:
                base_state = "critical" if consecutive_bad >= thresholds.consecutive_bad_critical_count else "warning"
                status_message = f"{consecutive_bad} bad reels in a row"
            elif latest_health.is_bad_reel:
                base_state = self._severity_from_bad_reel(latest_health, thresholds)
                status_message = "1 bad reel"
            elif latest_health.is_qualifying_reel and previous_bad:
                base_state = "healthy"
                is_recovered = True
                status_message = "Recovered on latest reel"
            else:
                base_state = "healthy"
                status_message = "Healthy on latest reel"
            if latest_health.is_qualifying_reel:
                if consecutive_bad >= thresholds.consecutive_bad_critical_count:
                    base_state = "critical"
                elif consecutive_bad >= thresholds.consecutive_bad_warn_count:
                    base_state = "warning"

        if SEVERITY_ORDER.get(recent_alert_severity, 0) > SEVERITY_ORDER.get(base_state, 0):
            base_state = recent_alert_severity

        status = base_state

        state_label = STATE_LABELS.get(status, status.title())
        flags = {
            "isRecovered": is_recovered,
            "hasZeroMonitoring": bool(latest_health and latest_health.has_zero_monitoring),
        }

        formatted_start = self._format_raw_timestamp(latest_reel.production_start_dt) if latest_reel else None
        iso_start = self._iso(latest_reel.production_start_dt) if latest_reel else None
        return {
            "machineId": machine.machine_id,
            "machineName": machine.machine_name,
            "status": status,
            "stateLabel": state_label,
            "severityCounts": counts,
            "statusMessage": status_message,
            "flags": flags,
            "latestReel": None if not latest_reel else {
                "reelDbId": latest_reel.reel_db_id,
                "reelId": latest_reel.reel_id,
                "jobName": latest_reel.job_name,
                "productionStart": iso_start,
                "productionStartLocal": formatted_start,
            },
            "metrics": None if not latest_health else {
                "feetTotal": latest_health.feet_total,
                "feetBad": latest_health.feet_bad,
                "feetGood": latest_health.feet_good,
                "estimatedBadFeet": latest_health.feet_bad,
                "estimatedGoodFeet": latest_health.feet_good,
                "badFeetPct": latest_health.bad_feet_pct,
                "monitoringPointsTotal": latest_health.monitoring_points_total,
                "matchedMonitoringPoints": latest_health.matched_monitoring_points,
                "unmatchedMonitoringPoints": latest_health.unmatched_monitoring_points,
                "monitoringPointsBad": latest_health.monitoring_points_bad,
                "monitoringPointsGood": latest_health.monitoring_points_good,
                "oobPointPct": latest_health.oob_point_pct,
                "badPointPct": latest_health.oob_point_pct,
                "goodPointPct": latest_health.good_point_pct,
                "pointsPer1000Ft": latest_health.points_per_1000_ft,
                "avgDelta": latest_health.avg_delta,
                "avgAbsDelta": latest_health.avg_abs_delta,
                "deltaStd": latest_health.delta_std,
                "avgWebspeed": latest_health.avg_webspeed,
                "minWebspeed": latest_health.min_webspeed,
                "maxWebspeed": latest_health.max_webspeed,
                "webspeedRange": latest_health.webspeed_range,
                "nominalValue": latest_health.nominal_value,
                "errShrink": latest_health.err_shrink,
                "errExpand": latest_health.err_expand,
                "consecutiveBad": consecutive_bad,
                "isBadReel": latest_health.is_bad_reel,
                "hasZeroMonitoring": latest_health.has_zero_monitoring,
                "lowDensity": latest_health.has_low_density_warn or latest_health.has_low_density_critical,
                "webspeedContributing": latest_health.webspeed_contributing,
            },
        }

    def _compute_reel_health_batch(self, session, reel_ids: Iterable[int], thresholds: Dict[int, RLMLiveMachineThreshold]) -> Dict[int, ReelHealth]:
        reel_ids = [int(x) for x in reel_ids if x is not None]
        if not reel_ids:
            return {}
        reels = (
            session.query(RLMReel)
            .filter(RLMReel.reel_db_id.in_(reel_ids))
            .all()
        )
        repeat_length = self.repeat_length_service.fetch_reel_batch(session, reel_ids)

        out: Dict[int, ReelHealth] = {}
        for reel in reels:
            threshold = thresholds[reel.machine_id]
            reel_repeat = repeat_length.get(reel.reel_db_id, {})
            reel_summary = self.repeat_length_service.build_reel_summary(reel, reel_repeat)
            latest_tol = reel_repeat.get("latestTolerance") or {}
            nominal = self._to_float(latest_tol.get("nominalLength"))
            err_shrink = abs(self._to_float(latest_tol.get("errShrink")) or 0.0) if latest_tol else None
            err_expand = abs(self._to_float(latest_tol.get("errExpand")) or 0.0) if latest_tol else None
            feet_total = float(reel_summary.get("feet_total") or 0.0)
            monitoring_points_total = int(reel_repeat.get("monitoringPointsTotal") or 0)
            matched_monitoring_points = int(reel_summary.get("matched_monitoring_points") or 0)
            unmatched_monitoring_points = int(reel_summary.get("unmatched_monitoring_points") or 0)
            monitoring_points_bad = int(reel_summary.get("bad_monitoring_points") or 0)
            monitoring_points_good = int(reel_summary.get("good_monitoring_points") or 0)
            oob_point_pct = float(reel_summary.get("bad_point_pct") or 0.0)
            good_point_pct = float(reel_summary.get("good_point_pct") or 0.0)
            bad_feet_pct = float(reel_summary.get("bad_point_pct") or 0.0) if matched_monitoring_points else 0.0
            feet_bad = float(reel_summary.get("estimated_bad_feet") or 0.0)
            feet_good = float(reel_summary.get("estimated_good_feet") or max(feet_total - feet_bad, 0.0))
            avg_delta = reel_repeat.get("avgDelta")
            avg_abs_delta = reel_repeat.get("avgAbsDelta")
            delta_std = reel_repeat.get("deltaStd")
            avg_webspeed = reel_repeat.get("avgWebspeed")
            min_webspeed = reel_repeat.get("minWebspeed")
            max_webspeed = reel_repeat.get("maxWebspeed")
            webspeed_range = (max_webspeed - min_webspeed) if min_webspeed is not None and max_webspeed is not None else None
            points_per_1000_ft = (monitoring_points_total / feet_total * 1000.0) if feet_total else None
            is_qualifying = feet_total >= threshold.min_qualifying_feet
            has_zero_monitoring = monitoring_points_total == 0
            density = points_per_1000_ft or 0.0
            has_low_density_critical = bool(
                points_per_1000_ft is not None
                and density < threshold.min_points_per_1000_ft_critical
            )
            has_low_density_warn = bool(
                points_per_1000_ft is not None
                and not has_low_density_critical
                and density < threshold.min_points_per_1000_ft_warn
            )
            monitoring_valid = not has_zero_monitoring and density >= threshold.min_points_per_1000_ft_warn
            # Bad-reel classification used for alerts + streaks should match configured thresholds and only apply when monitoring is valid.
            is_bad_reel = bool(
                monitoring_valid
                and feet_total >= threshold.min_qualifying_feet
                and oob_point_pct >= threshold.bad_reel_warn_oob_pct
            )
            webspeed_contributing = bool(
                is_bad_reel
                and webspeed_range is not None
                and delta_std is not None
                and webspeed_range >= threshold.webspeed_range_warn
                and delta_std >= threshold.delta_std_warn
            )
            out[reel.reel_db_id] = ReelHealth(
                machine_id=reel.machine_id,
                machine_name=reel.machine.machine_name if reel.machine else f"Press {reel.machine_id}",
                reel_db_id=reel.reel_db_id,
                reel_id=reel.reel_id or str(reel.reel_db_id),
                job_name=reel.job_name or "",
                production_start=reel.production_start_dt,
                feet_total=feet_total,
                monitoring_points_total=monitoring_points_total,
                matched_monitoring_points=matched_monitoring_points,
                unmatched_monitoring_points=unmatched_monitoring_points,
                monitoring_points_bad=monitoring_points_bad,
                monitoring_points_good=monitoring_points_good,
                oob_point_pct=round(oob_point_pct, 2),
                good_point_pct=round(good_point_pct, 2),
                bad_feet_pct=round(bad_feet_pct, 2),
                feet_bad=round(feet_bad, 2),
                feet_good=round(feet_good, 2),
                avg_delta=avg_delta,
                avg_abs_delta=avg_abs_delta,
                delta_std=delta_std,
                avg_webspeed=avg_webspeed,
                min_webspeed=min_webspeed,
                max_webspeed=max_webspeed,
                webspeed_range=webspeed_range,
                nominal_value=nominal,
                err_shrink=err_shrink,
                err_expand=err_expand,
                points_per_1000_ft=points_per_1000_ft,
                is_qualifying_reel=is_qualifying,
                is_bad_reel=is_bad_reel,
                has_zero_monitoring=has_zero_monitoring,
                has_low_density_warn=has_low_density_warn,
                has_low_density_critical=has_low_density_critical,
                webspeed_contributing=webspeed_contributing,
                monitoring_valid=monitoring_valid,
            )
        return out

    def _active_alerts(self, session) -> List[RLMLiveAlertEvent]:
        return (
            session.query(RLMLiveAlertEvent)
            .filter(RLMLiveAlertEvent.status == "open")
            .order_by(RLMLiveAlertEvent.triggered_at.desc())
            .all()
        )

    def _alerts_by_machine(self, alerts: List[RLMLiveAlertEvent]) -> Dict[int, List[RLMLiveAlertEvent]]:
        out: Dict[int, List[RLMLiveAlertEvent]] = defaultdict(list)
        for alert in alerts:
            out[alert.machine_id].append(alert)
        return out

    def _group_active_alerts(self, alerts: List[RLMLiveAlertEvent]) -> List[Dict[str, object]]:
        groups: Dict[Tuple[int, int, str], Dict[str, object]] = {}
        for alert in alerts:
            key = (alert.machine_id, alert.reel_db_id, alert.alert_type)
            entry = groups.get(key)
            payload = alert.event_payload or {}
            if entry:
                entry["alert_ids"].append(alert.id)
                entry["repeat_count"] += 1
                if SEVERITY_ORDER.get(alert.severity, 0) > SEVERITY_ORDER.get(entry["severity"], 0):
                    entry["severity"] = alert.severity
                if alert.triggered_at and (entry["triggered_at"] is None or alert.triggered_at > entry["triggered_at"]):
                    entry["triggered_at"] = alert.triggered_at
                    entry["message"] = alert.message
                    entry["payload"] = payload
            else:
                groups[key] = {
                    "machine_id": alert.machine_id,
                    "machine_name": alert.machine_name,
                    "reel_id": alert.reel_id,
                    "job_name": alert.job_name,
                    "alert_type": alert.alert_type,
                    "severity": alert.severity,
                    "triggered_at": alert.triggered_at,
                    "triggered_at_local": self._format_raw_timestamp(alert.triggered_at),
                    "message": alert.message,
                    "payload": payload,
                    "alert_ids": [alert.id],
                    "repeat_count": 1,
                }
        aggregated = []
        for entry in groups.values():
            aggregated.append({
                "machineId": entry["machine_id"],
                "machineName": entry["machine_name"],
                "reelId": entry["reel_id"],
                "jobName": entry["job_name"],
                "alertType": entry["alert_type"],
                "severity": entry["severity"],
                "triggeredAt": self._iso(entry["triggered_at"]),
                "triggeredAtLocal": entry.get("triggered_at_local"),
                "message": entry["message"],
                "payload": entry["payload"],
                "alertIds": entry["alert_ids"],
                "repeatCount": entry["repeat_count"],
            })
        aggregated.sort(key=lambda x: (-SEVERITY_ORDER.get(x["severity"], 0), x["triggeredAt"] or ""))
        return aggregated

    def _get_system_config(self, session) -> RLMLiveSystemConfig:
        row = session.query(RLMLiveSystemConfig).order_by(RLMLiveSystemConfig.id.asc()).first()
        if row:
            return row
        from werkzeug.security import generate_password_hash
        row = RLMLiveSystemConfig(admin_password_hash=generate_password_hash("123456"))
        session.add(row)
        session.commit()
        return row

    def _get_scan_state(self, session) -> RLMLiveScanState:
        state = session.query(RLMLiveScanState).order_by(RLMLiveScanState.id.asc()).first()
        if state:
            return state
        state = RLMLiveScanState()
        session.add(state)
        session.commit()
        return state

    def _ensure_threshold_rows(self, session, machines: List[RLMMachine]) -> Dict[int, RLMLiveMachineThreshold]:
        rows = {r.machine_id: r for r in session.query(RLMLiveMachineThreshold).all()}
        changed = False
        for machine in machines:
            if machine.machine_id not in rows:
                row = RLMLiveMachineThreshold(machine_id=machine.machine_id, machine_name=machine.machine_name)
                session.add(row)
                rows[machine.machine_id] = row
                changed = True
            elif rows[machine.machine_id].machine_name != machine.machine_name:
                rows[machine.machine_id].machine_name = machine.machine_name
                changed = True
        if changed:
            session.commit()
        return rows

    def _latest_reels_by_machine(self, session, machine_ids: List[int]) -> Dict[int, Optional[RLMReel]]:
        rows = (
            session.query(RLMReel)
            .filter(RLMReel.machine_id.in_(machine_ids))
            .order_by(RLMReel.machine_id.asc(), RLMReel.production_start_dt.desc())
            .all()
        )
        out: Dict[int, Optional[RLMReel]] = {m: None for m in machine_ids}
        for row in rows:
            if out[row.machine_id] is None:
                out[row.machine_id] = row
        return out

    def _recent_reels_by_machine(self, session, machine_ids: List[int], start: datetime) -> Dict[int, List[RLMReel]]:
        rows = (
            session.query(RLMReel)
            .filter(RLMReel.machine_id.in_(machine_ids))
            .filter(RLMReel.production_start_dt >= start)
            .order_by(RLMReel.machine_id.asc(), RLMReel.production_start_dt.asc())
            .all()
        )
        out: Dict[int, List[RLMReel]] = defaultdict(list)
        for row in rows:
            out[row.machine_id].append(row)
        return out

    def _serialize_alert(self, row: RLMLiveAlertEvent) -> Dict[str, object]:
        return {
            "id": row.id,
            "machineId": row.machine_id,
            "machineName": row.machine_name,
            "reelDbId": row.reel_db_id,
            "reelId": row.reel_id,
            "jobName": row.job_name,
            "alertType": row.alert_type,
            "severity": row.severity,
            "status": row.status,
            "message": row.message,
            "rootCauseHint": row.root_cause_hint,
            "triggeredAt": self._iso(row.triggered_at),
            "triggeredAtLocal": self._format_raw_timestamp(row.triggered_at),
            "acknowledgedAt": self._iso(row.acknowledged_at),
            "payload": row.event_payload or {},
        }

    def _serialize_threshold(self, row: RLMLiveMachineThreshold) -> Dict[str, object]:
        return {
            "machineId": row.machine_id,
            "machineName": row.machine_name,
            "enabled": row.enabled,
            "minQualifyingFeet": row.min_qualifying_feet,
            "minFeetForZeroMonitoring": row.min_feet_for_zero_monitoring,
            "minPointsPer1000FtWarn": row.min_points_per_1000_ft_warn,
            "minPointsPer1000FtCritical": row.min_points_per_1000_ft_critical,
            "badReelWarnOobPct": row.bad_reel_warn_oob_pct,
            "badReelCriticalOobPct": row.bad_reel_critical_oob_pct,
            "rollingBadFeetWarnPct": row.rolling_bad_feet_warn_pct,
            "rollingBadFeetCriticalPct": row.rolling_bad_feet_critical_pct,
            "rollingOobWarnPct": row.rolling_oob_warn_pct,
            "rollingOobCriticalPct": row.rolling_oob_critical_pct,
            "consecutiveBadWarnCount": row.consecutive_bad_warn_count,
            "consecutiveBadCriticalCount": row.consecutive_bad_critical_count,
            "deltaStdWarn": row.delta_std_warn,
            "deltaStdCritical": row.delta_std_critical,
            "webspeedRangeWarn": row.webspeed_range_warn,
            "webspeedRangeCritical": row.webspeed_range_critical,
            "refreshSeconds": row.refresh_seconds,
            "staleAfterMinutes": row.stale_after_minutes,
            "cyclePanelSeconds": row.cycle_panel_seconds,
        }

    def _to_float(self, value) -> Optional[float]:
        try:
            return None if value is None else float(value)
        except Exception:
            return None

    def _feet_from_reel(self, reel: RLMReel) -> float:
        feet = compute_reel_feet_from_range(reel.reel_start, reel.reel_end)
        return feet if feet is not None else 0.0

    def _mean(self, values: List[Optional[float]]) -> Optional[float]:
        vals = [v for v in values if v is not None]
        if not vals:
            return None
        return round(sum(vals) / len(vals), 3)

    def _stddev(self, values: List[float]) -> Optional[float]:
        vals = [v for v in values if v is not None]
        if len(vals) < 2:
            return None
        mean = sum(vals) / len(vals)
        return round(sqrt(sum((x - mean) ** 2 for x in vals) / len(vals)), 3)

    def _iso(self, dt: Optional[datetime]) -> Optional[str]:
        aware = self._ensure_aware(dt)
        if not aware:
            return None
        return aware.isoformat().replace("+00:00", "Z")

    def _format_raw_timestamp(self, dt: Optional[datetime]) -> Optional[str]:
        localized = self._ensure_local(dt)
        if not localized:
            return None
        try:
            return localized.strftime("%Y-%m-%d %I:%M %p").lstrip("0").replace(" 0", " ")
        except TypeError:
            return str(localized)

    def _ensure_local(self, dt: Optional[datetime]) -> Optional[datetime]:
        if not dt:
            return None
        if dt.tzinfo is None:
            localized = dt.replace(tzinfo=LOCAL_TIMEZONE)
        else:
            localized = dt.astimezone(LOCAL_TIMEZONE)
        return localized

    def _ensure_aware(self, dt: Optional[datetime]) -> Optional[datetime]:
        localized = self._ensure_local(dt)
        if not localized:
            return None
        return localized.astimezone(timezone.utc)

    def _clean_id_list(self, values: Optional[List[int]]) -> List[int]:
        out = []
        if not values:
            return out
        for val in values:
            try:
                out.append(int(val))
            except Exception:
                continue
        return out

    def _parse_iso(self, value: Optional[str]) -> Optional[datetime]:
        if not value:
            return None
        try:
            dt = datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError:
            return None
        return self._ensure_aware(dt)

    def _auto_close_recovered_alerts(
        self,
        session,
        machine_id: int,
        recovery_cutoff: Optional[datetime],
    ) -> int:
        cutoff = self._ensure_aware(recovery_cutoff)
        query = (
            session.query(RLMLiveAlertEvent)
            .filter(RLMLiveAlertEvent.machine_id == machine_id)
            .filter(RLMLiveAlertEvent.status == "open")
            .filter(RLMLiveAlertEvent.severity.in_(("info", "warning")))
        )
        if cutoff:
            query = query.filter(RLMLiveAlertEvent.triggered_at < cutoff)
        rows = query.order_by(RLMLiveAlertEvent.triggered_at.desc()).all()
        count = 0
        for alert in rows:
            alert.status = "acknowledged"
            alert.acknowledged_at = datetime.now(timezone.utc)
            alert.acknowledged_by = "auto-recovery"
            count += 1
        if count:
            session.flush()
        return count

    def _ensure_alert_config(self, session) -> None:
        defaults = {
            "BAD_DELTA_REEL": "Bad reel / repeat length alerts",
            "ZERO_MONITORING": "Zero monitoring alerts",
            "LOW_MONITORING_DENSITY": "Low monitoring density alerts",
            "ROLLING_BAD_FEET": "Rolling bad-feet alerts",
            "ROLLING_OOB_POINTS": "Rolling OOB alerts",
            "ROLLING_DELTA_DEVIATION": "Rolling delta deviation alerts",
            "CONSECUTIVE_BAD_REELS": "Consecutive bad reels",
            "WEBSPEED_CONTRIBUTION": "Webspeed contribution alerts",
        }
        existing = {row.alert_type: row for row in session.query(RLMLiveAlertConfig).all()}
        changed = False
        for alert_type, desc in defaults.items():
            if alert_type not in existing:
                session.add(
                    RLMLiveAlertConfig(
                        alert_type=alert_type,
                        display_name=self._alert_display_name(alert_type),
                        category=self._alert_category(alert_type),
                        description=desc,
                    )
                )
                changed = True
            else:
                row = existing[alert_type]
                new_display = self._alert_display_name(alert_type)
                new_cat = self._alert_category(alert_type)
                if row.description != desc or row.display_name != new_display or row.category != new_cat:
                    row.description = desc
                    row.display_name = new_display
                    row.category = new_cat
                    changed = True
        if changed:
            session.commit()

    def _alert_config(self, session) -> Dict[str, bool]:
        rows = session.query(RLMLiveAlertConfig).all()
        if not rows:
            self._ensure_alert_config(session)
            rows = session.query(RLMLiveAlertConfig).all()
        return {row.alert_type: row.enabled for row in rows}

    def _alert_display_name(self, alert_type: str) -> str:
        mapping = {
            "BAD_DELTA_REEL": "Bad Reel / Repeat Length",
            "ZERO_MONITORING": "Zero Monitoring",
            "LOW_MONITORING_DENSITY": "Low Monitoring Density",
            "ROLLING_BAD_FEET": "Rolling Bad Feet %",
            "ROLLING_OOB_POINTS": "Rolling OOB %",
            "ROLLING_DELTA_DEVIATION": "Rolling Delta Deviation",
            "CONSECUTIVE_BAD_REELS": "Consecutive Bad Reels",
            "WEBSPEED_CONTRIBUTION": "Webspeed Contribution",
        }
        return mapping.get(alert_type, alert_type)

    def _alert_category(self, alert_type: str) -> str:
        categories = {
            "BAD_DELTA_REEL": "Reel Quality / Repeat Length",
            "ZERO_MONITORING": "Monitoring / Instrumentation",
            "LOW_MONITORING_DENSITY": "Monitoring / Instrumentation",
            "ROLLING_BAD_FEET": "Rolling / Trend Alerts",
            "ROLLING_OOB_POINTS": "Rolling / Trend Alerts",
            "ROLLING_DELTA_DEVIATION": "Rolling / Trend Alerts",
            "CONSECUTIVE_BAD_REELS": "Sequence / Recurrence",
            "WEBSPEED_CONTRIBUTION": "Process / Speed",
        }
        return categories.get(alert_type, "Other")

    def _window_status(self, qualifying: int, monitored: int, bad_feet_pct: float) -> Tuple[str, str]:
        if qualifying <= 0:
            return "unknown", "No qualifying reels"
        if monitored <= 0:
            return "unknown", "No monitoring"
        if monitored < qualifying:
            return "partial", "Low coverage"
        if bad_feet_pct >= 10.0:
            return "critical", "Degrading"
        if bad_feet_pct >= 5.0:
            return "warning", "Needs attention"
        if bad_feet_pct >= 2.0:
            return "caution", "Watch"
        return "healthy", "Improving"

    def _serialize_window_reel(self, health: ReelHealth) -> Dict[str, object]:
        return {
            "reelId": health.reel_id,
            "reelDbId": health.reel_db_id,
            "jobName": health.job_name,
            "productionStart": self._iso(health.production_start),
            "productionStartLocal": self._format_raw_timestamp(health.production_start),
            "feetTotal": health.feet_total,
            "estimatedBadFeet": health.feet_bad,
            "estimatedGoodFeet": health.feet_good,
            "qualifying": health.is_qualifying_reel,
            "monitored": health.monitoring_points_total > 0,
            "monitoringPointsTotal": health.monitoring_points_total,
            "matchedMonitoringPoints": health.matched_monitoring_points,
            "unmatchedMonitoringPoints": health.unmatched_monitoring_points,
            "monitoringPointsBad": health.monitoring_points_bad,
            "monitoringPointsGood": health.monitoring_points_good,
            "badFeetPct": health.bad_feet_pct,
            "oobPointPct": health.oob_point_pct,
            "badPointPct": health.oob_point_pct,
            "goodPointPct": health.good_point_pct,
            "avgDelta": health.avg_delta,
            "deltaStd": health.delta_std,
            "hasZeroMonitoring": health.has_zero_monitoring,
            "lowDensity": health.has_low_density_warn or health.has_low_density_critical,
            "isBadReel": health.is_bad_reel,
        }

    def _build_trend_signals(self, window_summary: List[Dict[str, object]]) -> List[Dict[str, object]]:
        signals = []
        for machine in window_summary:
            windows = machine.get("windows") or {}
            win_1h = windows.get("1h") or {}
            win_6h = windows.get("6h") or {}
            win_12h = windows.get("12h") or {}
            win_24h = windows.get("24h") or {}
            if not win_1h.get("open") and not win_6h.get("open") and not win_12h.get("open"):
                continue
            bad1 = win_1h.get("badFeetPct") or 0.0
            bad6 = win_6h.get("badFeetPct") or 0.0
            bad12 = win_12h.get("badFeetPct") or 0.0
            monitored1 = win_1h.get("monitoredReels") or 0
            qualifying1 = win_1h.get("qualifyingReels") or 0
            delta1 = win_1h.get("avgDelta")
            signal = None
            score = 0.0
            detail = ""
            context = ""
            if qualifying1 > 0 and monitored1 == 0:
                signal = "lowMonitoring"
                score = 100.0
                detail = "No monitoring on qualifying reels"
                context = f"{qualifying1} qualifying · 0 monitored (1h)"
            elif qualifying1 > 0 and monitored1 < qualifying1:
                signal = "lowCoverage"
                score = 90.0
                detail = "Monitoring incomplete"
                context = f"{qualifying1} qualifying · {monitored1} monitored (1h)"
            elif bad1 >= bad6 + 2 and bad1 >= bad12:
                signal = "recentSpike"
                score = 80.0 + (bad1 - bad6)
                detail = "Bad feet rising"
                context = f"6h → 1h: {bad6:.1f}% → {bad1:.1f}%"
            elif bad6 > bad12 + 1:
                signal = "degrading"
                score = 70.0 + (bad6 - bad12)
                detail = "Degrading over 12h"
                context = f"12h → 6h: {bad12:.1f}% → {bad6:.1f}%"
            elif delta1 and delta1 >= (win_6h.get("avgDelta") or 0) + 0.5:
                signal = "unstable"
                score = 60.0 + delta1
                detail = "Repeat variation rising"
                context = f"Δ avg 6h → 1h: {(win_6h.get('avgDelta') or 0):.2f} → {delta1:.2f}"
            elif bad6 <= 2 and bad1 <= 2 and win_6h.get("badReels"):
                signal = "recovering"
                score = 10.0
                detail = "Improving"
                context = f"6h → 1h: {(win_6h.get('badFeetPct') or 0):.1f}% → {bad1:.1f}%"
            if signal:
                signals.append({
                    "machineId": machine["machineId"],
                    "machineName": machine["machineName"],
                    "signal": signal,
                    "score": score,
                    "detail": detail,
                    "context": context,
                    "windowLabel": "Last 6 hours",
                })
        signals.sort(key=lambda x: x["score"], reverse=True)
        return signals[:3]
    def get_window_reels(self, machine_id: int, window_label: str) -> Dict[str, object]:
        if window_label not in WINDOWS:
            raise ValueError("Unknown window label")
        now = datetime.now(timezone.utc)
        with RLMSessionLocal() as session:
            machine = session.query(RLMMachine).filter(RLMMachine.machine_id == machine_id).first()
            if not machine:
                raise LookupError("Machine not found")
            machines = [machine]
            thresholds = self._ensure_threshold_rows(session, machines)
            recent_reels = self._recent_reels_by_machine(session, [machine_id], now - WINDOWS["24h"])
            rows_for_machine = recent_reels.get(machine_id, [])
            if not rows_for_machine:
                return {
                    "machineId": machine_id,
                    "machineName": machine.machine_name,
                    "windowLabel": window_label,
                    "summary": {"reelsRun": 0, "qualifyingReels": 0, "monitoredReels": 0, "badReels": 0, "badFeetPct": 0.0},
                    "reels": [],
                }
            latest_job = rows_for_machine[-1].job_name if rows_for_machine else ""
            filtered_rows = [r for r in rows_for_machine if (r.job_name or "") == (latest_job or "")]
            health_map = self._compute_reel_health_batch(session, [r.reel_db_id for r in filtered_rows], thresholds)
            start = now - WINDOWS[window_label]
            subset = []
            for r in filtered_rows:
                prod = self._ensure_aware(r.production_start_dt)
                health = health_map.get(r.reel_db_id)
                if prod and prod >= start and health:
                    subset.append(health)
            qualifying = [x for x in subset if x.is_qualifying_reel]
            valid_quality = [x for x in qualifying if x.monitoring_valid]
            bad_reels = [x for x in valid_quality if x.is_bad_reel]
            total_feet = max(sum(x.feet_total for x in valid_quality) or 0, 1e-9)
            bad_feet_pct = round(sum(x.feet_bad for x in valid_quality) / total_feet * 100.0, 2) if valid_quality else 0.0
            status, status_label = self._window_status(len(qualifying), len(valid_quality), bad_feet_pct)
            reels_serialized = [self._serialize_window_reel(r) for r in sorted(subset, key=lambda x: x.production_start or datetime.min, reverse=True)]
            return {
                "machineId": machine_id,
                "machineName": machine.machine_name,
                "windowLabel": window_label,
                "summary": {
                    "reelsRun": len(subset),
                    "qualifyingReels": len(qualifying),
                    "monitoredReels": len(valid_quality),
                    "badReels": len(bad_reels),
                    "badFeetPct": bad_feet_pct,
                    "status": status,
                    "statusLabel": status_label,
                },
                "reels": reels_serialized,
            }
    def get_alert_config_view(self) -> Dict[str, object]:
        with RLMSessionLocal() as session:
            rows = session.query(RLMLiveAlertConfig).order_by(RLMLiveAlertConfig.category.asc(), RLMLiveAlertConfig.display_name.asc()).all()
            if not rows:
                self._ensure_alert_config(session)
                rows = session.query(RLMLiveAlertConfig).order_by(RLMLiveAlertConfig.category.asc(), RLMLiveAlertConfig.display_name.asc()).all()
            output = []
            for row in rows:
                output.append({
                    "id": row.id,
                    "alertType": row.alert_type,
                    "displayName": row.display_name,
                    "category": row.category,
                    "description": row.description,
                    "enabled": row.enabled,
                })
            return {"alerts": output}

    def update_alert_config(self, password: str, updates: List[Dict[str, object]], updated_by: str) -> Tuple[bool, str]:
        with RLMSessionLocal() as session:
            config = self._get_system_config(session)
            if not check_password_hash(config.admin_password_hash, password):
                return False, "Invalid password"
            mapping = {row.alert_type: row for row in session.query(RLMLiveAlertConfig).all()}
            changed = False
            for item in updates:
                alert_type = item.get("alertType")
                enabled = item.get("enabled")
                row = mapping.get(alert_type)
                if not row or enabled is None:
                    continue
                if bool(row.enabled) != bool(enabled):
                    row.enabled = bool(enabled)
                    row.updated_by = updated_by
                    changed = True
            if changed:
                session.commit()
            return True, "Alert settings updated" if changed else "No changes applied"
