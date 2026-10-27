import unittest
from datetime import datetime
from unittest.mock import patch

from services.status_overview_service import CENTRAL_TZ, StatusOverviewService


class StatusOverviewServiceTests(unittest.TestCase):
    def test_synced_reel_uses_latest_activity_from_either_source(self) -> None:
        service = StatusOverviewService.__new__(StatusOverviewService)
        bst_activity = datetime(2026, 10, 23, 15, 4)
        rlm_activity = datetime(2026, 10, 23, 16, 7)
        matched_activity = datetime(2026, 10, 23, 14, 50)
        matched_context = {
            "lastActivity": matched_activity,
            "displayReel": {"reelNumber": "R-100"},
        }
        stopped_at = datetime(2026, 10, 23, 12, 47)

        with patch.object(
            service,
            "_latest_synced_reel_context",
            return_value=matched_context,
        ):
            context = service._select_display_reel_context(
                {"latestActivity": bst_activity},
                {"latestActivity": rlm_activity, "statusActivity": stopped_at},
            )

        self.assertIs(context, matched_context)
        self.assertEqual(context["lastActivity"], rlm_activity)
        self.assertEqual(context["statusActivity"], rlm_activity)

    def test_rlm_status_activity_uses_newest_reel_or_monitoring_timestamp(self) -> None:
        service = StatusOverviewService.__new__(StatusOverviewService)
        last_monitoring = datetime(2026, 10, 23, 13, 14)
        fallback = datetime(2026, 10, 23, 14, 44)

        status_activity = service._rlm_status_activity(
            [datetime(2026, 10, 23, 12, 50), last_monitoring],
            fallback,
        )

        self.assertEqual(status_activity, datetime(2026, 10, 23, 14, 44, tzinfo=CENTRAL_TZ))
        self.assertEqual(
            service._rlm_status_activity([last_monitoring], datetime(2026, 10, 23, 12, 0)),
            datetime(2026, 10, 23, 13, 14, tzinfo=CENTRAL_TZ),
        )
        self.assertEqual(
            service._rlm_status_activity([], fallback),
            service._central_time(fallback),
        )


if __name__ == "__main__":
    unittest.main()
