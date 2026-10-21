from __future__ import annotations

from collections import defaultdict
from datetime import datetime, timezone
from decimal import Decimal
from typing import Any, Dict, Iterable, List, Optional, Tuple
from zoneinfo import ZoneInfo

from sqlalchemy import case, func, select
from sqlalchemy.orm import selectinload

from db.connection import SessionLocal
from db.models import Machine, Mask, Reel, ReferenceImage, SensitivitySet
from db.rlm_connection import RLMSessionLocal
from db.rlm_models import RLMMachine, RLMReel, RLMTolerance
from services.rlm_reel_footage import compute_feet_per_range_unit
from services.status_overview_service import (
    BST_FEET_MULTIPLIER_DEFAULT,
    BST_FEET_MULTIPLIERS_BY_MACHINE,
    STATUS_OVERVIEW_MACHINE_ORDER,
)

CENTRAL_TZ = ZoneInfo("America/Chicago")
CHANGE_FLAGS_DEFAULT_REEL_LIMIT = 40


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
                previous = self._previous_same_rlm_job(latest, reels[1:]) if latest else None
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
                previous = self._previous_same_bst_job(latest, reels[1:]) if latest else None
                out[_norm(machine.name)] = {
                    "machineName": machine.name,
                    "machineId": machine.machine_id,
                    "latest": latest,
                    "previous": previous,
                    "recentReels": reels,
                }
            return out

    def _previous_same_rlm_job(self, latest: RLMReel, reels: Iterable[RLMReel]) -> Optional[RLMReel]:
        latest_job = (_norm(latest.order_number), _norm(latest.job_name))
        for reel in reels:
            if (_norm(reel.order_number), _norm(reel.job_name)) == latest_job:
                return reel
        return None

    def _previous_same_bst_job(self, latest: Reel, reels: Iterable[Reel]) -> Optional[Reel]:
        latest_job = (_norm(latest.order_number), _norm(latest.job_name))
        for reel in reels:
            if (_norm(reel.order_number), _norm(reel.job_name)) == latest_job:
                return reel
        return None

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
        bst_reels = list((bst or {}).get("recentReels") or [])[: max(limit, 1)]
        rlm_reels = list((rlm or {}).get("recentReels") or [])
        rlm_tolerances_by_reel = (rlm or {}).get("recentTolerancesByReel") or {}
        rlm_index_by_id = {int(reel.reel_db_id): index for index, reel in enumerate(rlm_reels) if reel is not None and reel.reel_db_id is not None}

        history: List[Dict[str, Any]] = []
        for index, bst_reel in enumerate(bst_reels[:limit]):
            rlm_reel = self._match_recent_rlm_reel(bst_reel, rlm_reels)
            previous_bst = self._previous_same_bst_job(bst_reel, bst_reels[index + 1 :]) if bst_reel else None
            previous_rlm = None
            if rlm_reel and rlm_reel.reel_db_id is not None:
                rlm_index = rlm_index_by_id.get(int(rlm_reel.reel_db_id))
                if rlm_index is not None:
                    previous_rlm = self._previous_same_rlm_job(rlm_reel, rlm_reels[rlm_index + 1 :])

            bst_changes, bst_summary = self._bst_history_tolerance_summary(previous_bst, bst_reel)
            rlm_changes, rlm_summary = self._rlm_history_tolerance_summary(previous_rlm, rlm_reel, rlm_tolerances_by_reel)
            feet = self._feet_from_bst_reel(bst_reel, (bst or {}).get("machineName")) if bst_reel else self._feet_from_rlm_reel(rlm_reel)
            history.append(
                {
                    "label": "Current" if index == 0 else f"Prior {index}",
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
                }
            )
        return history

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
        mask_changes = self._mask_changes(previous, current) if previous else []
        reference_images = self._ordered_reference_images(current.reference_images)
        reference_change_count = max(len(reference_images) - 1, 0)
        changes: List[Dict[str, Any]] = []
        changes.extend(sensitivity_changes)
        changes.extend(mask_changes)
        if reference_change_count:
            changes.append(
                {
                    "label": "Reference images",
                    "summary": self._reference_change_label(reference_change_count),
                    "images": self._serialize_reference_images(reference_images),
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
        changes = self._rlm_tolerance_changes(previous_rows, current_rows) if previous else []
        if not changes:
            return [], "No RLM tolerance changes"
        return changes, self._history_change_summary(changes, "RLM")

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
        return f"{count} Change{'s' if count != 1 else ''}"

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
        changes = self._rlm_tolerance_changes(previous_rows, current_rows)
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
        reference_images = self._ordered_reference_images(latest.reference_images)
        reference_change_count = max(len(reference_images) - 1, 0)
        sensitivity_changes = self._sensitivity_changes(previous.sensitivity_sets, latest.sensitivity_sets) if previous else []
        mask_changes = self._mask_changes(previous, latest) if previous else []

        details: List[Dict[str, Any]] = []
        details.extend(sensitivity_changes)
        details.extend(mask_changes)
        if reference_change_count:
            details.append(
                {
                    "label": "Reference images",
                    "summary": self._reference_change_label(reference_change_count),
                    "images": self._serialize_reference_images(reference_images),
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

    def _rlm_tolerance_changes(
        self,
        previous_rows: Iterable[RLMTolerance],
        current_rows: Iterable[RLMTolerance],
    ) -> List[Dict[str, Any]]:
        previous = self._rlm_tolerance_map(previous_rows)
        current = self._rlm_tolerance_map(current_rows)
        changes: List[Dict[str, Any]] = []
        for key in sorted(set(previous) & set(current), key=lambda item: str(item)):
            before = previous.get(key)
            after = current.get(key)
            if before == after:
                continue
            field_changes = []
            for field, label in (
                ("errShrink", "Err shrink"),
                ("errExpand", "Err expand"),
                ("nomLength", "Nom length"),
            ):
                before_value = before.get(field) if before else None
                after_value = after.get(field) if after else None
                if before_value is not None and after_value is not None and before_value != after_value:
                    field_changes.append(f"{label}: {self._value_label(before_value)} to {self._value_label(after_value)}")
            if field_changes:
                changes.append(
                    {
                        "label": f"Tolerance {key}",
                        "summary": "; ".join(field_changes),
                    }
                )
        return changes

    def _rlm_tolerance_map(self, rows: Iterable[RLMTolerance]) -> Dict[str, Dict[str, Optional[float]]]:
        out = {}
        for row in rows or []:
            if row.tol_sequence is not None:
                key = f"seq {row.tol_sequence}"
            elif row.tol_format is not None:
                key = f"format {_rounded(row.tol_format)}"
            elif row.tol_id:
                key = str(row.tol_id)
            else:
                key = "default"
            out[key] = {
                "errShrink": _rounded(row.err_shrink),
                "errExpand": _rounded(row.err_expand),
                "nomLength": _rounded(row.nom_length),
            }
        return out

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

    def _mask_changes(self, previous: Reel, current: Reel) -> List[Dict[str, Any]]:
        previous_map = self._mask_map(previous.masks)
        current_map = self._mask_map(current.masks)
        changed_keys = [
            key
            for key in sorted(set(previous_map) | set(current_map))
            if (previous_map.get(key) or {}).get("coords") != (current_map.get(key) or {}).get("coords")
        ]
        if not changed_keys:
            return []

        latest_current_mask = max(
            current_map.values(),
            key=lambda mask: str(mask.get("timestamp") or ""),
            default=None,
        )
        mask_format = (
            latest_current_mask.get("format")
            if latest_current_mask
            else self._mask_format_for_key(previous_map, changed_keys[-1])
        )
        before_image = self._reference_for_mask(previous.reference_images, mask_format)
        after_image = self._reference_for_mask(current.reference_images, mask_format)
        before_payload = {
            "label": "Initial",
            "reel": previous.reel_code,
            "image": self._serialize_reference_image(before_image),
            "format_width": _to_float(getattr(previous, "format_width", None)),
            "format_length": _to_float(getattr(previous, "format_length", None)),
            "masks": [self._serialize_mask(mask, key) for key, mask in sorted(previous_map.items())],
        }
        after_payload = {
            "label": "Current",
            "reel": current.reel_code,
            "image": self._serialize_reference_image(after_image),
            "format_width": _to_float(getattr(current, "format_width", None)),
            "format_length": _to_float(getattr(current, "format_length", None)),
            "masks": [self._serialize_mask(mask, key) for key, mask in sorted(current_map.items())],
        }
        sequence = [before_payload, after_payload] if before_payload["masks"] else [after_payload]
        return [
            {
                "label": "Mask applied",
                "summary": f"Mask applied {self._count_label(len(changed_keys))}",
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
