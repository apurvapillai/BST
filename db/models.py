from datetime import datetime

from sqlalchemy import (
    Column,
    Integer,
    String,
    DECIMAL,
    DateTime,
    ForeignKey,
    Boolean,
    Text,
    JSON,
)
from sqlalchemy.orm import relationship
from db.connection import Base


# -----------------------
# Machine
# -----------------------
class Machine(Base):
    __tablename__ = "machines"

    machine_id = Column(Integer, primary_key=True, autoincrement=True)
    name = Column(String(100), nullable=False)
    location = Column(String(100))
    description = Column(String(255))

    reels = relationship("Reel", back_populates="machine", cascade="all, delete-orphan")


# -----------------------
# Reel
# -----------------------
class Reel(Base):
    __tablename__ = "reels"

    reel_id = Column(Integer, primary_key=True, autoincrement=True)
    machine_id = Column(Integer, ForeignKey("machines.machine_id", ondelete="CASCADE"), index=True)

    # New identifiers
    reel_code = Column(String(50), index=True)
    order_number = Column(String(50), index=True)
    job_name = Column(String(100), index=True)
    classification = Column(String(32), index=True, default="active")

    reel_start = Column(DECIMAL(10, 2))
    reel_end = Column(DECIMAL(10, 2))

    time_start = Column(DateTime, index=True)
    time_end = Column(DateTime, index=True)

    # Removed: inspection_state (now modeled in InspectionPhase)
    format_length = Column(DECIMAL(10, 2))
    format_width = Column(DECIMAL(10, 2))

    # Relationships
    machine = relationship("Machine", back_populates="reels")

    sensitivity_sets = relationship("SensitivitySet", back_populates="reel", cascade="all, delete-orphan")
    defects = relationship("Defect", back_populates="reel", cascade="all, delete-orphan")

    reference_images = relationship("ReferenceImage", back_populates="reel", cascade="all, delete-orphan")
    inspection_phases = relationship("InspectionPhase", back_populates="reel", cascade="all, delete-orphan")
    masks = relationship("Mask", back_populates="reel", cascade="all, delete-orphan")

    rlm_config = relationship("RLMConfig", back_populates="reel", uselist=False, cascade="all, delete-orphan")
    rlm_phases = relationship("RLMPhase", back_populates="reel", cascade="all, delete-orphan")
    rlm_monitoring = relationship("RLMMonitoring", back_populates="reel", cascade="all, delete-orphan")
    reviews = relationship("ReelReview", back_populates="reel", cascade="all, delete-orphan")


# -----------------------
# SensitivitySet
# -----------------------
class SensitivitySet(Base):
    __tablename__ = "sensitivity_sets"

    set_id = Column(Integer, primary_key=True, autoincrement=True)
    reel_id = Column(Integer, ForeignKey("reels.reel_id", ondelete="CASCADE"), index=True)

    set_name = Column(String(50))
    is_standard = Column(Boolean, default=False)
    defect_class = Column(String(50))
    threshold_value = Column(DECIMAL(10, 2))
    warn_threshold = Column(DECIMAL(10, 2))

    reel = relationship("Reel", back_populates="sensitivity_sets")


# -----------------------
# Defect
# -----------------------
class Defect(Base):
    __tablename__ = "defects"

    defect_id = Column(Integer, primary_key=True, autoincrement=True)
    reel_id = Column(Integer, ForeignKey("reels.reel_id", ondelete="CASCADE"), index=True)

    class_name = Column(String(50), index=True)
    magnitude_value = Column(DECIMAL(10, 2))
    severity_value = Column(DECIMAL(10, 2))
    defect_time = Column(DateTime, index=True)
    format_position = Column(DECIMAL(10, 2))
    image_src = Column(String(255))
    coords_json = Column(JSON)
    qc_decision = Column(String(16), index=True)
    defect_category = Column(String(64))
    severity_score = Column(Integer)
    severity_confidence = Column(Integer)
    severity_uncertain = Column(Boolean, default=False)

    reel = relationship("Reel", back_populates="defects")


# -----------------------
# ReferenceImage
# -----------------------
class ReferenceImage(Base):
    __tablename__ = "reference_images"

    ref_image_id = Column(Integer, primary_key=True, autoincrement=True)
    reel_id = Column(Integer, ForeignKey("reels.reel_id", ondelete="CASCADE"), index=True)

    filename = Column(String(255))
    image_src = Column(String(255))

    reel = relationship("Reel", back_populates="reference_images")


# -----------------------
# InspectionPhase
# -----------------------
class InspectionPhase(Base):
    __tablename__ = "inspection_phases"

    phase_id = Column(Integer, primary_key=True, autoincrement=True)
    reel_id = Column(Integer, ForeignKey("reels.reel_id", ondelete="CASCADE"), index=True)

    phase = Column(String(32), index=True)
    start_time = Column(DateTime, index=True)
    end_time = Column(DateTime, index=True)
    start_format = Column(DECIMAL(10, 2))
    end_format = Column(DECIMAL(10, 2))
    refimgid = Column(String(64))

    reel = relationship("Reel", back_populates="inspection_phases")


# -----------------------
# Mask
# -----------------------
class Mask(Base):
    __tablename__ = "masks"

    mask_id = Column(Integer, primary_key=True, autoincrement=True)
    reel_id = Column(Integer, ForeignKey("reels.reel_id", ondelete="CASCADE"), index=True)

    xml_id = Column(String(64))
    sensitivitysetid = Column(String(64))
    noinspection = Column(Boolean, default=False)
    coords = Column(Text)
    timestamp = Column(DateTime, index=True)
    format_value = Column(DECIMAL(10, 2))

    reel = relationship("Reel", back_populates="masks")


# -----------------------
# RLMConfig
# -----------------------
class RLMConfig(Base):
    __tablename__ = "rlm_configs"

    config_id = Column(Integer, primary_key=True, autoincrement=True)
    reel_id = Column(Integer, ForeignKey("reels.reel_id", ondelete="CASCADE"), unique=True)

    config_json = Column(JSON)

    reel = relationship("Reel", back_populates="rlm_config")


# -----------------------
# RLMPhase
# -----------------------
class RLMPhase(Base):
    __tablename__ = "rlm_phases"

    rlm_phase_id = Column(Integer, primary_key=True, autoincrement=True)
    reel_id = Column(Integer, ForeignKey("reels.reel_id", ondelete="CASCADE"), index=True)

    phase = Column(String(32), index=True)
    start_time = Column(DateTime, index=True)
    end_time = Column(DateTime, index=True)
    start_format = Column(DECIMAL(10, 2))
    end_format = Column(DECIMAL(10, 2))

    reel = relationship("Reel", back_populates="rlm_phases")


# -----------------------
# RLMMonitoring
# -----------------------
class RLMMonitoring(Base):
    __tablename__ = "rlm_monitoring"

    monitor_id = Column(Integer, primary_key=True, autoincrement=True)
    reel_id = Column(Integer, ForeignKey("reels.reel_id", ondelete="CASCADE"), index=True)

    timestamp = Column(DateTime, index=True)
    curlength = Column(DECIMAL(10, 3))
    webspeed = Column(DECIMAL(10, 3))

    reel = relationship("Reel", back_populates="rlm_monitoring")


# -----------------------
# ReelReview
# -----------------------
class ReelReview(Base):
    __tablename__ = "reel_reviews"

    review_id = Column(Integer, primary_key=True, autoincrement=True)
    reel_id = Column(Integer, ForeignKey("reels.reel_id", ondelete="CASCADE"), index=True, nullable=True)
    reel_code = Column(String(50), index=True, nullable=False)
    decision = Column(String(16), nullable=False)
    reviewer_id = Column(String(100), nullable=False)
    comments = Column(Text)
    extra_data = Column(JSON)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow, nullable=False)

    reel = relationship("Reel", back_populates="reviews")


# -----------------------
# HeatmapRegion
# -----------------------
class HeatmapRegion(Base):
    __tablename__ = "heatmap_regions"

    region_id = Column(Integer, primary_key=True, autoincrement=True)
    job_name = Column(String(100), nullable=False, index=True)
    machine_id = Column(Integer, ForeignKey("machines.machine_id", ondelete="SET NULL"), nullable=True, index=True)
    weight_pct = Column(Integer, nullable=False)
    x0 = Column(DECIMAL(10, 6), nullable=False)
    y0 = Column(DECIMAL(10, 6), nullable=False)
    x1 = Column(DECIMAL(10, 6), nullable=False)
    y1 = Column(DECIMAL(10, 6), nullable=False)
    coords_json = Column(JSON)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow, nullable=False)

    machine = relationship("Machine")


# -----------------------
# BSTLiveAlertEvent
# -----------------------
class BSTLiveAlertEvent(Base):
    __tablename__ = "bst_live_alert_events"

    alert_event_id = Column(Integer, primary_key=True, autoincrement=True)
    alert_key = Column(String(255), unique=True, nullable=False, index=True)
    alert_type = Column(String(64), nullable=False, index=True)
    severity = Column(String(32), nullable=False, index=True)
    status = Column(String(32), nullable=False, index=True, default="active")

    machine_id = Column(Integer, ForeignKey("machines.machine_id"), nullable=True, index=True)
    reel_id = Column(Integer, ForeignKey("reels.reel_id"), nullable=True, index=True)
    defect_id = Column(Integer, ForeignKey("defects.defect_id"), nullable=True, index=True)

    machine_name = Column(String(100))
    reel_code = Column(String(64))
    job_name = Column(String(100))
    order_number = Column(String(64))

    title = Column(String(255), nullable=False)
    message = Column(Text, nullable=False)
    detail_json = Column(JSON)

    first_seen_at = Column(DateTime, nullable=False, index=True)
    last_seen_at = Column(DateTime, nullable=False, index=True)
    acknowledged_at = Column(DateTime, nullable=True, index=True)
    acknowledged_by = Column(String(100))
    resolved_at = Column(DateTime, nullable=True, index=True)

    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow, nullable=False)


# -----------------------
# BSTLiveAlertThreshold
# -----------------------
class BSTLiveAlertThreshold(Base):
    __tablename__ = "bst_live_alert_thresholds"

    threshold_id = Column(Integer, primary_key=True, autoincrement=True)
    machine_id = Column(Integer, ForeignKey("machines.machine_id"), nullable=True, unique=True)
    is_enabled = Column(Boolean, default=True, nullable=False)

    no_recent_data_minutes = Column(Integer)
    inspection_off_running_minutes = Column(Integer)
    defect_spike_15_min_threshold = Column(Integer)
    defect_spike_60_min_threshold = Column(Integer)
    high_learn_minutes = Column(Integer)
    review_backlog_reels_threshold = Column(Integer)

    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow, nullable=False)
