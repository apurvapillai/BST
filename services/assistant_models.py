from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Dict, List, Literal, Optional


AnalysisDomain = Literal["auto", "rlm", "bst_defects"]
IntentKind = Literal[
    "status",
    "activity",
    "discovery",
    "compare",
    "ranking",
    "ranking_summary",
    "reel_summary",
    "trend",
    "job_list",
    "job_analysis",
]
ComparisonMode = Literal["none", "press_vs_press", "press_vs_average", "ranking"]
OutputShape = Literal["summary", "table", "chart", "drilldown"]


@dataclass
class StickyFilters:
    analysis_domain: AnalysisDomain = "auto"
    time_scope: Optional[Dict[str, Any]] = None
    press_id: Optional[int] = None
    job: Optional[str] = None
    reel_scope: Optional[Dict[str, Any]] = None
    min_reel_feet: Optional[float] = None

    @classmethod
    def from_dict(cls, data: Optional[Dict[str, Any]]) -> "StickyFilters":
        payload = data or {}
        feet_filter = payload.get("feetFilter")
        return cls(
            analysis_domain=str(payload.get("analysisDomain") or "auto"),
            time_scope=payload.get("timeScope"),
            press_id=payload.get("pressId"),
            job=payload.get("job"),
            reel_scope=payload.get("reelScope"),
            min_reel_feet=(feet_filter or {}).get("minFeet") if isinstance(feet_filter, dict) else payload.get("minReelFeet"),
        )

    def to_dict(self) -> Dict[str, Any]:
        return {
            "analysisDomain": self.analysis_domain,
            "timeScope": self.time_scope,
            "pressId": self.press_id,
            "job": self.job,
            "reelScope": self.reel_scope,
            "minReelFeet": self.min_reel_feet,
            "feetFilter": {
                "minFeet": self.min_reel_feet,
                "label": f"Over {int(self.min_reel_feet)} ft",
            } if self.min_reel_feet is not None else None,
        }


@dataclass
class AssistantRequest:
    intent: Optional[str] = None
    domain: AnalysisDomain = "auto"
    metric_key: Optional[str] = None
    category_key: Optional[str] = None
    comparison_mode: ComparisonMode = "none"
    comparison_target: Optional[str] = None
    grouping: Optional[str] = None
    output_shape: OutputShape = "summary"
    press_id: Optional[int] = None
    press_ids: List[int] = field(default_factory=list)
    job: Optional[str] = None
    time_scope: Optional[Dict[str, Any]] = None
    reel_scope: Optional[Dict[str, Any]] = None
    min_reel_feet: Optional[float] = None
    effective_start: Optional[str] = None
    effective_end: Optional[str] = None
    trend_requested: Optional[bool] = None

    @classmethod
    def from_legacy_dict(cls, data: Optional[Dict[str, Any]]) -> Optional["AssistantRequest"]:
        if not data:
            return None
        analysis_scope = data.get("analysisScope") or {}
        time_scope = analysis_scope if analysis_scope.get("kind") == "time" else None
        reel_scope = analysis_scope if analysis_scope.get("kind") == "reels" else None
        comparison_mode: ComparisonMode = str(data.get("comparison_mode") or data.get("comparisonMode") or "none")
        if comparison_mode == "none":
            if data.get("kind") == "compare":
                comparison_mode = "press_vs_press"
            elif data.get("kind") in {"ranking", "ranking_summary"}:
                comparison_mode = "ranking"
        return cls(
            intent=data.get("kind"),
            domain=str(data.get("domain") or "auto"),
            metric_key=data.get("metric_key"),
            category_key=data.get("summaryCategoryKey") or data.get("compareCategoryKey"),
            comparison_mode=comparison_mode,
            comparison_target=data.get("compareDirection"),
            grouping=data.get("grouping"),
            output_shape=str(data.get("output_shape") or "summary"),
            press_id=data.get("machine_id"),
            press_ids=list(data.get("machine_ids") or []),
            job=data.get("job"),
            time_scope=time_scope,
            reel_scope=reel_scope,
            min_reel_feet=data.get("min_reel_feet"),
            effective_start=data.get("effective_start"),
            effective_end=data.get("effective_end"),
            trend_requested=data.get("trendRequested"),
        )

    def to_dict(self) -> Dict[str, Any]:
        analysis_scope = self.time_scope or self.reel_scope
        return {
            "kind": self.intent,
            "domain": self.domain,
            "metric_key": self.metric_key,
            "category_key": self.category_key,
            "comparison_mode": self.comparison_mode,
            "comparison_target": self.comparison_target,
            "grouping": self.grouping,
            "output_shape": self.output_shape,
            "machine_id": self.press_id,
            "machine_ids": list(self.press_ids),
            "job": self.job,
            "analysisScope": analysis_scope,
            "min_reel_feet": self.min_reel_feet,
            "effective_start": self.effective_start,
            "effective_end": self.effective_end,
            "trendRequested": self.trend_requested,
        }


@dataclass
class QualificationSummary:
    matched_reels: int = 0
    qualified_reels: int = 0
    excluded_reels: int = 0
    exclusion_counts: Dict[str, int] = field(default_factory=dict)
    denominator_label: Optional[str] = None
    notes: List[str] = field(default_factory=list)

    def to_dict(self) -> Dict[str, Any]:
        return {
            "matchedReels": self.matched_reels,
            "qualifiedReels": self.qualified_reels,
            "excludedReels": self.excluded_reels,
            "exclusionCounts": dict(self.exclusion_counts),
            "denominatorLabel": self.denominator_label,
            "notes": list(self.notes),
        }


@dataclass
class ConversationContext:
    sticky_filters: StickyFilters = field(default_factory=StickyFilters)
    last_resolved_request: Optional[AssistantRequest] = None
    source_turn: Optional[int] = None


@dataclass
class RequestResolution:
    original_filters: Dict[str, Any]
    normalized_filters: Dict[str, Any]
    effective_filters: Dict[str, Any]
    parsed_intent: Optional[Dict[str, Any]]
    resolved_intent: Optional[Dict[str, Any]]
    conversation_context: ConversationContext
    sticky_filters_before: StickyFilters
    sticky_filters_after: StickyFilters
    filter_updates: Dict[str, Any]
    time_range_source: str
    sticky_filter_source: str
    conversation_debug: Dict[str, Any]
