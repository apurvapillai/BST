from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta
from math import sqrt
from typing import Any, Dict, Iterable, List, Optional, Tuple

from sqlalchemy import func
from sqlalchemy.orm import selectinload

from db.rlm_connection import RLMSessionLocal
from db.rlm_models import RLMMachine, RLMMonitoring, RLMReel, RLMTolerance
from services.rlm_reel_footage import MM_PER_FOOT, compute_reel_feet_from_range
from services.rlm_repeat_length_service import RLMRepeatLengthService
DEFAULT_MIN_MONITORING_POINTS_PER_1000_FT = 20.0
ISSUE_CLASSES = {
    "drift": "Repeat Length Drift",
    "bad_feet": "Bad Feet / OOB",
    "speed_instability": "Speed Instability",
    "tolerance_volatility": "Tolerance Volatility",
    "monitoring_quality": "Monitoring/Data Quality",
    "mixed": "Mixed",
}


@dataclass(frozen=True)
class PressIntelligenceFilters:
    """Normalized filters used by the read-only Press Intelligence aggregate."""

    start: datetime
    end: datetime
    job: Optional[str] = None
    min_feet: Optional[float] = None


class RLMPressIntelligenceService:
    """Read-only aggregate service for the RLM Press Intelligence page.

    This service intentionally does not import or call RLMLiveService because that
    service owns live alert scanning/config concerns. This module should only run
    SELECT queries against existing RLM tables and perform in-memory aggregation.
    """

    repeat_length_service = RLMRepeatLengthService()

    def get_press_intelligence(self, filters: PressIntelligenceFilters) -> Dict[str, Any]:
        """Build the full executive payload for press-level RLM comparison.

        Planned payload sections:
        - decisionCards: ranked management-level findings.
        - pressRankings: one row per press for sorting and comparison.
        - heatmap: normalized issue scores by press and issue category.
        - outlierQueue: reel/job/press records that explain the rankings.
        - metadata: filter context and data-quality notes.
        """
        with RLMSessionLocal() as session:
            reels = self._get_reels(session, filters)
            reel_ids = [row.reel_db_id for row in reels]
            repeat_length = self._get_repeat_length_batch(session, reel_ids)

        reel_metrics = self._compute_reel_metrics(
            reels,
            repeat_length,
        )
        press_metrics = self._aggregate_press_metrics(reel_metrics)
        comparisons = self._build_comparisons(press_metrics)
        self._annotate_rank_explanations(press_metrics, comparisons)
        category_leaderboards = self._build_category_leaderboards(press_metrics)
        category_trends = self._build_category_trends(reel_metrics)

        return {
            "decisionCards": self._build_decision_cards(press_metrics, comparisons),
            "pressRankings": press_metrics,
            "overviewRankings": self._build_overview_rankings(category_leaderboards),
            "categoryLeaderboards": category_leaderboards,
            "categoryTrends": category_trends,
            "comparisons": comparisons,
            "heatmap": self._build_heatmap(press_metrics, category_leaderboards),
            "trend": self._build_trend(reel_metrics),
            "outlierQueue": [],
            "outliers": [],
            "metadata": {
                "start": filters.start.isoformat(),
                "end": filters.end.isoformat(),
                "job": filters.job,
                "minFeet": filters.min_feet,
                "readOnly": True,
                "notes": [
                    "Repeat-length quality uses the shared segmented tolerance evaluator for every reel.",
                    "Estimated bad feet and bad-point percentages are derived from the canonical reel summary service.",
                ],
            },
        }

    def _get_reels(self, session, filters: PressIntelligenceFilters) -> List[RLMReel]:
        """Fetch qualifying reels for the requested executive window.

        This method should remain read-only. It is the root query for plant-level
        aggregation and should keep the result set bounded by date, optional job,
        and optional minimum reel feet.
        """
        query = (
            session.query(RLMReel)
            .join(RLMMachine, RLMReel.machine_id == RLMMachine.machine_id)
            .options(selectinload(RLMReel.machine))
            .filter(RLMReel.production_start_dt.isnot(None))
            .filter(RLMReel.production_start_dt >= filters.start)
            .filter(RLMReel.production_start_dt <= filters.end)
            .order_by(RLMMachine.machine_name.asc(), RLMReel.production_start_dt.asc())
        )
        if filters.job:
            query = query.filter(RLMReel.job_name == filters.job)
        if filters.min_feet is not None:
            query = query.filter(RLMReel.reel_start.isnot(None))
            query = query.filter(RLMReel.reel_end.isnot(None))
            query = query.filter(RLMReel.reel_end >= RLMReel.reel_start)
            query = query.filter(((RLMReel.reel_end - RLMReel.reel_start) * RLMReel.format_length) / MM_PER_FOOT >= filters.min_feet)
        return query.all()

    def _get_latest_tolerances(self, session, reel_ids: Iterable[int]) -> Dict[int, Dict[str, Any]]:
        repeat_length = self._get_repeat_length_batch(session, reel_ids)
        return {
            int(reel_id): (item.get("latestTolerance") or {})
            for reel_id, item in repeat_length.items()
        }

    def _get_tolerance_change_counts(self, session, reel_ids: Iterable[int]) -> Dict[int, int]:
        repeat_length = self._get_repeat_length_batch(session, reel_ids)
        return {
            int(reel_id): max(int(item.get("toleranceSegmentCount") or 0) - 1, 0)
            for reel_id, item in repeat_length.items()
        }

    def _get_tolerance_data(self, session, reel_ids: Iterable[int]) -> Dict[int, Dict[str, Any]]:
        """Compatibility wrapper returning latest tolerance plus change count."""
        latest = self._get_latest_tolerances(session, reel_ids)
        changes = self._get_tolerance_change_counts(session, reel_ids)
        return {
            reel_id: {
                "latest": value,
                "toleranceChangeCount": changes.get(reel_id, 0),
            }
            for reel_id, value in latest.items()
        }

    def _get_monitoring_aggregates(self, session, reel_ids: Iterable[int]) -> Dict[int, Dict[str, Any]]:
        repeat_length = self._get_repeat_length_batch(session, reel_ids)
        out: Dict[int, Dict[str, Any]] = {}
        for reel_id, item in repeat_length.items():
            out[int(reel_id)] = {
                "monitorCount": int(item.get("monitoringPointsTotal") or 0),
                "curlengthValues": [
                    float(point.get("curlength"))
                    for point in (item.get("points") or [])
                    if point.get("curlength") is not None
                ],
                "webspeedValues": [
                    float(point.get("webspeed"))
                    for point in (item.get("points") or [])
                    if point.get("webspeed") is not None
                ],
                "avgCurlength": item.get("avgCurlength"),
                "avgWebspeed": item.get("avgWebspeed"),
                "minWebspeed": item.get("minWebspeed"),
                "maxWebspeed": item.get("maxWebspeed"),
                "matchedMonitoringPoints": int(item.get("matchedMonitoringPoints") or 0),
                "unmatchedMonitoringPoints": int(item.get("unmatchedMonitoringPoints") or 0),
                "goodMonitoringPoints": int(item.get("goodMonitoringPoints") or 0),
                "badMonitoringPoints": int(item.get("badMonitoringPoints") or 0),
                "badPointPct": item.get("badPointPct"),
            }
        return out

    def _get_repeat_length_batch(self, session, reel_ids: Iterable[int]) -> Dict[int, Dict[str, Any]]:
        return self.repeat_length_service.fetch_reel_batch(session, reel_ids)

    def _compute_reel_metrics(
        self,
        reels: List[RLMReel],
        repeat_length: Dict[int, Dict[str, Any]],
    ) -> List[Dict[str, Any]]:
        """Compute per-reel metrics from read-only reel, monitoring, and tolerance data.

        Reel quality counts and footage come from the shared repeat-length reel
        summary so press intelligence matches the assistant, /rlm, and live
        dashboard outputs.
        """
        metrics: List[Dict[str, Any]] = []
        for reel in reels:
            reel_repeat = repeat_length.get(reel.reel_db_id, {})
            reel_summary = self.repeat_length_service.build_reel_summary(reel, reel_repeat)
            latest_tolerance = (reel_repeat.get("latestTolerance") or {})
            feet_total = float(reel_summary.get("feet_total") or 0.0)
            monitor_count = int(reel_repeat.get("monitoringPointsTotal") or 0)
            points_per_1000_ft = (monitor_count / feet_total * 1000.0) if feet_total else None
            min_speed = reel_repeat.get("minWebspeed")
            max_speed = reel_repeat.get("maxWebspeed")
            speed_range = (
                max_speed - min_speed
                if min_speed is not None and max_speed is not None
                else None
            )
            nominal = latest_tolerance.get("nominalLength")
            err_shrink = abs(latest_tolerance.get("errShrink") or 0.0) if latest_tolerance else None
            err_expand = abs(latest_tolerance.get("errExpand") or 0.0) if latest_tolerance else None
            delta_count = int(reel_repeat.get("deltaPointCount") or 0)
            oob_count = int(reel_repeat.get("oobPointCount") or 0)
            avg_delta = reel_repeat.get("avgDelta")
            delta_std = reel_repeat.get("deltaStd")
            oob_point_pct = reel_summary.get("bad_point_pct")
            estimated_bad_feet_pct = reel_summary.get("bad_point_pct")
            estimated_bad_feet = reel_summary.get("estimated_bad_feet")
            estimated_good_feet = reel_summary.get("estimated_good_feet")
            tolerance_change_count = max(int(reel_repeat.get("toleranceSegmentCount") or 0) - 1, 0)
            outlier_score = self._compute_reel_outlier_score(
                avg_delta=avg_delta,
                delta_std=delta_std,
                oob_point_pct=oob_point_pct,
                estimated_bad_feet_pct=estimated_bad_feet_pct,
                webspeed_range=speed_range,
                tolerance_change_count=tolerance_change_count,
                points_per_1000_ft=points_per_1000_ft,
            )

            metrics.append(
                {
                    "machineId": reel.machine_id,
                    "machineName": reel.machine.machine_name if reel.machine else f"Press {reel.machine_id}",
                    "reelDbId": reel.reel_db_id,
                    "reelId": reel.reel_id,
                    "jobName": reel.job_name,
                    "orderNumber": reel.order_number,
                    "productionStart": reel.production_start_dt.isoformat() if reel.production_start_dt else None,
                    "feetTotal": feet_total,
                    "estimatedGoodFeet": round(float(estimated_good_feet), 3) if estimated_good_feet is not None else None,
                    "monitoringPointsTotal": monitor_count,
                    "matchedMonitoringPoints": int(reel_summary.get("matched_monitoring_points") or 0),
                    "unmatchedMonitoringPoints": int(reel_summary.get("unmatched_monitoring_points") or 0),
                    "goodMonitoringPoints": int(reel_summary.get("good_monitoring_points") or 0),
                    "badMonitoringPoints": int(reel_summary.get("bad_monitoring_points") or 0),
                    "goodPointPct": round(float(reel_summary.get("good_point_pct")), 3) if reel_summary.get("good_point_pct") is not None else None,
                    "deltaPointCount": delta_count,
                    "oobPointCount": oob_count,
                    "pointsPer1000Ft": points_per_1000_ft,
                    "avgCurlength": reel_repeat.get("avgCurlength"),
                    "nominalLength": nominal,
                    "avgDelta": avg_delta,
                    "avgAbsDelta": reel_repeat.get("avgAbsDelta"),
                    "deltaStd": delta_std,
                    "deltaSum": None,
                    "deltaSumSq": None,
                    "oobPointPct": round(oob_point_pct, 3) if oob_point_pct is not None else None,
                    "estimatedBadFeetPct": round(estimated_bad_feet_pct, 3) if estimated_bad_feet_pct is not None else None,
                    "estimatedBadFeet": round(estimated_bad_feet, 3) if estimated_bad_feet is not None else None,
                    "avgWebspeed": reel_repeat.get("avgWebspeed"),
                    "webspeedRange": speed_range,
                    "toleranceChangeCount": tolerance_change_count,
                    "toleranceSegmentCount": int(reel_repeat.get("toleranceSegmentCount") or 0),
                    "repeatLengthDebug": {
                        "segmentBreakdown": reel_repeat.get("segmentBreakdown") or [],
                    },
                    "outlierScore": outlier_score,
                }
            )
        return metrics

    def _aggregate_press_metrics(self, reel_metrics: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        """Roll up per-reel metrics into one executive row per press."""
        by_press: Dict[int, List[Dict[str, Any]]] = {}
        for row in reel_metrics:
            by_press.setdefault(int(row["machineId"]), []).append(row)

        rankings: List[Dict[str, Any]] = []
        for machine_id, rows in by_press.items():
            jobs = {row.get("jobName") for row in rows if row.get("jobName")}
            total_feet = sum(float(row.get("feetTotal") or 0.0) for row in rows)
            total_bad_feet = sum(float(row.get("estimatedBadFeet") or 0.0) for row in rows)
            total_good_feet = sum(float(row.get("estimatedGoodFeet") or 0.0) for row in rows)
            total_delta_points = sum(int(row.get("deltaPointCount") or 0) for row in rows)
            total_oob_points = sum(int(row.get("oobPointCount") or 0) for row in rows)
            total_monitor_points = sum(int(row.get("monitoringPointsTotal") or 0) for row in rows)
            total_matched_monitor_points = sum(int(row.get("matchedMonitoringPoints") or 0) for row in rows)
            total_good_monitor_points = sum(int(row.get("goodMonitoringPoints") or 0) for row in rows)
            total_bad_monitor_points = sum(int(row.get("badMonitoringPoints") or 0) for row in rows)
            total_unmatched_monitor_points = sum(int(row.get("unmatchedMonitoringPoints") or 0) for row in rows)
            avg_delta = self._weighted_mean(rows, "avgDelta", "deltaPointCount")
            avg_webspeed = self._weighted_mean(rows, "avgWebspeed", "monitoringPointsTotal")
            delta_std = self._combined_stddev(rows)
            oob_pct = (total_bad_monitor_points / total_matched_monitor_points * 100.0) if total_matched_monitor_points else None
            good_point_pct = (total_good_monitor_points / total_matched_monitor_points * 100.0) if total_matched_monitor_points else None
            bad_feet_pct = (total_bad_feet / total_feet * 100.0) if total_feet else None
            points_per_1000_ft = (total_monitor_points / total_feet * 1000.0) if total_feet else None
            tolerance_changes = sum(int(row.get("toleranceChangeCount") or 0) for row in rows)
            speed_ranges = [row.get("webspeedRange") for row in rows if row.get("webspeedRange") is not None]
            avg_speed_range = self._mean(speed_ranges)
            median_speed_range = self._median(speed_ranges)
            impact_score = self._compute_impact_score(rows)
            rankings.append(
                {
                    "machineId": machine_id,
                    "machineName": rows[0].get("machineName"),
                    "jobsRun": len(jobs),
                    "reelsRun": len(rows),
                    "feetTotal": round(total_feet, 3),
                    "estimatedGoodFeet": round(total_good_feet, 3),
                    "monitoringPointsTotal": total_monitor_points,
                    "matchedMonitoringPoints": total_matched_monitor_points,
                    "unmatchedMonitoringPoints": total_unmatched_monitor_points,
                    "goodMonitoringPoints": total_good_monitor_points,
                    "badMonitoringPoints": total_bad_monitor_points,
                    "avgDelta": avg_delta,
                    "deltaStd": delta_std,
                    "oobPointPct": round(oob_pct, 3) if oob_pct is not None else None,
                    "goodPointPct": round(good_point_pct, 3) if good_point_pct is not None else None,
                    "estimatedBadFeetPct": round(bad_feet_pct, 3) if bad_feet_pct is not None else None,
                    "estimatedBadFeet": round(total_bad_feet, 3),
                    "avgWebspeed": avg_webspeed,
                    "avgSpeedRange": avg_speed_range,
                    "medianSpeedRange": median_speed_range,
                    "webspeedRange": avg_speed_range,
                    "toleranceChangeCount": tolerance_changes,
                    "pointsPer1000Ft": round(points_per_1000_ft, 3) if points_per_1000_ft is not None else None,
                    "impactScore": impact_score,
                    "issueClass": self._classify_issue(rows),
                }
            )
        rankings.sort(key=lambda row: row.get("impactScore") or 0, reverse=True)
        return rankings

    def _build_decision_cards(
        self,
        press_metrics: List[Dict[str, Any]],
        comparisons: Dict[str, Any],
    ) -> List[Dict[str, Any]]:
        """Build paired best-vs-worst cards that explain scale and urgency."""
        if not press_metrics:
            return []
        cards: List[Dict[str, Any]] = []
        comparison_map = {item.get("key"): item for item in comparisons.get("items", [])}
        card_specs = [
            ("monitoring_coverage", "Monitoring coverage", "Lower coverage means weaker defect visibility."),
            ("bad_feet_pct", "Bad material spread", "Worst estimated bad-foot rate vs the cleanest press."),
            ("bad_feet", "Bad material feet", "Total estimated bad feet shows the production-size impact."),
            ("speed_instability", "Speed stability", "Average per-reel speed swing identifies unstable running behavior."),
            ("delta_variation", "Repeat-length variation", "Higher delta variation means repeat length is less consistent."),
        ]
        for key, title, detail in card_specs:
            comparison = comparison_map.get(key)
            if not comparison:
                continue
            cards.append(
                {
                    "kind": "comparison",
                    "key": key,
                    "title": title,
                    "severity": comparison.get("severity", "info"),
                    "detail": detail,
                    "best": comparison.get("bestPress"),
                    "worst": comparison.get("worstPress"),
                    "bestLabel": comparison.get("bestLabel", "Best"),
                    "worstLabel": comparison.get("worstLabel", "Worst"),
                    "unit": comparison.get("unit"),
                }
            )
        return cards[:5]

    def _build_comparisons(self, press_metrics: List[Dict[str, Any]]) -> Dict[str, Any]:
        """Build reusable best-vs-worst press comparisons for the UI and explanations."""
        items = [
            self._metric_comparison(
                press_metrics,
                key="bad_feet_pct",
                label="Bad feet %",
                value_key="estimatedBadFeetPct",
                unit="%",
                lower_is_better=True,
                best_label="Best",
                worst_label="Worst",
            ),
            self._metric_comparison(
                press_metrics,
                key="bad_feet",
                label="Bad feet",
                value_key="estimatedBadFeet",
                unit="ft",
                lower_is_better=True,
                best_label="Lowest",
                worst_label="Highest",
            ),
            self._metric_comparison(
                press_metrics,
                key="monitoring_coverage",
                label="Monitoring coverage",
                value_key="pointsPer1000Ft",
                unit="pts/1k ft",
                lower_is_better=False,
                best_label="Highest",
                worst_label="Lowest",
            ),
            self._metric_comparison(
                press_metrics,
                key="speed_instability",
                label="Speed instability",
                value_key="avgSpeedRange",
                unit="speed swing/reel",
                lower_is_better=True,
                best_label="Most stable",
                worst_label="Most unstable",
            ),
            self._metric_comparison(
                press_metrics,
                key="delta_variation",
                label="Delta variation",
                value_key="deltaStd",
                unit="mm std",
                lower_is_better=True,
                best_label="Most consistent",
                worst_label="Most variable",
            ),
        ]
        return {"items": [item for item in items if item is not None]}

    def _build_category_leaderboards(self, press_metrics: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        """Build per-category press rankings with explicit best/worst rank direction."""
        specs = [
            {
                "key": "monitoring_coverage",
                "title": "Monitoring Coverage",
                "metricKey": "pointsPer1000Ft",
                "sort": "desc",
                "rankOrientation": "best_to_worst",
                "meaning": "Highest to lowest monitoring coverage",
                "helpText": "Monitoring coverage is monitoring points per 1,000 ft. Higher coverage is better; lower coverage means weaker defect visibility.",
                "formatter": self._format_coverage,
            },
            {
                "key": "bad_feet_pct",
                "title": "Bad Feet %",
                "metricKey": "estimatedBadFeetPct",
                "sort": "asc",
                "rankOrientation": "best_to_worst",
                "meaning": "Lowest to highest estimated bad-foot rate",
                "helpText": "Bad Feet % estimates what share of footage was outside repeat-length bounds. Higher is worse.",
                "formatter": self._format_pct,
            },
            {
                "key": "bad_feet",
                "title": "Bad Feet (ft)",
                "metricKey": "estimatedBadFeet",
                "sort": "asc",
                "rankOrientation": "best_to_worst",
                "meaning": "Lowest to highest estimated bad feet",
                "helpText": "Bad Feet (ft) estimates total footage outside repeat-length bounds. Higher is worse.",
                "formatter": self._format_feet,
            },
            {
                "key": "delta_variation",
                "title": "Repeat Length Variation",
                "metricKey": "deltaStd",
                "sort": "asc",
                "rankOrientation": "best_to_worst",
                "meaning": "Lowest to highest delta standard deviation",
                "helpText": "Variation measures how much repeat length bounces around its average. Higher is less stable.",
                "formatter": self._format_mm,
            },
            {
                "key": "delta_drift",
                "title": "Repeat Length Drift",
                "metricKey": "avgDelta",
                "sort": "abs_asc",
                "rankOrientation": "best_to_worst",
                "meaning": "Lowest absolute average delta to highest",
                "helpText": "Drift measures how far the press runs from nominal on average. Higher absolute drift means it is consistently farther from target.",
                "formatter": self._format_mm,
            },
            {
                "key": "speed_instability",
                "title": "Speed Instability",
                "metricKey": "avgSpeedRange",
                "sort": "asc",
                "rankOrientation": "best_to_worst",
                "meaning": "Lowest to highest average per-reel speed swing",
                "helpText": "Speed instability is the average max-to-min webspeed swing inside each reel. Higher means less stable speed control.",
                "formatter": self._format_speed_swing,
            },
            {
                "key": "tolerance_changes",
                "title": "Tolerance Changes",
                "metricKey": "toleranceChangeCount",
                "sort": "asc",
                "rankOrientation": "best_to_worst",
                "meaning": "Lowest to highest tolerance-change count",
                "helpText": "Tolerance changes count in-reel tolerance edits. Higher can indicate setup or process volatility.",
                "formatter": self._format_change_count,
            },
        ]

        leaderboards = []
        for spec in specs:
            rows = [row for row in press_metrics if row.get(spec["metricKey"]) is not None]
            if spec["sort"] == "asc":
                rows.sort(key=lambda row: float(row.get(spec["metricKey"]) or 0.0))
            elif spec["sort"] == "abs_desc":
                rows.sort(key=lambda row: abs(float(row.get(spec["metricKey"]) or 0.0)), reverse=True)
            elif spec["sort"] == "abs_asc":
                rows.sort(key=lambda row: abs(float(row.get(spec["metricKey"]) or 0.0)))
            else:
                rows.sort(key=lambda row: float(row.get(spec["metricKey"]) or 0.0), reverse=True)

            values = [abs(float(row.get(spec["metricKey"]) or 0.0)) if spec["sort"] in {"abs_desc", "abs_asc"} else float(row.get(spec["metricKey"]) or 0.0) for row in rows]
            plant_avg = self._mean(values)
            items = []
            for rank, row in enumerate(rows, start=1):
                raw_value = row.get(spec["metricKey"])
                comparison_value = abs(float(raw_value or 0.0)) if spec["sort"] in {"abs_desc", "abs_asc"} else float(raw_value or 0.0)
                average_position = self._leaderboard_average_position(comparison_value, plant_avg)
                items.append(
                    {
                        "rank": rank,
                        "machineId": row.get("machineId"),
                        "machineName": row.get("machineName"),
                        "rawValue": raw_value,
                        "valueDisplay": spec["formatter"](raw_value),
                        "averagePosition": average_position,
                        "contextLabel": self._leaderboard_context(
                            rank,
                            len(rows),
                            comparison_value,
                            plant_avg,
                            spec["sort"],
                            spec["rankOrientation"],
                        ),
                    }
                )
            leaderboards.append(
                {
                    "key": spec["key"],
                    "title": spec["title"],
                    "averageRaw": plant_avg,
                    "averageDisplay": spec["formatter"](plant_avg),
                    "sortMeaning": spec["meaning"],
                    "rankOrientation": spec["rankOrientation"],
                    "helpText": spec["helpText"],
                    "items": items,
                }
            )
        return leaderboards

    def _build_overview_rankings(self, category_leaderboards: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        """Build best-to-worst overall press ranking from category positions.

        Category leaderboards rank worst-to-best, so this converts each category
        position to a best-oriented position where 1 is best before averaging.
        """
        by_machine: Dict[int, Dict[str, Any]] = {}
        for board in category_leaderboards:
            items = board.get("items", [])
            total_items = len(items)
            if total_items <= 0:
                continue
            for item in items:
                machine_id = item.get("machineId")
                if machine_id is None:
                    continue
                rank = int(item.get("rank") or total_items)
                best_oriented_position = (
                    rank
                    if board.get("rankOrientation") == "best_to_worst"
                    else total_items - rank + 1
                )
                bucket = by_machine.setdefault(
                    int(machine_id),
                    {
                        "machineId": machine_id,
                        "machineName": item.get("machineName"),
                        "positionTotal": 0.0,
                        "categoryCount": 0,
                        "categoryRanks": [],
                    },
                )
                bucket["positionTotal"] += best_oriented_position
                bucket["categoryCount"] += 1
                bucket["categoryRanks"].append(
                    {
                        "key": board.get("key"),
                        "title": board.get("title"),
                        "rank": rank,
                        "bestOrientedRank": best_oriented_position,
                        "valueDisplay": item.get("valueDisplay"),
                    }
                )

        rows = []
        for item in by_machine.values():
            category_count = int(item.get("categoryCount") or 0)
            if category_count <= 0:
                continue
            average_position = item["positionTotal"] / category_count
            rows.append(
                {
                    "machineId": item.get("machineId"),
                    "machineName": item.get("machineName"),
                    "averageCategoryPosition": round(average_position, 2),
                    "categoryCount": category_count,
                    "categoryRanks": item.get("categoryRanks", []),
                }
            )
        rows.sort(key=lambda row: (row.get("averageCategoryPosition") or 999.0, row.get("machineName") or ""))
        for rank, row in enumerate(rows, start=1):
            row["rank"] = rank
        return rows

    def _metric_comparison(
        self,
        press_metrics: List[Dict[str, Any]],
        *,
        key: str,
        label: str,
        value_key: str,
        unit: str,
        lower_is_better: bool,
        best_label: str,
        worst_label: str,
    ) -> Optional[Dict[str, Any]]:
        """Return best and worst press records for one comparable metric."""
        rows = [row for row in press_metrics if row.get(value_key) is not None]
        if not rows:
            return None
        best = min(rows, key=lambda row: row.get(value_key) or 0.0) if lower_is_better else max(rows, key=lambda row: row.get(value_key) or 0.0)
        worst = max(rows, key=lambda row: row.get(value_key) or 0.0) if lower_is_better else min(rows, key=lambda row: row.get(value_key) or 0.0)
        return {
            "key": key,
            "label": label,
            "valueKey": value_key,
            "unit": unit,
            "lowerIsBetter": lower_is_better,
            "bestLabel": best_label,
            "worstLabel": worst_label,
            "bestPress": self._comparison_press(best, value_key),
            "worstPress": self._comparison_press(worst, value_key),
            "severity": self._comparison_severity(key, worst.get(value_key)),
        }

    def _comparison_press(self, row: Dict[str, Any], value_key: str) -> Dict[str, Any]:
        """Serialize the compact press fields needed for comparison cards."""
        return {
            "machineId": row.get("machineId"),
            "machineName": row.get("machineName"),
            "value": row.get(value_key),
            "feetTotal": row.get("feetTotal"),
            "estimatedBadFeet": row.get("estimatedBadFeet"),
            "estimatedBadFeetPct": row.get("estimatedBadFeetPct"),
            "avgSpeedRange": row.get("avgSpeedRange"),
            "medianSpeedRange": row.get("medianSpeedRange"),
            "deltaStd": row.get("deltaStd"),
            "pointsPer1000Ft": row.get("pointsPer1000Ft"),
            "reelsRun": row.get("reelsRun"),
            "issueClass": row.get("issueClass"),
        }

    def _comparison_severity(self, key: str, value: Optional[float]) -> str:
        """Map comparison values to display severity without exposing impact score."""
        number = float(value or 0.0)
        if key in {"bad_feet_pct"}:
            return "critical" if number >= 10 else "warning" if number >= 3 else "info"
        if key == "speed_instability":
            return "warning" if number >= 30 else "info"
        if key == "monitoring_coverage":
            return "warning" if number < DEFAULT_MIN_MONITORING_POINTS_PER_1000_FT else "info"
        if key == "delta_variation":
            return "warning" if number >= 0.5 else "info"
        return "info"

    def _annotate_rank_explanations(
        self,
        press_metrics: List[Dict[str, Any]],
        comparisons: Dict[str, Any],
    ) -> None:
        """Attach plain-English ranking explanations to each press row."""
        comparison_by_key = {item.get("key"): item for item in comparisons.get("items", [])}
        best_bad_pct = self._comparison_value(comparison_by_key, "bad_feet_pct", "bestPress")
        best_speed = self._comparison_value(comparison_by_key, "speed_instability", "bestPress")
        best_coverage = self._comparison_value(comparison_by_key, "monitoring_coverage", "bestPress")
        best_delta_std = self._comparison_value(comparison_by_key, "delta_variation", "bestPress")

        for index, row in enumerate(press_metrics, start=1):
            row["rank"] = index
            issue = row.get("issueClass") or ISSUE_CLASSES["mixed"]
            if issue == ISSUE_CLASSES["bad_feet"]:
                row["rankExplanation"] = (
                    f"Ranks #{index} because bad-feet rate is {self._format_pct(row.get('estimatedBadFeetPct'))}"
                    f" vs best {self._format_pct(best_bad_pct)}."
                )
            elif issue == ISSUE_CLASSES["speed_instability"]:
                row["rankExplanation"] = (
                    f"Ranks #{index} because average speed swing is {self._format_number(row.get('avgSpeedRange'))}"
                    f" vs most stable {self._format_number(best_speed)}."
                )
            elif issue == ISSUE_CLASSES["monitoring_quality"]:
                row["rankExplanation"] = (
                    f"Ranks #{index} because monitoring coverage is {self._format_number(row.get('pointsPer1000Ft'))}"
                    f" pts/1k ft vs best {self._format_number(best_coverage)}."
                )
            elif issue == ISSUE_CLASSES["tolerance_volatility"]:
                row["rankExplanation"] = (
                    f"Ranks #{index} because it had {self._format_count(row.get('toleranceChangeCount'))}"
                    " tolerance changes in the selected window."
                )
            else:
                row["rankExplanation"] = (
                    f"Ranks #{index} because delta variation is {self._format_mm(row.get('deltaStd'))}"
                    f" vs best {self._format_mm(best_delta_std)}."
                )

    def _comparison_value(
        self,
        comparison_by_key: Dict[str, Dict[str, Any]],
        key: str,
        side: str,
    ) -> Optional[float]:
        """Safely read a metric value from a comparison object."""
        item = comparison_by_key.get(key) or {}
        press = item.get(side) or {}
        return press.get("value")

    def _build_heatmap(
        self,
        press_metrics: List[Dict[str, Any]],
        category_leaderboards: Optional[List[Dict[str, Any]]] = None,
    ) -> Dict[str, Any]:
        """Build average-relative risk values for the executive heatmap."""
        columns = [
            {"key": "monitoring_coverage", "label": "Monitoring Coverage", "metricKey": "pointsPer1000Ft", "direction": "higher_better"},
            {"key": "bad_feet_pct", "label": "Bad Feet %", "metricKey": "estimatedBadFeetPct", "direction": "lower_better"},
            {"key": "bad_feet", "label": "Bad Feet", "metricKey": "estimatedBadFeet", "direction": "lower_better"},
            {"key": "delta_variation", "label": "Repeat Length Variation", "metricKey": "deltaStd", "direction": "lower_better"},
            {"key": "delta_drift", "label": "Repeat Length Drift", "metricKey": "avgDelta", "direction": "abs_lower_better"},
            {"key": "speed_instability", "label": "Speed Instability", "metricKey": "avgSpeedRange", "direction": "lower_better"},
            {"key": "tolerance_changes", "label": "Tolerance Changes", "metricKey": "toleranceChangeCount", "direction": "lower_better"},
        ]
        averages_by_key = {
            board.get("key"): board.get("averageRaw")
            for board in (category_leaderboards or [])
        }

        def average_relative_risk(value: Optional[float], plant_avg: Optional[float], direction: str) -> float:
            """Return 0..1 risk based on how far a value is worse than average."""
            if value is None or plant_avg is None:
                return 0.0
            number = float(value)
            average = float(plant_avg)
            if average <= 0:
                return 0.0 if number <= 0 else 1.0
            if direction == "higher_better":
                if number >= average:
                    return 0.0
                return round(min(((average - number) / average) / 0.5, 1.0), 3)
            if number <= average:
                return 0.0
            return round(min(((number - average) / average) / 0.5, 1.0), 3)

        raw_rows = []
        for row in press_metrics:
            raw_values = {}
            risk_values = {}
            for column in columns:
                metric_value = row.get(column["metricKey"])
                comparable_value = abs(float(metric_value or 0.0)) if column["direction"] == "abs_lower_better" else metric_value
                raw_values[column["key"]] = comparable_value if comparable_value is not None else 0.0
                risk_values[column["key"]] = average_relative_risk(
                    comparable_value,
                    averages_by_key.get(column["key"]),
                    column["direction"],
                )
            raw_rows.append(
                {
                    "machineId": row.get("machineId"),
                    "machineName": row.get("machineName"),
                    "raw": raw_values,
                    "risk": risk_values,
                }
            )
        raw_rows.sort(key=lambda item: self._press_sort_key(item.get("machineName"), item.get("machineId")))
        rows = [
            {
                "machineId": item.get("machineId"),
                "machineName": item.get("machineName"),
                "values": item["risk"],
                "rawValues": item["raw"],
            }
            for item in raw_rows
        ]
        return {"columns": columns, "rows": rows}

    def _build_trend(self, reel_metrics: List[Dict[str, Any]]) -> Dict[str, Any]:
        """Build a compact plant-level daily quality trend from reel metrics.

        The trend is read-only and derived from the same selected reels as the
        ranking table. It intentionally stays small: one point per production
        date with bad-feet %, OOB %, and average absolute delta.
        """
        by_date: Dict[str, Dict[str, Any]] = {}
        for row in reel_metrics:
            start_raw = row.get("productionStart")
            if not start_raw:
                continue
            date_key = str(start_raw)[:10]
            bucket = by_date.setdefault(
                date_key,
                {
                    "date": date_key,
                    "reelsRun": 0,
                    "feetTotal": 0.0,
                    "estimatedBadFeet": 0.0,
                    "oobPointCount": 0,
                    "deltaPointCount": 0,
                    "absDeltaWeightedSum": 0.0,
                    "absDeltaWeight": 0,
                },
            )
            feet_total = float(row.get("feetTotal") or 0.0)
            bad_feet = float(row.get("estimatedBadFeet") or 0.0)
            delta_points = int(row.get("deltaPointCount") or 0)
            avg_abs_delta = row.get("avgAbsDelta")
            bucket["reelsRun"] += 1
            bucket["feetTotal"] += feet_total
            bucket["estimatedBadFeet"] += bad_feet
            bucket["oobPointCount"] += int(row.get("oobPointCount") or 0)
            bucket["deltaPointCount"] += delta_points
            if avg_abs_delta is not None and delta_points > 0:
                bucket["absDeltaWeightedSum"] += float(avg_abs_delta) * delta_points
                bucket["absDeltaWeight"] += delta_points

        points = []
        for bucket in sorted(by_date.values(), key=lambda item: item["date"]):
            feet_total = bucket["feetTotal"]
            delta_points = bucket["deltaPointCount"]
            abs_delta_weight = bucket["absDeltaWeight"]
            points.append(
                {
                    "date": bucket["date"],
                    "reelsRun": bucket["reelsRun"],
                    "feetTotal": round(feet_total, 3),
                    "estimatedBadFeet": round(bucket["estimatedBadFeet"], 3),
                    "estimatedBadFeetPct": (
                        round(bucket["estimatedBadFeet"] / feet_total * 100.0, 3)
                        if feet_total
                        else None
                    ),
                    "oobPointPct": (
                        round(bucket["oobPointCount"] / delta_points * 100.0, 3)
                        if delta_points
                        else None
                    ),
                    "avgAbsDelta": (
                        round(bucket["absDeltaWeightedSum"] / abs_delta_weight, 3)
                        if abs_delta_weight
                        else None
                    ),
                }
            )
        return {
            "plantQuality": points,
            "metric": "estimatedBadFeetPct",
            "label": "Daily estimated bad feet %",
        }

    def _build_category_trends(self, reel_metrics: List[Dict[str, Any]]) -> Dict[str, Any]:
        """Build compact daily category trends from selected reel metrics.

        The payload is derived from the same in-memory reel metrics as the rest
        of the page. "All" mode includes stacked per-press daily segments for
        each category, while individual press mode includes one daily bar series
        per category plus a short operator-readable summary.
        """
        categories = [
            {
                "key": "monitoring_coverage",
                "title": "Monitoring Coverage",
                "unit": "pts/1k ft",
                "direction": "higher_better",
                "description": "Shows monitoring points per 1,000 ft. Higher means stronger defect visibility.",
            },
            {
                "key": "bad_feet_pct",
                "title": "Bad Feet %",
                "unit": "%",
                "direction": "lower_better",
                "description": "Estimated share of footage outside repeat-length bounds. Lower is better.",
            },
            {
                "key": "bad_feet",
                "title": "Bad Feet",
                "unit": "ft",
                "direction": "lower_better",
                "description": "Estimated footage outside repeat-length bounds. Lower means less material at risk.",
            },
            {
                "key": "total_feet",
                "title": "Total Feet",
                "unit": "ft",
                "direction": "higher_better",
                "description": "Total production footage in the selected window. This gives volume context for the quality trends.",
            },
            {
                "key": "delta_variation",
                "title": "Repeat Length Variation",
                "unit": "mm",
                "direction": "lower_better",
                "description": "Repeat-length standard deviation. Lower means the press is running more consistently.",
            },
            {
                "key": "delta_drift",
                "title": "Repeat Length Drift",
                "unit": "mm",
                "direction": "lower_better",
                "description": "Absolute average distance from nominal repeat length. Lower means closer to target.",
            },
            {
                "key": "speed_instability",
                "title": "Speed Instability",
                "unit": "avg/reel",
                "direction": "lower_better",
                "description": "Average per-reel max-to-min webspeed swing. Lower means steadier speed control.",
            },
            {
                "key": "tolerance_changes",
                "title": "Tolerance Changes",
                "unit": "changes",
                "direction": "lower_better",
                "description": "Tolerance edits during selected production. Lower means less setup/process volatility.",
            },
        ]
        machines: Dict[int, Dict[str, Any]] = {}
        all_by_date: Dict[str, List[Dict[str, Any]]] = {}
        press_by_date: Dict[int, Dict[str, List[Dict[str, Any]]]] = {}

        for row in reel_metrics:
            start_raw = row.get("productionStart")
            machine_id = row.get("machineId")
            if not start_raw or machine_id is None:
                continue
            date_key = str(start_raw)[:10]
            machine_id = int(machine_id)
            machines.setdefault(
                machine_id,
                {
                    "machineId": machine_id,
                    "machineName": row.get("machineName") or f"Press {machine_id}",
                },
            )
            all_by_date.setdefault(date_key, []).append(row)
            press_by_date.setdefault(machine_id, {}).setdefault(date_key, []).append(row)

        press_list = sorted(
            machines.values(),
            key=lambda item: self._press_sort_key(item.get("machineName"), item.get("machineId")),
        )

        all_series: Dict[str, List[Dict[str, Any]]] = {category["key"]: [] for category in categories}
        all_summary: Dict[str, Dict[str, str]] = {}
        for category in categories:
            key = category["key"]
            series = []
            for date_key in sorted(all_by_date):
                rows = all_by_date[date_key]
                segments = []
                for press in press_list:
                    segment_rows = [
                        row for row in rows if int(row.get("machineId") or 0) == int(press["machineId"])
                    ]
                    if not segment_rows:
                        continue
                    value = self._trend_category_value(key, segment_rows)
                    if value is None:
                        continue
                    segments.append(
                        {
                            "machineId": press["machineId"],
                            "machineName": press["machineName"],
                            "value": round(float(value), 3),
                            "valueDisplay": self._format_trend_value(key, value),
                        }
                    )
                value = self._trend_category_value(key, rows)
                series.append(
                    {
                        "date": date_key,
                        "value": round(float(value), 3) if value is not None else None,
                        "valueDisplay": self._format_trend_value(key, value),
                        "segments": segments,
                    }
                )
            all_series[key] = series
            all_summary[key] = self._trend_summary(category, series, all_mode=True)

        by_press: Dict[str, Dict[str, Any]] = {}
        for press in press_list:
            machine_id = int(press["machineId"])
            press_series: Dict[str, List[Dict[str, Any]]] = {category["key"]: [] for category in categories}
            press_summary: Dict[str, Dict[str, str]] = {}
            by_date = press_by_date.get(machine_id, {})
            for category in categories:
                key = category["key"]
                series = []
                for date_key in sorted(by_date):
                    value = self._trend_category_value(key, by_date[date_key])
                    series.append(
                        {
                            "date": date_key,
                            "value": round(float(value), 3) if value is not None else None,
                            "valueDisplay": self._format_trend_value(key, value),
                        }
                    )
                press_series[key] = series
                press_summary[key] = self._trend_summary(category, series, all_mode=False)
            by_press[str(machine_id)] = {
                "machineId": machine_id,
                "machineName": press["machineName"],
                "series": press_series,
                "summary": press_summary,
            }

        return {
            "presses": press_list,
            "categories": categories,
            "all": {
                "label": "All Presses",
                "series": all_series,
                "summary": all_summary,
            },
            "byPress": by_press,
        }

    def _trend_category_value(self, key: str, rows: List[Dict[str, Any]]) -> Optional[float]:
        """Compute one category value for a date/press bucket."""
        if not rows:
            return None
        total_feet = sum(float(row.get("feetTotal") or 0.0) for row in rows)
        if key == "monitoring_coverage":
            points = sum(int(row.get("monitoringPointsTotal") or 0) for row in rows)
            return points / total_feet * 1000.0 if total_feet else None
        if key == "bad_feet_pct":
            bad_feet = sum(float(row.get("estimatedBadFeet") or 0.0) for row in rows)
            return bad_feet / total_feet * 100.0 if total_feet else None
        if key == "bad_feet":
            return sum(float(row.get("estimatedBadFeet") or 0.0) for row in rows)
        if key == "total_feet":
            return total_feet
        if key == "delta_variation":
            return self._combined_stddev(rows)
        if key == "delta_drift":
            value = self._weighted_mean(rows, "avgDelta", "deltaPointCount")
            return abs(value) if value is not None else None
        if key == "speed_instability":
            return self._mean([row.get("webspeedRange") for row in rows])
        if key == "tolerance_changes":
            return float(sum(int(row.get("toleranceChangeCount") or 0) for row in rows))
        return None

    def _trend_summary(
        self,
        category: Dict[str, Any],
        series: List[Dict[str, Any]],
        *,
        all_mode: bool,
    ) -> Dict[str, str]:
        """Build a short explanatory summary for one trend card."""
        values = [float(point["value"]) for point in series if point.get("value") is not None]
        if not values:
            return {
                "headline": "No usable trend data",
                "detail": category.get("description", ""),
            }
        first = values[0]
        last = values[-1]
        average = sum(values) / len(values)
        direction_text = self._trend_direction_text(first, last, category.get("direction"))
        scope = "Plant" if all_mode else "Selected press"
        return {
            "headline": f"{scope} {direction_text}",
            "detail": (
                f"Window average {self._format_trend_value(category['key'], average)}. "
                f"Latest day {self._format_trend_value(category['key'], last)}. "
                f"{category.get('description', '')}"
            ),
        }

    def _trend_direction_text(self, first: float, last: float, direction: Optional[str]) -> str:
        """Describe whether the trend improved, worsened, or stayed flat."""
        delta = last - first
        if abs(delta) < 0.001:
            return "stayed flat"
        lower_better = direction != "higher_better"
        worsened = delta > 0 if lower_better else delta < 0
        verb = "worsened" if worsened else "improved"
        return f"{verb} from first to last day"

    def _format_trend_value(self, key: str, value: Optional[float]) -> str:
        """Format a category trend value with operator-friendly units."""
        if value is None:
            return "--"
        if key == "monitoring_coverage":
            return self._format_coverage(value)
        if key == "bad_feet_pct":
            return self._format_pct(value)
        if key == "bad_feet":
            return self._format_feet(value)
        if key == "total_feet":
            return self._format_feet(value)
        if key in {"delta_variation", "delta_drift"}:
            return self._format_mm(value)
        if key == "speed_instability":
            return self._format_speed_swing(value)
        if key == "tolerance_changes":
            return self._format_change_count(value)
        return self._format_number(value)

    def _build_outlier_queue(self, reel_metrics: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        """Rank reel/job/press records that should explain executive decisions."""
        outliers = []
        for row in reel_metrics:
            if (row.get("outlierScore") or 0) <= 0:
                continue
            issue = self._classify_issue([row])
            detail_parts = []
            if row.get("estimatedBadFeetPct") is not None:
                detail_parts.append(f"{self._format_pct(row.get('estimatedBadFeetPct'))} estimated bad feet")
            if row.get("avgDelta") is not None:
                detail_parts.append(f"avg delta {self._format_mm(row.get('avgDelta'))}")
            if row.get("deltaStd") is not None:
                detail_parts.append(f"delta std {self._format_mm(row.get('deltaStd'))}")
            if row.get("toleranceChangeCount"):
                detail_parts.append(f"{row.get('toleranceChangeCount')} tolerance changes")
            if row.get("pointsPer1000Ft") is not None:
                detail_parts.append(f"{self._format_number(row.get('pointsPer1000Ft'))} pts/1000ft")
            if row.get("webspeedRange") is not None:
                detail_parts.append(f"speed range {self._format_number(row.get('webspeedRange'))}")
                outliers.append(
                    self._outlier_payload(row, issue, " · ".join(detail_parts))
                )
            elif detail_parts:
                outliers.append(self._outlier_payload(row, issue, " · ".join(detail_parts)))
        outliers.sort(key=lambda row: row.get("score") or 0, reverse=True)
        return outliers[:20]

    def _compute_impact_score(self, rows: List[Dict[str, Any]]) -> float:
        """Compute a composite executive impact score for press ranking.

        Formula components are capped so one extreme metric does not dominate:
        - estimated bad feet %: 35% weight, capped at 20%.
        - OOB point %: 25% weight, capped at 20%.
        - delta std dev: 15% weight, capped at 2 mm.
        - tolerance changes per reel: 10% weight, capped at 2/reel.
        - monitoring penalty: 10% weight for coverage below 20 pts/1000ft.
        - average per-reel webspeed range: 5% weight, capped at 40 speed units.
        """
        total_feet = sum(float(row.get("feetTotal") or 0.0) for row in rows)
        total_bad_feet = sum(float(row.get("estimatedBadFeet") or 0.0) for row in rows)
        total_delta_points = sum(int(row.get("deltaPointCount") or 0) for row in rows)
        total_oob_points = sum(int(row.get("oobPointCount") or 0) for row in rows)
        total_monitor_points = sum(int(row.get("monitoringPointsTotal") or 0) for row in rows)
        bad_feet_pct = (total_bad_feet / total_feet * 100.0) if total_feet else 0.0
        oob_point_pct = (total_oob_points / total_delta_points * 100.0) if total_delta_points else 0.0
        coverage = (total_monitor_points / total_feet * 1000.0) if total_feet else None
        monitoring_penalty = (
            max(DEFAULT_MIN_MONITORING_POINTS_PER_1000_FT - coverage, 0.0)
            / DEFAULT_MIN_MONITORING_POINTS_PER_1000_FT
            if coverage is not None
            else 1.0
        )
        tolerance_per_reel = sum(int(row.get("toleranceChangeCount") or 0) for row in rows) / max(len(rows), 1)
        score = (
            35.0 * self._cap_ratio(bad_feet_pct, 20.0)
            + 25.0 * self._cap_ratio(oob_point_pct, 20.0)
            + 15.0 * self._cap_ratio(self._combined_stddev(rows) or 0.0, 2.0)
            + 10.0 * self._cap_ratio(tolerance_per_reel, 2.0)
            + 10.0 * self._cap_ratio(monitoring_penalty, 1.0)
            + 5.0 * self._cap_ratio(self._mean([row.get("webspeedRange") for row in rows]) or 0.0, 40.0)
        )
        return round(score, 3)

    def _classify_issue(self, rows: List[Dict[str, Any]]) -> str:
        """Classify the dominant likely issue for a press."""
        total_feet = sum(float(row.get("feetTotal") or 0.0) for row in rows)
        total_bad_feet = sum(float(row.get("estimatedBadFeet") or 0.0) for row in rows)
        total_monitor_points = sum(int(row.get("monitoringPointsTotal") or 0) for row in rows)
        bad_feet_pct = (total_bad_feet / total_feet * 100.0) if total_feet else 0.0
        coverage = (total_monitor_points / total_feet * 1000.0) if total_feet else None
        signals = {
            "drift": self._cap_ratio(abs(self._weighted_mean(rows, "avgDelta", "deltaPointCount") or 0.0), 1.0),
            "bad_feet": self._cap_ratio(bad_feet_pct, 10.0),
            "speed_instability": self._cap_ratio(self._mean([row.get("webspeedRange") for row in rows]) or 0.0, 30.0),
            "tolerance_volatility": self._cap_ratio(
                sum(int(row.get("toleranceChangeCount") or 0) for row in rows) / max(len(rows), 1),
                1.0,
            ),
            "monitoring_quality": (
                self._cap_ratio(DEFAULT_MIN_MONITORING_POINTS_PER_1000_FT - coverage, DEFAULT_MIN_MONITORING_POINTS_PER_1000_FT)
                if coverage is not None and coverage < DEFAULT_MIN_MONITORING_POINTS_PER_1000_FT
                else 0.0
            ),
        }
        ranked = sorted(signals.items(), key=lambda item: item[1], reverse=True)
        if not ranked or ranked[0][1] <= 0:
            return ISSUE_CLASSES["mixed"]
        if len(ranked) > 1 and ranked[1][1] >= ranked[0][1] * 0.85 and ranked[1][1] >= 0.25:
            return ISSUE_CLASSES["mixed"]
        return ISSUE_CLASSES.get(ranked[0][0], ISSUE_CLASSES["mixed"])

    def _feet_from_reel(self, reel: RLMReel) -> float:
        feet = compute_reel_feet_from_range(reel.reel_start, reel.reel_end, reel.format_length)
        return feet if feet is not None else 0.0

    def _mean(self, values: Iterable[Optional[float]]) -> Optional[float]:
        """Return a rounded mean for numeric values only."""
        clean = [float(value) for value in values if value is not None]
        if not clean:
            return None
        return round(sum(clean) / len(clean), 3)

    def _median(self, values: Iterable[Optional[float]]) -> Optional[float]:
        """Return a rounded median for numeric values only."""
        clean = sorted(float(value) for value in values if value is not None)
        if not clean:
            return None
        middle = len(clean) // 2
        if len(clean) % 2:
            return round(clean[middle], 3)
        return round((clean[middle - 1] + clean[middle]) / 2.0, 3)

    def _stddev(self, values: Iterable[Optional[float]]) -> Optional[float]:
        """Return population std dev for numeric values only."""
        clean = [float(value) for value in values if value is not None]
        if len(clean) < 2:
            return None
        mean = sum(clean) / len(clean)
        return round(sqrt(sum((value - mean) ** 2 for value in clean) / len(clean)), 3)

    def _weighted_mean(self, rows: List[Dict[str, Any]], value_key: str, weight_key: str) -> Optional[float]:
        """Return a rounded weighted mean for pre-aggregated row values."""
        total_weight = 0.0
        total = 0.0
        for row in rows:
            value = row.get(value_key)
            weight = float(row.get(weight_key) or 0.0)
            if value is None or weight <= 0:
                continue
            total += float(value) * weight
            total_weight += weight
        if total_weight <= 0:
            return None
        return round(total / total_weight, 3)

    def _combined_stddev(self, rows: List[Dict[str, Any]]) -> Optional[float]:
        """Combine per-reel delta sums into one population std dev."""
        count = sum(int(row.get("deltaPointCount") or 0) for row in rows)
        if count < 2:
            return None
        total = sum(float(row.get("deltaSum") or 0.0) for row in rows)
        total_sq = sum(float(row.get("deltaSumSq") or 0.0) for row in rows)
        mean = total / count
        variance = max((total_sq / count) - (mean * mean), 0.0)
        return round(sqrt(variance), 3)

    def _compute_reel_outlier_score(
        self,
        *,
        avg_delta: Optional[float],
        delta_std: Optional[float],
        oob_point_pct: Optional[float],
        estimated_bad_feet_pct: Optional[float],
        webspeed_range: Optional[float],
        tolerance_change_count: int,
        points_per_1000_ft: Optional[float],
    ) -> float:
        """Compute a compact score for reel-level outlier queue ranking."""
        monitoring_penalty = (
            max(DEFAULT_MIN_MONITORING_POINTS_PER_1000_FT - points_per_1000_ft, 0.0)
            / DEFAULT_MIN_MONITORING_POINTS_PER_1000_FT
            if points_per_1000_ft is not None
            else 1.0
        )
        score = (
            30.0 * self._cap_ratio(estimated_bad_feet_pct or 0.0, 20.0)
            + 25.0 * self._cap_ratio(oob_point_pct or 0.0, 20.0)
            + 15.0 * self._cap_ratio(abs(avg_delta or 0.0), 1.0)
            + 15.0 * self._cap_ratio(delta_std or 0.0, 2.0)
            + 10.0 * self._cap_ratio(tolerance_change_count, 2.0)
            + 5.0 * self._cap_ratio(monitoring_penalty, 1.0)
            + 5.0 * self._cap_ratio(webspeed_range or 0.0, 40.0)
        )
        return round(score, 3)

    def _cap_ratio(self, value: Optional[float], cap: float) -> float:
        """Normalize a positive value to 0..1 using a cap."""
        if value is None or cap <= 0:
            return 0.0
        return max(0.0, min(float(value) / cap, 1.0))

    def _to_float(self, value: Any) -> Optional[float]:
        """Convert DB numeric values to floats without raising."""
        try:
            return None if value is None else float(value)
        except (TypeError, ValueError):
            return None

    def _append_metric_card(
        self,
        cards: List[Dict[str, Any]],
        press_metrics: List[Dict[str, Any]],
        *,
        metric_key: str,
        title_suffix: str,
        label: str,
        formatter,
    ) -> None:
        """Append a decision card for a max metric when it has usable data."""
        rows = [row for row in press_metrics if row.get(metric_key) is not None]
        if not rows:
            return
        top = max(rows, key=lambda row: row.get(metric_key) or 0)
        if not top.get(metric_key):
            return
        cards.append(
            {
                "title": f"{top.get('machineName')} {title_suffix}",
                "severity": self._severity_from_score(top.get("impactScore")),
                "metric": label,
                "value": top.get(metric_key),
                "detail": f"{formatter(top.get(metric_key))} · Impact {self._format_number(top.get('impactScore'))}",
            }
        )

    def _outlier_payload(self, row: Dict[str, Any], issue: str, detail: str) -> Dict[str, Any]:
        """Serialize a reel outlier row for frontend display."""
        return {
            "machineId": row.get("machineId"),
            "machineName": row.get("machineName"),
            "jobName": row.get("jobName"),
            "orderNumber": row.get("orderNumber"),
            "reelDbId": row.get("reelDbId"),
            "reelId": row.get("reelId"),
            "productionStart": row.get("productionStart"),
            "issue": issue,
            "detail": detail,
            "score": row.get("outlierScore"),
            "oobPointPct": row.get("oobPointPct"),
            "estimatedBadFeetPct": row.get("estimatedBadFeetPct"),
            "avgDelta": row.get("avgDelta"),
            "deltaStd": row.get("deltaStd"),
            "webspeedRange": row.get("webspeedRange"),
            "toleranceChangeCount": row.get("toleranceChangeCount"),
            "pointsPer1000Ft": row.get("pointsPer1000Ft"),
        }

    def _severity_from_score(self, score: Optional[float]) -> str:
        """Map an impact score into display severity."""
        value = score or 0.0
        if value >= 70:
            return "critical"
        if value >= 35:
            return "warning"
        return "info"

    def _format_pct(self, value: Optional[float]) -> str:
        """Format a percentage for executive copy."""
        if value is None:
            return "--"
        return f"{float(value):.1f}%"

    def _format_count(self, value: Optional[float]) -> str:
        """Format a whole count for executive copy."""
        if value is None:
            return "--"
        return f"{int(value)}"

    def _format_change_count(self, value: Optional[float]) -> str:
        """Format tolerance-change counts for leaderboard display."""
        if value is None:
            return "--"
        return f"{int(value)} changes"

    def _format_feet(self, value: Optional[float]) -> str:
        """Format feet values for leaderboard display."""
        if value is None:
            return "--"
        return f"{float(value):,.0f} ft"

    def _format_coverage(self, value: Optional[float]) -> str:
        """Format monitoring coverage for leaderboard display."""
        if value is None:
            return "--"
        return f"{float(value):.1f} pts/1k ft"

    def _format_speed_swing(self, value: Optional[float]) -> str:
        """Format average per-reel speed swing for leaderboard display."""
        if value is None:
            return "--"
        return f"{float(value):.1f} avg/reel"

    def _leaderboard_context(
        self,
        rank: int,
        total: int,
        value: float,
        plant_avg: Optional[float],
        sort: str,
        rank_orientation: str,
    ) -> str:
        """Return a compact operator-friendly context label for a leaderboard row."""
        if rank == 1:
            return "best"
        if rank == total:
            return "highest risk" if rank_orientation == "best_to_worst" else "lowest risk"
        if plant_avg is None:
            return ""
        if sort in {"asc", "abs_asc"}:
            return "below plant avg" if value < plant_avg else "above plant avg"
        return "above plant avg" if value > plant_avg else "below plant avg"

    def _leaderboard_average_position(self, value: float, plant_avg: Optional[float]) -> str:
        """Return whether a leaderboard value is above, below, or at the category average."""
        if plant_avg is None:
            return "unknown"
        if value > plant_avg:
            return "above"
        if value < plant_avg:
            return "below"
        return "average"

    def _average_relative_risk(
        self,
        value: Optional[float],
        plant_avg: Optional[float],
        direction: str,
    ) -> float:
        """Return 0..1 risk based on how far a value is from the plant average.

        0.0 is at/better than average. 0.5 is moderately worse. 1.0 is far worse.
        """
        if value is None or plant_avg is None:
            return 0.0
        number = float(value)
        average = float(plant_avg)
        if average <= 0:
            if number <= 0:
                return 0.0
            return 1.0
        if direction == "higher_better":
            if number >= average:
                return 0.0
            shortfall_ratio = (average - number) / average
            return round(min(shortfall_ratio / 0.5, 1.0), 3)
        if number <= average:
            return 0.0
        overage_ratio = (number - average) / average
        return round(min(overage_ratio / 0.5, 1.0), 3)

    def _press_sort_key(self, machine_name: Optional[str], machine_id: Optional[int]) -> Tuple[int, str]:
        """Sort press names like Press 5, Press 10, Press 15 in numeric order."""
        text = str(machine_name or "")
        digits = "".join(ch if ch.isdigit() else " " for ch in text).split()
        if digits:
            return int(digits[-1]), text
        return int(machine_id or 999999), text

    def _format_number(self, value: Optional[float]) -> str:
        """Format a numeric value for executive copy."""
        if value is None:
            return "--"
        return f"{float(value):.2f}"

    def _format_mm(self, value: Optional[float]) -> str:
        """Format millimeter values for executive copy."""
        if value is None:
            return "--"
        return f"{float(value):.3f} mm"


def default_filters() -> PressIntelligenceFilters:
    """Return the default read-only executive window."""
    end = datetime.utcnow().replace(microsecond=0)
    start = end - timedelta(days=2)
    return PressIntelligenceFilters(start=start, end=end)
