from __future__ import annotations

from datetime import datetime, date
from decimal import Decimal

from sqlalchemy import Column, Date, DateTime, Float, ForeignKey, Integer, Numeric, String, Text
from sqlalchemy.orm import relationship

from .rlm_connection import RLMBase


class RLMMachine(RLMBase):
    __tablename__ = "machines"

    machine_id = Column(Integer, primary_key=True, autoincrement=True)
    machine_name = Column(String(100), nullable=False)
    machine_ip = Column(String(64))

    reels = relationship("RLMReel", back_populates="machine")


class SourceFile(RLMBase):
    __tablename__ = "source_files"

    source_file_id = Column(Integer, primary_key=True, autoincrement=True)
    machine_id = Column(Integer, ForeignKey("machines.machine_id"), nullable=False, index=True)
    source_zip_name = Column(String(255))
    source_url = Column(Text)
    remote_modified_at = Column(DateTime)
    status = Column(String(32))
    last_seen_at = Column(DateTime)
    downloaded_at = Column(DateTime)
    processed_at = Column(DateTime)
    reel_db_id = Column(Integer, ForeignKey("reels.reel_db_id"))
    error_message = Column(Text)

    machine = relationship("RLMMachine")
    reel = relationship("RLMReel")


class RLMReel(RLMBase):
    __tablename__ = "reels"

    reel_db_id = Column(Integer, primary_key=True, autoincrement=True)
    machine_id = Column(Integer, ForeignKey("machines.machine_id"), nullable=False, index=True)
    reel_id = Column(String(64), index=True)
    order_number = Column(String(64), index=True)
    job_name = Column(String(100), index=True)
    protversion = Column(String(32))
    format_length = Column(Numeric(10, 3))
    format_width = Column(Numeric(10, 3))
    reel_start = Column(Numeric(10, 3))
    reel_end = Column(Numeric(10, 3))
    production_start_dt = Column(DateTime, index=True)
    production_end_dt = Column(DateTime, index=True)
    production_date = Column(Date)
    source_zip_name = Column(String(255))
    source_xml_name = Column(String(255))

    machine = relationship("RLMMachine", back_populates="reels")
    phase_events = relationship("RLMPhaseEvent", back_populates="reel")
    phase_intervals = relationship("RLMPhaseInterval", back_populates="reel")
    tolerances = relationship("RLMTolerance", back_populates="reel")
    monitorings = relationship("RLMMonitoring", back_populates="reel")


class RLMPhaseEvent(RLMBase):
    __tablename__ = "rlm_phase_events"

    id = Column(Integer, primary_key=True, autoincrement=True)
    reel_db_id = Column(Integer, ForeignKey("reels.reel_db_id"), nullable=False, index=True)
    phase_name = Column(String(64))
    phase_time = Column(DateTime)
    phase_date = Column(Date)
    phase_format = Column(Numeric(10, 3))
    event_sequence = Column(Integer, index=True)

    reel = relationship("RLMReel", back_populates="phase_events")


class RLMPhaseInterval(RLMBase):
    __tablename__ = "rlm_phase_intervals"

    id = Column(Integer, primary_key=True, autoincrement=True)
    reel_db_id = Column(Integer, ForeignKey("reels.reel_db_id"), nullable=False, index=True)
    phase_name = Column(String(64))
    start_time = Column(DateTime)
    end_time = Column(DateTime)
    interval_date = Column(Date)
    start_format = Column(Numeric(10, 3))
    end_format = Column(Numeric(10, 3))
    duration_seconds = Column(Float)
    start_event_id = Column(Integer)
    end_event_id = Column(Integer)

    reel = relationship("RLMReel", back_populates="phase_intervals")


class RLMTolerance(RLMBase):
    __tablename__ = "rlm_tolerances"

    tolerance_id = Column(Integer, primary_key=True, autoincrement=True)
    reel_db_id = Column(Integer, ForeignKey("reels.reel_db_id"), nullable=False, index=True)
    tol_sequence = Column(Integer)
    tol_format = Column(Numeric(10, 3))
    tol_id = Column(String(64))
    err_shrink = Column(Numeric(10, 3))
    err_expand = Column(Numeric(10, 3))
    wrn_shrink = Column(Numeric(10, 3))
    wrn_expand = Column(Numeric(10, 3))
    nom_length = Column(Numeric(10, 3))
    tolerance_time = Column(DateTime)
    tolerance_date = Column(Date)

    reel = relationship("RLMReel", back_populates="tolerances")


class RLMMonitoring(RLMBase):
    __tablename__ = "rlm_monitorings"

    monitoring_id = Column(Integer, primary_key=True, autoincrement=True)
    reel_db_id = Column(Integer, ForeignKey("reels.reel_db_id"), nullable=False, index=True)
    monpoint_id = Column(String(64))
    monitoring_ts = Column(DateTime, index=True)
    monitoring_date = Column(Date)
    format_value = Column(Numeric(10, 3))
    curlength = Column(Numeric(10, 3))
    webspeed = Column(Numeric(10, 3))

    reel = relationship("RLMReel", back_populates="monitorings")
