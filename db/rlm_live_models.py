from __future__ import annotations

from datetime import datetime

from sqlalchemy import (
    Boolean,
    Column,
    DateTime,
    Float,
    Integer,
    JSON,
    String,
    Text,
    UniqueConstraint,
)

from db.rlm_connection import RLMBase


class RLMLiveMachineThreshold(RLMBase):
    __tablename__ = "rlm_live_machine_thresholds"

    id = Column(Integer, primary_key=True, autoincrement=True)
    machine_id = Column(Integer, nullable=False, unique=True, index=True)
    machine_name = Column(String(100))
    enabled = Column(Boolean, nullable=False, default=True)

    min_qualifying_feet = Column(Float, nullable=False, default=300.0)
    min_feet_for_zero_monitoring = Column(Float, nullable=False, default=300.0)
    min_points_per_1000_ft_warn = Column(Float, nullable=False, default=20.0)
    min_points_per_1000_ft_critical = Column(Float, nullable=False, default=8.0)

    bad_reel_warn_oob_pct = Column(Float, nullable=False, default=2.0)
    bad_reel_critical_oob_pct = Column(Float, nullable=False, default=10.0)
    rolling_bad_feet_warn_pct = Column(Float, nullable=False, default=5.0)
    rolling_bad_feet_critical_pct = Column(Float, nullable=False, default=15.0)
    rolling_oob_warn_pct = Column(Float, nullable=False, default=2.0)
    rolling_oob_critical_pct = Column(Float, nullable=False, default=10.0)

    consecutive_bad_warn_count = Column(Integer, nullable=False, default=2)
    consecutive_bad_critical_count = Column(Integer, nullable=False, default=3)
    delta_std_warn = Column(Float, nullable=False, default=1.5)
    delta_std_critical = Column(Float, nullable=False, default=3.0)
    webspeed_range_warn = Column(Float, nullable=False, default=20.0)
    webspeed_range_critical = Column(Float, nullable=False, default=35.0)

    refresh_seconds = Column(Integer, nullable=False, default=30)
    stale_after_minutes = Column(Integer, nullable=False, default=20)
    cycle_panel_seconds = Column(Integer, nullable=False, default=8)

    updated_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    updated_by = Column(String(100))


class RLMLiveSystemConfig(RLMBase):
    __tablename__ = "rlm_live_system_config"

    id = Column(Integer, primary_key=True, autoincrement=True)
    admin_password_hash = Column(String(255), nullable=False)
    default_refresh_seconds = Column(Integer, nullable=False, default=30)
    default_cycle_panel_seconds = Column(Integer, nullable=False, default=8)
    updated_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    updated_by = Column(String(100))


class RLMLiveScanState(RLMBase):
    __tablename__ = "rlm_live_scan_state"

    id = Column(Integer, primary_key=True, autoincrement=True)
    last_reel_db_id = Column(Integer)
    last_checked_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    updated_at = Column(DateTime, default=datetime.utcnow, nullable=False, onupdate=datetime.utcnow)


class RLMLiveAlertEvent(RLMBase):
    __tablename__ = "rlm_live_alert_events"
    __table_args__ = (
        UniqueConstraint("machine_id", "reel_db_id", "alert_type", name="uq_rlm_live_alert"),
    )

    id = Column(Integer, primary_key=True, autoincrement=True)
    machine_id = Column(Integer, nullable=False, index=True)
    machine_name = Column(String(100), nullable=False)
    reel_db_id = Column(Integer, nullable=False, index=True)
    reel_id = Column(String(64), index=True)
    job_name = Column(String(100), index=True)

    alert_type = Column(String(64), nullable=False, index=True)
    severity = Column(String(16), nullable=False, index=True)  # info | warning | critical
    status = Column(String(16), nullable=False, default="open", index=True)  # open | acknowledged | resolved
    root_cause_hint = Column(String(255))
    message = Column(Text, nullable=False)

    triggered_at = Column(DateTime, nullable=False, default=datetime.utcnow, index=True)
    production_start_dt = Column(DateTime, index=True)
    acknowledged_at = Column(DateTime)
    acknowledged_by = Column(String(100))

    feet_total = Column(Float)
    feet_bad = Column(Float)
    feet_good = Column(Float)
    bad_feet_pct = Column(Float)

    monitoring_points_total = Column(Integer)
    monitoring_points_bad = Column(Integer)
    monitoring_points_good = Column(Integer)
    oob_point_pct = Column(Float)
    points_per_1000_ft = Column(Float)

    nominal_value = Column(Float)
    err_shrink = Column(Float)
    err_expand = Column(Float)
    avg_delta = Column(Float)
    avg_abs_delta = Column(Float)
    delta_std = Column(Float)

    avg_webspeed = Column(Float)
    min_webspeed = Column(Float)
    max_webspeed = Column(Float)
    webspeed_range = Column(Float)

    event_payload = Column(JSON)


class RLMLiveAlertConfig(RLMBase):
    __tablename__ = "rlm_live_alert_config"

    id = Column(Integer, primary_key=True, autoincrement=True)
    alert_type = Column(String(64), nullable=False, unique=True, index=True)
    display_name = Column(String(100), nullable=False)
    category = Column(String(64), nullable=False)
    description = Column(String(255))
    enabled = Column(Boolean, nullable=False, default=True)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    updated_at = Column(DateTime, default=datetime.utcnow, nullable=False, onupdate=datetime.utcnow)
    updated_by = Column(String(100))
