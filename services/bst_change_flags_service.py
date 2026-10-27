from __future__ import annotations

import logging
import time
from collections import defaultdict
from datetime import datetime, timezone
from decimal import Decimal
from typing import Any, Dict, Iterable, List, Optional, Tuple
from zoneinfo import ZoneInfo

from sqlalchemy import case, func, select
from sqlalchemy.orm import selectinload

from db.connection import SessionLocal
from db.models import Defect, Machine, Mask, Reel, ReferenceImage, SensitivitySet
from db.rlm_connection import RLMSessionLocal
from db.rlm_models import RLMMachine, RLMReel, RLMTolerance
from services.rlm_reel_footage import compute_feet_per_range_unit
from services.status_overview_service import (
    BST_FEET_MULTIPLIER_DEFAULT,
    BST_FEET_MULTIPLIERS_BY_MACHINE,
    BST_OFF_ACTIVE_PCT,
    MAKE_READY_FEET_LIMIT,
    RLM_OFF_MONITORING_POINTS,
    STATUS_OVERVIEW_MACHINE_ORDER,
    make_ready_feet,
    overview_setting,
)

CENTRAL_TZ = ZoneInfo("America/Chicago")
CHANGE_FLAGS_DEFAULT_REEL_LIMIT = 40
JOB_SUMMARY_CACHE_SECONDS = 60
JOB_SUMMARY_MAX_REELS = 400
# Default make-ready length. The live value is the "makeReadyFeet" overview
# setting (make_ready_feet()), the same one used everywhere else.
JOB_SUMMARY_MIN_FEET = MAKE_READY_FEET_LIMIT
_JOB_SUMMARY_CACHE: Dict[Tuple[Any, ...], Tuple[float, Optional[Dict[str, Any]]]] = {}


def clear_job_summary_cache() -> None:
    """Forget cached job summaries (after the overview settings change)."""
    _JOB_SUMMARY_CACHE.clear()
# Finished reels never change, so their rows are kept in memory and only new
# or still-running reels are read from the database on each refresh.
#   BST: machine_id -> {reel_id: (Reel, defect_count)}
#   RLM: machine name -> {reel_db_id: {"tolerances": [...], "feet": float, "points": int}}
_JOB_BST_REEL_CACHE: Dict[Any, Dict[int, Tuple[Any, int]]] = {}
_JOB_RLM_REEL_CACHE: Dict[str, Dict[int, Dict[str, Any]]] = {}

logger = logging.getLogger(__name__)


def _to_float(value: Any) -> Optional[float]:
    if value is None:
        return None
    if isinstance(value, Decimal):
        return float(value)
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _rounded(value: Any) -> Optional[float]:
    parsed = _to_float(value)
    return round(parsed, 4) if parsed is not None else None


def _norm(value: Any) -> str:
    return str(value or "").strip().lower()


def _machine_sort_key(name: Optional[str]) -> Tuple[int, str]:
    key = _norm(name)
    try:
        return (STATUS_OVERVIEW_MACHINE_ORDER.index(key), key)
    except ValueError:
        return (999, key)


class BSTChangeFlagsService:
    def get_payload(self, reel_limit: int = CHANGE_FLAGS_DEFAULT_REEL_LIMIT) -> Dict[str, Any]:
        reel_limit = max(int(reel_limit or CHANGE_FLAGS_DEFAULT_REEL_LIMIT), 2)
        bst_rows = self._load_bst_rows(reel_limit)
        rlm_rows = self._load_rlm_rows(reel_limit)
        machine_names = sorted(set(bst_rows) | set(rlm_rows), key=_machine_sort_key)

        rows: List[Dict[str, Any]] = []
        for machine_key in machine_names:
            bst = bst_rows.get(machine_key)
            rlm = rlm_rows.get(machine_key)
            machine_name = (bst or rlm or {}).get("machineName") or machine_key.title()
            rows.append(
                {
                    "machineName": machine_name,
                    "machineId": (bst or rlm or {}).get("machineId"),
                    "displayReel": self._display_reel(bst, rlm),
                    "rlmTolerance": self._build_rlm_flag(rlm),
                    "bstSetup": self._build_bst_flag(bst),
                    "reelHistory": self._build_reel_history(bst, rlm),
                }
            )

        return {
            "generatedAt": datetime.now(timezone.utc).isoformat(),
            "rows": rows,
            "legend": [
                {"key": "changed", "label": "Changed"},
                {"key": "unchanged", "label": "No change"},
                {"key": "missing", "label": "No comparison"},
            ],
        }

    def _load_rlm_rows(self, reel_limit: int) -> Dict[str, Dict[str, Any]]:
        with RLMSessionLocal() as session:
            machines = (
                session.query(RLMMachine)
                .filter(RLMMachine.machine_name.isnot(None))
                .order_by(RLMMachine.machine_name.asc())
                .all()
            )
            machine_ids = [machine.machine_id for machine in machines]
            activity = case(
                (RLMReel.production_end_dt.is_(None), RLMReel.production_start_dt),
                else_=RLMReel.production_end_dt,
            )
            ranked = (
                select(
                    RLMReel.reel_db_id.label("reel_db_id"),
                    func.row_number().over(
                        partition_by=RLMReel.machine_id,
                        order_by=(activity.desc(), RLMReel.reel_db_id.desc()),
                    ).label("reel_rank"),
                )
                .where(RLMReel.machine_id.in_(machine_ids))
                .subquery()
            )
            reel_ids_query = select(ranked.c.reel_db_id).where(ranked.c.reel_rank <= reel_limit)
            all_reels = (
                session.query(RLMReel)
                .filter(RLMReel.reel_db_id.in_(reel_ids_query))
                .order_by(RLMReel.machine_id.asc(), activity.desc(), RLMReel.reel_db_id.desc())
                .all()
            )
            reels_by_machine: Dict[int, List[RLMReel]] = defaultdict(list)
            for reel in all_reels:
                reels_by_machine[int(reel.machine_id)].append(reel)
            tolerance_ids = [reel.reel_db_id for reel in all_reels if reel.reel_db_id is not None]
            tolerances_by_reel = self._rlm_tolerances_by_reel(session, tolerance_ids)

            out: Dict[str, Dict[str, Any]] = {}
            for machine in machines:
                reels = reels_by_machine.get(int(machine.machine_id), [])
                latest = reels[0] if reels else None
                previous = self._previous_same_rlm_job(latest, reels[1:], skip_make_ready=True) if latest else None
                machine_tolerances = {
                    int(reel.reel_db_id): tolerances_by_reel.get(int(reel.reel_db_id), [])
                    for reel in reels
                    if reel.reel_db_id is not None
                }
                out[_norm(machine.machine_name)] = {
                    "machineName": machine.machine_name,
                    "machineId": machine.machine_id,
                    "latest": latest,
                    "previous": previous,
                    "recentReels": reels,
                    "recentTolerancesByReel": machine_tolerances,
                    "tolerancesByReel": machine_tolerances,
                }
            return out

    def _load_bst_rows(self, reel_limit: int) -> Dict[str, Dict[str, Any]]:
        with SessionLocal() as session:
            machines = session.query(Machine).order_by(Machine.name.asc()).all()
            machine_ids = [machine.machine_id for machine in machines]
            activity = case((Reel.time_end.is_(None), Reel.time_start), else_=Reel.time_end)
            ranked = (
                select(
                    Reel.reel_id.label("reel_id"),
                    func.row_number().over(
                        partition_by=Reel.machine_id,
                        order_by=(activity.desc(), Reel.reel_id.desc()),
                    ).label("reel_rank"),
                )
                .where(Reel.machine_id.in_(machine_ids))
                .subquery()
            )
            reel_ids_query = select(ranked.c.reel_id).where(ranked.c.reel_rank <= reel_limit)
            all_reels = (
                session.query(Reel)
                .options(
                    selectinload(Reel.sensitivity_sets),
                    selectinload(Reel.masks),
                    selectinload(Reel.reference_images),
                    selectinload(Reel.inspection_phases),
                )
                .filter(Reel.reel_id.in_(reel_ids_query))
                .order_by(Reel.machine_id.asc(), activity.desc(), Reel.reel_id.desc())
                .all()
            )
            reels_by_machine: Dict[int, List[Reel]] = defaultdict(list)
            for reel in all_reels:
                reels_by_machine[int(reel.machine_id)].append(reel)

            out: Dict[str, Dict[str, Any]] = {}
            for machine in machines:
                reels = reels_by_machine.get(int(machine.machine_id), [])
                latest = reels[0] if reels else None
                previous = (
                    self._previous_same_bst_job(latest, reels[1:], machine.name, skip_make_ready=True)
                    if latest
                    else None
                )
                out[_norm(machine.name)] = {
                    "machineName": machine.name,
                    "machineId": machine.machine_id,
                    "latest": latest,
                    "previous": previous,
                    "recentReels": reels,
                }
            return out

    def _previous_same_rlm_job(
        self,
        latest: RLMReel,
        reels: Iterable[RLMReel],
        skip_make_ready: bool = False,
    ) -> Optional[RLMReel]:
        latest_job = (_norm(latest.order_number), _norm(latest.job_name))
        reels = list(reels)
        for position, reel in enumerate(reels):
            if (_norm(reel.order_number), _norm(reel.job_name)) != latest_job:
                continue
            if skip_make_ready and (self._is_make_ready_rlm(reel) or self._is_job_start(reel, reels[position + 1 :])):
                continue
            return reel
        return None

    def _previous_same_bst_job(
        self,
        latest: Reel,
        reels: Iterable[Reel],
        machine_name: Optional[str] = None,
        skip_make_ready: bool = False,
    ) -> Optional[Reel]:
        latest_job = (_norm(latest.order_number), _norm(latest.job_name))
        reels = list(reels)
        for position, reel in enumerate(reels):
            if (_norm(reel.order_number), _norm(reel.job_name)) != latest_job:
                continue
            if skip_make_ready and (self._is_make_ready_bst(reel, machine_name) or self._is_job_start(reel, reels[position + 1 :])):
                continue
            return reel
        return None


    def _is_job_start(self, reel: Any, older: List[Any]) -> bool:
        """First reel of a new job: the reel just before it (older[0]) has a
        different order number or job name. Unknown (False) when there is no
        older reel."""
        if reel is None or not older or older[0] is None:
            return False
        return self._is_new_job(older[0], reel)

    def _is_new_job(self, before: Any, reel: Any) -> bool:
        """True when the reel's order number or job name differs from the reel
        that ran before it (a new job can keep the same order number)."""
        if before is None or reel is None:
            return False
        for field in ("order_number", "job_name"):
            mine = _norm(getattr(reel, field, None))
            theirs = _norm(getattr(before, field, None))
            if mine and theirs and mine != theirs:
                return True
        return False

    # Make-ready / splice / sample reels are short reels. They are ignored when
    # looking for reference image, mask, sensitivity or RLM tolerance changes.
    def _is_make_ready_bst(self, reel: Optional[Reel], machine_name: Optional[str] = None) -> bool:
        feet = self._feet_from_bst_reel(reel, machine_name) if reel else None
        return feet is not None and feet < make_ready_feet()

    def _is_make_ready_rlm(self, reel: Optional[RLMReel]) -> bool:
        feet = self._feet_from_rlm_reel(reel) if reel else None
        return feet is not None and feet < make_ready_feet()

    def _rlm_tolerances_by_reel(self, session, reel_ids: List[int]) -> Dict[int, List[RLMTolerance]]:
        if not reel_ids:
            return {}
        rows = (
            session.query(RLMTolerance)
            .filter(RLMTolerance.reel_db_id.in_(reel_ids))
            .order_by(
                RLMTolerance.reel_db_id.asc(),
                RLMTolerance.tol_sequence.asc(),
                RLMTolerance.tolerance_time.asc(),
                RLMTolerance.tolerance_id.asc(),
            )
            .all()
        )
        grouped: Dict[int, List[RLMTolerance]] = defaultdict(list)
        for row in rows:
            grouped[int(row.reel_db_id)].append(row)
        return grouped

    def _display_reel(self, bst: Optional[Dict[str, Any]], rlm: Optional[Dict[str, Any]]) -> Dict[str, Any]:
        bst_reel = (bst or {}).get("latest")
        rlm_reel = (rlm or {}).get("latest")
        reel_code = (bst_reel.reel_code if bst_reel else None) or (rlm_reel.reel_id if rlm_reel else None)
        job = (bst_reel.order_number if bst_reel else None) or (rlm_reel.order_number if rlm_reel else None)
        ended = (bst_reel.time_end if bst_reel else None) or (rlm_reel.production_end_dt if rlm_reel else None)
        feet = self._feet_from_bst_reel(bst_reel, (bst or {}).get("machineName")) if bst_reel else self._feet_from_rlm_reel(rlm_reel)
        return {
            "reelCode": reel_code,
            "jobNumber": job,
            "reelContext": self._reel_explorer_context(bst_reel),
            "feet": self._format_feet(feet),
            "endedAt": ended.isoformat() if ended else None,
        }

    def _reel_explorer_context(self, reel: Optional[Reel]) -> Optional[Dict[str, Any]]:
        if not reel:
            return None
        return {
            "reelId": reel.reel_id,
            "machineId": reel.machine_id,
            "jobName": reel.job_name,
            "orderNumber": reel.order_number,
            "timeStart": reel.time_start.isoformat() if reel.time_start else None,
            "timeEnd": reel.time_end.isoformat() if reel.time_end else None,
        }

    def _feet_from_bst_reel(self, reel: Optional[Reel], machine_name: Optional[str] = None) -> Optional[float]:
        if not reel:
            return None
        start = _to_float(reel.reel_start)
        end = _to_float(reel.reel_end)
        if start is None or end is None:
            return None
        format_multiplier = compute_feet_per_range_unit(reel.format_length)
        multiplier = format_multiplier if format_multiplier is not None else float(
            BST_FEET_MULTIPLIERS_BY_MACHINE.get(_norm(machine_name), BST_FEET_MULTIPLIER_DEFAULT)
        )
        return abs(end - start) * multiplier

    def _feet_from_rlm_reel(self, reel: Optional[RLMReel]) -> Optional[float]:
        if not reel:
            return None
        start = _to_float(reel.reel_start)
        end = _to_float(reel.reel_end)
        multiplier = compute_feet_per_range_unit(reel.format_length)
        if start is None or end is None or multiplier is None:
            return None
        return abs(end - start) * multiplier

    def _format_feet(self, value: Optional[float]) -> str:
        if value is None:
            return "--"
        return f"{value:,.0f} ft"

    def _normalize_reel_token(self, value: Optional[Any]) -> str:
        return _norm(value)

    def _latest_activity(self, bst_time: Optional[datetime], rlm_time: Optional[datetime]) -> Optional[datetime]:
        if bst_time and rlm_time:
            return max(bst_time, rlm_time)
        return bst_time or rlm_time

    def _central_time(self, value: Optional[datetime]) -> Optional[datetime]:
        if not value:
            return None
        if value.tzinfo:
            return value.astimezone(CENTRAL_TZ)
        return value.replace(tzinfo=CENTRAL_TZ)

    def _bst_local_time(self, value: Optional[datetime]) -> Optional[datetime]:
        return self._central_time(value)

    def _iso_local(self, value: Optional[datetime]) -> Optional[str]:
        local = self._central_time(value)
        return local.isoformat() if local else None

    def _build_reel_history(self, bst: Optional[Dict[str, Any]], rlm: Optional[Dict[str, Any]], limit: int = 10) -> List[Dict[str, Any]]:
        machine_name = (bst or rlm or {}).get("machineName")
        all_bst_reels = list((bst or {}).get("recentReels") or [])
        bst_reels = all_bst_reels[: max(limit, 1)]
        rlm_reels = list((rlm or {}).get("recentReels") or [])
        rlm_tolerances_by_reel = (rlm or {}).get("recentTolerancesByReel") or {}
        rlm_index_by_id = {int(reel.reel_db_id): index for index, reel in enumerate(rlm_reels) if reel is not None and reel.reel_db_id is not None}

        history: List[Dict[str, Any]] = []
        for index, bst_reel in enumerate(bst_reels[:limit]):
            rlm_reel = self._match_recent_rlm_reel(bst_reel, rlm_reels)
            # Short reels and the first reel of a new job are make ready.
            is_make_ready = self._is_make_ready_bst(bst_reel, machine_name) or self._is_job_start(
                bst_reel, all_bst_reels[index + 1 :]
            )
            previous_bst = None
            previous_rlm = None
            if not is_make_ready:
                previous_bst = (
                    self._previous_same_bst_job(bst_reel, all_bst_reels[index + 1 :], machine_name, skip_make_ready=True)
                    if bst_reel
                    else None
                )
                if rlm_reel and rlm_reel.reel_db_id is not None:
                    rlm_index = rlm_index_by_id.get(int(rlm_reel.reel_db_id))
                    if rlm_index is not None:
                        previous_rlm = self._previous_same_rlm_job(
                            rlm_reel, rlm_reels[rlm_index + 1 :], skip_make_ready=True
                        )

            if is_make_ready:
                bst_changes, bst_summary = [], "Make ready reel - changes not tracked"
                rlm_changes, rlm_summary = [], "Make ready reel - changes not tracked"
            else:
                bst_changes, bst_summary = self._bst_history_tolerance_summary(previous_bst, bst_reel)
                rlm_changes, rlm_summary = self._rlm_history_tolerance_summary(previous_rlm, rlm_reel, rlm_tolerances_by_reel)
            make_ready_mask_note = (
                self._make_ready_mask_note(bst_reel, previous_bst, all_bst_reels[index + 1 :])
                if bst_reel is not None and not is_make_ready
                else ""
            )
            feet = self._feet_from_bst_reel(bst_reel, (bst or {}).get("machineName")) if bst_reel else self._feet_from_rlm_reel(rlm_reel)
            history.append(
                {
                    "label": "Current" if index == 0 else f"Prior {index}",
                    "isMakeReady": is_make_ready,
                    "reelNumber": (bst_reel.reel_code if bst_reel and bst_reel.reel_code else None) or (rlm_reel.reel_id if rlm_reel else None),
                    "jobNumber": (bst_reel.order_number or bst_reel.job_name if bst_reel else None) or (rlm_reel.job_name if rlm_reel else None),
                    "reelContext": self._reel_explorer_context(bst_reel),
                    "feet": self._format_feet(feet),
                    "timeEnd": self._iso_local(
                        self._latest_activity(
                            self._bst_local_time((bst_reel.time_end or bst_reel.time_start) if bst_reel else None),
                            self._central_time((rlm_reel.production_end_dt or rlm_reel.production_start_dt) if rlm_reel else None),
                        )
                    ),
                    "state": "alert" if bst_changes or rlm_changes else "healthy",
                    "bstState": "alert" if bst_changes else "healthy",
                    "rlmState": "alert" if rlm_changes else "healthy",
                    "bstSummary": bst_summary,
                    "rlmSummary": rlm_summary,
                    "bstDetails": bst_changes,
                    "rlmDetails": rlm_changes,
                    "makeReadyMaskNote": make_ready_mask_note,
                }
            )
        return history

    def _make_ready_mask_note(self, current: Reel, previous: Optional[Reel], older_reels: List[Reel]) -> str:
        """e.g. "1 mask applied during make ready (r12)" for masks changed between
        the previous production reel and this one. Not counted as a change here."""
        if previous is None:
            return ""
        events = self._mask_events(previous, current).get("makeReady") or {}
        applied = len(events.get("applied") or [])
        removed = len(events.get("removed") or [])
        if not applied and not removed:
            return ""
        codes = []
        for reel in older_reels:
            if reel is previous or getattr(reel, "reel_id", None) == getattr(previous, "reel_id", None):
                break
            if getattr(reel, "reel_code", None):
                codes.append(str(reel.reel_code))
        parts = []
        if applied:
            parts.append(f"{applied} mask{'s' if applied != 1 else ''} applied")
        if removed:
            parts.append(f"{removed} mask{'s' if removed != 1 else ''} removed")
        where = f" ({', '.join(reversed(codes))})" if codes else ""
        return f"{' and '.join(parts)} during make ready{where}"

    def _match_recent_rlm_reel(self, bst_reel: Reel, rlm_reels: List[RLMReel]) -> Optional[RLMReel]:
        bst_code = self._normalize_reel_token(getattr(bst_reel, "reel_code", None))
        if not bst_code:
            return None
        for reel in rlm_reels:
            if self._normalize_reel_token(getattr(reel, "reel_id", None)) == bst_code:
                return reel
        return None

    def _bst_history_tolerance_summary(
        self,
        previous: Optional[Reel],
        current: Optional[Reel],
    ) -> Tuple[List[Dict[str, Any]], str]:
        if not current:
            return [], "No BST tolerance changes"
        sensitivity_changes = self._sensitivity_changes(previous.sensitivity_sets, current.sensitivity_sets) if previous else []
        mask_changes = self._mask_changes(previous, current)
        reference_switches: List[str] = []
        new_reference_images: List[ReferenceImage] = []
        # Only flag a reference change when the reel's XML lists three or more reference images.
        if self._reference_image_count(current) > 2:
            reference_switches = self._reference_switches(previous, current)
            new_reference_images = self._images_for_switches(current, reference_switches, previous)
        # R only when the reel has at least the set number of reference changes.
        if (len(reference_switches) or len(new_reference_images)) < int(overview_setting("refChangesMin")):
            reference_switches, new_reference_images = [], []
        changes: List[Dict[str, Any]] = []
        changes.extend(sensitivity_changes)
        changes.extend(mask_changes)
        if reference_switches or new_reference_images:
            changes.append(
                {
                    "label": "Reference images",
                    "summary": self._reference_change_label(len(reference_switches) or len(new_reference_images)),
                    "referenceIds": reference_switches,
                    "images": self._serialize_reference_images(new_reference_images),
                }
            )
        if not changes:
            return [], "No BST tolerance changes"
        return changes, self._history_change_summary(changes, "BST")

    def _rlm_history_tolerance_summary(
        self,
        previous: Optional[RLMReel],
        current: Optional[RLMReel],
        tolerances_by_reel: Dict[int, List[RLMTolerance]],
    ) -> Tuple[List[Dict[str, Any]], str]:
        if not current:
            return [], "No RLM tolerance changes"
        previous_rows = tolerances_by_reel.get(int(previous.reel_db_id), []) if previous and previous.reel_db_id is not None else []
        current_rows = tolerances_by_reel.get(int(current.reel_db_id), []) if current.reel_db_id is not None else []
        changes = self._rlm_tolerance_changes(previous_rows, current_rows, current)
        if not changes:
            return [], "No RLM tolerance changes"
        count = len(changes)
        return changes, f"{count} nominal change{'s' if count != 1 else ''} during this reel"

    def _history_change_summary(self, changes: List[Dict[str, Any]], prefix: str) -> str:
        if not changes:
            return f"No {prefix} tolerance changes"
        if len(changes) == 1:
            label = changes[0].get("label") or "change"
            return f"{label}: {changes[0].get('summary') or 'changed'}"
        return f"{len(changes)} {prefix} tolerance changes"

    def _reference_change_label(self, change_count: int) -> str:
        count = max(int(change_count or 0), 0)
        if count <= 0:
            return "No changes"
        return f"{count} reference image switch{'es' if count != 1 else ''}"

    # ---- Reference image identity ------------------------------------------
    # Each status entry in the XML carries refimgid="rId_27253". The number is
    # the format where that reference became active in THIS reel, so the same
    # image gets a new rId on every reel. The real identity is the image file:
    # <reference_image id="rId_27253">../image/reference/reference_16726.jpg
    # (16726 = format where the image was learned). The parser stores the rId
    # number in ReferenceImage.format, so we map refimgid -> file name here.
    def _reference_file_by_rid(self, reel: Optional[Reel]) -> Dict[str, str]:
        out: Dict[str, str] = {}
        for image in getattr(reel, "reference_images", None) or []:
            key = self._reference_key(image)
            rid = str(image.format or "").strip().lower()
            if key and rid:
                out[rid] = key
                out[f"rid_{rid}"] = key
        return out

    def _phase_reference_ids(self, reel: Optional[Reel]) -> List[str]:
        """Ordered reference image files used while the reel ran."""
        if not reel:
            return []
        files = self._reference_file_by_rid(reel)
        sequence: List[str] = []
        phases = sorted(
            list(getattr(reel, "inspection_phases", None) or []),
            key=lambda phase: phase.start_time or datetime.min,
        )
        reel_start = getattr(reel, "time_start", None)
        for phase in phases:
            raw = str(phase.refimgid or "").strip().lower()
            if not raw:
                continue
            # A status entry that ended before this reel started (e.g. the
            # "inactive" carried over from the last reel) is not this reel's ref.
            phase_end = getattr(phase, "end_time", None)
            if reel_start and phase_end and phase_end <= reel_start:
                continue
            ref = files.get(raw) or files.get(raw.split("_")[-1])
            if not ref:
                # rId not in this reel's <reference_images>: only keep the raw
                # id when the reel has no image list to map against.
                if files:
                    continue
                ref = raw
            if not sequence or sequence[-1] != ref:
                sequence.append(ref)
        return sequence

    def _reference_switches(self, previous: Optional[Reel], current: Optional[Reel]) -> List[str]:
        """Reference ids the current reel switched to: a different id than the
        previous production reel ended on, or a switch in the middle of the reel."""
        sequence = self._phase_reference_ids(current)
        if not sequence:
            return []
        previous_sequence = self._phase_reference_ids(previous)
        last = previous_sequence[-1] if previous_sequence else None
        switches: List[str] = []
        for ref in sequence:
            if last is not None and ref != last:
                switches.append(ref)
            last = ref
        return switches

    def _images_for_switches(
        self,
        current: Optional[Reel],
        switches: List[str],
        previous: Optional[Reel],
    ) -> List[ReferenceImage]:
        if not current:
            return []
        if not switches:
            # No refimgid data on either reel: fall back to file names.
            if not self._phase_reference_ids(current) and not self._phase_reference_ids(previous):
                return self._new_reference_images(previous, current) if previous else []
            return []
        images = self._ordered_reference_images(current.reference_images)
        wanted = {ref.lower() for ref in switches}
        matched = [image for image in images if self._reference_key(image) in wanted]
        return matched or images

    def _reference_key(self, row: ReferenceImage) -> str:
        # The XML rId is not stored, so identify an image by its file name
        # (e.g. reference_16726.jpg). Falls back to image_src.
        raw = str(row.filename or row.image_src or "").strip().replace("\\", "/")
        return raw.rsplit("/", 1)[-1].lower()

    def _reference_keys(self, reel: Optional[Reel]) -> set:
        if not reel:
            return set()
        return {key for key in (self._reference_key(row) for row in reel.reference_images or []) if key}

    def _reference_image_count(self, reel: Optional[Reel]) -> int:
        """Distinct reference images listed in the reel's XML (<reference_images>)."""
        if not reel:
            return 0
        return len(self._reference_keys(reel))

    def _new_reference_images(self, previous: Optional[Reel], current: Optional[Reel]) -> List[ReferenceImage]:
        # Reference images on the current reel that the previous production reel
        # of the same job did not have.
        if not previous or not current:
            return []
        previous_keys = self._reference_keys(previous)
        seen = set()
        out = []
        for row in self._ordered_reference_images(current.reference_images):
            key = self._reference_key(row)
            if not key or key in previous_keys or key in seen:
                continue
            seen.add(key)
            out.append(row)
        return out

    def _build_rlm_flag(self, rlm: Optional[Dict[str, Any]]) -> Dict[str, Any]:
        if not rlm or not rlm.get("latest"):
            return self._missing_flag("No RLM reel")
        latest = rlm["latest"]
        previous = rlm.get("previous")
        if not previous:
            return self._missing_flag("No prior RLM reel in this job", latest, None)

        grouped = rlm.get("tolerancesByReel") or {}
        current_rows = grouped.get(int(latest.reel_db_id), [])
        previous_rows = grouped.get(int(previous.reel_db_id), [])
        changes = self._rlm_tolerance_changes(previous_rows, current_rows, latest)
        return self._flag_payload(
            latest,
            previous,
            changed=bool(changes),
            changed_label=f"{len(changes)} tolerance change{'s' if len(changes) != 1 else ''}",
            unchanged_label="No tolerance changes",
            details=changes,
        )

    def _build_bst_flag(self, bst: Optional[Dict[str, Any]]) -> Dict[str, Any]:
        if not bst or not bst.get("latest"):
            return self._missing_flag("No BST reel")
        latest = bst["latest"]
        previous = bst.get("previous")
        reference_switches: List[str] = []
        new_reference_images: List[ReferenceImage] = []
        # Only flag a reference change when the reel's XML lists three or more reference images.
        if self._reference_image_count(latest) > 2:
            reference_switches = self._reference_switches(previous, latest)
            new_reference_images = self._images_for_switches(latest, reference_switches, previous)
        # R only when the reel has at least the set number of reference changes.
        if (len(reference_switches) or len(new_reference_images)) < int(overview_setting("refChangesMin")):
            reference_switches, new_reference_images = [], []
        reference_change_count = len(reference_switches) or len(new_reference_images)
        sensitivity_changes = self._sensitivity_changes(previous.sensitivity_sets, latest.sensitivity_sets) if previous else []
        mask_changes = self._mask_changes(previous, latest)

        details: List[Dict[str, Any]] = []
        details.extend(sensitivity_changes)
        details.extend(mask_changes)
        if reference_change_count:
            details.append(
                {
                    "label": "Reference images",
                    "summary": self._reference_change_label(reference_change_count),
                    "referenceIds": reference_switches,
                    "images": self._serialize_reference_images(new_reference_images),
                }
            )

        if not previous and not details:
            return self._flag_payload(
                latest,
                previous,
                changed=False,
                changed_label="Good",
                unchanged_label="Good",
                details=[],
            )

        change_count = len(sensitivity_changes) + len(mask_changes) + reference_change_count
        reference_only = bool(reference_change_count) and not sensitivity_changes and not mask_changes
        changed_label = (
            self._reference_change_label(reference_change_count)
            if reference_only or (not previous and reference_change_count)
            else f"{change_count} BST change{'s' if change_count != 1 else ''}"
        )

        return self._flag_payload(
            latest,
            previous,
            changed=bool(details),
            changed_label=changed_label,
            unchanged_label="No BST changes",
            details=details,
        )

    # ---- RLM tolerance changes ----------------------------------------------
    # A reel stores its RLM tolerance settings as a list of entries (rlm_tolerances),
    # one per time the settings were saved during the reel. A "change" is an entry
    # whose values differ from the entry before it. The first entry of a reel is
    # compared with the last entry of the previous production reel.
    # Only the nominal length counts as a tolerance change.
    _RLM_TOLERANCE_FIELDS = (
        ("nomLength", "Nominal", "nom_length"),
    )

    def _rlm_tolerance_entries(self, rows: Iterable[RLMTolerance]) -> List[Dict[str, Any]]:
        ordered = sorted(
            list(rows or []),
            key=lambda row: (
                row.tolerance_time or datetime.min,
                row.tol_sequence if row.tol_sequence is not None else 0,
                row.tolerance_id or 0,
            ),
        )
        entries = []
        for row in ordered:
            entries.append(
                {
                    "time": row.tolerance_time,
                    "format": _to_float(row.tol_format),
                    "values": {key: _rounded(getattr(row, column)) for key, _, column in self._RLM_TOLERANCE_FIELDS},
                }
            )
        return entries

    def _rlm_tolerance_diff(self, before: Dict[str, Any], after: Dict[str, Any]) -> List[Dict[str, Any]]:
        # T only when the nominal length moved by MORE than the set delta (mm).
        # Delta 0 (default) = any change.
        min_delta = float(overview_setting("rlmNominalDeltaMm"))
        fields = []
        for key, label, _ in self._RLM_TOLERANCE_FIELDS:
            old, new = before.get(key), after.get(key)
            if old is None or new is None or old == new:
                continue
            try:
                if abs(float(new) - float(old)) <= min_delta:
                    continue
            except (TypeError, ValueError):
                pass
            fields.append({"key": key, "label": label, "before": old, "after": new})
        return fields

    def _rlm_feet_into_reel(self, reel: Optional[RLMReel], tol_format: Optional[float]) -> Optional[float]:
        if reel is None or tol_format is None:
            return None
        start = _to_float(getattr(reel, "reel_start", None))
        per_unit = compute_feet_per_range_unit(getattr(reel, "format_length", None))
        if start is None or per_unit is None:
            return None
        return round(max(tol_format - start, 0.0) * per_unit, 0)

    def _rlm_tolerance_changes(
        self,
        previous_rows: Iterable[RLMTolerance],
        current_rows: Iterable[RLMTolerance],
        current_reel: Optional[RLMReel] = None,
    ) -> List[Dict[str, Any]]:
        """One dict per tolerance change made during the current reel, in order."""
        current = self._rlm_tolerance_entries(current_rows)
        if not current:
            return []
        previous = self._rlm_tolerance_entries(previous_rows)
        last_values = previous[-1]["values"] if previous else None
        start_values = dict(last_values or current[0]["values"])
        changes: List[Dict[str, Any]] = []
        for entry in current:
            if last_values is not None:
                fields = self._rlm_tolerance_diff(last_values, entry["values"])
                if fields:
                    number = len(changes) + 1
                    changes.append(
                        {
                            "label": f"Tolerance change {number}",
                            "summary": "; ".join(
                                f"{field['label']}: {self._value_label(field['before'])} to {self._value_label(field['after'])}"
                                for field in fields
                            ),
                            "rlmTolerance": True,
                            "number": number,
                            "time": self._iso_local(self._central_time(entry["time"])) if entry["time"] else None,
                            "format": entry["format"],
                            "feetIntoReel": self._rlm_feet_into_reel(current_reel, entry["format"]),
                            "fields": fields,
                            "values": dict(entry["values"]),
                        }
                    )
            last_values = entry["values"]
        if changes:
            changes[0]["reelStart"] = {
                "values": start_values,
                "time": self._iso_local(self._central_time(current[0]["time"])) if current[0]["time"] else None,
                "fromPreviousReel": bool(previous),
            }
        return changes

    def _sensitivity_changes(
        self,
        previous_rows: Iterable[SensitivitySet],
        current_rows: Iterable[SensitivitySet],
    ) -> List[Dict[str, Any]]:
        previous = self._sensitivity_map(previous_rows)
        current = self._sensitivity_map(current_rows)
        changes = []
        for defect_class in sorted(set(previous) | set(current)):
            before = previous.get(defect_class)
            after = current.get(defect_class)
            if before is None or after is None or before == after:
                continue
            changes.append(
                {
                    "label": defect_class or "Sensitivity",
                    "summary": f"Warn threshold {self._value_label(before)} to {self._value_label(after)}",
                }
            )
        return changes

    def _sensitivity_map(self, rows: Iterable[SensitivitySet]) -> Dict[str, Optional[float]]:
        out = {}
        for row in rows or []:
            if row.set_name and row.set_name != "sId_mmx_stand":
                continue
            key = str(row.defect_class or "").strip()
            if not key:
                continue
            out[key] = _rounded(row.warn_threshold)
        return out

    def _mask_signature(self, rows: Iterable[Mask]) -> Tuple[Tuple[str, str, str], ...]:
        values = []
        for row in rows or []:
            values.append(
                (
                    str(row.xml_id or "").strip(),
                    str(row.sensitivitysetid or "").strip(),
                    str(row.coords or "").strip(),
                )
            )
        return tuple(sorted(values))

    # ---- Mask changes ------------------------------------------------------
    # A mask change is counted when a mask was actually applied or removed
    # while the reel ran (mask timestamps from the XML), not by comparing mask
    # ids between reels: BST renumbers mask ids per reel file, which made one
    # real change show up as "applied 6 times".
    # The window starts where the previous production reel of the job ended,
    # so a mask applied during a skipped make-ready reel is credited to the
    # next production reel instead of being lost.
    def _coords_key(self, coords: Any) -> str:
        return " ".join(str(coords or "").split())

    def _active_mask_coords(self, reel: Optional[Reel]) -> set:
        if not reel:
            return set()
        return {self._coords_key(mask.get("coords")) for mask in self._mask_map(reel.masks).values() if mask.get("coords")}

    def _mask_events(self, previous: Optional[Reel], current: Optional[Reel]) -> Dict[str, List[Dict[str, Any]]]:
        """Mask apply/remove events that happened while the current reel ran.

        Events between the previous production reel and the start of this reel
        (i.e. during make-ready reels) are returned separately under "makeReady"
        and are NOT counted as changes on this reel, so the badge matches what
        Reel Explorer shows for the reel."""
        empty = {"applied": [], "removed": [], "makeReady": {"applied": [], "removed": []}}
        if not current:
            return empty
        reel_start = current.time_start
        reel_end = current.time_end
        gap_start = previous.time_end if previous is not None and previous.time_end else None
        previous_active = self._active_mask_coords(previous)
        current_active = self._active_mask_coords(current)
        rows = sorted(
            list(current.masks or []),
            key=lambda row: (str(getattr(row, "timestamp", None) or ""), _to_float(getattr(row, "format_value", None)) or 0.0),
        )
        window_start = reel_start or gap_start
        has_times = window_start is not None and any(getattr(row, "timestamp", None) for row in rows)

        if not has_times:
            # No timestamps to go on: fall back to comparing mask shapes.
            if previous is None:
                return empty
            added = sorted(current_active - previous_active)
            removed = sorted(previous_active - current_active)
            return {
                "applied": [{"coords": coords, "time": None} for coords in added],
                "removed": [{"coords": coords, "time": None} for coords in removed],
                "makeReady": {"applied": [], "removed": []},
            }

        def event_for(row) -> Dict[str, Any]:
            return {
                "coords": self._coords_key(row.coords),
                "time": row.timestamp.isoformat(),
                "format": _rounded(getattr(row, "format_value", None)),
            }

        # 1) Make-ready gap: after the previous production reel ended, before this reel started.
        active_at_start = set(previous_active)
        mr_applied: Dict[str, Dict[str, Any]] = {}
        mr_removed: Dict[str, Dict[str, Any]] = {}
        if reel_start is not None and gap_start is not None:
            for row in rows:
                ts = getattr(row, "timestamp", None)
                coords = self._coords_key(row.coords)
                if ts is None or not coords or ts <= gap_start or ts > reel_start:
                    continue
                if bool(getattr(row, "noinspection", False)):
                    if coords not in active_at_start:
                        mr_applied.setdefault(coords, event_for(row))
                    active_at_start.add(coords)
                else:
                    if coords in active_at_start:
                        mr_removed.setdefault(coords, event_for(row))
                    active_at_start.discard(coords)

        # 2) Events while this reel ran.
        applied: Dict[str, Dict[str, Any]] = {}
        removed: Dict[str, Dict[str, Any]] = {}
        for row in rows:
            ts = getattr(row, "timestamp", None)
            coords = self._coords_key(row.coords)
            if ts is None or not coords or ts <= window_start or (reel_end is not None and ts > reel_end):
                continue
            if bool(getattr(row, "noinspection", False)):
                # Ignore a re-listed mask that was already active when the reel started.
                if coords not in active_at_start or previous is None:
                    applied.setdefault(coords, event_for(row))
            else:
                if previous is None or coords in active_at_start or coords in applied:
                    removed.setdefault(coords, event_for(row))
        return {
            "applied": list(applied.values()),
            "removed": list(removed.values()),
            "makeReady": {"applied": list(mr_applied.values()), "removed": list(mr_removed.values())},
        }

    def _mask_event_summary(self, events: Dict[str, List[Dict[str, Any]]]) -> str:
        applied = len(events.get("applied") or [])
        removed = len(events.get("removed") or [])
        parts = []
        if applied:
            parts.append(f"{applied} mask{'s' if applied != 1 else ''} applied")
        if removed:
            parts.append(f"{removed} mask{'s' if removed != 1 else ''} removed")
        return " · ".join(parts) or "No mask changes"

    def _mask_changes(self, previous: Optional[Reel], current: Reel) -> List[Dict[str, Any]]:
        events = self._mask_events(previous, current)
        if not events["applied"] and not events["removed"]:
            return []
        # M only when at least the set number of masks were applied/removed.
        if len(events["applied"]) + len(events["removed"]) < int(overview_setting("maskChangesMin")):
            return []

        previous_map = self._mask_map(previous.masks) if previous else {}
        current_map = self._mask_map(current.masks)
        latest_current_mask = max(
            current_map.values(),
            key=lambda mask: str(mask.get("timestamp") or ""),
            default=None,
        )
        mask_format = latest_current_mask.get("format") if latest_current_mask else None
        after_image = self._reference_for_mask(current.reference_images, mask_format)
        after_payload = {
            "label": "Current",
            "reel": current.reel_code,
            "image": self._serialize_reference_image(after_image),
            "format_width": _to_float(getattr(current, "format_width", None)),
            "format_length": _to_float(getattr(current, "format_length", None)),
            "masks": [self._serialize_mask(mask, key) for key, mask in sorted(current_map.items())],
        }
        before_payload = None
        if previous is not None:
            before_image = self._reference_for_mask(previous.reference_images, mask_format)
            before_payload = {
                "label": "Initial",
                "reel": previous.reel_code,
                "image": self._serialize_reference_image(before_image),
                "format_width": _to_float(getattr(previous, "format_width", None)),
                "format_length": _to_float(getattr(previous, "format_length", None)),
                "masks": [self._serialize_mask(mask, key) for key, mask in sorted(previous_map.items())],
            }
        sequence = [before_payload, after_payload] if before_payload and before_payload["masks"] else [after_payload]
        return [
            {
                "label": (
                    "Mask applied" if events["applied"] and not events["removed"]
                    else "Mask removed" if events["removed"] and not events["applied"]
                    else "Mask changes"
                ),
                "summary": self._mask_event_summary(events),
                "maskEvents": events,
                "maskChangeCount": len(events["applied"]) + len(events["removed"]),
                "maskComparison": {
                    "before": before_payload,
                    "after": after_payload,
                    "sequence": sequence,
                },
            }
        ]

    def _mask_map(self, rows: Iterable[Mask]) -> Dict[str, Dict[str, Any]]:
        ordered = sorted(
            list(rows or []),
            key=lambda row: (
                str(getattr(row, "timestamp", None) or ""),
                _to_float(getattr(row, "format_value", None)) or float("inf"),
                getattr(row, "mask_id", None) or 0,
            ),
        )
        latest_by_signature: Dict[Tuple[str, str, str], Tuple[bool, Mask]] = {}
        for row in ordered:
            signature = (
                str(getattr(row, "xml_id", None) or "").strip(),
                str(getattr(row, "sensitivitysetid", None) or "").strip(),
                str(getattr(row, "coords", None) or "").strip(),
            )
            is_applied = not hasattr(row, "noinspection") or bool(getattr(row, "noinspection", False))
            latest_by_signature[signature] = (is_applied, row)

        out = {}
        for index, (signature, (_, row)) in enumerate(
            ((signature, event) for signature, event in latest_by_signature.items() if event[0]),
            start=1,
        ):
            xml_id, sensitivity_id, coords = signature
            key = "|".join(signature) or f"mask-{index}"
            timestamp = getattr(row, "timestamp", None)
            out[key] = {
                "id": getattr(row, "mask_id", None),
                "xmlId": xml_id,
                "sensitivityId": sensitivity_id,
                "coords": coords,
                "format": _rounded(getattr(row, "format_value", None)),
                "timestamp": timestamp.isoformat() if timestamp else None,
            }
        return out

    def _first_mask_format(self, masks: Iterable[Optional[Dict[str, Any]]]) -> Optional[float]:
        for mask in masks:
            if mask and mask.get("format") is not None:
                return mask.get("format")
        return None

    def _mask_format_for_key(self, mask_map: Dict[str, Dict[str, Any]], key: str) -> Optional[float]:
        mask = mask_map.get(key) or {}
        return mask.get("format")

    def _reference_for_mask(
        self,
        rows: Iterable[ReferenceImage],
        mask_format: Optional[float],
    ) -> Optional[ReferenceImage]:
        images = self._ordered_reference_images(rows)
        if not images:
            return None
        if mask_format is None:
            return images[-1]
        with_formats = [
            (abs((_to_float(image.format) or 0.0) - mask_format), image)
            for image in images
            if _to_float(image.format) is not None
        ]
        if not with_formats:
            return images[-1]
        return min(with_formats, key=lambda item: item[0])[1]

    def _serialize_mask(self, mask: Dict[str, Any], key: str) -> Dict[str, Any]:
        return {
            "key": key,
            "label": mask.get("xmlId") or key,
            "coords": mask.get("coords"),
            "format": mask.get("format"),
        }

    def _ordered_reference_images(self, rows: Iterable[ReferenceImage]) -> List[ReferenceImage]:
        return sorted(
            [
                row
                for row in rows or []
                if (row.filename and row.filename.strip()) or (row.image_src and row.image_src.strip())
            ],
            key=lambda row: (
                row.ref_image_id or 0,
                str(row.format or ""),
                str(row.filename or row.image_src or "").strip().lower(),
            ),
        )

    def _serialize_reference_images(self, rows: Iterable[ReferenceImage]) -> List[Dict[str, Any]]:
        images = []
        for index, row in enumerate(rows or [], start=1):
            images.append(
                {
                    "id": row.ref_image_id,
                    "label": f"Reference {index}",
                    "filename": row.filename,
                    "format": row.format,
                    "imageSrc": (row.image_src or "").replace("\\", "/"),
                }
            )
        return images

    def _serialize_reference_image(self, row: Optional[ReferenceImage]) -> Optional[Dict[str, Any]]:
        if not row:
            return None
        return {
            "id": row.ref_image_id,
            "filename": row.filename,
            "format": row.format,
            "imageSrc": (row.image_src or "").replace("\\", "/"),
        }

    def _flag_payload(
        self,
        latest: Any,
        previous: Any,
        *,
        changed: bool,
        changed_label: str,
        unchanged_label: str,
        details: List[Dict[str, Any]],
    ) -> Dict[str, Any]:
        return {
            "state": "changed" if changed else "unchanged",
            "label": changed_label if changed else unchanged_label,
            "currentReel": getattr(latest, "reel_code", None) or getattr(latest, "reel_id", None),
            "previousReel": getattr(previous, "reel_code", None) or getattr(previous, "reel_id", None),
            "reelContext": self._reel_explorer_context(latest) if isinstance(latest, Reel) else None,
            "details": details,
        }

    def _missing_flag(self, label: str, latest: Any = None, previous: Any = None) -> Dict[str, Any]:
        return {
            "state": "missing",
            "label": label,
            "currentReel": getattr(latest, "reel_code", None) or getattr(latest, "reel_id", None) if latest else None,
            "previousReel": getattr(previous, "reel_code", None) or getattr(previous, "reel_id", None) if previous else None,
            "details": [],
        }

    def _value_label(self, value: Optional[float]) -> str:
        if value is None:
            return "--"
        return f"{value:g}"

    def _count_label(self, count: int) -> str:
        if count == 1:
            return "once"
        if count == 2:
            return "twice"
        return f"{count} times"

    # =====================================================================
    # Job summary for the BST Overview cards
    # Looks at every reel of the job currently running on a press (not just
    # the last 7) and counts reference images / switches, mask applications
    # and RLM tolerance changes. Make-ready reels are skipped for changes.
    # =====================================================================
    def get_job_summary_for_card(self, card: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        try:
            return self.get_job_summary(
                machine_id=card.get("machineId"),
                machine_name=card.get("machineName"),
                order_number=card.get("orderNumber"),
                job_name=card.get("jobName"),
            )
        except Exception:  # never break the board because of the summary
            logger.exception("Job summary failed for %s", card.get("machineName"))
            return None

    def get_job_summary(
        self,
        *,
        machine_id: Optional[int],
        machine_name: Optional[str],
        order_number: Optional[str],
        job_name: Optional[str],
    ) -> Optional[Dict[str, Any]]:
        order_key = _norm(order_number)
        job_key = _norm(job_name)
        if not order_key and not job_key:
            return None
        cache_key = (machine_id, _norm(machine_name), order_key, job_key)
        cached = _JOB_SUMMARY_CACHE.get(cache_key)
        if cached and time.monotonic() - cached[0] < JOB_SUMMARY_CACHE_SECONDS:
            return cached[1]

        bst_reels, defect_counts = self._job_bst_reels(machine_id, order_key, job_key)
        rlm_tol_changes, rlm_stats = self._job_rlm_data(machine_name, order_key, job_key)
        result = self._build_job_summary(
            bst_reels, rlm_tol_changes, machine_name, order_number, job_name, defect_counts, rlm_stats
        )
        _JOB_SUMMARY_CACHE[cache_key] = (time.monotonic(), result)
        return result

    def _bst_active_pct(self, reel: Reel) -> Optional[float]:
        """BST inspection % for one reel, same method as the overview:
        footage (format) clipped to the reel's range, else time clipped to the
        reel's start/end. None when the reel has no phase data."""
        amounts: Dict[str, float] = defaultdict(float)
        reel_lo = _to_float(reel.reel_start)
        reel_hi = _to_float(reel.reel_end)
        if reel_lo is not None and reel_hi is not None and reel_hi < reel_lo:
            reel_lo, reel_hi = reel_hi, reel_lo
        phases = list(getattr(reel, "inspection_phases", None) or [])
        for phase in phases:
            start = _to_float(getattr(phase, "start_format", None))
            end = _to_float(getattr(phase, "end_format", None))
            if start is None or end is None:
                continue
            lo, hi = min(start, end), max(start, end)
            if reel_lo is not None:
                lo = max(lo, reel_lo)
            if reel_hi is not None:
                hi = min(hi, reel_hi)
            if hi > lo:
                amounts[str(phase.phase or "").strip().lower()] += hi - lo
        if not amounts:
            for phase in phases:
                if not phase.start_time or not phase.end_time or phase.end_time <= phase.start_time:
                    continue
                start = max(phase.start_time, reel.time_start) if reel.time_start else phase.start_time
                end = min(phase.end_time, reel.time_end) if reel.time_end else phase.end_time
                if end > start:
                    amounts[str(phase.phase or "").strip().lower()] += (end - start).total_seconds()
        total = sum(amounts.values())
        if total <= 0:
            return None
        return amounts.get("active", 0.0) / total * 100.0

    def _bst_inspection_off(self, reel: Reel) -> bool:
        # BST inspection under BST_OFF_ACTIVE_PCT (40%) counts as BST off.
        pct = self._bst_active_pct(reel)
        return pct is not None and pct < BST_OFF_ACTIVE_PCT

    def _job_matches(self, order_value: Any, job_value: Any, order_key: str, job_key: str) -> bool:
        if order_key:
            return _norm(order_value) == order_key
        return _norm(job_value) == job_key

    def _job_bst_reels(
        self, machine_id: Optional[int], order_key: str, job_key: str
    ) -> Tuple[List[Reel], Dict[int, int]]:
        """The current, unbroken run of this job on this press (oldest first)
        plus {reel_id: defect count}. Finished reels come from memory; only new
        or still-running reels are loaded from the database."""
        if not machine_id:
            return [], {}
        activity = case((Reel.time_end.is_(None), Reel.time_start), else_=Reel.time_end)
        with SessionLocal() as session:
            recent = (
                session.query(Reel.reel_id, Reel.order_number, Reel.job_name)
                .filter(Reel.machine_id == int(machine_id))
                .order_by(activity.desc(), Reel.reel_id.desc())
                .limit(JOB_SUMMARY_MAX_REELS)
                .all()
            )
            run_ids: List[int] = []  # newest first
            started = False
            for reel_id, order_value, job_value in recent:
                if self._job_matches(order_value, job_value, order_key, job_key):
                    started = True
                    run_ids.append(int(reel_id))
                elif started:
                    break
            if not run_ids:
                return [], {}

            cache = _JOB_BST_REEL_CACHE.setdefault(int(machine_id), {})
            run_set = set(run_ids)
            for cached_id in list(cache):
                if cached_id not in run_set:
                    del cache[cached_id]

            newest_id = run_ids[0]
            fresh: Dict[int, Tuple[Reel, int]] = {}
            missing = [reel_id for reel_id in run_ids if reel_id not in cache]
            if missing:
                rows = (
                    session.query(Reel)
                    .options(
                        selectinload(Reel.reference_images),
                        selectinload(Reel.inspection_phases),
                        selectinload(Reel.masks),
                    )
                    .filter(Reel.reel_id.in_(missing))
                    .all()
                )
                counts = {
                    int(reel_id): int(count or 0)
                    for reel_id, count in (
                        session.query(Defect.reel_id, func.count(Defect.defect_id))
                        .filter(Defect.reel_id.in_(missing))
                        .group_by(Defect.reel_id)
                        .all()
                    )
                }
                for reel in rows:
                    entry = (reel, counts.get(int(reel.reel_id), 0))
                    # Only finished reels are kept; the running reel is re-read every time.
                    if int(reel.reel_id) != newest_id and reel.time_end is not None:
                        cache[int(reel.reel_id)] = entry
                    else:
                        fresh[int(reel.reel_id)] = entry

        reels: List[Reel] = []
        defect_counts: Dict[int, int] = {}
        for reel_id in reversed(run_ids):  # oldest first
            entry = fresh.get(reel_id) or cache.get(reel_id)
            if entry:
                reels.append(entry[0])
                defect_counts[reel_id] = entry[1]
        return reels, defect_counts

    def _job_rlm_data(
        self, machine_name: Optional[str], order_key: str, job_key: str
    ) -> Tuple[Dict[str, int], Dict[str, Any]]:
        """({reel code: tolerance changes}, job RLM totals) for the job's RLM reels.
        Totals leave out reels under JOB_SUMMARY_MIN_FEET and RLM-off reels."""
        empty_stats: Dict[str, Any] = {"points": 0, "feet": 0.0, "reels": 0, "offReels": 0}
        if not machine_name:
            return {}, empty_stats
        activity = case(
            (RLMReel.production_end_dt.is_(None), RLMReel.production_start_dt),
            else_=RLMReel.production_end_dt,
        )
        with RLMSessionLocal() as session:
            machine = session.query(RLMMachine).filter(RLMMachine.machine_name.ilike(machine_name.strip())).first()
            if not machine:
                return {}, empty_stats
            recent = (
                session.query(RLMReel)
                .filter(RLMReel.machine_id == machine.machine_id)
                .order_by(activity.desc(), RLMReel.reel_db_id.desc())
                .limit(JOB_SUMMARY_MAX_REELS)
                .all()
            )
            run: List[RLMReel] = []
            started = False
            for reel in recent:
                if self._job_matches(reel.order_number, reel.job_name, order_key, job_key):
                    started = True
                    run.append(reel)
                elif started:
                    break
            if not run:
                return {}, empty_stats
            newest_id = run[0].reel_db_id
            run.reverse()  # oldest first

            cache = _JOB_RLM_REEL_CACHE.setdefault(_norm(machine_name), {})
            run_ids = {int(reel.reel_db_id) for reel in run if reel.reel_db_id is not None}
            for cached_id in list(cache):
                if cached_id not in run_ids:
                    del cache[cached_id]

            fresh: Dict[int, Dict[str, Any]] = {}
            missing = [int(reel.reel_db_id) for reel in run if reel.reel_db_id is not None and int(reel.reel_db_id) not in cache]
            if missing:
                tolerances = self._rlm_tolerances_by_reel(session, missing)
                health: Dict[int, Any] = {}
                health_batch = getattr(self, "rlm_health_batch", None)
                if health_batch is not None:
                    try:
                        health = health_batch(session, missing, [machine]) or {}
                    except Exception:
                        logger.exception("RLM job health failed for %s", machine_name)
                        health = {}
                for reel in run:
                    if reel.reel_db_id is None or int(reel.reel_db_id) not in missing:
                        continue
                    reel_id = int(reel.reel_db_id)
                    row = health.get(reel_id)
                    entry = {
                        "tolerances": tolerances.get(reel_id, []),
                        "feet": float(row.feet_total or 0.0) if row else None,
                        "points": int(row.monitoring_points_total or 0) if row else None,
                    }
                    # Keep finished reels (when RLM points are read, only once they are available).
                    if (
                        reel.reel_db_id != newest_id
                        and reel.production_end_dt is not None
                        and (row is not None or health_batch is None)
                    ):
                        cache[reel_id] = entry
                    else:
                        fresh[reel_id] = entry

        changed: Dict[str, int] = {}
        stats = dict(empty_stats)
        stats["offCodes"] = []  # reel codes with RLM off (job barcode shows them red)
        previous: Optional[RLMReel] = None
        previous_entry: Optional[Dict[str, Any]] = None
        # First reel of the job is make ready: not in the totals, no tolerance compare.
        job_start_db_id = run[0].reel_db_id if run and len(run) < JOB_SUMMARY_MAX_REELS else None
        for reel in run:
            if reel.reel_db_id is None:
                continue
            if job_start_db_id is not None and reel.reel_db_id == job_start_db_id:
                continue
            entry = fresh.get(int(reel.reel_db_id)) or cache.get(int(reel.reel_db_id)) or {}
            feet = entry.get("feet")
            points = entry.get("points")
            if feet is not None and feet >= make_ready_feet():
                if (points or 0) <= RLM_OFF_MONITORING_POINTS:
                    stats["offReels"] += 1
                    stats["offCodes"].append(_norm(reel.reel_id))
                else:
                    stats["points"] += int(points or 0)
                    stats["feet"] += float(feet)
                    stats["reels"] += 1
            if self._is_make_ready_rlm(reel):
                continue
            diff = self._rlm_tolerance_changes(
                previous_entry.get("tolerances", []) if previous_entry else [],
                entry.get("tolerances", []),
            )
            if diff:
                changed[_norm(reel.reel_id)] = len(diff)
            previous = reel
            previous_entry = entry
        return changed, stats

    def _job_reel_entry(self, reel: Reel, kind: str, feet: Optional[float], pct: Optional[float]) -> Dict[str, Any]:
        """One reel of the whole-job barcode. kind: ok / off / mr / sp.
        (Off = BST off, or RLM off from the job's RLM data.)"""
        return {
            "n": reel.reel_code or str(reel.reel_id),
            "k": kind,
            "ft": round(feet) if feet is not None else None,
            "bst": round(pct, 1) if pct is not None else None,
            "start": self._iso_local(self._bst_local_time(reel.time_start)) if reel.time_start else None,
            "end": self._iso_local(self._bst_local_time(reel.time_end)) if reel.time_end else None,
        }

    def _mark_job_reels(
        self,
        reels: List[Reel],
        job_reels: List[Dict[str, Any]],
        job_start_ids: set,
        rlm_off_codes: set,
    ) -> List[Dict[str, Any]]:
        """Add the facts the page needs to re-colour the barcode by itself when
        the make-ready length changes: js = first reel of a job, rlmOff."""
        if len(job_reels) != len(reels):
            return job_reels
        for reel, entry in zip(reels, job_reels):
            if reel.reel_id in job_start_ids:
                entry["js"] = True
            if _norm(reel.reel_code) in rlm_off_codes:
                entry["rlmOff"] = True
        return job_reels

    def _job_reel_kinds(
        self,
        reels: List[Reel],
        machine_name: Optional[str],
        min_feet: float,
        job_start_ids: set,
        rlm_off_codes: Optional[set] = None,
    ) -> List[str]:
        """Kind of each reel (oldest first): start (first reel of a job), short
        (under the make-ready length), off (BST or RLM off) or good.
        A single off reel with make-ready reels right before and after it is
        part of the make ready too, so it becomes short."""
        rlm_off_codes = rlm_off_codes or set()
        kinds: List[str] = []
        for reel in reels:
            feet = self._feet_from_bst_reel(reel, machine_name)
            if reel.reel_id in job_start_ids:
                kinds.append("start")  # first reel of a job: always make ready, never splice
                continue
            if feet is not None and feet < min_feet:
                kinds.append("short")
                continue
            pct = self._bst_active_pct(reel)
            off = (pct is not None and pct < BST_OFF_ACTIVE_PCT) or _norm(getattr(reel, "reel_code", None)) in rlm_off_codes
            kinds.append("off" if off else "good")
        for index in range(1, len(kinds) - 1):
            if kinds[index] == "off" and kinds[index - 1] in ("start", "short") and kinds[index + 1] == "short":
                kinds[index] = "short"
        return kinds

    def _red_make_ready_ids(self, reels: List[Reel], kinds: List[str], min_feet: float, machine_name: Optional[str]) -> set:
        """Off reels that the rule above turned into make ready."""
        out = set()
        for reel, kind in zip(reels, kinds):
            feet = self._feet_from_bst_reel(reel, machine_name)
            if kind == "short" and not (feet is not None and feet < min_feet):
                out.add(reel.reel_id)
        return out

    def _splice_reel_ids(
        self,
        reels: List[Reel],
        machine_name: Optional[str],
        min_feet: float,
        job_start_ids: set,
        rlm_off_codes: Optional[set] = None,
        kinds: Optional[List[str]] = None,
    ) -> set:
        """Short reels (oldest first) that sit between two good production
        reels of the job: splice / sample instead of make ready. A run of short
        reels counts together. Good = at least min_feet with BST and RLM on."""
        if kinds is None:
            kinds = self._job_reel_kinds(reels, machine_name, min_feet, job_start_ids, rlm_off_codes)
        splice: set = set()
        index = 0
        while index < len(reels):
            if kinds[index] != "short":
                index += 1
                continue
            end = index
            while end + 1 < len(reels) and kinds[end + 1] == "short":
                end += 1
            before_good = index > 0 and kinds[index - 1] == "good"
            after_good = end + 1 < len(reels) and kinds[end + 1] == "good"
            if before_good and after_good:
                splice.update(reels[pos].reel_id for pos in range(index, end + 1))
            index = end + 1
        return splice

    def _build_job_summary(
        self,
        reels: List[Reel],
        rlm_tol_changes: Dict[str, int],
        machine_name: Optional[str],
        order_number: Optional[str],
        job_name: Optional[str],
        defect_counts: Optional[Dict[int, int]] = None,
        rlm_stats: Optional[Dict[str, Any]] = None,
    ) -> Optional[Dict[str, Any]]:
        defect_counts = defect_counts or {}
        rlm_stats = rlm_stats or {}
        if not reels and not rlm_tol_changes:
            return None
        ref_ids = set()
        ref_files = set()
        ref_switches = 0
        ref_change_reels = 0
        multi_ref = 0
        mask_applied = 0
        mask_removed = 0
        mask_change_reels = 0
        tol_change_reels = 0
        production = 0
        # Good production reels: every reel of JOB_SUMMARY_MIN_FEET or more,
        # whatever the BST inspection % (BST-off reels included).
        good_reels = 0
        skipped_short = 0
        skipped_off = 0
        total_feet = 0.0
        # Defects / 1k ft over counted reels only (no make-ready, no BST off).
        defect_total = 0
        defect_feet = 0.0
        # Job BST inspection %: active footage / total footage over reels
        # >= JOB_SUMMARY_MIN_FEET, BST-off reels included.
        bst_pct_weighted = 0.0
        bst_pct_feet = 0.0
        previous: Optional[Reel] = None
        last_ref: Optional[str] = None

        # The first reel of the job is always make ready. Only known when the
        # whole job was loaded (the run stopped at a reel from another job).
        job_start_id = reels[0].reel_id if reels and len(reels) < JOB_SUMMARY_MAX_REELS else None
        # Also a job start: a reel whose order or job name differs from the reel
        # before it (a new job can keep the same order number).
        job_start_ids = {job_start_id} if job_start_id is not None else set()
        for position in range(1, len(reels)):
            if self._is_new_job(reels[position - 1], reels[position]):
                job_start_ids.add(reels[position].reel_id)
        rlm_off_codes = set((rlm_stats or {}).get("offCodes") or [])
        min_feet = make_ready_feet()
        kinds = self._job_reel_kinds(reels, machine_name, min_feet, job_start_ids, rlm_off_codes)
        splice_ids = self._splice_reel_ids(reels, machine_name, min_feet, job_start_ids, kinds=kinds)
        # A single red reel between make-ready reels counts as make ready too.
        red_mr_ids = self._red_make_ready_ids(reels, kinds, min_feet, machine_name)
        # Every reel of the job, oldest first, for the whole-job barcode on the card.
        job_reels: List[Dict[str, Any]] = []
        for reel in reels:
            feet = self._feet_from_bst_reel(reel, machine_name)
            if feet:
                total_feet += feet
            pct = self._bst_active_pct(reel)
            if (feet is not None and feet < min_feet) or reel.reel_id in job_start_ids or reel.reel_id in red_mr_ids:
                skipped_short += 1
                job_reels.append(self._job_reel_entry(reel, "sp" if reel.reel_id in splice_ids else "mr", feet, pct))
                continue
            good_reels += 1
            if pct is not None and feet:
                bst_pct_weighted += pct * feet
                bst_pct_feet += feet
            if pct is not None and pct < BST_OFF_ACTIVE_PCT:
                skipped_off += 1
                job_reels.append(self._job_reel_entry(reel, "off", feet, pct))
                continue
            # Red in the barcode when the RLM was off on this reel too.
            job_reels.append(self._job_reel_entry(reel, "off" if _norm(reel.reel_code) in rlm_off_codes else "ok", feet, pct))
            production += 1
            if feet and reel.reel_id is not None:
                defect_total += defect_counts.get(int(reel.reel_id), 0)
                defect_feet += feet

            sequence = self._phase_reference_ids(reel)
            if sequence:
                ref_ids |= set(sequence)
                if len(set(sequence)) > 1:
                    multi_ref += 1
                switches_here = 0
                for ref in sequence:
                    if last_ref is not None and ref != last_ref:
                        switches_here += 1
                    last_ref = ref
                if switches_here:
                    ref_switches += switches_here
                    ref_change_reels += 1
            else:
                keys = self._reference_keys(reel)
                ref_files |= keys
                if len(keys) > 1:
                    multi_ref += 1
                if previous is not None and keys - self._reference_keys(previous):
                    ref_switches += len(keys - self._reference_keys(previous))
                    ref_change_reels += 1

            events = self._mask_events(previous, reel)
            if events["applied"] or events["removed"]:
                mask_applied += len(events["applied"])
                mask_removed += len(events["removed"])
                mask_change_reels += 1

            if rlm_tol_changes.get(_norm(reel.reel_code)):
                tol_change_reels += 1
            previous = reel

        if not reels:
            tol_change_reels = len(rlm_tol_changes)

        first = reels[0] if reels else None
        started_at = (first.time_start or first.time_end) if first else None
        return {
            "orderNumber": order_number or "",
            "jobName": job_name or "",
            "productionReels": production,
            "goodReels": good_reels,
            "skippedShortReels": skipped_short,
            "skippedInspectionOffReels": skipped_off,
            # Short reels split into make ready (job start, after an off reel,
            # newest reel) and splice / sample (between two good reels).
            "makeReadyReels": skipped_short - len(splice_ids),
            "spliceReels": len(splice_ids),
            "reels": self._mark_job_reels(reels, job_reels, job_start_ids, rlm_off_codes),
            "minFeet": min_feet,
            "totalFeet": round(total_feet, 0),
            "startedAt": self._iso_local(started_at),
            "referenceImages": len(ref_ids) + len(ref_files),
            "refSwitches": ref_switches,
            "refChangeReels": ref_change_reels,
            "reelsWithMultipleRefs": multi_ref,
            "masksApplied": mask_applied,
            "masksRemoved": mask_removed,
            "maskChangeReels": mask_change_reels,
            "rlmToleranceChangeReels": tol_change_reels,
            "defectCount": defect_total,
            "defectFeet": round(defect_feet, 0),
            "defectsPer1kFt": round(defect_total / defect_feet * 1000.0, 2) if defect_feet > 0 else None,
            "bstInspectionPct": round(bst_pct_weighted / bst_pct_feet, 1) if bst_pct_feet > 0 else None,
            "bstInspectionFeet": round(bst_pct_feet, 0),
            "rlmPoints": int(rlm_stats.get("points") or 0),
            "rlmFeet": round(float(rlm_stats.get("feet") or 0.0), 0),
            "rlmReels": int(rlm_stats.get("reels") or 0),
            "rlmOffReels": int(rlm_stats.get("offReels") or 0),
            "rlmPointsPer1kFt": (
                round(rlm_stats["points"] / rlm_stats["feet"] * 1000.0, 1)
                if rlm_stats.get("feet") else None
            ),
        }