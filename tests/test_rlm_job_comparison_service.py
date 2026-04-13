import unittest
from types import SimpleNamespace

from services.rlm_job_comparison_service import RLMJobComparisonService


class RLMJobComparisonServiceTests(unittest.TestCase):
    def setUp(self) -> None:
        self.service = RLMJobComparisonService()

    def test_reel_zone_summary_splits_points_into_early_middle_late(self) -> None:
        reel = SimpleNamespace(reel_start=0.0, reel_end=100.0)
        points = [
            {"formatValue": 10.0, "matchedTolerance": True, "outOfRange": True, "delta": 0.4},
            {"formatValue": 40.0, "matchedTolerance": True, "outOfRange": False, "delta": 0.1},
            {"formatValue": 90.0, "matchedTolerance": True, "outOfRange": True, "delta": 0.6},
        ]
        zones = self.service._build_reel_zone_summary(
            reel,
            points,
            estimated_bad_feet=100.0,
            matched_points=3,
            bad_points=2,
        )

        early = next(zone for zone in zones if zone["key"] == "early")
        middle = next(zone for zone in zones if zone["key"] == "middle")
        late = next(zone for zone in zones if zone["key"] == "late")

        self.assertEqual(early["badMonitoringPoints"], 1)
        self.assertEqual(middle["goodMonitoringPoints"], 1)
        self.assertEqual(late["badMonitoringPoints"], 1)
        self.assertAlmostEqual(early["estimatedBadFeet"], 50.0, places=3)
        self.assertAlmostEqual(late["estimatedBadFeet"], 50.0, places=3)

    def test_within_reel_direction_detects_late_worsening(self) -> None:
        direction = self.service._within_reel_direction(
            [
                {"key": "early", "badPointPct": 10.0},
                {"key": "middle", "badPointPct": 30.0},
                {"key": "late", "badPointPct": 35.0},
            ]
        )
        self.assertEqual(direction, "worsening")

    def test_aggregate_side_records_computes_active_and_run_profile(self) -> None:
        rows = [
            {
                "feetTotal": 1000.0,
                "estimatedBadFeet": 20.0,
                "estimatedGoodFeet": 980.0,
                "monitoringPointsTotal": 10,
                "matchedMonitoringPoints": 10,
                "goodMonitoringPoints": 9,
                "badMonitoringPoints": 1,
                "unmatchedMonitoringPoints": 0,
                "active": True,
                "activeSeconds": 20.0,
                "inactiveSeconds": 5.0,
                "avgDelta": 0.1,
                "deltaStd": 0.2,
                "webspeedRange": 3.0,
                "toleranceChangeCount": 0,
                "productionStart": "2026-04-10T08:00:00",
                "zoneSummary": [
                    {"key": "early", "label": "First 25%", "matchedMonitoringPoints": 4, "badMonitoringPoints": 0, "goodMonitoringPoints": 4, "estimatedBadFeet": 0.0, "avgAbsDelta": 0.1},
                    {"key": "middle", "label": "Middle 50%", "matchedMonitoringPoints": 3, "badMonitoringPoints": 1, "goodMonitoringPoints": 2, "estimatedBadFeet": 20.0, "avgAbsDelta": 0.2},
                    {"key": "late", "label": "Last 25%", "matchedMonitoringPoints": 3, "badMonitoringPoints": 0, "goodMonitoringPoints": 3, "estimatedBadFeet": 0.0, "avgAbsDelta": 0.1},
                ],
                "withinReelDirection": "flat",
                "badPattern": "clustered",
                "estimatedBadFeetPct": 2.0,
            },
            {
                "feetTotal": 1000.0,
                "estimatedBadFeet": 120.0,
                "estimatedGoodFeet": 880.0,
                "monitoringPointsTotal": 10,
                "matchedMonitoringPoints": 10,
                "goodMonitoringPoints": 6,
                "badMonitoringPoints": 4,
                "unmatchedMonitoringPoints": 0,
                "active": True,
                "activeSeconds": 25.0,
                "inactiveSeconds": 5.0,
                "avgDelta": 0.2,
                "deltaStd": 0.5,
                "webspeedRange": 6.0,
                "toleranceChangeCount": 2,
                "productionStart": "2026-04-10T10:00:00",
                "zoneSummary": [
                    {"key": "early", "label": "First 25%", "matchedMonitoringPoints": 4, "badMonitoringPoints": 0, "goodMonitoringPoints": 4, "estimatedBadFeet": 0.0, "avgAbsDelta": 0.2},
                    {"key": "middle", "label": "Middle 50%", "matchedMonitoringPoints": 3, "badMonitoringPoints": 1, "goodMonitoringPoints": 2, "estimatedBadFeet": 30.0, "avgAbsDelta": 0.4},
                    {"key": "late", "label": "Last 25%", "matchedMonitoringPoints": 3, "badMonitoringPoints": 3, "goodMonitoringPoints": 0, "estimatedBadFeet": 90.0, "avgAbsDelta": 0.7},
                ],
                "withinReelDirection": "worsening",
                "badPattern": "clustered",
                "estimatedBadFeetPct": 12.0,
            },
        ]
        aggregate = self.service._aggregate_side_records(rows)

        self.assertEqual(aggregate["reelCount"], 2)
        self.assertEqual(aggregate["activeReelCount"], 2)
        self.assertAlmostEqual(aggregate["badFeetPct"], 7.0, places=3)
        self.assertEqual(aggregate["derivedFeatures"]["runDirection"], "worsening")
        self.assertEqual(aggregate["derivedFeatures"]["dominantZone"], "late")
        self.assertAlmostEqual(aggregate["derivedFeatures"]["lateDegradeRate"], 50.0, places=3)


if __name__ == "__main__":
    unittest.main()
