from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass
from datetime import datetime, timedelta
from math import sqrt
from typing import Any, Dict, Iterable, List, Optional, Tuple

from sqlalchemy.orm import selectinload

from db.rlm_connection import RLMSessionLocal
from db.rlm_models import RLMMachine, RLMPhaseInterval, RLMReel
from services.rlm_reel_footage import MM_PER_FOOT, compute_reel_feet_from_range
from services.rlm_repeat_length_service import RLMRepeatLengthService

ZONE_SPECS = (
    ("early", "First 25%", 0.0, 0.25),
    ("middle", "Middle 50%", 0.25, 0.75),
    ("late", "Last 25%", 0.75, 1.0000001),
)


@dataclass(frozen=True)
class JobComparisonSideFilters:
    machine_id: Optional[int]
    start: datetime
    end: datetime
    job: Optional[str] = None
    job_machine_id: Optional[int] = None
    min_feet: Optional[float] = None


def default_side_filters() -> JobComparisonSideFilters:
    end = datetime.utcnow().replace(microsecond=0)
    start = end - timedelta(days=2)
    return JobComparisonSideFilters(machine_id=None, start=start, end=end)


class RLMJobComparisonService:
    repeat_length_service = RLMRepeatLengthService()

    def get_job_comparison(
        self,
        left_filters: JobComparisonSideFilters,
        right_filters: JobComparisonSideFilters,
    ) -> Dict[str, Any]:
        with RLMSessionLocal() as session:
            left = self._build_side(session, "job1", "Job 1", left_filters)
            right = self._build_side(session, "job2", "Job 2", right_filters)
            machine_rows = session.query(RLMMachine).order_by(RLMMachine.machine_name.asc()).all()
        comparison = self._build_comparison(left, right)
        return {
            "metadata": {
                "generatedAt": datetime.utcnow().isoformat(),
                "machines": [
                    {"machineId": machine.machine_id, "machineName": machine.machine_name or f"Machine {machine.machine_id}"}
                    for machine in machine_rows
                ],
                "notes": [
                    "All feet, bad feet, and bad-point calculations come from the shared backend reel summary.",
                    "Bad Feet % and Bad Feet are the primary quality outcome metrics; other metrics explain the gap.",
                ],
            },
            "job1": left,
            "job2": right,
            "comparison": comparison,
        }

    def _build_side(self, session, side_key: str, side_label: str, filters: JobComparisonSideFilters) -> Dict[str, Any]:
        if not filters.job:
            aggregate = self._empty_aggregate()
            return {
                "sideKey": side_key,
                "sideLabel": side_label,
                "filters": self._serialize_filters(filters, []),
                "selectedPopulation": self._empty_population(),
                "comparisonReadiness": self._empty_comparison_readiness(),
                "aggregate": aggregate,
                "supportingMetrics": self._build_supporting_metrics(aggregate),
                "reelSeries": [],
                "worstReels": [],
                "bestReels": [],
                "zoneSummary": aggregate.get("zoneSummary"),
                "derivedFeatures": aggregate.get("derivedFeatures"),
                "summaryParagraph": f"Choose a job for {side_label} to compare.",
                "intraReelConclusion": f"Choose a job for {side_label} to see within-reel behavior.",
                "isSelected": False,
            }
        reels = self._get_reels(session, filters)
        selected_population = self._summarize_selected_population(reels)
        reel_ids = [int(reel.reel_db_id) for reel in reels]
        repeat_length = self.repeat_length_service.fetch_reel_batch(session, reel_ids)
        phase_aggregates = self._get_phase_interval_aggregates(session, reel_ids)
        reel_records = [
            self._build_reel_record(reel, repeat_length.get(int(reel.reel_db_id)) or {}, phase_aggregates.get(int(reel.reel_db_id)) or {})
            for reel in reels
        ]
        aggregate = self._aggregate_side_records(reel_records)
        comparison_readiness = self._assess_comparison_readiness(selected_population, aggregate)
        supporting_metrics = self._build_supporting_metrics(aggregate)
        worst_reels = self._rank_reels(reel_records, reverse=True)[:4]
        best_reels = list(reversed(self._rank_reels(reel_records, reverse=False)[:4]))
        return {
            "sideKey": side_key,
            "sideLabel": side_label,
            "filters": self._serialize_filters(filters, reels),
            "selectedPopulation": selected_population,
            "comparisonReadiness": comparison_readiness,
            "aggregate": aggregate,
            "supportingMetrics": supporting_metrics,
            "reelSeries": self._build_reel_series(reel_records),
            "worstReels": worst_reels,
            "bestReels": best_reels,
            "zoneSummary": aggregate.get("zoneSummary"),
            "derivedFeatures": aggregate.get("derivedFeatures"),
            "summaryParagraph": self._build_side_summary(side_label, filters, aggregate),
            "intraReelConclusion": self._build_intra_reel_conclusion(filters.job or side_label, aggregate),
            "isSelected": True,
        }

    def _summarize_selected_population(self, reels: List[RLMReel]) -> Dict[str, Any]:
        run_times = [reel.production_start_dt.isoformat() for reel in reels if reel.production_start_dt]
        total_feet = 0.0
        reels_with_feet = 0
        for reel in reels:
            feet = compute_reel_feet_from_range(
                getattr(reel, "reel_start", None),
                getattr(reel, "reel_end", None),
                getattr(reel, "format_length", None),
            )
            if feet is None:
                continue
            total_feet += float(feet)
            reels_with_feet += 1
        return {
            "reelCount": len(reels),
            "reelsWithFeet": reels_with_feet,
            "totalFeet": round(total_feet, 3),
            "runStart": min(run_times) if run_times else None,
            "runEnd": max(run_times) if run_times else None,
        }

    def _get_reels(self, session, filters: JobComparisonSideFilters) -> List[RLMReel]:
        effective_machine_id = filters.machine_id if filters.machine_id is not None else filters.job_machine_id
        query = (
            session.query(RLMReel)
            .join(RLMMachine, RLMReel.machine_id == RLMMachine.machine_id)
            .options(selectinload(RLMReel.machine))
            .filter(RLMReel.production_start_dt.isnot(None))
            .filter(RLMReel.production_start_dt >= filters.start)
            .filter(RLMReel.production_start_dt <= filters.end)
            .order_by(RLMMachine.machine_name.asc(), RLMReel.production_start_dt.asc(), RLMReel.reel_db_id.asc())
        )
        if effective_machine_id is not None:
            query = query.filter(RLMReel.machine_id == effective_machine_id)
        if filters.job:
            query = query.filter(RLMReel.job_name == filters.job)
        if filters.min_feet is not None:
            query = query.filter(RLMReel.reel_start.isnot(None))
            query = query.filter(RLMReel.reel_end.isnot(None))
            query = query.filter(RLMReel.reel_end >= RLMReel.reel_start)
            query = query.filter(((RLMReel.reel_end - RLMReel.reel_start) * RLMReel.format_length) / MM_PER_FOOT >= filters.min_feet)
        return query.all()

    def _get_phase_interval_aggregates(self, session, reel_ids: Iterable[int]) -> Dict[int, Dict[str, Any]]:
        clean_ids = [int(reel_id) for reel_id in reel_ids if reel_id is not None]
        if not clean_ids:
            return {}
        rows = (
            session.query(
                RLMPhaseInterval.reel_db_id,
                RLMPhaseInterval.phase_name,
                RLMPhaseInterval.duration_seconds,
            )
            .filter(RLMPhaseInterval.reel_db_id.in_(clean_ids))
            .all()
        )
        by_reel: Dict[int, Dict[str, float]] = defaultdict(lambda: {"active": 0.0, "inactive": 0.0, "other": 0.0})
        for reel_id, phase_name, duration_seconds in rows:
            key = str(phase_name or "").strip().lower()
            duration = max(float(duration_seconds or 0.0), 0.0)
            bucket = by_reel[int(reel_id)]
            if key == "active":
                bucket["active"] += duration
            elif key == "inactive":
                bucket["inactive"] += duration
            else:
                bucket["other"] += duration
        out: Dict[int, Dict[str, Any]] = {}
        for reel_id in clean_ids:
            bucket = by_reel.get(int(reel_id), {"active": 0.0, "inactive": 0.0, "other": 0.0})
            known = bucket["active"] + bucket["inactive"]
            out[int(reel_id)] = {
                "activeSeconds": round(bucket["active"], 3),
                "inactiveSeconds": round(bucket["inactive"], 3),
                "otherSeconds": round(bucket["other"], 3),
                "knownSeconds": round(known, 3),
                "activePct": round((bucket["active"] / known * 100.0), 3) if known > 0 else None,
                "inactivePct": round((bucket["inactive"] / known * 100.0), 3) if known > 0 else None,
            }
        return out

    def _build_reel_record(self, reel: RLMReel, repeat_length: Dict[str, Any], phase_data: Dict[str, Any]) -> Dict[str, Any]:
        summary = self.repeat_length_service.build_reel_summary(reel, repeat_length)
        feet_total = self._to_float(summary.get("feet_total")) or 0.0
        estimated_bad_feet = self._to_float(summary.get("estimated_bad_feet")) or 0.0
        estimated_good_feet = self._to_float(summary.get("estimated_good_feet")) or max(feet_total - estimated_bad_feet, 0.0)
        matched_points = int(summary.get("matched_monitoring_points") or 0)
        total_points = int(summary.get("total_monitoring_points") or 0)
        bad_points = int(summary.get("bad_monitoring_points") or 0)
        good_points = int(summary.get("good_monitoring_points") or 0)
        unmatched_points = int(summary.get("unmatched_monitoring_points") or 0)
        active = total_points > 0
        zone_summary = self._build_reel_zone_summary(
            reel,
            repeat_length.get("points") or [],
            estimated_bad_feet=estimated_bad_feet,
            matched_points=matched_points,
            bad_points=bad_points,
        )
        avg_delta = self._to_float(repeat_length.get("avgDelta"))
        delta_std = self._to_float(repeat_length.get("deltaStd"))
        avg_abs_delta = self._to_float(repeat_length.get("avgAbsDelta"))
        avg_webspeed = self._to_float(repeat_length.get("avgWebspeed"))
        min_webspeed = self._to_float(repeat_length.get("minWebspeed"))
        max_webspeed = self._to_float(repeat_length.get("maxWebspeed"))
        speed_range = (max_webspeed - min_webspeed) if min_webspeed is not None and max_webspeed is not None else None
        tolerance_changes = max(int(summary.get("tolerance_segment_count") or 0) - 1, 0)
        points_per_1000_ft = (total_points / feet_total * 1000.0) if feet_total > 0 else None
        matched_density = (matched_points / feet_total * 1000.0) if feet_total > 0 else None
        return {
            "reelDbId": int(reel.reel_db_id),
            "machineId": int(reel.machine_id),
            "machineName": reel.machine.machine_name if reel.machine else f"Press {reel.machine_id}",
            "reelId": reel.reel_id or str(reel.reel_db_id),
            "jobName": reel.job_name or "",
            "productionStart": reel.production_start_dt.isoformat() if reel.production_start_dt else None,
            "orderNumber": reel.order_number,
            "feetTotal": round(feet_total, 3),
            "estimatedBadFeet": round(estimated_bad_feet, 3),
            "estimatedGoodFeet": round(estimated_good_feet, 3),
            "estimatedBadFeetPct": round((estimated_bad_feet / feet_total * 100.0), 3) if feet_total > 0 else None,
            "monitoringPointsTotal": total_points,
            "matchedMonitoringPoints": matched_points,
            "goodMonitoringPoints": good_points,
            "badMonitoringPoints": bad_points,
            "unmatchedMonitoringPoints": unmatched_points,
            "badPointPct": self._to_float(summary.get("bad_point_pct")),
            "goodPointPct": self._to_float(summary.get("good_point_pct")),
            "pointsPer1000Ft": round(points_per_1000_ft, 3) if points_per_1000_ft is not None else None,
            "matchedPointsPer1000Ft": round(matched_density, 3) if matched_density is not None else None,
            "avgDelta": avg_delta,
            "avgAbsDelta": avg_abs_delta,
            "deltaStd": delta_std,
            "avgWebspeed": avg_webspeed,
            "webspeedRange": round(speed_range, 3) if speed_range is not None else None,
            "toleranceChangeCount": tolerance_changes,
            "active": active,
            "inactive": not active,
            "activeSeconds": self._to_float(phase_data.get("activeSeconds")) or 0.0,
            "inactiveSeconds": self._to_float(phase_data.get("inactiveSeconds")) or 0.0,
            "phaseActivePct": self._to_float(phase_data.get("activePct")),
            "phaseInactivePct": self._to_float(phase_data.get("inactivePct")),
            "zoneSummary": zone_summary,
            "withinReelDirection": self._within_reel_direction(zone_summary),
            "dominantBadZone": self._dominant_bad_zone(zone_summary),
            "badPattern": self._bad_pattern(zone_summary),
        }

    def _build_reel_zone_summary(
        self,
        reel: RLMReel,
        points: List[Dict[str, Any]],
        *,
        estimated_bad_feet: float,
        matched_points: int,
        bad_points: int,
    ) -> List[Dict[str, Any]]:
        start = self._to_float(getattr(reel, "reel_start", None))
        end = self._to_float(getattr(reel, "reel_end", None))
        zones: Dict[str, Dict[str, Any]] = {
            key: {
                "key": key,
                "label": label,
                "matchedMonitoringPoints": 0,
                "badMonitoringPoints": 0,
                "goodMonitoringPoints": 0,
                "badPointPct": None,
                "avgDelta": None,
                "avgAbsDelta": None,
                "estimatedBadFeet": 0.0,
            }
            for key, label, _zone_start, _zone_end in ZONE_SPECS
        }
        delta_values: Dict[str, List[float]] = defaultdict(list)
        abs_delta_values: Dict[str, List[float]] = defaultdict(list)

        for point in points or []:
            if not point.get("matchedTolerance"):
                continue
            ratio = self._relative_position(start, end, self._to_float(point.get("formatValue")))
            zone_key = self._zone_for_ratio(ratio)
            if not zone_key:
                continue
            zone = zones[zone_key]
            zone["matchedMonitoringPoints"] += 1
            if point.get("outOfRange"):
                zone["badMonitoringPoints"] += 1
            else:
                zone["goodMonitoringPoints"] += 1
            delta = self._to_float(point.get("delta"))
            if delta is not None:
                delta_values[zone_key].append(delta)
                abs_delta_values[zone_key].append(abs(delta))

        for key, zone in zones.items():
            matched = int(zone["matchedMonitoringPoints"] or 0)
            bad = int(zone["badMonitoringPoints"] or 0)
            zone["badPointPct"] = round((bad / matched * 100.0), 3) if matched > 0 else None
            zone["avgDelta"] = self._mean(delta_values.get(key, []))
            zone["avgAbsDelta"] = self._mean(abs_delta_values.get(key, []))
            zone["estimatedBadFeet"] = round((bad / max(bad_points, 1)) * estimated_bad_feet, 3) if bad_points > 0 else 0.0
        return [zones[key] for key, _label, _start, _end in ZONE_SPECS]

    def _aggregate_side_records(self, reel_records: List[Dict[str, Any]]) -> Dict[str, Any]:
        production_times = [str(row.get("productionStart")) for row in reel_records if row.get("productionStart")]
        total_feet = sum(float(row.get("feetTotal") or 0.0) for row in reel_records)
        total_bad_feet = sum(float(row.get("estimatedBadFeet") or 0.0) for row in reel_records)
        total_good_feet = sum(float(row.get("estimatedGoodFeet") or 0.0) for row in reel_records)
        total_monitoring_points = sum(int(row.get("monitoringPointsTotal") or 0) for row in reel_records)
        total_matched_points = sum(int(row.get("matchedMonitoringPoints") or 0) for row in reel_records)
        total_bad_points = sum(int(row.get("badMonitoringPoints") or 0) for row in reel_records)
        total_good_points = sum(int(row.get("goodMonitoringPoints") or 0) for row in reel_records)
        total_unmatched_points = sum(int(row.get("unmatchedMonitoringPoints") or 0) for row in reel_records)
        active_reels = [row for row in reel_records if row.get("active")]
        inactive_reels = [row for row in reel_records if not row.get("active")]
        active_feet = sum(float(row.get("feetTotal") or 0.0) for row in active_reels)
        inactive_feet = sum(float(row.get("feetTotal") or 0.0) for row in inactive_reels)
        phase_active_seconds = sum(float(row.get("activeSeconds") or 0.0) for row in reel_records)
        phase_inactive_seconds = sum(float(row.get("inactiveSeconds") or 0.0) for row in reel_records)
        known_phase_seconds = phase_active_seconds + phase_inactive_seconds
        bad_feet_pct = (total_bad_feet / total_feet * 100.0) if total_feet > 0 else None
        good_point_pct = (total_good_points / total_matched_points * 100.0) if total_matched_points > 0 else None
        bad_point_pct = (total_bad_points / total_matched_points * 100.0) if total_matched_points > 0 else None
        zone_summary = self._aggregate_zone_summary(reel_records, total_bad_feet)
        run_profile = self._build_run_profile(reel_records)
        late_degrade_rate = self._pct(
            sum(1 for row in reel_records if row.get("withinReelDirection") == "worsening"),
            len(reel_records),
        )
        clustered_bad_rate = self._pct(
            sum(1 for row in reel_records if row.get("badPattern") == "clustered"),
            len(reel_records),
        )
        return {
            "reelCount": len(reel_records),
            "qualifiedReelCount": sum(1 for row in reel_records if float(row.get("feetTotal") or 0.0) > 0),
            "runStart": min(production_times) if production_times else None,
            "runEnd": max(production_times) if production_times else None,
            "totalFeet": round(total_feet, 3),
            "totalBadFeet": round(total_bad_feet, 3),
            "totalGoodFeet": round(total_good_feet, 3),
            "badFeetPct": round(bad_feet_pct, 3) if bad_feet_pct is not None else None,
            "monitoringPointsTotal": total_monitoring_points,
            "matchedMonitoringPoints": total_matched_points,
            "goodMonitoringPoints": total_good_points,
            "badMonitoringPoints": total_bad_points,
            "unmatchedMonitoringPoints": total_unmatched_points,
            "badPointPct": round(bad_point_pct, 3) if bad_point_pct is not None else None,
            "goodPointPct": round(good_point_pct, 3) if good_point_pct is not None else None,
            "activeReelCount": len(active_reels),
            "inactiveReelCount": len(inactive_reels),
            "activeReelPct": self._pct(len(active_reels), len(reel_records)),
            "inactiveReelPct": self._pct(len(inactive_reels), len(reel_records)),
            "activeFeet": round(active_feet, 3),
            "inactiveFeet": round(inactive_feet, 3),
            "activeFeetPct": self._pct(active_feet, total_feet),
            "inactiveFeetPct": self._pct(inactive_feet, total_feet),
            "phaseActivePct": self._pct(phase_active_seconds, known_phase_seconds),
            "phaseInactivePct": self._pct(phase_inactive_seconds, known_phase_seconds),
            "monitoringDensity": round((total_monitoring_points / total_feet * 1000.0), 3) if total_feet > 0 else None,
            "matchedMonitoringDensity": round((total_matched_points / total_feet * 1000.0), 3) if total_feet > 0 else None,
            "repeatLengthDrift": self._weighted_mean_abs(reel_records, "avgDelta", "matchedMonitoringPoints"),
            "repeatLengthVariation": self._weighted_mean(reel_records, "deltaStd", "matchedMonitoringPoints"),
            "speedInstability": self._weighted_mean(reel_records, "webspeedRange", "monitoringPointsTotal"),
            "toleranceChanges": sum(int(row.get("toleranceChangeCount") or 0) for row in reel_records),
            "avgToleranceChangesPerReel": round(
                sum(int(row.get("toleranceChangeCount") or 0) for row in reel_records) / len(reel_records), 3
            ) if reel_records else None,
            "runProfile": run_profile,
            "zoneSummary": zone_summary,
            "derivedFeatures": {
                "lateDegradeRate": late_degrade_rate,
                "clusteredBadRate": clustered_bad_rate,
                "dominantZone": self._dominant_zone_from_aggregate(zone_summary),
                "runDirection": run_profile.get("direction"),
                "broadIssueRate": self._pct(
                    sum(1 for row in reel_records if (row.get("estimatedBadFeetPct") or 0.0) >= 5.0),
                    len(reel_records),
                ),
            },
        }

    def _aggregate_zone_summary(self, reel_records: List[Dict[str, Any]], total_bad_feet: float) -> List[Dict[str, Any]]:
        buckets: Dict[str, Dict[str, Any]] = {
            key: {
                "key": key,
                "label": label,
                "matchedMonitoringPoints": 0,
                "badMonitoringPoints": 0,
                "goodMonitoringPoints": 0,
                "estimatedBadFeet": 0.0,
                "avgAbsDeltaSamples": [],
            }
            for key, label, _start, _end in ZONE_SPECS
        }
        for row in reel_records:
            for zone in row.get("zoneSummary") or []:
                bucket = buckets[zone["key"]]
                bucket["matchedMonitoringPoints"] += int(zone.get("matchedMonitoringPoints") or 0)
                bucket["badMonitoringPoints"] += int(zone.get("badMonitoringPoints") or 0)
                bucket["goodMonitoringPoints"] += int(zone.get("goodMonitoringPoints") or 0)
                bucket["estimatedBadFeet"] += float(zone.get("estimatedBadFeet") or 0.0)
                if zone.get("avgAbsDelta") is not None:
                    bucket["avgAbsDeltaSamples"].append(float(zone.get("avgAbsDelta")))
        out = []
        for key, label, _start, _end in ZONE_SPECS:
            bucket = buckets[key]
            matched = int(bucket["matchedMonitoringPoints"] or 0)
            bad = int(bucket["badMonitoringPoints"] or 0)
            out.append(
                {
                    "key": key,
                    "label": label,
                    "matchedMonitoringPoints": matched,
                    "badMonitoringPoints": bad,
                    "goodMonitoringPoints": int(bucket["goodMonitoringPoints"] or 0),
                    "badPointPct": round((bad / matched * 100.0), 3) if matched > 0 else None,
                    "badFeet": round(bucket["estimatedBadFeet"], 3),
                    "badFeetSharePct": self._pct(bucket["estimatedBadFeet"], total_bad_feet),
                    "avgAbsDelta": self._mean(bucket["avgAbsDeltaSamples"]),
                }
            )
        return out

    def _build_run_profile(self, reel_records: List[Dict[str, Any]]) -> Dict[str, Any]:
        ordered = sorted(
            [row for row in reel_records if row.get("productionStart")],
            key=lambda row: row.get("productionStart") or "",
        )
        if not ordered:
            return {"direction": "unclear", "firstHalfBadFeetPct": None, "secondHalfBadFeetPct": None, "summary": "No reel sequence available."}
        midpoint = max(len(ordered) // 2, 1)
        first_half = ordered[:midpoint]
        second_half = ordered[midpoint:]
        first_bad = self._feet_weighted_bad_pct(first_half)
        second_bad = self._feet_weighted_bad_pct(second_half) if second_half else first_bad
        delta = None if first_bad is None or second_bad is None else second_bad - first_bad
        direction = "flat"
        if delta is not None:
            if delta >= 2.0:
                direction = "worsening"
            elif delta <= -2.0:
                direction = "improving"
            else:
                direction = "mixed"
        summary = "Run stayed fairly even."
        if direction == "worsening":
            summary = "Run quality degraded later in the job."
        elif direction == "improving":
            summary = "Run started rough and cleaned up later."
        elif direction == "mixed":
            summary = "Run shifted somewhat, but not enough to call a clear directional move."
        return {
            "direction": direction,
            "firstHalfBadFeetPct": round(first_bad, 3) if first_bad is not None else None,
            "secondHalfBadFeetPct": round(second_bad, 3) if second_bad is not None else None,
            "summary": summary,
        }

    def _rank_reels(self, reel_records: List[Dict[str, Any]], *, reverse: bool) -> List[Dict[str, Any]]:
        ranked = sorted(
            reel_records,
            key=lambda row: (
                float(row.get("estimatedBadFeetPct") or 0.0),
                float(row.get("estimatedBadFeet") or 0.0),
                float(row.get("feetTotal") or 0.0),
            ),
            reverse=reverse,
        )
        return [
            {
                "reelId": row.get("reelId"),
                "jobName": row.get("jobName"),
                "machineName": row.get("machineName"),
                "productionStart": row.get("productionStart"),
                "feetTotal": row.get("feetTotal"),
                "estimatedBadFeet": row.get("estimatedBadFeet"),
                "estimatedBadFeetPct": row.get("estimatedBadFeetPct"),
                "badPointPct": row.get("badPointPct"),
                "monitoringPointsTotal": row.get("monitoringPointsTotal"),
                "dominantBadZone": row.get("dominantBadZone"),
                "withinReelDirection": row.get("withinReelDirection"),
                "badPattern": row.get("badPattern"),
            }
            for row in ranked
            if float(row.get("feetTotal") or 0.0) > 0
        ]

    def _build_reel_series(self, reel_records: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        ordered = sorted(
            reel_records,
            key=lambda row: row.get("productionStart") or "",
        )
        series = []
        for index, row in enumerate(ordered, start=1):
            series.append(
                {
                    "index": index,
                    "reelId": row.get("reelId"),
                    "productionStart": row.get("productionStart"),
                    "feetTotal": row.get("feetTotal"),
                    "estimatedBadFeetPct": row.get("estimatedBadFeetPct"),
                    "estimatedBadFeet": row.get("estimatedBadFeet"),
                    "deltaStd": row.get("deltaStd"),
                    "avgDelta": row.get("avgDelta"),
                    "webspeedRange": row.get("webspeedRange"),
                    "pointsPer1000Ft": row.get("pointsPer1000Ft"),
                    "active": row.get("active"),
                    "withinReelDirection": row.get("withinReelDirection"),
                    "dominantBadZone": row.get("dominantBadZone"),
                }
            )
        return series

    def _build_supporting_metrics(self, aggregate: Dict[str, Any]) -> List[Dict[str, Any]]:
        return [
            {"key": "repeatLengthDrift", "label": "Repeat-length drift", "value": aggregate.get("repeatLengthDrift"), "unit": "mm", "direction": "lower_better"},
            {"key": "repeatLengthVariation", "label": "Repeat-length variation", "value": aggregate.get("repeatLengthVariation"), "unit": "mm", "direction": "lower_better"},
            {"key": "monitoringDensity", "label": "Monitoring density", "value": aggregate.get("monitoringDensity"), "unit": "pts/1k ft", "direction": "higher_better"},
            {"key": "speedInstability", "label": "Speed instability", "value": aggregate.get("speedInstability"), "unit": "speed swing", "direction": "lower_better"},
            {"key": "toleranceChanges", "label": "Tolerance changes", "value": aggregate.get("toleranceChanges"), "unit": "changes", "direction": "lower_better"},
            {"key": "activeFeetPct", "label": "Active feet %", "value": aggregate.get("activeFeetPct"), "unit": "%", "direction": "higher_better"},
            {"key": "phaseActivePct", "label": "Active phase %", "value": aggregate.get("phaseActivePct"), "unit": "%", "direction": "higher_better"},
        ]

    def _build_comparison(self, left: Dict[str, Any], right: Dict[str, Any]) -> Dict[str, Any]:
        left_selected = bool(left.get("isSelected"))
        right_selected = bool(right.get("isSelected"))
        if left_selected and not right_selected:
            return self._build_single_side_comparison(left, "job2")
        if right_selected and not left_selected:
            return self._build_single_side_comparison(right, "job1")

        left_readiness = left.get("comparisonReadiness") or self._empty_comparison_readiness()
        right_readiness = right.get("comparisonReadiness") or self._empty_comparison_readiness()
        if not left_readiness.get("isComparable") or not right_readiness.get("isComparable"):
            return self._build_not_comparable_comparison(left, right)

        left_agg = left.get("aggregate") or {}
        right_agg = right.get("aggregate") or {}
        winner = self._winner(left_agg, right_agg)
        loser = "job2" if winner == "job1" else "job1"
        winner_side = left if winner == "job1" else right
        loser_side = right if winner == "job1" else left
        summary = self._build_comparison_summary(left, right, winner)
        top_cards = [
            self._comparison_card("Overall quality", "badFeetPct", left_agg, right_agg, unit="%"),
            self._comparison_card("Bad feet", "totalBadFeet", left_agg, right_agg, unit="ft"),
            self._comparison_card("Active feet %", "activeFeetPct", left_agg, right_agg, unit="%"),
            self._comparison_card("Monitoring density", "monitoringDensity", left_agg, right_agg, unit="pts/1k ft"),
            self._comparison_card("Repeat-length variation", "repeatLengthVariation", left_agg, right_agg, unit="mm"),
            self._comparison_card("Speed instability", "speedInstability", left_agg, right_agg, unit="swing"),
        ]
        top_cards = [card for card in top_cards if card is not None]
        return {
            "winner": winner,
            "loser": loser,
            "summaryParagraph": summary,
            "takeaway": self._build_takeaway(winner_side, loser_side),
            "analytics": self._build_analytics_summary(left, right, winner),
            "topCards": top_cards,
            "mainDifferences": self._build_main_differences(left, right, winner),
            "reelRunComparison": {
                "job1": left_agg.get("runProfile"),
                "job2": right_agg.get("runProfile"),
            },
            "zoneComparison": {
                "job1": left_agg.get("zoneSummary"),
                "job2": right_agg.get("zoneSummary"),
            },
        }

    def _build_single_side_comparison(self, selected_side: Dict[str, Any], missing_side_label: str) -> Dict[str, Any]:
        aggregate = selected_side.get("aggregate") or {}
        readiness = selected_side.get("comparisonReadiness") or self._empty_comparison_readiness()
        job_label = selected_side.get("filters", {}).get("jobLabel") or selected_side.get("sideLabel")
        summary = (
            f"{job_label} is loaded. It is running at {self._format_pct(aggregate.get('badFeetPct'))} Bad Feet % "
            f"with {self._format_feet(aggregate.get('totalBadFeet'))} bad feet across "
            f"{int((selected_side.get('selectedPopulation') or {}).get('reelCount') or aggregate.get('reelCount') or 0)} reels. "
            f"Choose {missing_side_label.title()} to compare against it."
        )
        if not readiness.get("isComparable") and readiness.get("message"):
            summary = f"{job_label} is loaded, but it is not comparison-ready yet. {readiness['message']} Choose {missing_side_label.title()} to compare once coverage is stronger."
        top_cards = [
            {"label": "Overall quality", "job1Value": aggregate.get("badFeetPct"), "job2Value": None, "unit": "%", "better": "job1", "delta": None},
            {"label": "Bad feet", "job1Value": aggregate.get("totalBadFeet"), "job2Value": None, "unit": "ft", "better": "job1", "delta": None},
            {"label": "Active feet %", "job1Value": aggregate.get("activeFeetPct"), "job2Value": None, "unit": "%", "better": "job1", "delta": None},
            {"label": "Monitoring density", "job1Value": aggregate.get("monitoringDensity"), "job2Value": None, "unit": "pts/1k ft", "better": "job1", "delta": None},
            {"label": "Repeat-length variation", "job1Value": aggregate.get("repeatLengthVariation"), "job2Value": None, "unit": "mm", "better": "job1", "delta": None},
            {"label": "Speed instability", "job1Value": aggregate.get("speedInstability"), "job2Value": None, "unit": "swing", "better": "job1", "delta": None},
        ]
        return {
            "winner": selected_side.get("sideKey"),
            "loser": missing_side_label,
            "summaryParagraph": summary,
            "takeaway": f"{job_label} is ready for comparison. Choose {missing_side_label.title()} to see the gap, drivers, and within-reel differences.",
            "analytics": {
                "primaryGap": None,
                "qualityGapDisplay": None,
                "coverageGapDisplay": None,
                "coverageRead": None,
                "patternRead": self._pattern_chip_for_side(selected_side),
                "winnerLabel": job_label,
                "loserLabel": missing_side_label.title(),
                "outcomeDeltaBadFeetPct": None,
                "outcomeDeltaBadFeet": None,
                "diffRows": [],
                "zoneComparisonConclusion": None,
                "winnerPatternChip": self._pattern_chip_for_side(selected_side),
                "loserPatternChip": None,
                "overallLabel": readiness.get("label") or job_label,
                "summaryRows": [
                    {"label": "Readiness", "value": readiness.get("message")}
                ] if readiness.get("message") else [],
            },
            "topCards": top_cards,
            "mainDifferences": [
                readiness.get("message")
                or f"{job_label} is currently the only selected job, so the page is showing its actual quality and driver metrics without a second benchmark yet."
            ],
            "reelRunComparison": {
                "job1": aggregate.get("runProfile"),
                "job2": None,
            },
            "zoneComparison": {
                "job1": aggregate.get("zoneSummary"),
                "job2": None,
            },
        }

    def _build_not_comparable_comparison(self, left: Dict[str, Any], right: Dict[str, Any]) -> Dict[str, Any]:
        left_readiness = left.get("comparisonReadiness") or self._empty_comparison_readiness()
        right_readiness = right.get("comparisonReadiness") or self._empty_comparison_readiness()
        messages = [
            readiness.get("message")
            for readiness in (left_readiness, right_readiness)
            if readiness.get("message")
        ]
        summary = "Comparison is not reliable yet because at least one side does not have enough usable RLM coverage."
        if messages:
            summary = " ".join([summary] + messages[:2])
        summary_rows = [
            {"label": "Overall", "value": "Not comparable yet"},
        ]
        if left_readiness.get("message"):
            summary_rows.append({"label": "Job 1", "value": left_readiness["message"]})
        if right_readiness.get("message"):
            summary_rows.append({"label": "Job 2", "value": right_readiness["message"]})
        return {
            "winner": None,
            "loser": None,
            "summaryParagraph": summary,
            "takeaway": "Wait for stronger RLM coverage before reading this as a true job-vs-job quality comparison.",
            "analytics": {
                "primaryGap": None,
                "qualityGapDisplay": None,
                "coverageGapDisplay": None,
                "coverageRead": None,
                "patternRead": None,
                "winnerLabel": None,
                "loserLabel": None,
                "overallLabel": "Not comparable yet",
                "outcomeLabel": None,
                "outcomeDeltaBadFeetPct": None,
                "outcomeDeltaBadFeet": None,
                "diffRows": [],
                "zoneComparisonConclusion": None,
                "winnerPatternChip": None,
                "loserPatternChip": None,
                "summaryRows": summary_rows,
            },
            "topCards": [],
            "mainDifferences": messages or [summary],
            "reelRunComparison": {
                "job1": left.get("aggregate", {}).get("runProfile"),
                "job2": right.get("aggregate", {}).get("runProfile"),
            },
            "zoneComparison": {
                "job1": left.get("aggregate", {}).get("zoneSummary"),
                "job2": right.get("aggregate", {}).get("zoneSummary"),
            },
        }

    def _build_analytics_summary(self, left: Dict[str, Any], right: Dict[str, Any], winner: str) -> Dict[str, Any]:
        left_agg = left.get("aggregate") or {}
        right_agg = right.get("aggregate") or {}
        winner_side = left if winner == "job1" else right
        loser_side = right if winner == "job1" else left
        winner_agg = winner_side.get("aggregate") or {}
        loser_agg = loser_side.get("aggregate") or {}
        winner_label = winner_side.get("filters", {}).get("jobLabel") or winner_side.get("sideLabel")
        loser_label = loser_side.get("filters", {}).get("jobLabel") or loser_side.get("sideLabel")
        quality_gap = None
        left_bad = self._to_float(left_agg.get("badFeetPct"))
        right_bad = self._to_float(right_agg.get("badFeetPct"))
        if left_bad is not None and right_bad is not None:
            quality_gap = abs(left_bad - right_bad)
        coverage_gap = None
        left_cov = self._to_float(left_agg.get("activeFeetPct"))
        right_cov = self._to_float(right_agg.get("activeFeetPct"))
        if left_cov is not None and right_cov is not None:
            coverage_gap = abs(left_cov - right_cov)
        pattern_read = self._pattern_read(winner_side, loser_side)
        bad_feet_pct_delta = self._delta_payload(left_agg.get("badFeetPct"), right_agg.get("badFeetPct"), "%", lower_better=True)
        bad_feet_delta = self._delta_payload(left_agg.get("totalBadFeet"), right_agg.get("totalBadFeet"), "ft", lower_better=True)
        return {
            "primaryGap": self._primary_driver_text(left, right),
            "qualityGapDisplay": f"{quality_gap:.1f} pts bad-feet gap" if quality_gap is not None else None,
            "coverageGapDisplay": f"{coverage_gap:.1f} pts active-feet gap" if coverage_gap is not None else None,
            "coverageRead": self._coverage_gap_text(left, right) or None,
            "patternRead": pattern_read,
            "winnerLabel": winner_label,
            "loserLabel": loser_label,
            "overallLabel": self._overall_label(left, right, winner),
            "outcomeLabel": self._quality_label(left, right, winner),
            "outcomeDeltaBadFeetPct": bad_feet_pct_delta,
            "outcomeDeltaBadFeet": bad_feet_delta,
            "diffRows": self._build_difference_rows(left, right),
            "zoneComparisonConclusion": self._comparison_zone_conclusion(left, right),
            "winnerPatternChip": self._pattern_chip_for_side(winner_side),
            "loserPatternChip": self._pattern_chip_for_side(loser_side),
            "summaryRows": self._build_summary_rows(left, right, winner, bad_feet_pct_delta, bad_feet_delta),
        }

    def _build_side_summary(self, side_label: str, filters: JobComparisonSideFilters, aggregate: Dict[str, Any]) -> str:
        job_label = filters.job or side_label
        if not aggregate.get("reelCount"):
            return f"{job_label} has no qualifying reels in the selected scope."
        phrases = [
            f"{job_label} ran {aggregate.get('reelCount')} reels and {self._format_feet(aggregate.get('totalFeet'))} total feet",
            f"with {self._format_pct(aggregate.get('badFeetPct'))} bad feet",
        ]
        if aggregate.get("derivedFeatures", {}).get("runDirection") == "worsening":
            phrases.append("and the run trended worse later on")
        elif aggregate.get("derivedFeatures", {}).get("runDirection") == "improving":
            phrases.append("and the run improved later on")
        dominant_zone = aggregate.get("derivedFeatures", {}).get("dominantZone")
        if dominant_zone and dominant_zone != "none":
            phrases.append(f"with the heaviest bad-point concentration in the {dominant_zone}")
        return ". ".join([phrases[0], ", ".join(phrases[1:]).strip(", ")]) + "."

    def _build_comparison_summary(self, left: Dict[str, Any], right: Dict[str, Any], winner: str) -> str:
        winner_side = left if winner == "job1" else right
        loser_side = right if winner == "job1" else left
        winner_agg = winner_side.get("aggregate") or {}
        loser_agg = loser_side.get("aggregate") or {}
        winner_label = winner_side.get("filters", {}).get("jobLabel") or winner_side.get("sideLabel")
        loser_label = loser_side.get("filters", {}).get("jobLabel") or loser_side.get("sideLabel")
        winner_bad_pct = self._format_pct(winner_agg.get("badFeetPct"))
        loser_bad_pct = self._format_pct(loser_agg.get("badFeetPct"))
        winner_bad_feet = self._format_feet(winner_agg.get("totalBadFeet"))
        loser_bad_feet = self._format_feet(loser_agg.get("totalBadFeet"))
        quality_gap = self._format_signed_delta(
            self._safe_delta(loser_agg.get("badFeetPct"), winner_agg.get("badFeetPct")),
            "%",
            digits=1,
        )
        bad_feet_gap = self._format_signed_delta(
            self._safe_delta(loser_agg.get("totalBadFeet"), winner_agg.get("totalBadFeet")),
            "ft",
            digits=0,
        )
        parts = [
            f"{loser_label} ran significantly worse than {winner_label} in the selected scope.",
            f"It finished at {loser_bad_pct} Bad Feet % versus {winner_bad_pct} ({quality_gap}), and {loser_bad_feet} bad feet versus {winner_bad_feet} ({bad_feet_gap}).",
        ]
        driver = self._primary_driver_text(left, right)
        if driver:
            parts.append(f"Most of the gap came from {driver.lower()}")
        coverage_text = self._coverage_gap_text(left, right)
        if coverage_text:
            parts.append(coverage_text)
        pattern_text = self._pattern_read(winner_side, loser_side)
        if pattern_text:
            parts.append(f"The weaker result appears tied to {pattern_text.lower()}")
        return " ".join(parts)

    def _build_takeaway(self, winner_side: Dict[str, Any], loser_side: Dict[str, Any]) -> str:
        winner_label = winner_side.get("filters", {}).get("jobLabel") or winner_side.get("sideLabel")
        loser_label = loser_side.get("filters", {}).get("jobLabel") or loser_side.get("sideLabel")
        loser_agg = loser_side.get("aggregate", {}) or {}
        winner_agg = winner_side.get("aggregate", {}) or {}
        outcome = f"{loser_label}'s worse quality appears to come from both higher repeat-length loss and weaker monitoring consistency."
        if (self._to_float(loser_agg.get("speedInstability")) or 0.0) > (self._to_float(winner_agg.get("speedInstability")) or 0.0):
            outcome = f"{loser_label}'s worse quality appears tied to higher repeat-length loss plus less stable speed behavior."
        pattern = self._pattern_read(winner_side, loser_side)
        if pattern:
            return f"{outcome} The main risk on {loser_label} is {pattern.lower()}, while {winner_label} held the run more consistently."
        return f"{outcome} {winner_label} held quality more consistently through the run."

    def _build_main_differences(self, left: Dict[str, Any], right: Dict[str, Any], winner: str) -> List[str]:
        winner_side = left if winner == "job1" else right
        loser_side = right if winner == "job1" else left
        winner_agg = winner_side.get("aggregate") or {}
        loser_agg = loser_side.get("aggregate") or {}
        winner_label = winner_side.get("filters", {}).get("jobLabel") or winner_side.get("sideLabel")
        loser_label = loser_side.get("filters", {}).get("jobLabel") or loser_side.get("sideLabel")
        bad_pct_delta = self._format_signed_delta(self._safe_delta(loser_agg.get("badFeetPct"), winner_agg.get("badFeetPct")), "%", digits=1)
        bad_feet_delta = self._format_signed_delta(self._safe_delta(loser_agg.get("totalBadFeet"), winner_agg.get("totalBadFeet")), "ft", digits=0)
        items = [
            f"Bad Feet % separated the jobs most clearly: {loser_label} ran at {self._format_pct(loser_agg.get('badFeetPct'))} versus {self._format_pct(winner_agg.get('badFeetPct'))} for {winner_label} ({bad_pct_delta}).",
            f"That translated into {self._format_feet(loser_agg.get('totalBadFeet'))} bad feet versus {self._format_feet(winner_agg.get('totalBadFeet'))} ({bad_feet_delta}).",
            f"{loser_label} also ran with weaker support signals, especially {self._primary_driver_text(left, right).lower()}.",
            f"The pattern was not random: {self._pattern_read(winner_side, loser_side)}.",
        ]
        return items

    def _comparison_card(self, label: str, key: str, left_agg: Dict[str, Any], right_agg: Dict[str, Any], *, unit: str) -> Optional[Dict[str, Any]]:
        left_value = left_agg.get(key)
        right_value = right_agg.get(key)
        if left_value is None and right_value is None:
            return None
        lower_better = key not in {"activeFeetPct", "monitoringDensity", "phaseActivePct"}
        if left_value is None:
            better = "job2"
        elif right_value is None:
            better = "job1"
        elif lower_better:
            better = "job1" if float(left_value) <= float(right_value) else "job2"
        else:
            better = "job1" if float(left_value) >= float(right_value) else "job2"
        materiality = self._materiality_for_metric(key, self._safe_delta(left_value, right_value))
        return {
            "label": label,
            "job1Value": left_value,
            "job2Value": right_value,
            "unit": unit,
            "better": better,
            "delta": self._safe_delta(left_value, right_value),
            "deltaDisplay": self._format_signed_delta(self._safe_delta(left_value, right_value), unit, digits=1 if unit == "%" else 0 if unit == "ft" else 2),
            "materialityLabel": materiality.get("label"),
            "materialityTier": materiality.get("tier"),
        }

    def _serialize_filters(self, filters: JobComparisonSideFilters, reels: List[RLMReel]) -> Dict[str, Any]:
        effective_machine_id = filters.machine_id if filters.machine_id is not None else filters.job_machine_id
        machine_name = reels[0].machine.machine_name if reels and reels[0].machine else (f"Press {effective_machine_id}" if effective_machine_id else "All presses")
        return {
            "machineId": filters.machine_id,
            "jobMachineId": filters.job_machine_id,
            "machineName": machine_name,
            "start": filters.start.isoformat(),
            "end": filters.end.isoformat(),
            "job": filters.job,
            "jobLabel": filters.job,
            "minFeet": filters.min_feet,
        }

    def _empty_aggregate(self) -> Dict[str, Any]:
        zone_summary = [
            {
                "key": key,
                "label": label,
                "matchedMonitoringPoints": 0,
                "badMonitoringPoints": 0,
                "goodMonitoringPoints": 0,
                "badPointPct": None,
                "badFeet": 0.0,
                "badFeetSharePct": 0.0,
                "avgAbsDelta": None,
            }
            for key, label, _start, _end in ZONE_SPECS
        ]
        return {
            "reelCount": 0,
            "qualifiedReelCount": 0,
            "runStart": None,
            "runEnd": None,
            "totalFeet": 0.0,
            "totalBadFeet": 0.0,
            "totalGoodFeet": 0.0,
            "badFeetPct": None,
            "activeReelCount": 0,
            "inactiveReelCount": 0,
            "activeReelPct": None,
            "inactiveReelPct": None,
            "activeFeet": 0.0,
            "inactiveFeet": 0.0,
            "activeFeetPct": None,
            "inactiveFeetPct": None,
            "repeatLengthDrift": None,
            "repeatLengthVariation": None,
            "monitoringDensity": None,
            "speedInstability": None,
            "toleranceChanges": None,
            "phaseActivePct": None,
            "runProfile": None,
            "zoneSummary": zone_summary,
            "derivedFeatures": {
                "runDirection": None,
                "dominantZone": None,
                "lateDegradeRate": None,
                "clusteredBadRate": None,
            },
        }

    def _empty_population(self) -> Dict[str, Any]:
        return {
            "reelCount": 0,
            "reelsWithFeet": 0,
            "totalFeet": 0.0,
            "runStart": None,
            "runEnd": None,
        }

    def _empty_comparison_readiness(self) -> Dict[str, Any]:
        return {
            "isComparable": False,
            "label": None,
            "message": None,
            "activeReelPct": None,
        }

    def _assess_comparison_readiness(self, population: Dict[str, Any], aggregate: Dict[str, Any]) -> Dict[str, Any]:
        selected_reels = int(population.get("reelCount") or 0)
        qualified_reels = int(aggregate.get("qualifiedReelCount") or 0)
        active_reels = int(aggregate.get("activeReelCount") or 0)
        active_reel_pct = self._pct(active_reels, selected_reels)
        if selected_reels <= 0:
            return {
                "isComparable": False,
                "label": "No reels in scope",
                "message": "No reels matched the selected job and date scope.",
                "activeReelPct": active_reel_pct,
            }
        if qualified_reels <= 0:
            return {
                "isComparable": False,
                "label": "No RLM-qualified reels",
                "message": f"{selected_reels} reels matched the selection, but none had enough RLM coverage to qualify for comparison.",
                "activeReelPct": active_reel_pct,
            }
        if active_reels <= 0:
            return {
                "isComparable": False,
                "label": "RLM inactive",
                "message": f"RLM was inactive across the full selected run ({selected_reels} reels).",
                "activeReelPct": active_reel_pct,
            }
        if active_reels < 2:
            return {
                "isComparable": False,
                "label": "Too little RLM coverage",
                "message": f"Only {active_reels} of {selected_reels} reels had RLM active, which is too thin for a reliable comparison.",
                "activeReelPct": active_reel_pct,
            }
        if selected_reels >= 10 and (active_reel_pct or 0.0) < 10.0:
            return {
                "isComparable": False,
                "label": "Coverage too thin",
                "message": f"Only {self._format_pct(active_reel_pct)} of reels were active with RLM, which is too little coverage to compare reliably.",
                "activeReelPct": active_reel_pct,
            }
        return {
            "isComparable": True,
            "label": "Comparison-ready",
            "message": None,
            "activeReelPct": active_reel_pct,
        }

    def _relative_position(self, start: Optional[float], end: Optional[float], value: Optional[float]) -> Optional[float]:
        if start is None or end is None or value is None:
            return None
        span = end - start
        if span <= 0:
            return None
        return max(0.0, min((value - start) / span, 1.0))

    def _zone_for_ratio(self, ratio: Optional[float]) -> Optional[str]:
        if ratio is None:
            return None
        for key, _label, start, end in ZONE_SPECS:
            if start <= ratio < end:
                return key
        return None

    def _within_reel_direction(self, zone_summary: List[Dict[str, Any]]) -> str:
        early = next((zone for zone in zone_summary if zone.get("key") == "early"), {})
        late = next((zone for zone in zone_summary if zone.get("key") == "late"), {})
        early_pct = self._to_float(early.get("badPointPct"))
        late_pct = self._to_float(late.get("badPointPct"))
        if early_pct is None and late_pct is None:
            return "flat"
        if early_pct is None:
            return "worsening" if (late_pct or 0.0) > 0 else "flat"
        if late_pct is None:
            return "improving" if early_pct > 0 else "flat"
        if late_pct - early_pct >= 10.0:
            return "worsening"
        if early_pct - late_pct >= 10.0:
            return "improving"
        return "flat"

    def _dominant_bad_zone(self, zone_summary: List[Dict[str, Any]]) -> str:
        zones = [zone for zone in zone_summary if int(zone.get("badMonitoringPoints") or 0) > 0]
        if not zones:
            return "none"
        best = max(zones, key=lambda zone: int(zone.get("badMonitoringPoints") or 0))
        return str(best.get("key") or "none")

    def _dominant_zone_from_aggregate(self, zone_summary: List[Dict[str, Any]]) -> str:
        if not zone_summary:
            return "none"
        zones = [zone for zone in zone_summary if float(zone.get("badFeet") or 0.0) > 0]
        if not zones:
            return "none"
        best = max(zones, key=lambda zone: float(zone.get("badFeet") or 0.0))
        return str(best.get("key") or "none")

    def _bad_pattern(self, zone_summary: List[Dict[str, Any]]) -> str:
        total_bad = sum(int(zone.get("badMonitoringPoints") or 0) for zone in zone_summary)
        if total_bad <= 0:
            return "none"
        dominant = max(int(zone.get("badMonitoringPoints") or 0) for zone in zone_summary)
        if dominant / total_bad >= 0.6:
            return "clustered"
        return "broad"

    def _winner(self, left_agg: Dict[str, Any], right_agg: Dict[str, Any]) -> str:
        left_bad_pct = float(left_agg.get("badFeetPct") or 9999.0)
        right_bad_pct = float(right_agg.get("badFeetPct") or 9999.0)
        if abs(left_bad_pct - right_bad_pct) > 0.25:
            return "job1" if left_bad_pct < right_bad_pct else "job2"
        left_bad_feet = float(left_agg.get("totalBadFeet") or 999999.0)
        right_bad_feet = float(right_agg.get("totalBadFeet") or 999999.0)
        return "job1" if left_bad_feet <= right_bad_feet else "job2"

    def _primary_driver_text(self, left: Dict[str, Any], right: Dict[str, Any]) -> str:
        comparisons = [
            ("repeat-length variation", "repeatLengthVariation", True),
            ("repeat-length drift", "repeatLengthDrift", True),
            ("speed instability", "speedInstability", True),
            ("monitoring density", "monitoringDensity", False),
            ("tolerance changes", "toleranceChanges", True),
        ]
        best_label = None
        best_gap = 0.0
        for label, key, lower_better in comparisons:
            left_value = self._to_float(left.get("aggregate", {}).get(key))
            right_value = self._to_float(right.get("aggregate", {}).get(key))
            if left_value is None or right_value is None:
                continue
            gap = abs(left_value - right_value)
            if gap > best_gap:
                best_gap = gap
                best_label = label
        if not best_label:
            return ""
        return f"{best_label}, which most likely explains the quality gap"

    def _build_summary_rows(
        self,
        left: Dict[str, Any],
        right: Dict[str, Any],
        winner: str,
        bad_feet_pct_delta: Optional[Dict[str, Any]],
        bad_feet_delta: Optional[Dict[str, Any]],
    ) -> List[Dict[str, str]]:
        winner_side = left if winner == "job1" else right
        loser_side = right if winner == "job1" else left
        rows: List[Dict[str, str]] = []
        overall = self._overall_label(left, right, winner)
        if overall:
            rows.append({"label": "Overall", "value": overall})
        quality = self._quality_label(left, right, winner)
        if quality:
            rows.append({"label": "Quality", "value": quality})
        if bad_feet_delta and bad_feet_delta.get("deltaDisplay"):
            rows.append(
                {
                    "label": "Main gap",
                    "value": f"{bad_feet_delta['deltaDisplay']} bad feet",
                }
            )
        driver = self._primary_driver_text(left, right)
        if driver:
            rows.append({"label": "Driver", "value": driver[:1].upper() + driver[1:]})
        pattern = self._pattern_read(winner_side, loser_side)
        if pattern:
            rows.append({"label": "Pattern", "value": pattern[:1].upper() + pattern[1:]})
        coverage = self._coverage_gap_text(left, right)
        if coverage:
            rows.append({"label": "Activity", "value": coverage})
        return rows[:6]

    def _overall_label(self, left: Dict[str, Any], right: Dict[str, Any], winner: str) -> str:
        winner_side = left if winner == "job1" else right
        winner_label = winner_side.get("filters", {}).get("jobLabel") or winner_side.get("sideLabel")
        delta_payload = self._delta_payload(
            left.get("aggregate", {}).get("badFeetPct"),
            right.get("aggregate", {}).get("badFeetPct"),
            "%",
            lower_better=True,
        )
        tier = (delta_payload or {}).get("materialityTier")
        if tier in {"none", "minimal"}:
            return "Comparable runs"
        if tier == "slight":
            return f"Small edge to {winner_label}"
        if tier == "moderate":
            return f"{winner_label} better overall"
        return f"Clear edge to {winner_label}"

    def _quality_label(self, left: Dict[str, Any], right: Dict[str, Any], winner: str) -> str:
        winner_side = left if winner == "job1" else right
        loser_side = right if winner == "job1" else left
        winner_label = winner_side.get("filters", {}).get("jobLabel") or winner_side.get("sideLabel")
        loser_label = loser_side.get("filters", {}).get("jobLabel") or loser_side.get("sideLabel")
        delta_payload = self._delta_payload(
            left.get("aggregate", {}).get("badFeetPct"),
            right.get("aggregate", {}).get("badFeetPct"),
            "%",
            lower_better=True,
        )
        tier = (delta_payload or {}).get("materialityTier")
        if tier in {"none", "minimal"}:
            return "Bad Feet % is essentially tied"
        if tier == "slight":
            return f"{loser_label} slightly worse on quality"
        if tier == "moderate":
            return f"{loser_label} worse on quality"
        return f"{loser_label} clearly worse on quality"

    def _materiality_for_metric(self, key: str, delta: Optional[float]) -> Dict[str, str]:
        gap = abs(self._to_float(delta) or 0.0)
        if key == "badFeetPct":
            if gap < 0.1:
                return {"tier": "none", "label": "Essentially tied"}
            if gap < 0.5:
                return {"tier": "slight", "label": "Slight gap"}
            if gap < 1.5:
                return {"tier": "moderate", "label": "Moderate gap"}
            return {"tier": "large", "label": "Large gap"}
        if key == "totalBadFeet":
            if gap < 500:
                return {"tier": "none", "label": "Minimal gap"}
            if gap < 2000:
                return {"tier": "slight", "label": "Slight gap"}
            if gap < 7000:
                return {"tier": "moderate", "label": "Moderate gap"}
            return {"tier": "large", "label": "Large gap"}
        if key in {"activeFeetPct", "activeReelPct"}:
            if gap < 3.0:
                return {"tier": "none", "label": "Similar"}
            if gap < 10.0:
                return {"tier": "slight", "label": "Slight gap"}
            if gap < 20.0:
                return {"tier": "moderate", "label": "Moderate gap"}
            return {"tier": "large", "label": "Large gap"}
        if key == "monitoringDensity":
            if gap < 10.0:
                return {"tier": "none", "label": "Similar"}
            if gap < 35.0:
                return {"tier": "slight", "label": "Slight gap"}
            if gap < 80.0:
                return {"tier": "moderate", "label": "Moderate gap"}
            return {"tier": "large", "label": "Large gap"}
        if gap < 0.05:
            return {"tier": "none", "label": "Minimal gap"}
        if gap < 0.2:
            return {"tier": "slight", "label": "Slight gap"}
        if gap < 0.6:
            return {"tier": "moderate", "label": "Moderate gap"}
        return {"tier": "large", "label": "Large gap"}

    def _coverage_gap_text(self, left: Dict[str, Any], right: Dict[str, Any]) -> str:
        left_active = self._to_float(left.get("aggregate", {}).get("activeFeetPct"))
        right_active = self._to_float(right.get("aggregate", {}).get("activeFeetPct"))
        if left_active is None or right_active is None:
            return ""
        if abs(left_active - right_active) < 5.0:
            return "Inspection activity was broadly similar between the two jobs."
        better = left if left_active > right_active else right
        return (
            f"{better.get('filters', {}).get('jobLabel') or better.get('sideLabel')} had meaningfully stronger activity coverage "
            f"at {self._format_pct(max(left_active, right_active))} active feet versus {self._format_pct(min(left_active, right_active))}."
        )

    def _run_direction_text(self, left: Dict[str, Any], right: Dict[str, Any]) -> str:
        left_direction = left.get("aggregate", {}).get("derivedFeatures", {}).get("runDirection")
        right_direction = right.get("aggregate", {}).get("derivedFeatures", {}).get("runDirection")
        if left_direction == right_direction or not left_direction or not right_direction:
            return ""
        if right_direction == "worsening" and left_direction != "worsening":
            return f"{right.get('filters', {}).get('jobLabel') or right.get('sideLabel')} also degraded more later in the run."
        if left_direction == "worsening" and right_direction != "worsening":
            return f"{left.get('filters', {}).get('jobLabel') or left.get('sideLabel')} also degraded more later in the run."
        return ""

    def _zone_gap_text(self, left: Dict[str, Any], right: Dict[str, Any]) -> str:
        left_zone = left.get("aggregate", {}).get("derivedFeatures", {}).get("dominantZone")
        right_zone = right.get("aggregate", {}).get("derivedFeatures", {}).get("dominantZone")
        if not left_zone or not right_zone or left_zone == right_zone or "none" in {left_zone, right_zone}:
            return ""
        return (
            f"The within-reel pattern differs too: {left.get('filters', {}).get('jobLabel') or left.get('sideLabel')} was more concentrated in the {left_zone} of reels, "
            f"while {right.get('filters', {}).get('jobLabel') or right.get('sideLabel')} was more concentrated in the {right_zone}."
        )

    def _build_difference_rows(self, left: Dict[str, Any], right: Dict[str, Any]) -> List[Dict[str, Any]]:
        left_label = left.get("filters", {}).get("jobLabel") or left.get("sideLabel")
        right_label = right.get("filters", {}).get("jobLabel") or right.get("sideLabel")
        left_agg = left.get("aggregate") or {}
        right_agg = right.get("aggregate") or {}
        specs = [
            ("Bad Feet %", "badFeetPct", "%", True, "Actual quality loss rate was clearly worse here."),
            ("Bad Feet", "totalBadFeet", "ft", True, "This is the footage impact of the quality gap."),
            ("Monitoring coverage", "monitoringDensity", "pts/1k ft", False, "Lower coverage makes the weaker run less controlled and less observable."),
            ("Active reel rate", "activeReelPct", "%", False, "This shows how often RLM was actually running across reels."),
        ]
        rows = []
        for label, key, unit, lower_better, interpretation in specs:
            left_value = self._to_float(left_agg.get(key))
            right_value = self._to_float(right_agg.get(key))
            if left_value is None and right_value is None:
                continue
            delta = self._safe_delta(left_value, right_value)
            if delta is None:
                delta_display = None
            else:
                delta_display = self._format_signed_delta(delta, unit, digits=1 if unit == "%" else 0 if unit == "ft" else 1)
            rows.append(
                {
                    "label": label,
                    "job1Value": left_value,
                    "job2Value": right_value,
                    "unit": unit,
                    "delta": delta,
                    "deltaDisplay": delta_display,
                    "better": self._better_side(left_value, right_value, lower_better=lower_better),
                    "interpretation": interpretation,
                    "job1Label": left_label,
                    "job2Label": right_label,
                }
            )
        return rows

    def _build_intra_reel_conclusion(self, label: str, aggregate: Dict[str, Any]) -> str:
        zone = aggregate.get("derivedFeatures", {}).get("dominantZone")
        direction = aggregate.get("derivedFeatures", {}).get("runDirection")
        clustered = self._to_float(aggregate.get("derivedFeatures", {}).get("clusteredBadRate")) or 0.0
        if zone == "late":
            base = f"{label} tends to degrade late in the reel."
        elif zone == "middle":
            base = f"{label} shows the strongest separation through the middle of the reel."
        elif zone == "early":
            base = f"{label} starts with more repeat-length loss early in the reel."
        else:
            base = f"{label} is more even across the reel."
        if direction == "worsening":
            base += " It also gets worse later in the overall run."
        elif direction == "improving":
            base += " It starts rough but improves later in the run."
        elif clustered >= 60.0:
            base += " Most of the bad-point activity is concentrated in a narrower zone rather than spread everywhere."
        else:
            base += " The issue pattern is fairly broad rather than isolated."
        return base

    def _comparison_zone_conclusion(self, left: Dict[str, Any], right: Dict[str, Any]) -> str:
        left_zone = left.get("aggregate", {}).get("derivedFeatures", {}).get("dominantZone")
        right_zone = right.get("aggregate", {}).get("derivedFeatures", {}).get("dominantZone")
        left_label = left.get("filters", {}).get("jobLabel") or left.get("sideLabel")
        right_label = right.get("filters", {}).get("jobLabel") or right.get("sideLabel")
        if left_zone == right_zone and left_zone and left_zone != "none":
            return f"Both jobs show their strongest within-reel separation in the {left_zone} of the reel."
        if left_zone == "late" and right_zone != "late":
            return f"The separation between the jobs is strongest at the reel end, where {left_label} loses more stability."
        if right_zone == "late" and left_zone != "late":
            return f"The separation between the jobs is strongest at the reel end, where {right_label} loses more stability."
        return "The two jobs show different within-reel patterns rather than the same failure shape."

    def _pattern_read(self, winner_side: Dict[str, Any], loser_side: Dict[str, Any]) -> str:
        loser_agg = loser_side.get("aggregate", {}) or {}
        winner_agg = winner_side.get("aggregate", {}) or {}
        loser_label = loser_side.get("filters", {}).get("jobLabel") or loser_side.get("sideLabel")
        winner_label = winner_side.get("filters", {}).get("jobLabel") or winner_side.get("sideLabel")
        loser_zone = loser_agg.get("derivedFeatures", {}).get("dominantZone")
        loser_direction = loser_agg.get("derivedFeatures", {}).get("runDirection")
        clustered = self._to_float(loser_agg.get("derivedFeatures", {}).get("clusteredBadRate")) or 0.0
        if loser_direction == "worsening" and loser_zone == "late":
            return f"{loser_label} getting worse over the run and clustering more heavily at the reel end"
        if loser_zone == "late":
            return f"{loser_label} showing most of its bad-point concentration in the last 25% of reels"
        if loser_direction == "worsening":
            return f"{loser_label} degrading later in the run while {winner_label} stays steadier"
        if clustered >= 60.0:
            return f"{loser_label} being driven by a few concentrated bad regions rather than a clean broad run"
        return f"{loser_label} carrying a broader persistent gap while {winner_label} stays more stable"

    def _pattern_chip_for_side(self, side: Dict[str, Any]) -> Optional[str]:
        agg = side.get("aggregate", {}) or {}
        zone = agg.get("derivedFeatures", {}).get("dominantZone")
        direction = agg.get("derivedFeatures", {}).get("runDirection")
        clustered = self._to_float(agg.get("derivedFeatures", {}).get("clusteredBadRate")) or 0.0
        if direction == "worsening":
            return "Gets worse over the run"
        if zone == "late":
            return "Problems cluster late in the reel"
        if clustered >= 60.0:
            return "Driven by concentrated bad regions"
        return "Stays relatively stable across reels"

    def _delta_payload(self, left_value: Optional[float], right_value: Optional[float], unit: str, *, lower_better: bool) -> Optional[Dict[str, Any]]:
        left_num = self._to_float(left_value)
        right_num = self._to_float(right_value)
        if left_num is None and right_num is None:
            return None
        delta = self._safe_delta(left_num, right_num)
        metric_key = "badFeetPct" if unit == "%" else "totalBadFeet" if unit == "ft" else ""
        materiality = self._materiality_for_metric(metric_key, delta) if metric_key else {"tier": None, "label": None}
        return {
            "job1Value": left_num,
            "job2Value": right_num,
            "delta": delta,
            "deltaDisplay": self._format_signed_delta(delta, unit, digits=1 if unit == "%" else 0),
            "better": self._better_side(left_num, right_num, lower_better=lower_better),
            "materialityTier": materiality.get("tier"),
            "materialityLabel": materiality.get("label"),
        }

    def _better_side(self, left_value: Optional[float], right_value: Optional[float], *, lower_better: bool) -> Optional[str]:
        if left_value is None and right_value is None:
            return None
        if left_value is None:
            return "job2"
        if right_value is None:
            return "job1"
        if lower_better:
            return "job1" if left_value <= right_value else "job2"
        return "job1" if left_value >= right_value else "job2"

    def _better_or_worse(self, value: Optional[float], baseline: Optional[float], *, lower_better: bool) -> str:
        if value is None or baseline is None:
            return "different"
        if lower_better:
            return "higher" if value > baseline else "lower"
        return "higher" if value > baseline else "lower"

    def _feet_weighted_bad_pct(self, rows: List[Dict[str, Any]]) -> Optional[float]:
        total_feet = sum(float(row.get("feetTotal") or 0.0) for row in rows)
        total_bad = sum(float(row.get("estimatedBadFeet") or 0.0) for row in rows)
        return (total_bad / total_feet * 100.0) if total_feet > 0 else None

    def _weighted_mean(self, rows: List[Dict[str, Any]], value_key: str, weight_key: str) -> Optional[float]:
        weighted_sum = 0.0
        total_weight = 0.0
        for row in rows:
            value = self._to_float(row.get(value_key))
            weight = self._to_float(row.get(weight_key))
            if value is None or weight is None or weight <= 0:
                continue
            weighted_sum += value * weight
            total_weight += weight
        return round(weighted_sum / total_weight, 3) if total_weight > 0 else None

    def _weighted_mean_abs(self, rows: List[Dict[str, Any]], value_key: str, weight_key: str) -> Optional[float]:
        weighted_sum = 0.0
        total_weight = 0.0
        for row in rows:
            value = self._to_float(row.get(value_key))
            weight = self._to_float(row.get(weight_key))
            if value is None or weight is None or weight <= 0:
                continue
            weighted_sum += abs(value) * weight
            total_weight += weight
        return round(weighted_sum / total_weight, 3) if total_weight > 0 else None

    def _mean(self, values: Iterable[float]) -> Optional[float]:
        clean = [float(value) for value in values if value is not None]
        if not clean:
            return None
        return round(sum(clean) / len(clean), 3)

    def _pct(self, numerator: Optional[float], denominator: Optional[float]) -> Optional[float]:
        if numerator is None or denominator is None or float(denominator) <= 0:
            return None
        return round(float(numerator) / float(denominator) * 100.0, 3)

    def _safe_delta(self, left: Optional[float], right: Optional[float]) -> Optional[float]:
        if left is None or right is None:
            return None
        return round(float(left) - float(right), 3)

    def _to_float(self, value: Any) -> Optional[float]:
        try:
            return None if value is None else float(value)
        except (TypeError, ValueError):
            return None

    def _format_pct(self, value: Optional[float]) -> str:
        if value is None:
            return "--"
        return f"{float(value):.1f}%"

    def _format_feet(self, value: Optional[float]) -> str:
        if value is None:
            return "--"
        return f"{float(value):,.0f} ft"

    def _format_signed_delta(self, value: Optional[float], unit: str, *, digits: int = 1) -> str:
        if value is None:
            return "--"
        prefix = "+" if value > 0 else ""
        if unit == "%":
            return f"{prefix}{float(value):.{digits}f}%"
        if unit == "ft":
            return f"{prefix}{float(value):,.0f} ft"
        return f"{prefix}{float(value):.{digits}f} {unit}".strip()
