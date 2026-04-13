import unittest
from types import SimpleNamespace

from services.rlm_reel_footage import compute_reel_feet_from_range
from services.rlm_repeat_length_service import RLMRepeatLengthService, ToleranceSegment


class RLMRepeatLengthServiceTests(unittest.TestCase):
    def setUp(self) -> None:
        self.service = RLMRepeatLengthService()

    def test_single_tolerance_segment(self) -> None:
        result = self.service.evaluate_reel(
            monitoring_rows=[
                {"monitoringId": 1, "reelDbId": 10, "formatValue": 1.0, "curlength": 10.0, "webspeed": 100.0},
                {"monitoringId": 2, "reelDbId": 10, "formatValue": 2.0, "curlength": 10.8, "webspeed": 101.0},
                {"monitoringId": 3, "reelDbId": 10, "formatValue": 3.0, "curlength": 11.5, "webspeed": 99.0},
            ],
            tolerance_rows=[
                ToleranceSegment(1, 10, 1, 0.0, 10.0, 1.0, 1.0, None, None, None),
            ],
        )
        self.assertEqual(result["totalMonitoringPoints"], 3)
        self.assertEqual(result["matchedMonitoringPoints"], 3)
        self.assertEqual(result["goodMonitoringPoints"], 2)
        self.assertEqual(result["badMonitoringPoints"], 1)
        self.assertAlmostEqual(result["badPointPct"], 33.333, places=3)

    def test_multiple_tolerance_segments(self) -> None:
        result = self.service.evaluate_reel(
            monitoring_rows=[
                {"monitoringId": 1, "reelDbId": 11, "formatValue": 25.0, "curlength": 10.5},
                {"monitoringId": 2, "reelDbId": 11, "formatValue": 75.0, "curlength": 20.5},
            ],
            tolerance_rows=[
                ToleranceSegment(1, 11, 1, 0.0, 10.0, 1.0, 1.0, None, None, None),
                ToleranceSegment(2, 11, 2, 50.0, 20.0, 1.0, 1.0, None, None, None),
            ],
        )
        self.assertEqual(result["matchedMonitoringPoints"], 2)
        self.assertEqual(result["badMonitoringPoints"], 0)
        self.assertEqual(result["segmentBreakdown"][0]["matchedMonitoringPoints"], 1)
        self.assertEqual(result["segmentBreakdown"][1]["matchedMonitoringPoints"], 1)

    def test_monitoring_points_crossing_transition_use_correct_segment(self) -> None:
        result = self.service.evaluate_reel(
            monitoring_rows=[
                {"monitoringId": 1, "reelDbId": 12, "formatValue": 49.0, "curlength": 10.9},
                {"monitoringId": 2, "reelDbId": 12, "formatValue": 50.0, "curlength": 20.9},
            ],
            tolerance_rows=[
                ToleranceSegment(1, 12, 1, 0.0, 10.0, 1.0, 1.0, None, None, None),
                ToleranceSegment(2, 12, 2, 50.0, 20.0, 1.0, 1.0, None, None, None),
            ],
        )
        self.assertTrue(result["points"][0]["matchedTolerance"])
        self.assertTrue(result["points"][1]["matchedTolerance"])
        self.assertEqual(result["points"][0]["segmentIndex"], 1)
        self.assertEqual(result["points"][1]["segmentIndex"], 2)
        self.assertFalse(result["points"][0]["outOfRange"])
        self.assertFalse(result["points"][1]["outOfRange"])

    def test_boundary_format_uses_new_segment(self) -> None:
        result = self.service.evaluate_reel(
            monitoring_rows=[
                {"monitoringId": 1, "reelDbId": 13, "formatValue": 50.0, "curlength": 20.0},
            ],
            tolerance_rows=[
                ToleranceSegment(1, 13, 1, 0.0, 10.0, 1.0, 1.0, None, None, None),
                ToleranceSegment(2, 13, 2, 50.0, 20.0, 1.0, 1.0, None, None, None),
            ],
        )
        self.assertEqual(result["points"][0]["segmentIndex"], 2)
        self.assertEqual(result["points"][0]["appliedNominalLength"], 20.0)

    def test_missing_tolerance_data_marks_points_unmatched(self) -> None:
        result = self.service.evaluate_reel(
            monitoring_rows=[
                {"monitoringId": 1, "reelDbId": 14, "formatValue": 10.0, "curlength": 10.2},
            ],
            tolerance_rows=[],
        )
        self.assertEqual(result["matchedMonitoringPoints"], 0)
        self.assertEqual(result["unmatchedMonitoringPoints"], 1)
        self.assertIsNone(result["badPointPct"])
        self.assertEqual(result["points"][0]["matchReason"], "missing_tolerance")

    def test_missing_monitoring_points(self) -> None:
        result = self.service.evaluate_reel(
            monitoring_rows=[],
            tolerance_rows=[
                ToleranceSegment(1, 15, 1, 0.0, 10.0, 1.0, 1.0, None, None, None),
            ],
        )
        self.assertEqual(result["totalMonitoringPoints"], 0)
        self.assertEqual(result["matchedMonitoringPoints"], 0)
        self.assertEqual(result["badMonitoringPoints"], 0)
        self.assertEqual(result["toleranceSegmentCount"], 1)

    def test_regression_first_segment_bad_second_segment_good(self) -> None:
        result = self.service.evaluate_reel(
            monitoring_rows=[
                {"monitoringId": 1, "reelDbId": 16, "formatValue": 10.0, "curlength": 15.0},
                {"monitoringId": 2, "reelDbId": 16, "formatValue": 20.0, "curlength": 14.5},
                {"monitoringId": 3, "reelDbId": 16, "formatValue": 60.0, "curlength": 15.2},
                {"monitoringId": 4, "reelDbId": 16, "formatValue": 70.0, "curlength": 14.8},
            ],
            tolerance_rows=[
                ToleranceSegment(1, 16, 1, 0.0, 10.0, 1.0, 1.0, None, None, None),
                ToleranceSegment(2, 16, 2, 50.0, 15.0, 1.0, 1.0, None, None, None),
            ],
        )
        self.assertEqual(result["badMonitoringPoints"], 2)
        self.assertEqual(result["goodMonitoringPoints"], 2)
        self.assertEqual(
            [point["outOfRange"] for point in result["points"]],
            [True, True, False, False],
        )

    def test_standard_reel_feet_conversion_short_and_long(self) -> None:
        self.assertAlmostEqual(compute_reel_feet_from_range(0, 100), 320.824, places=3)
        self.assertAlmostEqual(compute_reel_feet_from_range(125.5, 925.5), 2566.592, places=3)

    def test_standard_reel_feet_conversion_invalid_inputs(self) -> None:
        self.assertIsNone(compute_reel_feet_from_range(None, 100))
        self.assertIsNone(compute_reel_feet_from_range(100, None))
        self.assertIsNone(compute_reel_feet_from_range(200, 100))

    def test_build_reel_summary_uses_canonical_feet_and_point_outputs(self) -> None:
        reel = SimpleNamespace(reel_start=10.0, reel_end=110.0)
        repeat = {
            "totalMonitoringPoints": 6,
            "matchedMonitoringPoints": 5,
            "unmatchedMonitoringPoints": 1,
            "goodMonitoringPoints": 3,
            "badMonitoringPoints": 2,
            "badPointPct": 40.0,
            "goodPointPct": 60.0,
            "toleranceSegmentCount": 2,
            "segmentBreakdown": [{"segmentIndex": 1}, {"segmentIndex": 2}],
        }
        summary = self.service.build_reel_summary(reel, repeat)

        self.assertAlmostEqual(summary["feet_total"], 320.824, places=3)
        self.assertEqual(summary["total_monitoring_points"], 6)
        self.assertEqual(summary["matched_monitoring_points"], 5)
        self.assertEqual(summary["unmatched_monitoring_points"], 1)
        self.assertEqual(summary["good_monitoring_points"], 3)
        self.assertEqual(summary["bad_monitoring_points"], 2)
        self.assertAlmostEqual(summary["bad_point_pct"], 40.0, places=3)
        self.assertAlmostEqual(summary["good_point_pct"], 60.0, places=3)
        self.assertAlmostEqual(summary["estimated_bad_feet"], 128.3296, places=3)
        self.assertAlmostEqual(summary["estimated_good_feet"], 192.4944, places=3)
        self.assertEqual(summary["tolerance_segment_count"], 2)
        self.assertEqual(len(summary["segment_breakdown"]), 2)

    def test_build_reel_summary_batch_preserves_per_reel_contract(self) -> None:
        reels = [
            SimpleNamespace(reel_db_id=1, reel_start=0.0, reel_end=100.0),
            SimpleNamespace(reel_db_id=2, reel_start=50.0, reel_end=150.0),
        ]
        repeat_batch = {
            1: {"matchedMonitoringPoints": 2, "goodMonitoringPoints": 2, "badMonitoringPoints": 0, "badPointPct": 0.0, "goodPointPct": 100.0},
            2: {"matchedMonitoringPoints": 4, "goodMonitoringPoints": 1, "badMonitoringPoints": 3, "badPointPct": 75.0, "goodPointPct": 25.0},
        }
        summaries = self.service.build_reel_summary_batch(reels, repeat_batch)

        self.assertEqual(set(summaries.keys()), {1, 2})
        self.assertAlmostEqual(summaries[1]["estimated_bad_feet"], 0.0, places=3)
        self.assertAlmostEqual(summaries[2]["estimated_bad_feet"], 240.618, places=3)
        self.assertAlmostEqual(summaries[2]["estimated_good_feet"], 80.206, places=3)
        self.assertEqual(summaries[2]["matchedMonitoringPoints"], 4)
        self.assertEqual(summaries[2]["badPointPct"], 75.0)


if __name__ == "__main__":
    unittest.main()
