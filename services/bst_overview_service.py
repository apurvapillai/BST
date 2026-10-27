from __future__ import annotations

import logging
import threading
import time
from typing import Any, Dict, List, Optional

from services.bst_change_flags_service import BSTChangeFlagsService, clear_job_summary_cache
from services.status_overview_service import StatusOverviewService, get_overview_settings


OVERVIEW_REEL_LIMIT = 7
OVERVIEW_CACHE_SECONDS = 60
OVERVIEW_CHANGE_CACHE_SECONDS = 120
OVERVIEW_CHANGE_REEL_QUERY_LIMIT = 10
# A background thread rebuilds the board this often (and syncs alerts), so a
# page load never has to wait for the database. Requests are served from the
# last build as long as it is younger than OVERVIEW_STALE_MAX_SECONDS.
OVERVIEW_WARM_SECONDS = 45
OVERVIEW_STALE_MAX_SECONDS = 300

logger = logging.getLogger(__name__)


class BSTOverviewService:
    """Combine operational status with viewable BST setup changes."""

    def __init__(
        self,
        status_service: Optional[StatusOverviewService] = None,
        change_service: Optional[BSTChangeFlagsService] = None,
    ) -> None:
        self.status_service = status_service or StatusOverviewService()
        self.change_service = change_service or BSTChangeFlagsService()
        self._payload_cache: Optional[Dict[str, Any]] = None
        self._payload_cache_at = 0.0
        self._change_payload_cache: Optional[Dict[str, Any]] = None
        self._change_payload_cache_at = 0.0
        self._payload_cache_lock = threading.Lock()
        self._warmer_started = False
        self._warmer_lock = threading.Lock()
        # Overview settings the cached board was built with. When the settings
        # change (saved here or by another app worker) the board is rebuilt.
        self._payload_settings: Optional[Dict[str, Any]] = None
        # Each settings change bumps _settings_gen; a finished build records the
        # generation it started with. The board is out of date ("dirty") until a
        # build that started after the last change has finished.
        self._settings_gen = 0
        self._built_gen = 0
        self._change_payload_stale = False

    def _ensure_warmer(self) -> None:
        if self._warmer_started:
            return
        with self._warmer_lock:
            if self._warmer_started:
                return
            self._warmer_started = True
            threading.Thread(target=self._warm_loop, name="bst-overview-warmer", daemon=True).start()

    def _warm_loop(self) -> None:
        while True:
            try:
                self._build_payload(sync_alerts=True)
            except Exception:
                logger.exception("BST overview background refresh failed")
            time.sleep(OVERVIEW_WARM_SECONDS)

    @property
    def _payload_dirty(self) -> bool:
        return self._built_gen != self._settings_gen

    def _settings_changed(self) -> bool:
        settings = get_overview_settings()
        if self._payload_settings is not None and settings != self._payload_settings and not self._payload_dirty:
            self.invalidate()
            return True
        return False

    def get_payload(self, sync_alerts: bool = False) -> Dict[str, Any]:
        self._ensure_warmer()
        self._settings_changed()
        now = time.monotonic()
        if (
            not sync_alerts
            and not self._payload_dirty
            and self._payload_cache is not None
            and now - self._payload_cache_at < OVERVIEW_STALE_MAX_SECONDS
        ):
            # Served from memory; the background thread keeps it fresh.
            return self._payload_cache
        return self._build_payload(sync_alerts=sync_alerts)

    def _build_payload(self, sync_alerts: bool = False) -> Dict[str, Any]:
        now = time.monotonic()
        if (
            not sync_alerts
            and not self._payload_dirty
            and self._payload_cache is not None
            and now - self._payload_cache_at < OVERVIEW_CACHE_SECONDS
        ):
            return self._payload_cache

        # Serialize refreshes so simultaneous page loads do not repeat the same
        # expensive BST/RLM/change-history queries.
        with self._payload_cache_lock:
            now = time.monotonic()
            if (
                not sync_alerts
                and not self._payload_dirty
                and self._payload_cache is not None
                and now - self._payload_cache_at < OVERVIEW_CACHE_SECONDS
            ):
                return self._payload_cache

            started = time.monotonic()
            # Settings saved after this point mark the board dirty again.
            started_gen = self._settings_gen
            if self._change_payload_stale:
                self._change_payload_cache = None
                self._change_payload_stale = False
            build_settings = get_overview_settings()
            # Record the settings this build uses now (not at the end), so a
            # request arriving mid-build does not start a second rebuild.
            self._payload_settings = build_settings
            board = self.status_service.get_board_payload(sync_alerts=sync_alerts)
            board_done = time.monotonic()
            changes = self._get_change_payload()
            changes_done = time.monotonic()
            job_seconds = 0.0
            changes_by_machine = {
                self._key(row.get("machineName")): row
                for row in changes.get("rows", [])
            }

            for card in board.get("cards", []):
                history = list(card.get("reelHistory") or [])[:OVERVIEW_REEL_LIMIT]
                change_row = changes_by_machine.get(self._key(card.get("machineName")))
                change_history = list((change_row or {}).get("reelHistory") or [])
                changes_by_reel: Dict[str, Dict[str, Any]] = {}
                for row in change_history:
                    for reel_key in self._reel_keys(row):
                        changes_by_reel[reel_key] = row

                for reel in history:
                    change_reel = self._find_change_reel(reel, changes_by_reel)
                    details = list((change_reel or {}).get("bstDetails") or [])
                    rlm_details = list((change_reel or {}).get("rlmDetails") or [])
                    reel["isMakeReady"] = "make-ready" in {
                        reel.get("state"),
                        reel.get("bstState"),
                        reel.get("rlmState"),
                    }
                    reel["changeDetails"] = [detail for detail in details if self._is_viewable_change(detail)]
                    reel["changeSummary"] = (change_reel or {}).get("bstSummary") or ""
                    reel["rlmChangeDetails"] = rlm_details
                    reel["rlmChangeSummary"] = (change_reel or {}).get("rlmSummary") or ""
                    # Masks changed during make-ready reels just before this one (not counted as an M).
                    reel["makeReadyMaskNote"] = "" if reel["isMakeReady"] else ((change_reel or {}).get("makeReadyMaskNote") or "")
                    # Badge letters for the card: M mask, R reference image,
                    # T RLM tolerance. None on make-ready reels.
                    reel["changeTags"] = [] if reel["isMakeReady"] else self._change_tags(details, rlm_details)
                card["reelHistory"] = history
                # Whole-job totals (reference images, mask applications, RLM tolerance).
                job_started = time.monotonic()
                card["jobSummary"] = self.change_service.get_job_summary_for_card(card)
                job_seconds += time.monotonic() - job_started

            board["reelLimit"] = OVERVIEW_REEL_LIMIT
            self._payload_cache = board
            self._payload_cache_at = time.monotonic()
            self._built_gen = started_gen
            logger.info(
                "BST overview built in %.2fs (board %.2fs, changes %.2fs, job summaries %.2fs, sync_alerts=%s)",
                self._payload_cache_at - started,
                board_done - started,
                changes_done - board_done,
                job_seconds,
                sync_alerts,
            )
            return board

    # Settings that change the reel change details (R / M / T badges). Only
    # these need the slow change-history reload; the make-ready length alone
    # does not (make-ready reels never show badges anyway).
    _CHANGE_SETTING_KEYS = ("refChangesMin", "maskChangesMin", "rlmNominalDeltaMm")
    # Settings used by the Current job numbers.
    _JOB_SETTING_KEYS = ("makeReadyFeet", "rlmNominalDeltaMm")

    def invalidate(self) -> None:
        """The overview settings changed: mark the board out of date and start
        rebuilding it in the background right away, redoing only the parts the
        changed settings affect. Never waits for a build already running."""
        current = get_overview_settings()
        previous = self._payload_settings or {}
        changed = {key for key in current if previous.get(key) != current.get(key)} if previous else set(current)
        self._settings_gen += 1
        if changed & set(self._CHANGE_SETTING_KEYS):
            self._change_payload_stale = True
        if changed & set(self._JOB_SETTING_KEYS):
            clear_job_summary_cache()
        threading.Thread(target=self._rebuild_now, name="bst-overview-settings-rebuild", daemon=True).start()

    def _rebuild_now(self) -> None:
        try:
            self._build_payload(sync_alerts=False)
        except Exception:
            logger.exception("BST overview rebuild after settings change failed")

    def _get_change_payload(self) -> Dict[str, Any]:
        now = time.monotonic()
        if (
            self._change_payload_cache is None
            or now - self._change_payload_cache_at >= OVERVIEW_CHANGE_CACHE_SECONDS
        ):
            self._change_payload_cache = self.change_service.get_payload(
                reel_limit=OVERVIEW_CHANGE_REEL_QUERY_LIMIT
            )
            self._change_payload_cache_at = now
        return self._change_payload_cache

    @staticmethod
    def _key(value: Any) -> str:
        return str(value or "").strip().lower()

    def _find_change_reel(
        self, reel: Dict[str, Any], changes_by_reel: Dict[str, Dict[str, Any]]
    ) -> Optional[Dict[str, Any]]:
        """Change details for this exact reel.

        Match by database reel id. Reel codes (r1, r12, ...) repeat across
        orders on the same press, so the code is only used when the reel has
        no id; otherwise another order's r12 could lend its masks/refs here."""
        reel_id = (reel.get("reelContext") or {}).get("reelId")
        if reel_id is not None:
            return changes_by_reel.get(f"id:{reel_id}")
        code = self._key(reel.get("reelNumber"))
        return changes_by_reel.get(f"code:{code}") if code else None

    def _reel_keys(self, row: Dict[str, Any]) -> List[str]:
        keys: List[str] = []
        context = row.get("reelContext") or {}
        reel_id = context.get("reelId")
        if reel_id is not None:
            keys.append(f"id:{reel_id}")
        reel_number = self._key(row.get("reelNumber"))
        if reel_number:
            keys.append(f"code:{reel_number}")
        return keys

    @staticmethod
    def _change_tags(details: List[Dict[str, Any]], rlm_details: List[Dict[str, Any]]) -> List[str]:
        tags = set()
        for detail in details:
            if detail.get("label") == "Reference images":
                tags.add("R")
            elif detail.get("maskComparison"):
                tags.add("M")
        if rlm_details:
            tags.add("T")
        return [tag for tag in ("M", "R", "T") if tag in tags]

    @staticmethod
    def _is_viewable_change(detail: Dict[str, Any]) -> bool:
        images: List[Dict[str, Any]] = detail.get("images") or []
        return any(image.get("imageSrc") for image in images) or bool(detail.get("maskComparison"))