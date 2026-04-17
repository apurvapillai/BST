from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass
from datetime import datetime
from decimal import Decimal
from math import sqrt
from typing import Any, DefaultDict, Dict, Iterable, List, Optional

from db.rlm_models import RLMMonitoring, RLMTolerance
from services.rlm_reel_footage import compute_reel_feet_from_range


@dataclass(frozen=True)
class ToleranceSegment:
    tolerance_id: Optional[int]
    reel_db_id: int
    sequence: int
    format_value: Optional[float]
    nominal_length: Optional[float]
    err_shrink: Optional[float]
    err_expand: Optional[float]
    warn_shrink: Optional[float]
    warn_expand: Optional[float]
    timestamp: Optional[datetime]


class RLMRepeatLengthService:
    def fetch_reel_batch(
        self,
        session,
        reel_ids: Iterable[int],
        start: Optional[datetime] = None,
        end: Optional[datetime] = None,
    ) -> Dict[int, Dict[str, Any]]:
        clean_ids = [int(reel_id) for reel_id in reel_ids if reel_id is not None]
        if not clean_ids:
            return {}

        monitoring_query = (
            session.query(
                RLMMonitoring.monitoring_id,
                RLMMonitoring.reel_db_id,
                RLMMonitoring.monitoring_ts,
                RLMMonitoring.format_value,
                RLMMonitoring.curlength,
                RLMMonitoring.webspeed,
            )
            .filter(RLMMonitoring.reel_db_id.in_(clean_ids))
        )
        if start is not None:
            monitoring_query = monitoring_query.filter(RLMMonitoring.monitoring_ts >= start)
        if end is not None:
            monitoring_query = monitoring_query.filter(RLMMonitoring.monitoring_ts <= end)
        monitoring_rows = (
            monitoring_query
            .order_by(
                RLMMonitoring.reel_db_id.asc(),
                RLMMonitoring.monitoring_ts.asc(),
                RLMMonitoring.monitoring_id.asc(),
            )
            .all()
        )
        tolerance_rows = (
            session.query(RLMTolerance)
            .filter(RLMTolerance.reel_db_id.in_(clean_ids))
            .order_by(
                RLMTolerance.reel_db_id.asc(),
                RLMTolerance.tol_format.asc(),
                RLMTolerance.tol_sequence.asc(),
                RLMTolerance.tolerance_time.asc(),
                RLMTolerance.tolerance_id.asc(),
            )
            .all()
        )

        monitoring_by_reel: DefaultDict[int, List[Dict[str, Any]]] = defaultdict(list)
        for monitoring_id, reel_db_id, monitoring_ts, format_value, curlength, webspeed in monitoring_rows:
            monitoring_by_reel[int(reel_db_id)].append(
                {
                    "monitoringId": int(monitoring_id),
                    "reelDbId": int(reel_db_id),
                    "timestamp": monitoring_ts.isoformat() if monitoring_ts else None,
                    "formatValue": self._to_float(format_value),
                    "curlength": self._to_float(curlength),
                    "webspeed": self._to_float(webspeed),
                }
            )

        tolerances_by_reel: DefaultDict[int, List[ToleranceSegment]] = defaultdict(list)
        for row in tolerance_rows:
            reel_db_id = int(row.reel_db_id)
            tolerances_by_reel[reel_db_id].append(
                ToleranceSegment(
                    tolerance_id=int(row.tolerance_id) if row.tolerance_id is not None else None,
                    reel_db_id=reel_db_id,
                    sequence=int(row.tol_sequence or 0),
                    format_value=self._to_float(row.tol_format),
                    nominal_length=self._to_float(row.nom_length),
                    err_shrink=self._abs_or_none(row.err_shrink),
                    err_expand=self._abs_or_none(row.err_expand),
                    warn_shrink=self._abs_or_none(row.wrn_shrink),
                    warn_expand=self._abs_or_none(row.wrn_expand),
                    timestamp=row.tolerance_time,
                )
            )

        return {
            reel_db_id: self.evaluate_reel(
                monitoring_by_reel.get(reel_db_id, []),
                tolerances_by_reel.get(reel_db_id, []),
            )
            for reel_db_id in clean_ids
        }

    def evaluate_reel(
        self,
        monitoring_rows: Iterable[Dict[str, Any]],
        tolerance_rows: Iterable[ToleranceSegment],
    ) -> Dict[str, Any]:
        points = list(monitoring_rows or [])
        segments = self._normalize_segments(tolerance_rows)
        per_segment_counts: DefaultDict[int, Dict[str, Any]] = defaultdict(
            lambda: {
                "segmentIndex": 0,
                "segmentStartFormat": None,
                "segmentEndFormat": None,
                "nominalLength": None,
                "errShrink": None,
                "errExpand": None,
                "matchedMonitoringPoints": 0,
                "goodMonitoringPoints": 0,
                "badMonitoringPoints": 0,
            }
        )
        for index, segment in enumerate(segments, start=1):
            next_segment = segments[index] if index < len(segments) else None
            per_segment_counts[index] = {
                "segmentIndex": index,
                "segmentStartFormat": segment.format_value,
                "segmentEndFormat": next_segment.format_value if next_segment else None,
                "nominalLength": segment.nominal_length,
                "errShrink": segment.err_shrink,
                "errExpand": segment.err_expand,
                "matchedMonitoringPoints": 0,
                "goodMonitoringPoints": 0,
                "badMonitoringPoints": 0,
            }
        enriched_points: List[Dict[str, Any]] = []
        matched_deltas: List[float] = []
        curlengths: List[float] = []
        webspeeds: List[float] = []
        matched_count = 0
        unmatched_count = 0
        good_count = 0
        bad_count = 0

        for point in points:
            curlength = self._to_float(point.get("curlength"))
            webspeed = self._to_float(point.get("webspeed"))
            if curlength is not None:
                curlengths.append(curlength)
            if webspeed is not None:
                webspeeds.append(webspeed)

            match = self._match_segment(point, segments)
            enriched = dict(point)
            enriched.update(match)
            enriched_points.append(enriched)

            if not match.get("matchedTolerance"):
                unmatched_count += 1
                continue

            matched_count += 1
            delta = self._to_float(match.get("delta"))
            if delta is not None:
                matched_deltas.append(delta)
            segment_index = int(match.get("segmentIndex") or 0)
            segment_bucket = per_segment_counts[segment_index]
            segment_bucket["segmentIndex"] = segment_index
            segment_bucket["segmentStartFormat"] = match.get("segmentStartFormat")
            segment_bucket["segmentEndFormat"] = match.get("segmentEndFormat")
            segment_bucket["nominalLength"] = match.get("appliedNominalLength")
            segment_bucket["errShrink"] = match.get("appliedErrShrink")
            segment_bucket["errExpand"] = match.get("appliedErrExpand")
            segment_bucket["matchedMonitoringPoints"] += 1
            if match.get("outOfRange"):
                bad_count += 1
                segment_bucket["badMonitoringPoints"] += 1
            else:
                good_count += 1
                segment_bucket["goodMonitoringPoints"] += 1

        bad_point_pct = (bad_count / matched_count * 100.0) if matched_count else None
        segment_breakdown = [
            per_segment_counts[index]
            for index in sorted(per_segment_counts)
        ]
        latest_segment = segments[-1] if segments else None
        return {
            "totalMonitoringPoints": len(points),
            "matchedMonitoringPoints": matched_count,
            "unmatchedMonitoringPoints": unmatched_count,
            "goodMonitoringPoints": good_count,
            "badMonitoringPoints": bad_count,
            "badPointPct": round(bad_point_pct, 3) if bad_point_pct is not None else None,
            "goodPointPct": round((good_count / matched_count * 100.0), 3) if matched_count else None,
            "toleranceSegmentCount": len(segments),
            "monitorCount": len(points),
            "deltaPointCount": matched_count,
            "oobPointCount": bad_count,
            "monitoringPointsTotal": len(points),
            "monitoringPointsGood": good_count,
            "monitoringPointsBad": bad_count,
            "oobPointPct": round(bad_point_pct, 3) if bad_point_pct is not None else None,
            "avgCurlength": self._mean(curlengths),
            "avgWebspeed": self._mean(webspeeds),
            "minWebspeed": min(webspeeds) if webspeeds else None,
            "maxWebspeed": max(webspeeds) if webspeeds else None,
            "avgDelta": self._mean(matched_deltas),
            "avgAbsDelta": self._mean([abs(delta) for delta in matched_deltas]),
            "deltaStd": self._stddev(matched_deltas),
            "latestTolerance": self._serialize_segment(latest_segment),
            "segments": [self._serialize_segment(segment) for segment in segments],
            "segmentBreakdown": segment_breakdown,
            "points": enriched_points,
        }

    def build_reel_summary(self, reel: Any, repeat_length: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        repeat = dict(repeat_length or {})
        feet_total = compute_reel_feet_from_range(
            getattr(reel, "reel_start", None),
            getattr(reel, "reel_end", None),
            getattr(reel, "format_length", None),
        )
        matched_monitoring_points = int(repeat.get("matchedMonitoringPoints") or 0)
        unmatched_monitoring_points = int(repeat.get("unmatchedMonitoringPoints") or 0)
        good_monitoring_points = int(repeat.get("goodMonitoringPoints") or 0)
        bad_monitoring_points = int(repeat.get("badMonitoringPoints") or 0)
        bad_point_pct = self._to_float(repeat.get("badPointPct"))
        good_point_pct = self._to_float(repeat.get("goodPointPct"))
        estimated_bad_feet = (
            feet_total * bad_point_pct / 100.0
            if feet_total is not None and bad_point_pct is not None
            else None
        )
        estimated_good_feet = (
            max(feet_total - float(estimated_bad_feet or 0.0), 0.0)
            if feet_total is not None and estimated_bad_feet is not None
            else None
        )
        summary = {
            "feet_total": feet_total,
            "estimated_bad_feet": estimated_bad_feet,
            "estimated_good_feet": estimated_good_feet,
            "matched_monitoring_points": matched_monitoring_points,
            "bad_monitoring_points": bad_monitoring_points,
            "good_monitoring_points": good_monitoring_points,
            "unmatched_monitoring_points": unmatched_monitoring_points,
            "bad_point_pct": bad_point_pct,
            "good_point_pct": good_point_pct,
            "total_monitoring_points": int(repeat.get("totalMonitoringPoints") or repeat.get("monitoringPointsTotal") or 0),
            "tolerance_segment_count": int(repeat.get("toleranceSegmentCount") or 0),
            "segment_breakdown": repeat.get("segmentBreakdown") or [],
        }
        summary.update(
            {
                "feetTotal": summary["feet_total"],
                "estimatedBadFeet": summary["estimated_bad_feet"],
                "estimatedGoodFeet": summary["estimated_good_feet"],
                "matchedMonitoringPoints": summary["matched_monitoring_points"],
                "badMonitoringPoints": summary["bad_monitoring_points"],
                "goodMonitoringPoints": summary["good_monitoring_points"],
                "unmatchedMonitoringPoints": summary["unmatched_monitoring_points"],
                "badPointPct": summary["bad_point_pct"],
                "goodPointPct": summary["good_point_pct"],
                "totalMonitoringPoints": summary["total_monitoring_points"],
                "toleranceSegmentCount": summary["tolerance_segment_count"],
                "segmentBreakdown": summary["segment_breakdown"],
            }
        )
        return summary

    def build_reel_summary_batch(
        self,
        reels: Iterable[Any],
        repeat_length_batch: Optional[Dict[int, Dict[str, Any]]] = None,
    ) -> Dict[int, Dict[str, Any]]:
        batch = repeat_length_batch or {}
        summaries: Dict[int, Dict[str, Any]] = {}
        for reel in reels or []:
            reel_db_id = int(getattr(reel, "reel_db_id"))
            summaries[reel_db_id] = self.build_reel_summary(reel, batch.get(reel_db_id) or {})
        return summaries

    def _normalize_segments(self, tolerance_rows: Iterable[ToleranceSegment]) -> List[ToleranceSegment]:
        segments = list(tolerance_rows or [])
        segments.sort(
            key=lambda segment: (
                float("-inf") if segment.format_value is None else float(segment.format_value),
                int(segment.sequence or 0),
                segment.timestamp or datetime.min,
                int(segment.tolerance_id or 0),
            )
        )
        return segments

    def _match_segment(self, point: Dict[str, Any], segments: List[ToleranceSegment]) -> Dict[str, Any]:
        format_value = self._to_float(point.get("formatValue"))
        curlength = self._to_float(point.get("curlength"))
        if curlength is None:
            return {
                "matchedTolerance": False,
                "outOfRange": None,
                "matchReason": "missing_curlength",
            }
        if not segments:
            return {
                "matchedTolerance": False,
                "outOfRange": None,
                "matchReason": "missing_tolerance",
            }
        if format_value is None:
            return {
                "matchedTolerance": False,
                "outOfRange": None,
                "matchReason": "missing_format",
            }

        matched_index = -1
        for index, segment in enumerate(segments):
            segment_start = float("-inf") if segment.format_value is None else float(segment.format_value)
            if segment_start <= format_value:
                matched_index = index
            else:
                break
        if matched_index < 0:
            return {
                "matchedTolerance": False,
                "outOfRange": None,
                "matchReason": "before_first_segment",
            }

        segment = segments[matched_index]
        if segment.nominal_length is None or segment.err_shrink is None or segment.err_expand is None:
            return {
                "matchedTolerance": False,
                "outOfRange": None,
                "matchReason": "invalid_tolerance_limits",
            }

        delta = curlength - float(segment.nominal_length)
        lower = -abs(float(segment.err_shrink))
        upper = abs(float(segment.err_expand))
        next_segment = segments[matched_index + 1] if matched_index + 1 < len(segments) else None
        out_of_range = bool(delta < lower or delta > upper)
        return {
            "matchedTolerance": True,
            "outOfRange": out_of_range,
            "matchReason": "matched",
            "segmentIndex": matched_index + 1,
            "segmentStartFormat": segment.format_value,
            "segmentEndFormat": next_segment.format_value if next_segment else None,
            "appliedToleranceId": segment.tolerance_id,
            "appliedNominalLength": segment.nominal_length,
            "appliedErrShrink": segment.err_shrink,
            "appliedErrExpand": segment.err_expand,
            "appliedWarnShrink": segment.warn_shrink,
            "appliedWarnExpand": segment.warn_expand,
            "delta": delta,
            "lowerBound": lower,
            "upperBound": upper,
        }

    def _serialize_segment(self, segment: Optional[ToleranceSegment]) -> Optional[Dict[str, Any]]:
        if segment is None:
            return None
        return {
            "toleranceId": segment.tolerance_id,
            "reelDbId": segment.reel_db_id,
            "sequence": segment.sequence,
            "formatValue": segment.format_value,
            "nominalLength": segment.nominal_length,
            "warnShrink": segment.warn_shrink,
            "warnExpand": segment.warn_expand,
            "errShrink": segment.err_shrink,
            "errExpand": segment.err_expand,
            "timestamp": segment.timestamp.isoformat() if segment.timestamp else None,
        }

    def _to_float(self, value: Any) -> Optional[float]:
        if value is None:
            return None
        if isinstance(value, (int, float)):
            return float(value)
        if isinstance(value, Decimal):
            return float(value)
        try:
            return float(value)
        except (TypeError, ValueError):
            return None

    def _abs_or_none(self, value: Any) -> Optional[float]:
        numeric = self._to_float(value)
        return abs(numeric) if numeric is not None else None

    def _mean(self, values: List[float]) -> Optional[float]:
        return sum(values) / len(values) if values else None

    def _stddev(self, values: List[float]) -> Optional[float]:
        if not values:
            return None
        avg = self._mean(values)
        if avg is None:
            return None
        variance = sum((value - avg) ** 2 for value in values) / len(values)
        return sqrt(variance)
