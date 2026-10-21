from __future__ import annotations

import threading
import time
from typing import Any, Dict, List, Optional

from services.bst_change_flags_service import BSTChangeFlagsService
from services.status_overview_service import StatusOverviewService


OVERVIEW_REEL_LIMIT = 7
OVERVIEW_CACHE_SECONDS = 60
OVERVIEW_CHANGE_CACHE_SECONDS = 120
OVERVIEW_CHANGE_REEL_QUERY_LIMIT = 10


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

    def get_payload(self, sync_alerts: bool = False) -> Dict[str, Any]:
        now = time.monotonic()
        if (
            not sync_alerts
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
                and self._payload_cache is not None
                and now - self._payload_cache_at < OVERVIEW_CACHE_SECONDS
            ):
                return self._payload_cache

            board = self.status_service.get_board_payload(sync_alerts=sync_alerts)
            changes = self._get_change_payload()
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
                    change_reel = next(
                        (changes_by_reel[key] for key in self._reel_keys(reel) if key in changes_by_reel),
                        None,
                    )
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
                card["reelHistory"] = history

            board["reelLimit"] = OVERVIEW_REEL_LIMIT
            self._payload_cache = board
            self._payload_cache_at = time.monotonic()
            return board

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
    def _is_viewable_change(detail: Dict[str, Any]) -> bool:
        images: List[Dict[str, Any]] = detail.get("images") or []
        return any(image.get("imageSrc") for image in images) or bool(detail.get("maskComparison"))
