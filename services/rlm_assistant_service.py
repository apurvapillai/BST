from __future__ import annotations

import logging
import os
import re
import time
from datetime import datetime, timedelta
from collections import defaultdict
from typing import Any, Dict, List, Optional

from db.rlm_connection import RLMSessionLocal
from db.rlm_models import RLMMachine, RLMPhaseInterval
from services.assistant_models import AssistantRequest, ConversationContext, QualificationSummary, StickyFilters
from services.assistant_metric_registry import METRIC_REGISTRY
from services.assistant_qualification import (
    EXCLUSION_REASON_BELOW_MIN_FEET,
    EXCLUSION_REASON_OUTSIDE_REEL_SCOPE,
    build_qualification_summary,
)
from services.assistant_request_resolver import AssistantRequestResolver
from services.rlm_assistant_openai import (
    RLMAssistantLLMConfigError,
    RLMAssistantLLMError,
    RLMAssistantOpenAIClient,
    RLMAssistantOpenAIConfig,
)
from services.rlm_live_service import RLMLiveService
from services.rlm_press_intelligence_service import (
    PressIntelligenceFilters,
    RLMPressIntelligenceService,
)


SUPPORTED_SCOPE_MESSAGE = (
    "This first version supports RLM-only status, comparison, ranking, reel summary, and trend questions."
)

EXECUTION_MODE_DETERMINISTIC = "deterministic"
EXECUTION_MODE_LLM = "llm-assisted"
VALID_EXECUTION_MODES = {EXECUTION_MODE_DETERMINISTIC, EXECUTION_MODE_LLM}
USE_LLM_REWRITE = False

RANKING_WEAKNESS_KEYWORDS = (
    "low",
    "weak",
    "bad",
    "poor",
    "underperforming",
    "struggling",
)
RANKING_CAUSAL_PHRASES = (
    "why",
    "what s hurting",
    "what is hurting",
    "what s driving",
    "what is driving",
    "what s causing",
    "what is causing",
    "what s dragging down",
    "what is dragging down",
)
RANKING_CONTEXT_KEYWORDS = (
    "ranking",
    "rank",
    "worst",
    "bottom",
    "top",
    "best",
)
RANKING_BREAKDOWN_PHRASES = (
    "hurting",
    "dragging down",
    "weak areas",
)
STATUS_SOFT_PHRASES = (
    "healthy right now",
    "healthy",
    "okay",
    "running okay",
    "in trouble",
    "doing okay",
    "doing alright",
    "how is it running",
)
STATUS_CONTEXT_PHRASES = (
    "tell me about",
)
KNOWN_PRESS_NUMBER_TO_MACHINE_ID = {
    5: 1,
    6: 2,
    7: 3,
    8: 4,
    9: 5,
    11: 6,
    12: 7,
    13: 8,
    14: 9,
    15: 10,
}
KNOWN_MACHINE_ID_TO_PRESS_LABEL = {machine_id: f"Press {press_number}" for press_number, machine_id in KNOWN_PRESS_NUMBER_TO_MACHINE_ID.items()}

METRIC_ALIAS_MAP = {
    "bad_feet_pct": [
        "bad feet pct",
        "bad feet %",
        "bad feet percentage",
        "bad feet",
    ],
    "monitoring_coverage": [
        "monitoring density",
        "monitoring coverage",
        "monitoring quality",
        "coverage",
        "density",
    ],
    "delta_variation": [
        "delta std",
        "delta standard deviation",
        "delta variation",
        "variation",
    ],
    "delta_drift": [
        "delta drift",
        "repeat length drift",
        "drift",
    ],
    "speed_instability": [
        "speed instability",
        "speed swing",
        "webspeed",
        "speed",
    ],
}

RANKING_CATEGORY_ALIAS_MAP = {
    "bad_feet_pct": [
        "bad feet",
        "bad feet pct",
        "bad feet %",
        "bad feet percentage",
    ],
    "monitoring_coverage": [
        "monitoring density",
        "monitoring coverage",
        "coverage",
    ],
    "delta_variation": [
        "delta std",
        "delta standard deviation",
        "repeat length variation",
        "variation",
    ],
    "delta_drift": [
        "repeat length drift",
        "delta drift",
        "drift",
    ],
    "speed_instability": [
        "speed instability",
        "speed swing",
        "webspeed",
    ],
    "tolerance_changes": [
        "tolerance changes",
        "tolerance change count",
        "tolerance changes count",
    ],
}

PHASE2A_METRIC_ALIAS_MAP = {
    "rlm_active_duration": [
        "how long was rlm active",
        "rlm active duration",
        "active duration",
        "active time",
    ],
    "rlm_inactive_duration": [
        "how long was rlm inactive",
        "rlm inactive duration",
        "inactive duration",
        "inactive time",
    ],
    "rlm_active_pct": [
        "rlm active %",
        "active %",
        "active percent",
        "active percentage",
        "rlm active percentage",
        "system active %",
        "system active percent",
        "system active percentage",
        "system active less often",
        "active less often",
        "active pct",
    ],
    "rlm_inactive_pct": [
        "rlm inactive %",
        "inactive %",
        "inactive percent",
        "inactive percentage",
        "rlm inactive percentage",
        "inactive pct",
    ],
    "rlm_good_feet": [
        "good feet",
        "qualified good feet",
    ],
    "rlm_bad_feet_pct": [
        "bad feet %",
        "bad feet pct",
        "bad feet percentage",
    ],
    "rlm_bad_feet": [
        "bad feet",
        "bad footage",
    ],
    "rlm_total_qualifying_feet": [
        "total qualifying feet",
        "qualifying feet",
        "total feet",
    ],
    "monitoring_coverage": [
        "monitored less",
        "weaker monitoring coverage",
        "monitoring density",
        "monitoring coverage",
        "monitoring coverage difference",
        "monitoring coverage differences",
    ],
    "monitoring_points_total": [
        "monitoring points total",
        "monitoring points",
    ],
    "monitoring_points_per_reel": [
        "monitoring points per reel",
    ],
    "monitoring_points_per_foot": [
        "monitoring points per foot",
    ],
    "reels_missing_monitoring": [
        "reels with missing monitoring",
        "missing monitoring",
    ],
    "qualified_reels": [
        "qualified reels",
    ],
    "excluded_reels": [
        "excluded reels",
    ],
    "delta_variation": [
        "delta behavior",
        "delta instability",
        "delta variation",
        "delta std",
        "repeat length variation",
    ],
    "delta_drift": [
        "drift behavior",
        "repeat length drift",
        "delta drift",
        "drift",
    ],
    "speed_instability": [
        "speed instability",
        "speed behavior",
        "speed swing",
        "webspeed",
    ],
    "tolerance_changes": [
        "tolerance changes",
        "tolerance change count",
        "tolerance changes count",
    ],
}


class RLMAssistantService:
    _machine_catalog_by_label: Optional[Dict[str, int]] = None
    _machine_catalog_by_id: Optional[Dict[int, str]] = None

    def __init__(
        self,
        live_service: Optional[RLMLiveService] = None,
        press_service: Optional[RLMPressIntelligenceService] = None,
        llm_client: Optional[RLMAssistantOpenAIClient] = None,
    ) -> None:
        self.live_service = live_service or RLMLiveService()
        self.press_service = press_service or RLMPressIntelligenceService()
        self.llm_client = llm_client
        self.logger = logging.getLogger(__name__)
        self.request_resolver = AssistantRequestResolver(self)

    def handle_chat(
        self,
        message: str,
        filters: Optional[Dict[str, Any]] = None,
        history: Optional[List[Dict[str, Any]]] = None,
        mode: str = EXECUTION_MODE_DETERMINISTIC,
        diagnostic: bool = False,
    ) -> Dict[str, Any]:
        total_start = time.perf_counter()
        diagnostics = self._init_diagnostics()
        resolution = self.request_resolver.resolve(
            message=message,
            filters=filters,
            history=history,
        )
        clean_message = (message or "").strip()
        original_filters = resolution.original_filters
        normalized_filters = resolution.normalized_filters
        effective_filters = resolution.effective_filters
        sticky_before = resolution.sticky_filters_before.to_dict()
        sticky_after = resolution.sticky_filters_after.to_dict()
        filter_updates = resolution.filter_updates
        normalized_message = self._normalize_message(clean_message)
        raw_press_ids = self._extract_press_ids(normalized_message)
        selected_machine_id, machine_id_source = self._resolve_primary_machine_selection(
            clean_message,
            raw_press_ids,
            normalized_filters,
        )
        diagnostics["rawExtractedPressIds"] = list(raw_press_ids)
        diagnostics["selectedMachineId"] = selected_machine_id
        diagnostics["machineIdSource"] = machine_id_source
        diagnostics["requestedPressLabel"] = self._press_label(selected_machine_id) if self._is_valid_machine_id(selected_machine_id) else None
        diagnostics["originalFilterStart"] = original_filters.get("start")
        diagnostics["originalFilterEnd"] = original_filters.get("end")
        diagnostics["stickyFiltersBefore"] = sticky_before
        diagnostics["stickyFiltersAfter"] = sticky_after
        diagnostics["filterUpdatesApplied"] = filter_updates
        diagnostics["activeStickyFilters"] = self._active_sticky_filters(sticky_after)
        normalized_mode = mode if mode in VALID_EXECUTION_MODES else EXECUTION_MODE_DETERMINISTIC
        parsed_intent = resolution.parsed_intent
        resolved_intent = resolution.resolved_intent
        conversation_context = resolution.conversation_debug
        diagnostics["parsedIntentKind"] = parsed_intent.get("kind") if parsed_intent else None
        diagnostics["parsedMachines"] = self._intent_machine_list(resolved_intent)
        diagnostics["usedConversationContext"] = conversation_context["used"]
        diagnostics["contextSourceTurn"] = resolution.conversation_context.source_turn if conversation_context["used"] else None
        diagnostics["inheritedIntent"] = conversation_context["inheritedIntent"]
        diagnostics["inheritedMachineId"] = conversation_context["inheritedMachineId"]
        diagnostics["inheritedMetricKey"] = conversation_context["inheritedMetricKey"]
        diagnostics["inheritedScope"] = conversation_context["inheritedScope"]
        diagnostics["overriddenFields"] = conversation_context["overriddenFields"]
        diagnostics["scopeSource"] = conversation_context.get("scopeSource") or "filters"
        diagnostics["filterSource"] = resolution.sticky_filter_source
        diagnostics["effectiveTimeScope"] = self._effective_time_scope_label(resolved_intent, sticky_after)
        diagnostics["effectiveReelScope"] = self._effective_reel_scope_label(resolved_intent, sticky_after)
        diagnostics["effectiveFeetFilter"] = self._effective_feet_filter_label(sticky_after)
        final_resolved_request = resolution.conversation_context.last_resolved_request.to_dict() if resolution.conversation_context.last_resolved_request else None
        diagnostics["finalResolvedRequest"] = final_resolved_request
        diagnostics["analysisDomain"] = effective_filters.get("analysis_domain") or "auto"
        diagnostics["comparisonMode"] = self._comparison_mode_from_intent(resolved_intent)
        request_model = AssistantRequest.from_legacy_dict(final_resolved_request)
        if request_model and request_model.comparison_mode != "none":
            diagnostics["comparisonScope"] = self.resolve_comparison_scope(
                request_model,
                self._build_filtered_dataset(effective_filters),
            )
        self._attach_scope_diagnostics(
            diagnostics,
            resolved_intent,
            original_filters,
            normalized_filters,
            effective_filters,
            resolution.time_range_source,
        )
        if diagnostic:
            if parsed_intent and parsed_intent.get("kind") in {"ranking", "status"}:
                diagnostics["matchedKeywords"] = list(parsed_intent.get("matchedKeywords") or [])
            if resolved_intent and resolved_intent.get("kind") in {"ranking", "status", "trend", "reel_summary"}:
                diagnostics["resolvedMachineId"] = self._to_int(resolved_intent.get("machine_id"))

        if not clean_message:
            response = self._unsupported_response(
                effective_filters,
                "Ask an RLM question to begin.",
                "No question was provided.",
                data_semantics="request-validation",
            )
            response = self._attach_execution_context(response, requested_mode=normalized_mode, used_mode=EXECUTION_MODE_DETERMINISTIC)
            response = self._attach_resolved_request_context(response, final_resolved_request)
            response = self._attach_sticky_filters_context(response, sticky_after)
            response = self._attach_conversation_context(response, resolution.conversation_context)
            response = self._attach_filter_context(
                response,
                filters=effective_filters,
                resolved_request=final_resolved_request,
                sticky_before=sticky_before,
                sticky_after=sticky_after,
                updates=filter_updates,
            )
            diagnostics["timingMs"]["total"] = self._elapsed_ms(total_start)
            self._finalize_ranking_diagnostics(response, diagnostics, resolved_intent)
            self._finalize_phase2a_diagnostics(response, diagnostics, resolved_intent)
            return self._attach_diagnostics(response, diagnostics, diagnostic)

        if self._is_filter_only_request(filter_updates, resolved_intent, history):
            response = self._sticky_filter_update_response(effective_filters, sticky_after, filter_updates)
            response = self._attach_execution_context(
                response,
                requested_mode=normalized_mode,
                used_mode=EXECUTION_MODE_DETERMINISTIC,
            )
            response = self._attach_resolved_request_context(response, final_resolved_request)
            response = self._attach_sticky_filters_context(response, sticky_after)
            response = self._attach_conversation_context(response, resolution.conversation_context)
            response = self._attach_filter_context(
                response,
                filters=effective_filters,
                resolved_request=final_resolved_request,
                sticky_before=sticky_before,
                sticky_after=sticky_after,
                updates=filter_updates,
            )
            diagnostics["timingMs"]["total"] = self._elapsed_ms(total_start)
            self._finalize_ranking_diagnostics(response, diagnostics, resolved_intent)
            self._finalize_phase2a_diagnostics(response, diagnostics, resolved_intent)
            return self._attach_diagnostics(response, diagnostics, diagnostic)

        if normalized_mode == EXECUTION_MODE_LLM:
            if not self._llm_feature_enabled():
                diagnostics["fallbackTriggered"] = True
                diagnostics["fallbackReason"] = "LLM-assisted mode is disabled by configuration."
                fallback = self._handle_deterministic_chat(clean_message, effective_filters, resolved_intent)
                fallback = self._attach_execution_context(
                    fallback,
                    requested_mode=EXECUTION_MODE_LLM,
                    used_mode=EXECUTION_MODE_DETERMINISTIC,
                    fallback_reason="LLM-assisted mode is currently disabled; deterministic mode was used.",
                )
                fallback = self._attach_resolved_request_context(fallback, final_resolved_request)
                fallback = self._attach_sticky_filters_context(fallback, sticky_after)
                fallback = self._attach_conversation_context(fallback, resolution.conversation_context)
                fallback = self._attach_filter_context(
                    fallback,
                    filters=effective_filters,
                    resolved_request=final_resolved_request,
                    sticky_before=sticky_before,
                    sticky_after=sticky_after,
                    updates=filter_updates,
                )
                diagnostics["timingMs"]["total"] = self._elapsed_ms(total_start)
                self._finalize_ranking_diagnostics(fallback, diagnostics, resolved_intent)
                self._finalize_phase2a_diagnostics(fallback, diagnostics, resolved_intent)
                fallback = self._attach_diagnostics(fallback, diagnostics, diagnostic)
                self._log_chat_result(fallback, diagnostics)
                return fallback
            try:
                response = self._handle_llm_assisted_chat(clean_message, effective_filters, diagnostics, resolved_intent)
                response = self._attach_execution_context(
                    response,
                    requested_mode=EXECUTION_MODE_LLM,
                    used_mode=EXECUTION_MODE_LLM,
                )
                response = self._attach_resolved_request_context(response, final_resolved_request)
                response = self._attach_sticky_filters_context(response, sticky_after)
                response = self._attach_conversation_context(response, resolution.conversation_context)
                response = self._attach_filter_context(
                    response,
                    filters=effective_filters,
                    resolved_request=final_resolved_request,
                    sticky_before=sticky_before,
                    sticky_after=sticky_after,
                    updates=filter_updates,
                )
                diagnostics["timingMs"]["total"] = self._elapsed_ms(total_start)
                self._finalize_ranking_diagnostics(response, diagnostics, resolved_intent)
                self._finalize_phase2a_diagnostics(response, diagnostics, resolved_intent)
                response = self._attach_diagnostics(response, diagnostics, diagnostic)
                self._log_chat_result(response, diagnostics)
                return response
            except (RLMAssistantLLMConfigError, RLMAssistantLLMError, ValueError) as exc:
                self.logger.warning("rlm_assistant.llm_fallback", extra={"error": str(exc)})
                diagnostics["fallbackTriggered"] = True
                diagnostics["fallbackReason"] = str(exc)
                fallback = self._handle_deterministic_chat(clean_message, effective_filters, resolved_intent)
                fallback = self._attach_execution_context(
                    fallback,
                    requested_mode=EXECUTION_MODE_LLM,
                    used_mode=EXECUTION_MODE_DETERMINISTIC,
                    fallback_reason="LLM-assisted mode was unavailable, so deterministic mode was used.",
                )
                fallback = self._attach_resolved_request_context(fallback, final_resolved_request)
                fallback = self._attach_sticky_filters_context(fallback, sticky_after)
                fallback = self._attach_conversation_context(fallback, resolution.conversation_context)
                fallback = self._attach_filter_context(
                    fallback,
                    filters=effective_filters,
                    resolved_request=final_resolved_request,
                    sticky_before=sticky_before,
                    sticky_after=sticky_after,
                    updates=filter_updates,
                )
                diagnostics["timingMs"]["total"] = self._elapsed_ms(total_start)
                self._finalize_ranking_diagnostics(fallback, diagnostics, resolved_intent)
                self._finalize_phase2a_diagnostics(fallback, diagnostics, resolved_intent)
                fallback = self._attach_diagnostics(fallback, diagnostics, diagnostic)
                self._log_chat_result(fallback, diagnostics)
                return fallback
            except Exception as exc:  # pragma: no cover
                self.logger.exception("rlm_assistant.llm_unexpected_failure")
                diagnostics["fallbackTriggered"] = True
                diagnostics["fallbackReason"] = str(exc)
                fallback = self._handle_deterministic_chat(clean_message, effective_filters, resolved_intent)
                fallback = self._attach_execution_context(
                    fallback,
                    requested_mode=EXECUTION_MODE_LLM,
                    used_mode=EXECUTION_MODE_DETERMINISTIC,
                    fallback_reason="LLM-assisted mode was unavailable, so deterministic mode was used.",
                )
                fallback = self._attach_resolved_request_context(fallback, final_resolved_request)
                fallback = self._attach_sticky_filters_context(fallback, sticky_after)
                fallback = self._attach_conversation_context(fallback, resolution.conversation_context)
                fallback = self._attach_filter_context(
                    fallback,
                    filters=effective_filters,
                    resolved_request=final_resolved_request,
                    sticky_before=sticky_before,
                    sticky_after=sticky_after,
                    updates=filter_updates,
                )
                diagnostics["timingMs"]["total"] = self._elapsed_ms(total_start)
                self._finalize_ranking_diagnostics(fallback, diagnostics, resolved_intent)
                self._finalize_phase2a_diagnostics(fallback, diagnostics, resolved_intent)
                fallback = self._attach_diagnostics(fallback, diagnostics, diagnostic)
                self._log_chat_result(fallback, diagnostics)
                return fallback

        response = self._handle_deterministic_chat(clean_message, effective_filters, resolved_intent)
        response = self._attach_execution_context(
            response,
            requested_mode=EXECUTION_MODE_DETERMINISTIC,
            used_mode=EXECUTION_MODE_DETERMINISTIC,
        )
        response = self._attach_resolved_request_context(response, final_resolved_request)
        response = self._attach_sticky_filters_context(response, sticky_after)
        response = self._attach_conversation_context(response, resolution.conversation_context)
        response = self._attach_filter_context(
            response,
            filters=effective_filters,
            resolved_request=final_resolved_request,
            sticky_before=sticky_before,
            sticky_after=sticky_after,
            updates=filter_updates,
        )
        diagnostics["timingMs"]["total"] = self._elapsed_ms(total_start)
        self._finalize_ranking_diagnostics(response, diagnostics, resolved_intent)
        self._finalize_phase2a_diagnostics(response, diagnostics, resolved_intent)
        response = self._attach_diagnostics(response, diagnostics, diagnostic)
        self._log_chat_result(response, diagnostics)
        return response

    def _handle_deterministic_chat(
        self,
        message: str,
        filters: Dict[str, Any],
        intent_override: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        intent = intent_override or self.classify_message(message, filters)
        if not intent:
            lowered = self._normalize_message(message)
            if any(
                token in lowered
                for token in (
                    " what stands out between them ",
                    " which one is worse ",
                    " is the gap big or small ",
                    " which metric differs most ",
                    " what should i check next ",
                )
            ):
                return self._unsupported_response(
                    filters,
                    "This follow-up needs an active comparison first.",
                    "Start with a question like 'Compare Press 6 and Press 8'.",
                    data_semantics="request-validation",
                )
            if any(
                token in lowered
                for token in (
                    " what stands out ",
                    " why is it worse ",
                    " why was it worse ",
                    " did it recover ",
                    " did it recover after the shift ",
                    " was it spikes or sustained ",
                    " spikes or sustained ",
                    " sustained or spikes ",
                    " concentrated or broad ",
                    " where did behavior shift ",
                )
            ):
                return self._unsupported_response(
                    filters,
                    "This analysis needs a press. Which press should I look at?",
                    "Use a press like 'Press 8' or ask 'What changed on Press 8 today?'.",
                    data_semantics="request-validation",
                )
            return self._unsupported_response(
                filters,
                "Question type not supported in this version.",
                SUPPORTED_SCOPE_MESSAGE,
                data_semantics="request-validation",
            )

        validation_error = intent.get("validationError")
        if validation_error == "missing_machine_for_discovery":
            return self._unsupported_response(
                filters,
                "This analysis needs a press. Which press should I look at?",
                "Set a press like 'Use Press 8' or ask with a machine name such as 'What changed on Press 8?'",
                tools=intent.get("tools", []),
                data_semantics="request-validation",
            )
        if validation_error == "job_selection_requires_specific_job":
            return self._clarification_response(
                filters,
                "I need a specific job selection to analyze.",
                "You can pick a job from the recent list, for example 'Use Job JOB-1-A'.",
                tools=intent.get("tools", []),
                data_semantics="request-validation",
            )
        if validation_error == "missing_job_for_machine_job_analysis":
            return self._clarification_response(
                filters,
                "This analysis needs a specific job selection.",
                "Pick a job from the recent list first, for example 'Use Job JOB-1-A'.",
                tools=intent.get("tools", []),
                data_semantics="request-validation",
            )
        if validation_error == "current_job_unknown_on_machine":
            return self._clarification_response(
                filters,
                "I could not determine the current job for that press.",
                "Try 'Show me recent jobs' first, or select a job explicitly with 'Use Job JOB-1-A'.",
                tools=intent.get("tools", []),
                data_semantics="request-validation",
            )
        if validation_error == "ranked_job_reference_unavailable":
            return self._clarification_response(
                filters,
                "I could not resolve that recent-job reference.",
                "Try 'Show me recent jobs' first, or ask 'Which one was worst?' before saying 'Use the worst one'.",
                tools=intent.get("tools", []),
                data_semantics="request-validation",
            )
        if validation_error == "missing_machine":
            return self._clarification_response(
                filters,
                "This question needs a press selection.",
                "Use the dashboard machine filter or mention a press like 'Press 5'.",
                tools=intent.get("tools", []),
                data_semantics="request-validation",
            )
        if validation_error == "comparison_requires_two_presses":
            return self._unsupported_response(
                filters,
                "Comparison questions need two presses.",
                "Use a question like 'Compare Press 6 vs Press 8'.",
                tools=intent.get("tools", []),
                data_semantics="request-validation",
            )
        if validation_error == "unsupported_metric":
            return self._unsupported_response(
                filters,
                "That trend metric is not supported in this version.",
                "Supported trend metrics include bad feet, monitoring density, delta std, drift, and speed instability.",
                tools=intent.get("tools", []),
                data_semantics="request-validation",
            )

        return self._dispatch_intent(filters, intent)

    def _handle_llm_assisted_chat(
        self,
        message: str,
        filters: Dict[str, Any],
        diagnostics: Dict[str, Any],
        parsed_intent_override: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        parsed_intent = parsed_intent_override or self.classify_message(message, filters)
        diagnostics["parsedMachines"] = self._intent_machine_list(parsed_intent)
        if parsed_intent and parsed_intent.get("kind") == "ranking_summary":
            tools_start = time.perf_counter()
            base_response = self._dispatch_intent(filters, parsed_intent)
            diagnostics["timingMs"]["tools"] = self._elapsed_ms(tools_start)
            diagnostics["executedMachines"] = self._rendered_machine_list(base_response)
            diagnostics["baseRenderedMachines"] = self._rendered_machine_list(base_response)
            if not USE_LLM_REWRITE:
                self.logger.info("LLM rewrite disabled — returning deterministic response")
                diagnostics["rewriteRenderedMachines"] = []
                diagnostics["finalRenderedMachines"] = self._rendered_machine_list(base_response)
                return base_response
            client = self._get_llm_client(required=True)
            try:
                diagnostics["rewriteAttempted"] = True
                rewrite_start = time.perf_counter()
                copy = client.compose_copy(
                    message=message,
                    base_response=base_response,
                    tool_results={"ranking_summary": {"answer": base_response.get("answer"), "context": base_response.get("context")}},
                )
                diagnostics["timingMs"]["rewrite"] = self._elapsed_ms(rewrite_start)
                merged = self._merge_llm_copy(base_response, copy, parsed_intent, {})
                diagnostics["rewriteRenderedMachines"] = self._rendered_machine_list(merged if merged is not base_response else copy)
                diagnostics["rewriteApplied"] = merged is not base_response and merged.get("answer") != base_response.get("answer")
                diagnostics["finalRenderedMachines"] = self._rendered_machine_list(merged)
                return merged
            except RLMAssistantLLMError:
                diagnostics["rewriteRenderedMachines"] = []
                diagnostics["finalRenderedMachines"] = self._rendered_machine_list(base_response)
                return base_response

        if parsed_intent and parsed_intent.get("kind") == "discovery":
            tools_start = time.perf_counter()
            base_response = self._dispatch_intent(filters, parsed_intent)
            diagnostics["timingMs"]["tools"] = self._elapsed_ms(tools_start)
            diagnostics["executedMachines"] = self._rendered_machine_list(base_response)
            diagnostics["baseRenderedMachines"] = self._rendered_machine_list(base_response)
            diagnostics["rewriteRenderedMachines"] = []
            diagnostics["finalRenderedMachines"] = self._rendered_machine_list(base_response)
            return base_response

        client = self._get_llm_client(required=True)
        tool_registry = self._tool_registry_schema(filters)
        diagnostics["plannerAttempted"] = True
        planner_start = time.perf_counter()
        raw_plan = client.build_plan(message=message, filters=self._filters_for_model(filters), tool_registry=tool_registry)
        diagnostics["plannerSucceeded"] = True
        diagnostics["timingMs"]["planner"] = self._elapsed_ms(planner_start)
        plan = self._validate_plan(raw_plan, filters, parsed_intent)
        diagnostics["plannerValidationPassed"] = True
        diagnostics["plannedMachines"] = self._plan_machine_list(plan)
        tools_start = time.perf_counter()
        tool_results = self._execute_tool_plan(plan, filters)
        diagnostics["timingMs"]["tools"] = self._elapsed_ms(tools_start)
        diagnostics["executedMachines"] = self._executed_machine_list(tool_results)
        base_response = self._assemble_plan_response(plan, tool_results, filters, parsed_intent)
        diagnostics["baseRenderedMachines"] = self._rendered_machine_list(base_response)
        if not USE_LLM_REWRITE:
            self.logger.info("LLM rewrite disabled — returning deterministic response")
            diagnostics["rewriteRenderedMachines"] = []
            diagnostics["finalRenderedMachines"] = self._rendered_machine_list(base_response)
            return base_response
        try:
            diagnostics["rewriteAttempted"] = True
            rewrite_start = time.perf_counter()
            copy = client.compose_copy(
                message=message,
                base_response=base_response,
                tool_results=self._tool_results_for_model(tool_results),
            )
            diagnostics["timingMs"]["rewrite"] = self._elapsed_ms(rewrite_start)
            merged = self._merge_llm_copy(base_response, copy, parsed_intent, tool_results)
            diagnostics["rewriteRenderedMachines"] = self._rendered_machine_list(merged if merged is not base_response else copy)
            diagnostics["rewriteApplied"] = merged is not base_response and merged.get("answer") != base_response.get("answer")
            diagnostics["finalRenderedMachines"] = self._rendered_machine_list(merged)
            return merged
        except RLMAssistantLLMError as exc:
            self.logger.warning("rlm_assistant.llm_copy_fallback", extra={"error": str(exc)})
            diagnostics["timingMs"]["rewrite"] = diagnostics["timingMs"].get("rewrite", 0)
            diagnostics["rewriteRenderedMachines"] = []
            diagnostics["finalRenderedMachines"] = self._rendered_machine_list(base_response)
            return base_response

    def classify_message(
        self,
        message: str,
        filters: Optional[Dict[str, Any]] = None,
    ) -> Optional[Dict[str, Any]]:
        normalized_filters = self._normalize_filters(filters or {})
        lowered = self._normalize_message(message)
        lowered_stripped = lowered.strip()
        press_ids = self._extract_press_ids(lowered)
        machine_id = self._resolve_primary_machine_id(message, press_ids, normalized_filters)

        previous_window_compare_requested = (
            " compare " in lowered
            and any(
                token in lowered
                for token in (
                    " previous window ",
                    " prior window ",
                    " previous 10 reels ",
                    " previous reels ",
                    " prior 10 reels ",
                    " previous ",
                )
            )
        )
        compare_requested = any(token in lowered for token in ("compare", " vs ", " versus ", " next to ")) and not previous_window_compare_requested
        compare_category_key = self._resolve_ranking_category_key(lowered)
        compare_category_label = self._ranking_category_label(compare_category_key) if compare_category_key else None
        category_compare_requested = bool(compare_category_key) and (
            (" compare " in lowered and (" on " in lowered or " for " in lowered))
            or " which is better on " in lowered
            or " which is worse on " in lowered
            or " who is worse on " in lowered
        )
        compare_direction = "worse" if any(token in lowered for token in (" which is worse on ", " who is worse on ")) else "better"
        ranking_summary_requested = self._parse_ranking_summary(lowered)
        analysis_scope = self._parse_analysis_scope(lowered)
        legacy_metric_key = self._resolve_metric_key(lowered)
        phase2a_metric_key = self._resolve_phase2a_metric_key(lowered)
        sticky_filters = filters.get("sticky_filters") if isinstance(filters.get("sticky_filters"), dict) else {}
        active_job = str(filters.get("job") or sticky_filters.get("job") or "").strip()
        job_list_requested = (
            (" what jobs " in lowered or lowered_stripped.startswith("what jobs"))
            and any(token in lowered for token in (" ran ", " run ", " produced "))
        )
        if not job_list_requested and any(token in lowered for token in (" recent jobs ", " latest jobs ")):
            job_list_requested = (" show me " in lowered or " show " in lowered or " what " in lowered) and self._is_valid_machine_id(machine_id)
        if not job_list_requested and " show jobs " in lowered and self._is_valid_machine_id(machine_id):
            job_list_requested = True
        weakest_recent_job_requested = any(
            token in lowered
            for token in (
                " which recent job performed the worst ",
                " which recent job on ",
                " which one was worst ",
                " which one is worst ",
                " weakest recent job ",
                " show me the weakest recent job ",
                " did one job stand out as the weakest ",
            )
        )
        best_recent_job_requested = any(
            token in lowered
            for token in (
                " which recent job performed the best ",
                " which one was best ",
                " which one is best ",
                " strongest recent job ",
                " show me the strongest recent job ",
                " did one job stand out as the best ",
            )
        )
        job_concentration_requested = any(
            token in lowered
            for token in (
                " concentrated in one recent job or spread across jobs ",
                " concentrated in one job or spread across jobs ",
                " spread across jobs ",
                " spread across recent jobs ",
            )
        )
        selected_job_performance_requested = any(
            token in lowered
            for token in (
                " how is this current job performing ",
                " how is this job performing ",
                " how is it performing ",
                " how is it doing ",
                " is this job worse than this machine s recent runs ",
                " is this job worse than this machine recent runs ",
                " is it worse than recent jobs ",
                " what stands out ",
                " how is the current job performing ",
                " is the current job worse than this machine s recent runs ",
            )
        )
        if " use the weakest recent job " in lowered:
            return {
                "kind": "job_list",
                "machine_id": machine_id,
                "analysisScope": analysis_scope if analysis_scope and analysis_scope.get("kind") in {"time", "reels"} else None,
                "tools": ["get_press_job_list"],
                "validationError": "job_selection_requires_specific_job",
            }
        if weakest_recent_job_requested or best_recent_job_requested or job_concentration_requested or selected_job_performance_requested:
            current_job_requested = " current job " in lowered
            resolved_job = active_job
            validation_error = None
            if current_job_requested:
                if not self._is_valid_machine_id(machine_id):
                    validation_error = "missing_machine"
                else:
                    resolved_job = self._current_job_name_for_machine(machine_id, filters)
                    if not resolved_job:
                        validation_error = "current_job_unknown_on_machine"
            return {
                "kind": "job_analysis",
                "machine_id": machine_id,
                "analysisScope": analysis_scope if analysis_scope and analysis_scope.get("kind") in {"time", "reels"} else None,
                "jobAnalysisMode": (
                    "selected_job_vs_recent"
                    if selected_job_performance_requested
                    else "best_recent_job"
                    if best_recent_job_requested
                    else "concentration"
                    if job_concentration_requested
                    else "weakest_recent_job"
                ),
                "job": resolved_job,
                "tools": ["get_machine_job_analysis"],
                "validationError": validation_error
                or (
                    "missing_machine"
                    if not self._is_valid_machine_id(machine_id)
                    else "missing_job_for_machine_job_analysis"
                    if selected_job_performance_requested and not resolved_job
                    else None
                ),
            }
        reel_summary_requested = any(
            token in lowered for token in ("reel to reel", "reel-to-reel", "reel by reel")
        ) or ("getting worse" in lowered and "reel" in lowered)
        explicit_trend_requested = any(token in lowered for token in (" trend", "trending", "plot "))
        trend_requested = explicit_trend_requested or "show " in lowered
        status_soft_matches = [token for token in STATUS_SOFT_PHRASES if f" {token} " in lowered]
        if " how is " in lowered and " running " in lowered and "how is it running" not in status_soft_matches:
            status_soft_matches.append("how is ... running")
        status_context_matches = [token for token in STATUS_CONTEXT_PHRASES if lowered_stripped.startswith(token)]
        bare_press_reference = bool(press_ids) and re.fullmatch(r"(?:press|p)\s*\d+", lowered_stripped) is not None
        status_matches: List[str] = []
        if " status " in lowered or lowered_stripped.startswith("status "):
            status_matches.append("status")
        if lowered_stripped.startswith("what is the status"):
            status_matches.append("what is the status")
        if lowered_stripped.startswith("how is"):
            status_matches.append("how is")
        if " doing " in lowered and bool(press_ids or machine_id):
            status_matches.append("doing")
        for token in status_soft_matches + status_context_matches:
            if token not in status_matches:
                status_matches.append(token)
        if bare_press_reference:
            status_matches.append("bare press reference")
        status_requested = bool(status_matches) and self._is_valid_machine_id(machine_id)
        weakness_matches = [token for token in RANKING_WEAKNESS_KEYWORDS if f" {token} " in lowered]
        causal_matches = [token for token in RANKING_CAUSAL_PHRASES if f" {token} " in lowered]
        context_matches = [token for token in RANKING_CONTEXT_KEYWORDS if f" {token} " in lowered]
        breakdown_matches = [token for token in RANKING_BREAKDOWN_PHRASES if f" {token} " in lowered]
        # Catch split phrasing like "dragging Press 8 down" after normalization.
        if " dragging " in lowered and " down " in lowered and "dragging down" not in breakdown_matches:
            breakdown_matches.append("dragging down")
        look_weak_matches = [token for token in ("look weak", "looks weak") if f" {token} " in lowered]
        if look_weak_matches:
            weakness_matches.extend(look_weak_matches)
        ranking_matches = []
        for token in weakness_matches + causal_matches + context_matches + breakdown_matches:
            if token not in ranking_matches:
                ranking_matches.append(token)
        ranking_requested = bool(machine_id) and (
            bool(breakdown_matches)
            or bool(causal_matches)
            or (bool(weakness_matches) and bool(context_matches))
            or (" why " in lowered and bool(weakness_matches))
        )
        status_prompt_framing = self._status_prompt_framing(lowered)
        broad_press_explanation_requested = bool(machine_id) and not compare_requested and not phase2a_metric_key and (
            status_requested
            or ranking_requested
            or lowered_stripped.startswith("tell me about")
            or lowered_stripped.startswith("summarize")
            or (" today" in lowered and lowered_stripped.startswith("press "))
        )
        explanation_focus = self._phase2b_explanation_focus(lowered)
        decision_requested = bool(machine_id) and (
            (" why was " in lowered and " worse " in lowered)
            or (" because of " in lowered and " something else " in lowered)
            or " what really changed " in lowered
            or " what changed " in lowered
            or " real difference " in lowered
            or " few reels or the whole job " in lowered
            or " broadly unstable or just spikes " in lowered
            or " just spikes or broadly unstable " in lowered
        )
        discovery_phrase_requested = (
            " what changed " in lowered
            or " what really changed " in lowered
            or (" why " in lowered and " worse " in lowered)
            or " is it getting worse " in lowered
            or " investigate " in lowered
            or " analyze patterns " in lowered
            or " what stands out " in lowered
            or " discover " in lowered
            or " did it recover " in lowered
            or " recover after the shift " in lowered
            or " recovered after the shift " in lowered
            or " spikes or sustained " in lowered
            or " sustained or spikes " in lowered
            or " concentrated or broad " in lowered
            or " where did behavior shift " in lowered
            or previous_window_compare_requested
        )
        discovery_requested = len(press_ids) <= 1 and not compare_requested and not any(token in lowered for token in (" between them ", " between the two ")) and discovery_phrase_requested
        prefer_legacy_trend = bool(
            legacy_metric_key
            and phase2a_metric_key == legacy_metric_key
            and trend_requested
            and not compare_requested
            and not explanation_focus
            and " average " not in lowered
        )
        natural_metric_compare_requested = bool(
            phase2a_metric_key
            and len(press_ids) >= 2
            and any(token in lowered for token in (" less than ", " more than ", " weaker ", " stronger ", " better ", " worse "))
        )
        natural_average_compare_requested = bool(
            phase2a_metric_key
            and self._is_valid_machine_id(machine_id)
            and any(token in lowered for token in (" than average ", " than peer average ", " than the others ", " than the other presses ", " peer average ", " average "))
        )
        if not phase2a_metric_key and any(token in lowered for token in (" repeat length ", " delta behavior ")) and any(
            token in lowered for token in (" how is ", " behaving ", " behavior ", " getting worse ", " getting better ", " trend", " trending ", " show ")
        ):
            phase2a_metric_key = "delta_variation"
        decision_metric_key = self._resolve_decision_metric_key(lowered, phase2a_metric_key)

        if compare_requested and " average " in lowered and self._is_valid_machine_id(machine_id) and len(press_ids) <= 1:
            return {
                "kind": "activity",
                "machine_id": machine_id,
                "metric_key": phase2a_metric_key or "rlm_bad_feet_pct",
                "analysisScope": analysis_scope if analysis_scope and analysis_scope.get("kind") in {"time", "reels"} else None,
                "comparisonMode": "press_vs_average",
                "compareDirection": compare_direction,
                "grouping": explanation_focus or "decision",
                "output_shape": "summary",
                "tools": ["get_rlm_metric_analysis"],
                "validationError": None,
            }
        if compare_requested and phase2a_metric_key:
            machine_ids = [self._machine_id_for_press_reference(press_id) for press_id in press_ids[:2]]
            primary_machine_id = machine_ids[0] if machine_ids else None
            comparison_mode = "press_vs_average" if " average " in lowered and (primary_machine_id or self._is_valid_machine_id(machine_id)) else "press_vs_press"
            return {
                "kind": "activity",
                "machine_id": primary_machine_id or machine_id,
                "machine_ids": machine_ids,
                "metric_key": phase2a_metric_key,
                "analysisScope": analysis_scope if analysis_scope and analysis_scope.get("kind") in {"time", "reels"} else None,
                "comparisonMode": comparison_mode,
                "compareDirection": compare_direction,
                "trendRequested": any(token in lowered for token in (" getting worse ", " getting better ", " trend", " trending ")),
                "output_shape": "summary",
                "grouping": explanation_focus,
                "tools": ["get_rlm_metric_analysis"],
                "validationError": (
                    None
                    if comparison_mode == "press_vs_average" and self._is_valid_machine_id(primary_machine_id or machine_id)
                    else None
                    if len(machine_ids) >= 2
                    else "comparison_requires_two_presses"
                ),
            }
        if natural_metric_compare_requested:
            machine_ids = [self._machine_id_for_press_reference(press_id) for press_id in press_ids[:2]]
            return {
                "kind": "activity",
                "machine_id": machine_ids[0] if machine_ids else None,
                "machine_ids": machine_ids,
                "metric_key": phase2a_metric_key,
                "analysisScope": analysis_scope if analysis_scope and analysis_scope.get("kind") in {"time", "reels"} else None,
                "comparisonMode": "press_vs_press",
                "compareDirection": compare_direction,
                "grouping": explanation_focus,
                "output_shape": "summary",
                "tools": ["get_rlm_metric_analysis"],
                "validationError": None if len(machine_ids) >= 2 else "comparison_requires_two_presses",
            }
        if natural_average_compare_requested:
            return {
                "kind": "activity",
                "machine_id": machine_id,
                "metric_key": phase2a_metric_key,
                "analysisScope": analysis_scope if analysis_scope and analysis_scope.get("kind") in {"time", "reels"} else None,
                "comparisonMode": "press_vs_average",
                "compareDirection": compare_direction,
                "grouping": explanation_focus or "fairness",
                "output_shape": "summary",
                "tools": ["get_rlm_metric_analysis"],
                "validationError": None if self._is_valid_machine_id(machine_id) else "missing_machine",
            }
        if (
            phase2a_metric_key
            and self._is_valid_machine_id(machine_id)
            and not compare_requested
            and any(token in lowered for token in (" how is ", " behaving ", " behavior "))
        ):
            return {
                "kind": "activity",
                "machine_id": machine_id,
                "metric_key": phase2a_metric_key,
                "analysisScope": analysis_scope if analysis_scope and analysis_scope.get("kind") in {"time", "reels"} else None,
                "comparisonMode": "none",
                "trendRequested": False,
                "output_shape": "summary",
                "grouping": explanation_focus,
                "tools": ["get_rlm_metric_analysis"],
                "validationError": None,
            }
        if discovery_requested:
            machine_ids = [self._machine_id_for_press_reference(press_id) for press_id in press_ids[:2]]
            comparison_mode = "none"
            if len(machine_ids) >= 2 or (compare_requested and len(press_ids) >= 2):
                comparison_mode = "press_vs_press"
            elif " average " in lowered or " than average " in lowered:
                comparison_mode = "press_vs_average"
            return {
                "kind": "discovery",
                "machine_id": machine_ids[0] if machine_ids else machine_id,
                "machine_ids": machine_ids,
                "metric_key": phase2a_metric_key or decision_metric_key or "rlm_bad_feet",
                "analysisScope": analysis_scope if analysis_scope and analysis_scope.get("kind") in {"time", "reels"} else None,
                "comparisonMode": comparison_mode,
                "compareDirection": compare_direction,
                "trendRequested": any(token in lowered for token in (" getting worse ", " getting better ", " trend", " trending ")),
                "baselineRequested": previous_window_compare_requested,
                "output_shape": "summary",
                "grouping": explanation_focus or "decision",
                "tools": ["run_discovery_analysis"],
                "validationError": (
                    "missing_machine_for_discovery"
                    if not self._is_valid_machine_id(machine_ids[0] if machine_ids else machine_id)
                    else None
                    if comparison_mode == "press_vs_average" and self._is_valid_machine_id(machine_ids[0] if machine_ids else machine_id)
                    else None
                    if comparison_mode != "press_vs_press" or len(machine_ids) >= 2
                    else "comparison_requires_two_presses"
                ),
            }
        if decision_requested:
            machine_ids = [self._machine_id_for_press_reference(press_id) for press_id in press_ids[:2]]
            comparison_mode = "none"
            if len(machine_ids) >= 2 or (compare_requested and len(press_ids) >= 2):
                comparison_mode = "press_vs_press"
            elif " average " in lowered or " than average " in lowered:
                comparison_mode = "press_vs_average"
            return {
                "kind": "activity",
                "machine_id": machine_ids[0] if machine_ids else machine_id,
                "machine_ids": machine_ids,
                "metric_key": decision_metric_key,
                "analysisScope": analysis_scope if analysis_scope and analysis_scope.get("kind") in {"time", "reels"} else None,
                "comparisonMode": comparison_mode,
                "compareDirection": compare_direction,
                "trendRequested": any(token in lowered for token in (" getting worse ", " getting better ", " trend", " trending ")),
                "output_shape": "summary",
                "grouping": explanation_focus or "decision",
                "tools": ["get_rlm_metric_analysis"],
                "validationError": (
                    None
                    if comparison_mode == "press_vs_average" and self._is_valid_machine_id(machine_ids[0] if machine_ids else machine_id)
                    else None
                    if comparison_mode != "press_vs_press" or len(machine_ids) >= 2
                    else "comparison_requires_two_presses"
                ),
            }
        if compare_requested or category_compare_requested:
            return {
                "kind": "compare",
                "machine_ids": [self._machine_id_for_press_reference(press_id) for press_id in press_ids[:2]],
                "compareRequestedLabels": [f"Press {press_id}" for press_id in press_ids[:2]],
                "analysisScope": analysis_scope if analysis_scope and analysis_scope.get("kind") == "time" else None,
                "tools": ["compare_presses"],
                "validationError": None if len(press_ids) >= 2 else "comparison_requires_two_presses",
                "compareCategoryKey": compare_category_key,
                "compareCategoryLabel": compare_category_label,
                "compareDirection": compare_direction,
            }
        if ranking_summary_requested:
            return ranking_summary_requested
        if job_list_requested:
            return {
                "kind": "job_list",
                "machine_id": machine_id,
                "analysisScope": analysis_scope if analysis_scope and analysis_scope.get("kind") in {"time", "reels"} else None,
                "tools": ["get_press_job_list"],
                "validationError": None if self._is_valid_machine_id(machine_id) else "missing_machine",
            }
        if phase2a_metric_key and not explicit_trend_requested and not prefer_legacy_trend:
            return {
                "kind": "activity",
                "machine_id": machine_id,
                "metric_key": phase2a_metric_key,
                "analysisScope": analysis_scope if analysis_scope and analysis_scope.get("kind") in {"time", "reels"} else None,
                "comparisonMode": "press_vs_average" if " average " in lowered else "none",
                "trendRequested": any(token in lowered for token in (" getting worse ", " getting better ", " trend", " trending ")),
                "output_shape": "drilldown" if explanation_focus in {"reels", "jobs"} else "summary",
                "grouping": explanation_focus,
                "tools": ["get_rlm_metric_analysis"],
                "validationError": None if self._is_valid_machine_id(machine_id) else "missing_machine",
            }
        if reel_summary_requested:
            return {
                "kind": "reel_summary",
                "machine_id": machine_id,
                "analysisScope": analysis_scope if analysis_scope and analysis_scope.get("kind") in {"reels", "time"} else None,
                "tools": ["get_reel_to_reel_summary"],
                "validationError": None if self._is_valid_machine_id(machine_id) else "missing_machine",
            }
        if broad_press_explanation_requested:
            return {
                "kind": "status",
                "machine_id": machine_id,
                "analysisScope": analysis_scope if analysis_scope and analysis_scope.get("kind") == "time" else None,
                "tools": ["get_press_status"],
                "validationError": None if self._is_valid_machine_id(machine_id) else "missing_machine",
                "matchedKeywords": list(dict.fromkeys(status_matches + ranking_matches)),
                "promptFraming": status_prompt_framing,
            }
        if trend_requested:
            metric_key = legacy_metric_key
            return {
                "kind": "trend",
                "machine_id": machine_id,
                "metric_key": metric_key,
                "analysisScope": analysis_scope if analysis_scope and analysis_scope.get("kind") == "time" else None,
                "tools": ["get_press_metric_trend"],
                "validationError": (
                    "missing_machine"
                    if not self._is_valid_machine_id(machine_id)
                    else "unsupported_metric"
                    if metric_key is None
                    else None
                ),
            }
        if ranking_requested:
            return {
                "kind": "ranking",
                "machine_id": machine_id,
                "tools": ["get_press_rankings", "get_press_category_breakdown"],
                "validationError": None if self._is_valid_machine_id(machine_id) else "missing_machine",
                "matchedKeywords": ranking_matches,
            }
        return None

    def _dispatch_intent(self, filters: Dict[str, Any], intent: Dict[str, Any]) -> Dict[str, Any]:
        kind = intent["kind"]
        if kind == "activity":
            return self._assemble_phase2a_metric_response(
                self.get_rlm_metric_analysis_tool(intent, filters),
                filters,
                intent,
            )
        if kind == "discovery":
            discovery_filters = self._filters_with_discovery_scope(filters, intent)
            dataset = self._build_filtered_dataset(discovery_filters, self._to_int(intent.get("machine_id")))
            return self._assemble_discovery_response(
                self.run_discovery_analysis(intent, dataset),
                discovery_filters,
                intent,
            )
        if kind == "job_list":
            return self._assemble_job_list_response(
                self.get_press_job_list_tool(intent["machine_id"], filters),
                filters,
                intent,
            )
        if kind == "job_analysis":
            return self._assemble_job_analysis_response(
                self.get_machine_job_analysis_tool(intent["machine_id"], filters, intent),
                filters,
                intent,
            )
        if kind == "status":
            return self._assemble_status_response(
                self.get_press_status_tool(intent["machine_id"], filters),
                filters,
                intent,
            )
        if kind == "compare":
            return self._assemble_compare_response(
                self.compare_presses_tool(intent["machine_ids"], filters),
                filters,
                intent,
            )
        if kind == "ranking":
            rankings = self._safe_get_press_rankings_tool(intent["machine_id"], filters)
            breakdown = self._safe_get_press_category_breakdown_tool(intent["machine_id"], filters)
            return self._assemble_ranking_response(rankings, breakdown, filters)
        if kind == "ranking_summary":
            return self._assemble_ranking_summary_response(intent, filters)
        if kind == "reel_summary":
            return self._assemble_reel_summary_response(
                self.get_reel_to_reel_summary_tool(intent["machine_id"], filters),
                filters,
                intent,
            )
        if kind == "trend":
            return self._assemble_trend_response(
                self.get_press_metric_trend_tool(intent["machine_id"], intent["metric_key"], filters),
                filters,
                intent,
            )
        return self._unsupported_response(
            filters,
            "Question type not supported.",
            SUPPORTED_SCOPE_MESSAGE,
            data_semantics="request-validation",
        )

    def get_press_status_tool(self, machine_id: int, filters: Dict[str, Any]) -> Dict[str, Any]:
        filtered_rows = self._filtered_reel_metrics(filters, machine_id)
        if filtered_rows:
            filtered_rows.sort(key=lambda row: row.get("productionStart") or "")
            latest = filtered_rows[-1]
            aggregate = self._aggregate_filtered_rows(filtered_rows)
            state = self._filtered_status_from_row(latest)
            requested_label = self._press_label(machine_id)
            return {
                "found": True,
                "machineId": machine_id,
                "machineName": requested_label,
                "latest": {**latest, "machineName": requested_label},
                "aggregate": aggregate,
                "filteredRows": filtered_rows,
                "state": state,
                "dataSemantics": "filtered-window",
            }

        if self._should_live_fallback(filters):
            overview = self.live_service.get_overview()
            card = next((row for row in overview.get("machineCards", []) if int(row.get("machineId") or 0) == machine_id), None)
            windows = next((row for row in overview.get("windowSummary", []) if int(row.get("machineId") or 0) == machine_id), None)
            signal = next((row for row in overview.get("trendSignals", []) if int(row.get("machineId") or 0) == machine_id), None)
            if card:
                requested_label = self._press_label(machine_id)
                return {
                    "found": True,
                    "machineId": machine_id,
                    "machineName": requested_label,
                    "card": {**card, "machineName": requested_label},
                    "windows": (windows or {}).get("windows", {}),
                    "signal": signal,
                    "dataSemantics": "live-current-fallback",
                }

        return {"found": False, "machineId": machine_id, "dataSemantics": "filtered-window"}

    def compare_presses_tool(self, machine_ids: List[int], filters: Dict[str, Any]) -> Dict[str, Any]:
        intelligence = self._get_press_intelligence(filters)
        requested_ids = [int(value) for value in machine_ids[:2]]
        requested_labels = [self._press_label(machine_id) for machine_id in requested_ids]
        rows = [
            row
            for row in intelligence.get("pressRankings", [])
            if int(row.get("machineId") or 0) in set(requested_ids)
        ]
        rows.sort(key=lambda row: requested_ids.index(int(row.get("machineId") or 0)))
        compared_rows = []
        for requested_id, requested_label in zip(requested_ids, requested_labels):
            row = next((item for item in rows if int(item.get("machineId") or 0) == requested_id), None)
            if row:
                normalized = dict(row)
                normalized["machineName"] = requested_label
                compared_rows.append(normalized)
        category_boards = intelligence.get("categoryLeaderboards", []) or []
        categories_by_machine: Dict[int, List[Dict[str, Any]]] = {machine_id: [] for machine_id in requested_ids}
        for board in category_boards:
            for requested_id in requested_ids:
                item = next(
                    (entry for entry in board.get("items", []) if int(entry.get("machineId") or 0) == requested_id),
                    None,
                )
                if not item:
                    continue
                categories_by_machine[requested_id].append(
                    {
                        "key": board.get("key"),
                        "title": board.get("title"),
                        "rank": item.get("rank"),
                        "valueDisplay": item.get("valueDisplay"),
                        "contextLabel": item.get("contextLabel"),
                    }
                )
        for requested_id in requested_ids:
            categories_by_machine[requested_id].sort(key=lambda row: int(row.get("rank") or 999))
        return {
            "machineIds": requested_ids,
            "requestedMachines": requested_ids,
            "requestedMachineLabels": requested_labels,
            "rows": compared_rows,
            "categoriesByMachine": categories_by_machine,
            "metadata": intelligence.get("metadata", {}),
            "dataSemantics": "filtered-window",
        }

    def get_press_rankings_tool(self, machine_id: int, filters: Dict[str, Any]) -> Dict[str, Any]:
        intelligence = self._get_press_intelligence(filters)
        press_row = next(
            (row for row in intelligence.get("pressRankings", []) if int(row.get("machineId") or 0) == machine_id),
            None,
        )
        overview_row = next(
            (row for row in intelligence.get("overviewRankings", []) if int(row.get("machineId") or 0) == machine_id),
            None,
        )
        return {
            "machineId": machine_id,
            "pressRow": press_row,
            "overviewRow": overview_row,
            "dataSemantics": "filtered-window",
        }

    def get_press_category_breakdown_tool(self, machine_id: int, filters: Dict[str, Any]) -> Dict[str, Any]:
        intelligence = self._get_press_intelligence(filters)
        categories = []
        for board in intelligence.get("categoryLeaderboards", []):
            item = next(
                (entry for entry in board.get("items", []) if int(entry.get("machineId") or 0) == machine_id),
                None,
            )
            if not item:
                continue
            categories.append(
                {
                    "key": board.get("key"),
                    "title": board.get("title"),
                    "rank": item.get("rank"),
                    "valueDisplay": item.get("valueDisplay"),
                    "contextLabel": item.get("contextLabel"),
                }
            )
        categories.sort(key=lambda row: int(row.get("rank") or 999))
        return {
            "machineId": machine_id,
            "categories": categories,
            "dataSemantics": "filtered-window",
        }

    def get_reel_to_reel_summary_tool(self, machine_id: int, filters: Dict[str, Any]) -> Dict[str, Any]:
        reels = self._filtered_reel_metrics(filters, machine_id)
        reels.sort(key=lambda row: row.get("productionStart") or "")
        requested_label = self._press_label(machine_id)
        return {
            "machineId": machine_id,
            "machineName": requested_label,
            "summary": self._aggregate_filtered_rows(reels) if reels else {},
            "reels": [{**row, "machineName": requested_label} for row in reels],
            "windowLabel": self._window_label(filters),
            "dataSemantics": "filtered-window",
        }

    def get_press_metric_trend_tool(self, machine_id: int, metric_key: str, filters: Dict[str, Any]) -> Dict[str, Any]:
        intelligence = self._get_press_intelligence(filters)
        category_trends = intelligence.get("categoryTrends", {})
        press_data = (category_trends.get("byPress") or {}).get(str(machine_id)) or {}
        categories = category_trends.get("categories") or []
        category = next((row for row in categories if row.get("key") == metric_key), None)
        requested_label = self._press_label(machine_id)
        return {
            "machineId": machine_id,
            "machineName": requested_label,
            "metricKey": metric_key,
            "metricLabel": (category or {}).get("title") or "Metric Trend",
            "series": (press_data.get("series") or {}).get(metric_key, []),
            "summary": (press_data.get("summary") or {}).get(metric_key, {}),
            "dataSemantics": "filtered-window",
        }

    def get_press_job_list_tool(self, machine_id: int, filters: Dict[str, Any]) -> Dict[str, Any]:
        rows = self._filtered_reel_metrics(filters, machine_id)
        requested_label = self._press_label(machine_id)
        jobs: Dict[str, Dict[str, Any]] = {}
        for row in rows:
            job_name = str(row.get("jobName") or "Unknown job")
            bucket = jobs.setdefault(
                job_name,
                {
                    "jobName": job_name,
                    "reelCount": 0,
                    "feetTotal": 0.0,
                    "start": None,
                    "end": None,
                },
            )
            bucket["reelCount"] += 1
            bucket["feetTotal"] += float(row.get("feetTotal") or 0.0)
            row_dt = self._row_datetime(row)
            if row_dt is not None:
                bucket["start"] = row_dt if bucket["start"] is None or row_dt < bucket["start"] else bucket["start"]
                bucket["end"] = row_dt if bucket["end"] is None or row_dt > bucket["end"] else bucket["end"]
        job_rows = sorted(
            jobs.values(),
            key=lambda item: (
                -(item.get("reelCount") or 0),
                -(item.get("feetTotal") or 0.0),
                str(item.get("jobName") or ""),
            ),
        )
        return {
            "machineId": machine_id,
            "machineName": requested_label,
            "jobs": job_rows,
            "selectedJob": str(filters.get("job") or "").strip() or None,
            "dataSemantics": "filtered-window",
        }

    def _filters_without_job_scope(self, filters: Dict[str, Any]) -> Dict[str, Any]:
        updated = dict(filters or {})
        updated["job"] = ""
        sticky_filters = dict(updated.get("sticky_filters") or {})
        if "job" in sticky_filters:
            sticky_filters["job"] = None
        updated["sticky_filters"] = sticky_filters
        return updated

    def _current_job_name_for_machine(self, machine_id: int, filters: Dict[str, Any]) -> Optional[str]:
        rows = self._filtered_reel_metrics(self._filters_without_job_scope(filters), machine_id)
        if not rows:
            return None
        rows.sort(key=lambda row: row.get("productionStart") or "")
        latest_job = str((rows[-1] or {}).get("jobName") or "").strip()
        return latest_job or None

    def _ranked_job_reference(
        self,
        machine_id: int,
        filters: Dict[str, Any],
        focus: str,
    ) -> Optional[str]:
        tool_data = self.get_machine_job_analysis_tool(
            machine_id,
            self._filters_without_job_scope(filters),
            {"jobAnalysisMode": "weakest_recent_job"},
        )
        ranked_jobs = tool_data.get("rankedJobs") or []
        if not ranked_jobs:
            return None
        if focus == "best":
            target = ranked_jobs[-1]
        else:
            target = ranked_jobs[0]
        job_name = str((target or {}).get("jobName") or "").strip()
        return job_name or None

    def get_machine_job_analysis_tool(self, machine_id: int, filters: Dict[str, Any], intent: Dict[str, Any]) -> Dict[str, Any]:
        rows = self._filtered_reel_metrics(filters, machine_id)
        requested_label = self._press_label(machine_id)
        by_job: Dict[str, List[Dict[str, Any]]] = defaultdict(list)
        for row in rows:
            by_job[str(row.get("jobName") or "Unknown job")].append(row)

        job_summaries: List[Dict[str, Any]] = []
        for job_name, job_rows in by_job.items():
            ordered_rows = sorted(job_rows, key=lambda row: row.get("productionStart") or "")
            aggregate = self._aggregate_filtered_rows(ordered_rows)
            estimated_bad_feet = None
            if aggregate.get("badFeetPct") is not None and aggregate.get("feetTotal") is not None:
                estimated_bad_feet = float(aggregate.get("feetTotal") or 0.0) * float(aggregate.get("badFeetPct") or 0.0) / 100.0
            job_summaries.append(
                {
                    "jobName": job_name,
                    "rows": ordered_rows,
                    "reelCount": aggregate.get("reelsRun") or len(ordered_rows),
                    "feetTotal": aggregate.get("feetTotal") or 0.0,
                    "badFeetPct": aggregate.get("badFeetPct"),
                    "deltaStd": aggregate.get("deltaStd"),
                    "pointsPer1000Ft": aggregate.get("pointsPer1000Ft"),
                    "estimatedBadFeetFeet": estimated_bad_feet,
                    "start": ordered_rows[0].get("productionStart") if ordered_rows else None,
                    "end": ordered_rows[-1].get("productionStart") if ordered_rows else None,
                }
            )

        def normalized_score(value: Optional[float], values: List[Optional[float]], higher_worse: bool = True) -> float:
            usable = [float(item) for item in values if item is not None]
            if value is None or len(usable) < 2:
                return 0.0
            low = min(usable)
            high = max(usable)
            if abs(high - low) < 1e-9:
                return 0.0
            position = (float(value) - low) / (high - low)
            return position if higher_worse else 1.0 - position

        bad_values = [item.get("badFeetPct") for item in job_summaries]
        delta_values = [item.get("deltaStd") for item in job_summaries]
        coverage_values = [item.get("pointsPer1000Ft") for item in job_summaries]
        for item in job_summaries:
            item["worstScore"] = round(
                normalized_score(item.get("badFeetPct"), bad_values, higher_worse=True)
                + normalized_score(item.get("deltaStd"), delta_values, higher_worse=True)
                + normalized_score(item.get("pointsPer1000Ft"), coverage_values, higher_worse=False),
                4,
            )

        ranked_jobs = sorted(
            job_summaries,
            key=lambda item: (
                -(item.get("worstScore") or 0.0),
                -(item.get("badFeetPct") or 0.0),
                -(item.get("deltaStd") or 0.0),
                str(item.get("jobName") or ""),
            ),
        )
        selected_job = str(intent.get("job") or filters.get("job") or "").strip() or None
        selected_summary = next((item for item in ranked_jobs if str(item.get("jobName") or "") == selected_job), None)
        peer_jobs = [item for item in ranked_jobs if str(item.get("jobName") or "") != selected_job] if selected_job else ranked_jobs

        def avg(items: List[Dict[str, Any]], key: str) -> Optional[float]:
            usable = [float(item.get(key)) for item in items if item.get(key) is not None]
            if not usable:
                return None
            return sum(usable) / len(usable)

        recent_baseline = {
            "jobCount": len(peer_jobs),
            "badFeetPct": avg(peer_jobs, "badFeetPct"),
            "deltaStd": avg(peer_jobs, "deltaStd"),
            "pointsPer1000Ft": avg(peer_jobs, "pointsPer1000Ft"),
        }
        total_estimated_bad_feet = sum(float(item.get("estimatedBadFeetFeet") or 0.0) for item in ranked_jobs)
        top_job = ranked_jobs[0] if ranked_jobs else None
        top_share = (
            float(top_job.get("estimatedBadFeetFeet") or 0.0) / total_estimated_bad_feet
            if top_job and total_estimated_bad_feet > 0
            else 0.0
        )
        concentration = {
            "label": "one recent job" if top_share >= 0.55 else "spread across multiple jobs",
            "topJob": top_job.get("jobName") if top_job else None,
            "topShare": round(top_share * 100.0, 1),
            "summary": (
                f"Problems are mainly concentrated in {top_job.get('jobName')}, which accounts for about {round(top_share * 100.0, 1)}% of estimated bad feet."
                if top_job and top_share >= 0.55
                else "Recent weakness is spread across multiple jobs rather than concentrated in one."
            ),
        }
        return {
            "machineId": machine_id,
            "machineName": requested_label,
            "selectedJob": selected_job,
            "selectedJobSummary": selected_summary,
            "recentBaseline": recent_baseline,
            "rankedJobs": ranked_jobs,
            "concentration": concentration,
            "jobAnalysisMode": str(intent.get("jobAnalysisMode") or ""),
            "dataSemantics": "filtered-window",
        }

    def get_rlm_metric_analysis_tool(self, intent: Dict[str, Any], filters: Dict[str, Any]) -> Dict[str, Any]:
        metric_key = str(intent.get("metric_key") or "")
        machine_id = self._to_int(intent.get("machine_id"))
        dataset = self._build_filtered_dataset(filters, machine_id)
        rows = list(dataset.get("rows") or [])
        qualification = dataset.get("qualification")
        metric_result = self._compute_phase2a_metric(metric_key, rows, qualification=qualification)
        comparison_mode = str(intent.get("comparisonMode") or "none")
        comparison = None
        comparison_request = AssistantRequest(
            intent="activity",
            domain=str(filters.get("analysis_domain") or "rlm"),
            metric_key=metric_key,
            comparison_mode=comparison_mode,
            press_id=machine_id,
            press_ids=[self._to_int(value) for value in intent.get("machine_ids") or [] if self._to_int(value) is not None],
        )
        comparison_scope = self.resolve_comparison_scope(comparison_request, self._build_filtered_dataset(filters))
        if comparison_scope.get("valid") and comparison_mode in {"press_vs_average", "press_vs_press"}:
            comparison = self._compute_phase2b_comparison(
                metric_key=metric_key,
                primary_machine_id=machine_id,
                primary_rows=rows,
                filters=filters,
                comparison_scope=comparison_scope,
                comparison_mode=comparison_mode,
            )
        trend = self._compute_phase2a_trend(metric_key, rows)
        drivers = self._compute_phase2b_drivers(metric_key, rows)
        run_position = self._compute_phase2b_run_position(metric_key, rows)
        concentration = self._compute_phase2b_concentration(metric_key, rows)
        alignment = self._compute_phase2b_alignment(rows)
        episodes = self._compute_phase2c_delta_episodes(metric_key, rows)
        return {
            "machineId": machine_id,
            "machineName": self._press_label(machine_id) if machine_id is not None else None,
            "metricKey": metric_key,
            "metricLabel": self._phase2a_metric_label(metric_key),
            "metricResult": metric_result,
            "comparison": comparison,
            "trend": trend,
            "drivers": drivers,
            "runPosition": run_position,
            "concentration": concentration,
            "alignment": alignment,
            "episodes": episodes,
            "qualification": qualification,
            "rows": rows,
            "effectiveFilters": dataset.get("effective_filters") or {},
            "dataSemantics": "filtered-window",
        }

    def _tool_registry_schema(self, filters: Dict[str, Any]) -> List[Dict[str, Any]]:
        return [
            {
                "tool": "get_press_status_tool",
                "description": "Get filtered-window press status, or live fallback when no current-window rows exist.",
                "arguments": {"machine_id": filters.get("machine_id")},
            },
            {
                "tool": "compare_presses_tool",
                "description": "Compare two presses inside the selected window.",
                "arguments": {"machine_ids": [filters.get("machine_id")] if filters.get("machine_id") else []},
            },
            {
                "tool": "get_press_rankings_tool",
                "description": "Get a press ranking row in the selected window.",
                "arguments": {"machine_id": filters.get("machine_id")},
            },
            {
                "tool": "get_press_category_breakdown_tool",
                "description": "Get the category-by-category ranking breakdown for one press.",
                "arguments": {"machine_id": filters.get("machine_id")},
            },
            {
                "tool": "get_reel_to_reel_summary_tool",
                "description": "Summarize reel-to-reel change for one press in the selected window.",
                "arguments": {"machine_id": filters.get("machine_id")},
            },
            {
                "tool": "get_press_metric_trend_tool",
                "description": "Get a filtered-window daily trend for one supported metric.",
                "arguments": {
                    "machine_id": filters.get("machine_id"),
                    "metric_key": sorted(METRIC_ALIAS_MAP.keys()),
                },
            },
        ]

    def _validate_plan(
        self,
        plan: Dict[str, Any],
        filters: Dict[str, Any],
        parsed_intent: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        if not isinstance(plan, dict):
            raise ValueError("LLM plan must be an object.")
        tool_calls = plan.get("toolCalls")
        if not isinstance(tool_calls, list) or not tool_calls:
            raise ValueError("LLM plan must include at least one tool call.")
        if len(tool_calls) > 3:
            raise ValueError("LLM plan requested more than 3 tool calls.")

        validated_calls = []
        allowed = {
            "get_press_status_tool",
            "compare_presses_tool",
            "get_press_rankings_tool",
            "get_press_category_breakdown_tool",
            "get_reel_to_reel_summary_tool",
            "get_press_metric_trend_tool",
        }
        for call in tool_calls:
            if not isinstance(call, dict):
                raise ValueError("Each tool call must be an object.")
            tool = call.get("tool")
            args = call.get("arguments") or {}
            if tool not in allowed:
                raise ValueError(f"Unknown tool requested by LLM: {tool}")
            if not isinstance(args, dict):
                raise ValueError(f"Arguments for {tool} must be an object.")
            validated_calls.append(
                {
                    "tool": tool,
                    "arguments": self._validate_tool_arguments(tool, args, filters, parsed_intent),
                }
            )

        tool_names = [entry["tool"] for entry in validated_calls]
        supported_exact = {
            ("get_press_status_tool",),
            ("compare_presses_tool",),
            ("get_reel_to_reel_summary_tool",),
            ("get_press_metric_trend_tool",),
        }
        ranking_pair = {"get_press_rankings_tool", "get_press_category_breakdown_tool"}
        if parsed_intent and parsed_intent.get("kind") == "ranking" and tool_names == ["get_press_rankings_tool"]:
            # Ranking detail answers are more reliable when the breakdown tool always accompanies the ranking row.
            machine_id = validated_calls[0]["arguments"]["machine_id"]
            validated_calls.append(
                {
                    "tool": "get_press_category_breakdown_tool",
                    "arguments": {"machine_id": machine_id},
                }
            )
            tool_names = [entry["tool"] for entry in validated_calls]
        if parsed_intent and parsed_intent.get("kind") == "ranking" and tool_names == ["get_press_category_breakdown_tool"]:
            # Planner-only breakdown requests still need the base ranking row for response assembly.
            machine_id = validated_calls[0]["arguments"]["machine_id"]
            validated_calls.insert(
                0,
                {
                    "tool": "get_press_rankings_tool",
                    "arguments": {"machine_id": machine_id},
                },
            )
            tool_names = [entry["tool"] for entry in validated_calls]
        if tuple(tool_names) not in supported_exact and set(tool_names) != ranking_pair:
            raise ValueError(f"Unsupported tool combination from LLM: {tool_names}")

        return {
            "intent": plan.get("intent") or "",
            "toolCalls": validated_calls,
        }

    def _validate_tool_arguments(
        self,
        tool: str,
        args: Dict[str, Any],
        filters: Dict[str, Any],
        parsed_intent: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        if tool in {
            "get_press_status_tool",
            "get_press_rankings_tool",
            "get_press_category_breakdown_tool",
            "get_reel_to_reel_summary_tool",
        }:
            explicit_machine = parsed_intent.get("machine_id") if parsed_intent else None
            planner_machine = args.get("machine_id")
            machine_id = self._coerce_machine_id(
                explicit_machine,
                planner_machine if planner_machine is not None else filters.get("machine_id"),
            )
            return {"machine_id": machine_id}
        if tool == "compare_presses_tool":
            explicit_machine_ids = list(parsed_intent.get("machine_ids") or []) if parsed_intent else []
            if explicit_machine_ids:
                machine_ids = explicit_machine_ids[:2]
            else:
                machine_ids = args.get("machine_ids")
            if not isinstance(machine_ids, list) or len(machine_ids) < 2:
                raise ValueError("compare_presses_tool requires 2 machine ids.")
            validated = [self._coerce_machine_id(value, None) for value in machine_ids[:2]]
            return {"machine_ids": validated}
        if tool == "get_press_metric_trend_tool":
            explicit_machine = parsed_intent.get("machine_id") if parsed_intent else None
            planner_machine = args.get("machine_id")
            machine_id = self._coerce_machine_id(
                explicit_machine,
                planner_machine if planner_machine is not None else filters.get("machine_id"),
            )
            explicit_metric = parsed_intent.get("metric_key") if parsed_intent else None
            metric_key = str(explicit_metric or args.get("metric_key") or "").strip()
            if metric_key not in METRIC_ALIAS_MAP:
                raise ValueError(f"Unsupported metric key: {metric_key}")
            return {"machine_id": machine_id, "metric_key": metric_key}
        raise ValueError(f"Unsupported tool validation path: {tool}")

    def _coerce_machine_id(self, raw_value: Any, fallback: Optional[int]) -> int:
        machine_id = self._to_int(raw_value)
        if machine_id is None:
            machine_id = self._to_int(fallback)
        if not self._is_valid_machine_id(machine_id):
            raise ValueError("Invalid or missing machine id.")
        return machine_id

    def _execute_tool_plan(self, plan: Dict[str, Any], filters: Dict[str, Any]) -> Dict[str, Any]:
        results: Dict[str, Any] = {}
        for call in plan.get("toolCalls", []):
            tool = call["tool"]
            args = call["arguments"]
            if tool == "get_press_status_tool":
                results[tool] = self.get_press_status_tool(args["machine_id"], filters)
            elif tool == "compare_presses_tool":
                results[tool] = self.compare_presses_tool(args["machine_ids"], filters)
            elif tool == "get_press_rankings_tool":
                results[tool] = self._safe_get_press_rankings_tool(args["machine_id"], filters)
            elif tool == "get_press_category_breakdown_tool":
                results[tool] = self._safe_get_press_category_breakdown_tool(args["machine_id"], filters)
            elif tool == "get_reel_to_reel_summary_tool":
                results[tool] = self.get_reel_to_reel_summary_tool(args["machine_id"], filters)
            elif tool == "get_press_metric_trend_tool":
                results[tool] = self.get_press_metric_trend_tool(args["machine_id"], args["metric_key"], filters)
            else:  # pragma: no cover
                raise ValueError(f"Tool execution not implemented: {tool}")
        return results

    def _assemble_plan_response(
        self,
        plan: Dict[str, Any],
        tool_results: Dict[str, Any],
        filters: Dict[str, Any],
        parsed_intent: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        tool_names = [call["tool"] for call in plan.get("toolCalls", [])]
        if tool_names == ["get_press_status_tool"]:
            return self._assemble_status_response(tool_results["get_press_status_tool"], filters, parsed_intent)
        if tool_names == ["compare_presses_tool"]:
            return self._assemble_compare_response(tool_results["compare_presses_tool"], filters, parsed_intent)
        if tool_names == ["get_reel_to_reel_summary_tool"]:
            return self._assemble_reel_summary_response(tool_results["get_reel_to_reel_summary_tool"], filters, parsed_intent)
        if tool_names == ["get_press_metric_trend_tool"]:
            return self._assemble_trend_response(tool_results["get_press_metric_trend_tool"], filters, parsed_intent)
        if set(tool_names) == {"get_press_rankings_tool", "get_press_category_breakdown_tool"}:
            return self._assemble_ranking_response(
                tool_results["get_press_rankings_tool"],
                tool_results["get_press_category_breakdown_tool"],
                filters,
            )
        raise ValueError(f"Unsupported plan assembly for tools: {tool_names}")

    def _merge_llm_copy(
        self,
        base_response: Dict[str, Any],
        llm_copy: Dict[str, Any],
        parsed_intent: Optional[Dict[str, Any]],
        tool_results: Dict[str, Any],
    ) -> Dict[str, Any]:
        if not isinstance(llm_copy, dict):
            return base_response
        title = str(llm_copy.get("title") or "").strip()
        summary = str(llm_copy.get("summary") or "").strip()
        sections = llm_copy.get("sections")
        prompts = llm_copy.get("suggestedPrompts")
        if not title or not summary or not isinstance(sections, list) or not isinstance(prompts, list):
            return base_response
        cleaned_sections = []
        for section in sections[:3]:
            if not isinstance(section, dict):
                continue
            label = str(section.get("label") or "").strip()
            text = str(section.get("text") or "").strip()
            if label and text:
                cleaned_sections.append({"label": label, "text": text})
        cleaned_prompts = [str(item).strip() for item in prompts[:3] if str(item).strip()]
        if not cleaned_sections:
            return base_response
        merged = dict(base_response)
        merged["answer"] = {
            "title": title,
            "summary": summary,
            "sections": cleaned_sections,
        }
        if cleaned_prompts:
            merged["suggestedPrompts"] = cleaned_prompts
        if not self._response_matches_entities(merged, parsed_intent, tool_results):
            return base_response
        return merged

    def _get_llm_client(self, *, required: bool) -> Optional[RLMAssistantOpenAIClient]:
        if self.llm_client is not None:
            return self.llm_client
        config = RLMAssistantOpenAIConfig.from_env(required=required)
        if not config:
            return None
        self.llm_client = RLMAssistantOpenAIClient(config)
        return self.llm_client

    def _llm_feature_enabled(self) -> bool:
        if self.llm_client is not None:
            return True
        raw = str(os.environ.get("RLM_ASSISTANT_ENABLE_LLM", "false")).strip().lower()
        return raw in {"1", "true", "yes", "on"}

    def _filters_for_model(self, filters: Dict[str, Any]) -> Dict[str, Any]:
        return {
            "machine_id": filters.get("machine_id"),
            "start": filters.get("start"),
            "end": filters.get("end"),
            "job": intent.get("job") or filters.get("job"),
            "order": filters.get("order"),
            "reel_ids": filters.get("reel_ids"),
        }

    def _tool_results_for_model(self, tool_results: Dict[str, Any]) -> Dict[str, Any]:
        cleaned: Dict[str, Any] = {}
        for key, value in tool_results.items():
            if not isinstance(value, dict):
                cleaned[key] = value
                continue
            subset = {}
            for field in ("machineName", "machineId", "dataSemantics", "summary", "state", "aggregate", "rows", "categories", "series", "pressRow", "overviewRow"):
                if field in value:
                    subset[field] = value[field]
            cleaned[key] = subset
        return cleaned

    def _attach_execution_context(
        self,
        response: Dict[str, Any],
        *,
        requested_mode: str,
        used_mode: str,
        fallback_reason: Optional[str] = None,
    ) -> Dict[str, Any]:
        context = response.setdefault("context", {})
        context["requestedMode"] = requested_mode
        context["executionMode"] = used_mode
        if fallback_reason:
            context["fallbackReason"] = fallback_reason
        return response

    def _attach_sticky_filters_context(
        self,
        response: Dict[str, Any],
        sticky_filters: Dict[str, Any],
    ) -> Dict[str, Any]:
        context = response.setdefault("context", {})
        context["stickyFilters"] = sticky_filters or self._default_sticky_filters()
        return response

    def _attach_resolved_request_context(
        self,
        response: Dict[str, Any],
        resolved_request: Optional[Dict[str, Any]],
    ) -> Dict[str, Any]:
        if resolved_request:
            context = response.setdefault("context", {})
            context["resolvedRequest"] = resolved_request
        return response

    def _attach_conversation_context(
        self,
        response: Dict[str, Any],
        conversation_context: ConversationContext,
    ) -> Dict[str, Any]:
        context = response.setdefault("context", {})
        context["conversationContext"] = {
            "stickyFilters": conversation_context.sticky_filters.to_dict(),
            "lastResolvedRequest": conversation_context.last_resolved_request.to_dict() if conversation_context.last_resolved_request else None,
            "sourceTurn": conversation_context.source_turn,
        }
        return response

    def _attach_diagnostics(
        self,
        response: Dict[str, Any],
        diagnostics: Dict[str, Any],
        enabled: bool,
    ) -> Dict[str, Any]:
        core = {
            "resolved_intent": diagnostics.get("finalResolvedRequest"),
            "analysis_domain": diagnostics.get("analysisDomain")
            or ((response.get("context") or {}).get("filtersApplied") or {}).get("analysis_domain")
            or "auto",
            "comparison_mode": diagnostics.get("comparisonMode") or "none",
            "inherited_from_previous": bool(diagnostics.get("usedConversationContext")),
            "sticky_applied": {
                "time_scope": bool(diagnostics.get("effectiveTimeScope")),
                "press": bool(((response.get("context") or {}).get("stickyFilters") or {}).get("pressId")),
                "job": bool(((response.get("context") or {}).get("stickyFilters") or {}).get("job")),
                "reel_scope": bool(diagnostics.get("effectiveReelScope")),
                "min_reel_feet": bool(diagnostics.get("effectiveFeetFilter")),
            },
        }
        if enabled:
            rendered_machines = self._rendered_machine_list(response)
            diagnostics["renderedPressLabel"] = f"Press {rendered_machines[0]}" if rendered_machines else None
            merged = dict(diagnostics)
            merged.update(core)
            response["diagnostics"] = merged
            return response
        response["diagnostics"] = core
        return response

    def _comparison_mode_from_intent(self, intent: Optional[Dict[str, Any]]) -> str:
        if not intent:
            return "none"
        explicit = str(intent.get("comparisonMode") or "").strip()
        if explicit:
            return explicit
        if intent.get("kind") == "compare":
            return "press_vs_press"
        if intent.get("kind") in {"ranking", "ranking_summary"}:
            return "ranking"
        return "none"

    def _default_sticky_filters(self) -> Dict[str, Any]:
        return {
            "analysisDomain": "auto",
            "timeScope": None,
            "pressId": None,
            "job": None,
            "reelScope": None,
            "feetFilter": None,
        }

    def _last_sticky_filters(self, history: List[Dict[str, Any]]) -> Dict[str, Any]:
        for index in range(len(history) - 1, -1, -1):
            entry = history[index] or {}
            if str(entry.get("role") or "") != "assistant":
                continue
            sticky = entry.get("stickyFilters") or ((entry.get("context") or {}).get("stickyFilters") if isinstance(entry.get("context"), dict) else None)
            if isinstance(sticky, dict):
                merged = self._default_sticky_filters()
                merged.update({key: sticky.get(key) for key in merged.keys() if key in sticky})
                return merged
        return self._default_sticky_filters()

    def _parse_sticky_filter_updates(self, message: str) -> Dict[str, Any]:
        lowered = self._normalize_message(message)
        updates: Dict[str, Any] = {"set": {}, "clear": [], "filterOnly": False}
        explicit_press_ids = self._extract_press_ids(message or "")
        stripped = lowered.strip()
        press_setter_only = bool(
            explicit_press_ids
            and re.fullmatch(r"(?:use\s+|now\s+)?(?:press|p)\s*\d+(?:\s+(?:last\s+\d+\s+(?:reels|hours?|days?)|today|last week))?", stripped)
        )
        if " clear all filters " in lowered:
            updates["clear"] = ["timeScope", "pressId", "job", "reelScope", "feetFilter"]
            updates["filterOnly"] = True
            return updates
        if " use rlm " in lowered:
            updates["set"]["analysisDomain"] = "rlm"
        elif any(token in lowered for token in (" use defects ", " use bst defects ", " defects only ")):
            updates["set"]["analysisDomain"] = "bst_defects"
        elif " use auto domain " in lowered:
            updates["set"]["analysisDomain"] = "auto"
        if " clear time filter " in lowered or " use the full time window again " in lowered:
            updates["clear"].append("timeScope")
        if " clear reel filter " in lowered or " look at all reels now " in lowered:
            updates["clear"].append("reelScope")
        if " clear the feet filter " in lowered or " clear feet filter " in lowered:
            updates["clear"].append("feetFilter")
        if " clear job filter " in lowered or " clear the job filter " in lowered:
            updates["clear"].append("job")
        if any(token in lowered for token in (" only that job ", " analyze only that job ", " use that job ")):
            updates["filterOnly"] = True
        if " clear press filter " in lowered or " clear the press filter " in lowered:
            updates["clear"].append("pressId")
        if explicit_press_ids:
            press_machine_id = self._machine_id_for_press_reference(explicit_press_ids[0])
            if self._is_valid_machine_id(press_machine_id) and press_setter_only:
                updates["set"]["pressId"] = press_machine_id

        explicit_scope = self._parse_analysis_scope(lowered)
        scope_only = bool(explicit_scope) and not any(
            token in stripped
            for token in (
                "status",
                "compare",
                "rank",
                "ranking",
                "trend",
                "plot",
                "show",
                "why",
                "what",
                "is it",
                "did it",
                "how",
                "investigate",
                "discover",
            )
        )
        if explicit_scope:
            if explicit_scope.get("kind") == "reels":
                updates["set"]["reelScope"] = explicit_scope
            elif explicit_scope.get("kind") == "time":
                updates["set"]["timeScope"] = explicit_scope
        if " instead " in lowered:
            if updates["set"].get("timeScope"):
                updates["clear"].append("reelScope")
            if updates["set"].get("reelScope"):
                updates["clear"].append("timeScope")

        if " today " in lowered:
            updates["set"]["timeScope"] = {"kind": "time", "preset": "today", "label": "today"}
        elif " last week " in lowered:
            updates["set"]["timeScope"] = {"kind": "time", "preset": "last_week", "label": "last week"}

        feet_match = re.search(r"\b(?:reels\s+)?(?:over|above)\s+(\d+(?:\.\d+)?)\s*(k)?\s*feet\b", lowered)
        if feet_match:
            value = float(feet_match.group(1))
            if feet_match.group(2):
                value *= 1000.0
            threshold = int(value)
            updates["set"]["feetFilter"] = {
                "minFeet": threshold,
                "label": f"Over {threshold} ft",
            }
        job_match = re.search(r"\bjob\s+([a-z0-9]+(?:[-_][a-z0-9]+)+)\b", message or "", flags=re.IGNORECASE)
        if job_match:
            updates["set"]["job"] = str(job_match.group(1)).strip()

        if updates["clear"] or updates["set"]:
            content_tokens = [
                "status", "compare", "rank", "ranking", "reel", "trend", "plot", "show", "press",
                "bad feet", "monitoring", "drift", "delta", "speed",
            ]
            updates["filterOnly"] = not any(token in stripped for token in content_tokens)
        if press_setter_only:
            updates["filterOnly"] = True
        if scope_only:
            updates["filterOnly"] = True
        updates["clear"] = list(dict.fromkeys(updates["clear"]))
        return updates

    def _apply_sticky_filter_updates(self, current: Dict[str, Any], updates: Dict[str, Any]) -> Dict[str, Any]:
        merged = self._default_sticky_filters()
        merged.update(current or {})
        for key in updates.get("clear") or []:
            if key in merged:
                merged[key] = None
        for key, value in (updates.get("set") or {}).items():
            if key in merged:
                merged[key] = value
        return merged

    def _filters_with_sticky_filters(
        self,
        filters: Dict[str, Any],
        sticky_filters: Dict[str, Any],
        updates: Optional[Dict[str, Any]] = None,
    ) -> tuple[Dict[str, Any], str]:
        updated = dict(filters)
        updated["sticky_filters"] = sticky_filters
        filter_source = self._sticky_filter_source(updates or {}, sticky_filters)

        time_scope = (sticky_filters or {}).get("timeScope")
        if time_scope:
            updated = self._apply_time_scope_to_filters(updated, time_scope)
        press_id = self._to_int((sticky_filters or {}).get("pressId"))
        if self._is_valid_machine_id(press_id):
            updated["machine_id"] = press_id
        job = str((sticky_filters or {}).get("job") or "").strip()
        if job and not updated.get("job"):
            updated["job"] = job
        updated["analysis_domain"] = str((sticky_filters or {}).get("analysisDomain") or "auto")

        feet_filter = (sticky_filters or {}).get("feetFilter")
        updated["min_feet"] = feet_filter.get("minFeet") if isinstance(feet_filter, dict) else None

        updated["reel_scope"] = (sticky_filters or {}).get("reelScope")

        return updated, filter_source

    def _sticky_filter_source(self, updates: Dict[str, Any], sticky_filters: Dict[str, Any]) -> str:
        has_sets = bool((updates or {}).get("set"))
        has_clears = bool((updates or {}).get("clear"))
        if has_sets:
            return "explicit_prompt"
        if has_clears:
            return "cleared"
        return "inherited_session" if self._active_sticky_filters(sticky_filters) else "filters"

    def _active_sticky_filters(self, sticky_filters: Optional[Dict[str, Any]]) -> Dict[str, Any]:
        sticky = sticky_filters or {}
        active = {}
        for key in ("analysisDomain", "timeScope", "pressId", "job", "reelScope", "feetFilter"):
            value = sticky.get(key)
            if value and not (key == "analysisDomain" and value == "auto"):
                active[key] = value
        return active

    def _analysis_domain_label(self, domain: Optional[str]) -> str:
        normalized = str(domain or "auto").strip().lower()
        if normalized == "rlm":
            return "RLM"
        if normalized == "bst_defects":
            return "BST Defects"
        return "Auto"

    def _metric_label_optional(self, metric_key: Optional[str]) -> Optional[str]:
        key = str(metric_key or "").strip()
        if not key:
            return None
        return self._phase2a_metric_label(key)

    def _follow_up_comparison_metric_key(self, metric_key: str) -> Optional[str]:
        key = str(metric_key or "").strip()
        if not key:
            return None
        if key == "bad_feet_pct":
            return "rlm_bad_feet_pct"
        return key

    def _applied_filters_context(
        self,
        filters: Dict[str, Any],
        resolved_request: Optional[Dict[str, Any]],
    ) -> Dict[str, str]:
        applied: Dict[str, str] = {}
        sticky = filters.get("sticky_filters") or {}
        resolved = resolved_request or {}

        machine_ids = [self._to_int(value) for value in resolved.get("machine_ids") or [] if self._to_int(value) is not None]
        machine_id = self._to_int(resolved.get("machine_id"))
        if len(machine_ids) >= 2:
            applied["Presses"] = " vs ".join(self._press_label(value) for value in machine_ids[:2])
        elif self._is_valid_machine_id(machine_id):
            applied["Press"] = self._press_label(machine_id)
        else:
            sticky_press = self._to_int(sticky.get("pressId"))
            if self._is_valid_machine_id(sticky_press):
                applied["Press"] = self._press_label(sticky_press)

        job = str(filters.get("job") or "").strip() or str(sticky.get("job") or "").strip()
        if job:
            applied["Job"] = job

        scope = resolved.get("analysisScope") or {}
        if scope.get("kind") == "time" and scope.get("label"):
            applied["Time scope"] = str(scope.get("label"))
        elif isinstance(sticky.get("timeScope"), dict) and sticky["timeScope"].get("label"):
            applied["Time scope"] = str(sticky["timeScope"].get("label"))

        if scope.get("kind") == "reels" and scope.get("label"):
            applied["Reel scope"] = str(scope.get("label"))
        elif isinstance(sticky.get("reelScope"), dict) and sticky["reelScope"].get("label"):
            applied["Reel scope"] = str(sticky["reelScope"].get("label"))

        min_feet = filters.get("min_feet")
        if min_feet:
            applied["Min reel feet"] = self._format_feet_value(min_feet)

        domain = self._analysis_domain_label(filters.get("analysis_domain"))
        if domain != "Auto":
            applied["Domain"] = domain

        metric_label = self._metric_label_optional(resolved.get("metric_key"))
        if metric_label:
            applied["Metric"] = metric_label

        return applied

    def _filter_changes_context(
        self,
        *,
        sticky_before: Dict[str, Any],
        sticky_after: Dict[str, Any],
        updates: Dict[str, Any],
    ) -> List[str]:
        before = sticky_before or {}
        after = sticky_after or {}
        set_updates = (updates or {}).get("set") or {}
        clear_updates = list((updates or {}).get("clear") or [])
        changes: List[str] = []

        before_time = ((before.get("timeScope") or {}).get("label") if isinstance(before.get("timeScope"), dict) else None)
        after_time = ((after.get("timeScope") or {}).get("label") if isinstance(after.get("timeScope"), dict) else None)
        before_reel = ((before.get("reelScope") or {}).get("label") if isinstance(before.get("reelScope"), dict) else None)
        after_reel = ((after.get("reelScope") or {}).get("label") if isinstance(after.get("reelScope"), dict) else None)

        if before_time and "timeScope" in clear_updates and set_updates.get("reelScope") and after_reel:
            changes.append(f"Replaced previous time scope with reel scope: {after_reel}")
        elif before_reel and "reelScope" in clear_updates and set_updates.get("timeScope") and after_time:
            changes.append(f"Cleared prior reel scope and applied time scope: {after_time}")
        else:
            if "timeScope" in clear_updates and not set_updates.get("timeScope"):
                changes.append("Cleared time scope")
            if set_updates.get("timeScope") and after_time:
                changes.append(f"Updated time scope to {after_time}")
            if "reelScope" in clear_updates and not set_updates.get("reelScope"):
                changes.append("Cleared reel scope")
            if set_updates.get("reelScope") and after_reel:
                changes.append(f"Updated reel scope to {after_reel}")

        if "job" in clear_updates and not set_updates.get("job"):
            changes.append("Cleared job filter")
        job_after = str(after.get("job") or "").strip()
        if set_updates.get("job") and job_after:
            changes.append(f"Updated job to {job_after}")

        if "pressId" in clear_updates and not set_updates.get("pressId"):
            changes.append("Cleared press filter")
        before_press = self._to_int(before.get("pressId"))
        after_press = self._to_int(after.get("pressId"))
        if after_press is not None and before_press != after_press:
            changes.append(f"Updated press to {self._press_label(after_press)}")

        if "feetFilter" in clear_updates and not set_updates.get("feetFilter"):
            changes.append("Cleared min reel feet filter")
        feet_after = (after.get("feetFilter") or {}) if isinstance(after.get("feetFilter"), dict) else {}
        feet_label = str(feet_after.get("label") or "").strip()
        if set_updates.get("feetFilter") and feet_label:
            changes.append(f"Updated min reel feet to {feet_label}")

        before_domain = str(before.get("analysisDomain") or "auto")
        after_domain = str(after.get("analysisDomain") or "auto")
        if after_domain != before_domain:
            changes.append(f"Switched analysis domain to {self._analysis_domain_label(after_domain)}")

        return list(dict.fromkeys(changes))

    def _attach_filter_context(
        self,
        response: Dict[str, Any],
        *,
        filters: Dict[str, Any],
        resolved_request: Optional[Dict[str, Any]],
        sticky_before: Dict[str, Any],
        sticky_after: Dict[str, Any],
        updates: Dict[str, Any],
    ) -> Dict[str, Any]:
        context = response.setdefault("context", {})
        context["appliedFilters"] = self._applied_filters_context(filters, resolved_request)
        context["filterChanges"] = self._filter_changes_context(
            sticky_before=sticky_before,
            sticky_after=sticky_after,
            updates=updates,
        )
        return response

    def _effective_time_scope_label(
        self,
        intent: Optional[Dict[str, Any]],
        sticky_filters: Dict[str, Any],
    ) -> Optional[str]:
        scope = (intent or {}).get("analysisScope") or {}
        if scope.get("kind") == "time":
            return scope.get("label")
        return ((sticky_filters or {}).get("timeScope") or {}).get("label")

    def _effective_reel_scope_label(
        self,
        intent: Optional[Dict[str, Any]],
        sticky_filters: Dict[str, Any],
    ) -> Optional[str]:
        scope = (intent or {}).get("analysisScope") or {}
        if scope.get("kind") == "reels":
            return scope.get("label")
        return ((sticky_filters or {}).get("reelScope") or {}).get("label")

    def _effective_feet_filter_label(self, sticky_filters: Dict[str, Any]) -> Optional[str]:
        return ((sticky_filters or {}).get("feetFilter") or {}).get("label")

    def _apply_time_scope_to_filters(self, filters: Dict[str, Any], scope: Dict[str, Any]) -> Dict[str, Any]:
        updated = dict(filters)
        today = datetime.utcnow().date()
        preset = scope.get("preset")
        if preset == "today":
            updated["start"] = today.isoformat()
            updated["end"] = today.isoformat()
            updated["start_dt"] = self._parse_filter_date(updated["start"], is_end=False)
            updated["end_dt"] = self._parse_filter_date(updated["end"], is_end=True)
            return updated
        if preset == "last_week":
            anchor = self._scope_anchor_datetime(filters)
            updated["start_dt"] = anchor - timedelta(days=7)
            updated["end_dt"] = anchor
            updated["start"] = updated["start_dt"].isoformat(timespec="seconds")
            updated["end"] = updated["end_dt"].isoformat(timespec="seconds")
            return updated
        if scope.get("kind") == "time":
            delta = self._scope_delta(scope)
            if delta is not None:
                anchor = self._scope_anchor_datetime(filters)
                updated["start_dt"] = anchor - delta
                updated["end_dt"] = anchor
                updated["start"] = updated["start_dt"].isoformat(timespec="seconds")
                updated["end"] = updated["end_dt"].isoformat(timespec="seconds")
        return updated

    def _scope_filter_update_keys(self, updates: Dict[str, Any]) -> set[str]:
        keys = set((updates.get("set") or {}).keys())
        keys.update(updates.get("clear") or [])
        return {key for key in keys if key in {"timeScope", "reelScope", "feetFilter"}}

    def _latest_active_analysis_request(self, history: Optional[List[Dict[str, Any]]]) -> Optional[Dict[str, Any]]:
        supported_kinds = {"status", "discovery", "compare", "trend", "reel_summary", "job_analysis", "ranking_summary"}
        for index in range(len(history or []) - 1, -1, -1):
            entry = (history or [])[index] or {}
            payload = entry.get("payload") if isinstance(entry.get("payload"), dict) else entry
            if str(entry.get("role") or payload.get("role") or "") != "assistant":
                continue
            context = payload.get("context") if isinstance(payload.get("context"), dict) else {}
            data_semantics = str(
                payload.get("dataSemantics")
                or context.get("dataSemantics")
                or ""
            ).strip()
            resolved = payload.get("resolvedRequest") or context.get("resolvedRequest")
            if not isinstance(resolved, dict) or not resolved.get("kind"):
                return None
            if data_semantics in {"session-filter-update", "request-validation"}:
                return None
            if str(resolved.get("kind") or "") in supported_kinds:
                return resolved
            return None
        return None

    def _is_filter_only_request(
        self,
        updates: Dict[str, Any],
        resolved_intent: Optional[Dict[str, Any]],
        history: Optional[List[Dict[str, Any]]] = None,
    ) -> bool:
        if not updates or not updates.get("filterOnly"):
            return False
        if self._scope_filter_update_keys(updates):
            latest_analysis = self._latest_active_analysis_request(history)
            if (
                latest_analysis
                and resolved_intent
                and str(resolved_intent.get("kind") or "") in {"status", "discovery", "compare", "trend", "reel_summary", "job_analysis", "ranking_summary"}
                and str(resolved_intent.get("kind") or "") == str(latest_analysis.get("kind") or "")
            ):
                return False
        set_updates = updates.get("set") or {}
        clear_updates = updates.get("clear") or []
        press_only_update = set(set_updates.keys()) == {"pressId"} and not clear_updates
        if (
            press_only_update
            and resolved_intent
            and str(resolved_intent.get("kind") or "") in {"status", "trend", "reel_summary", "activity", "discovery"}
        ):
            return False
        return True

    def _sticky_filter_update_response(
        self,
        filters: Dict[str, Any],
        sticky_filters: Dict[str, Any],
        updates: Dict[str, Any],
    ) -> Dict[str, Any]:
        changed = []
        for key in updates.get("clear") or []:
            changed.append(f"cleared {self._sticky_filter_label(key)}")
        for key, value in (updates.get("set") or {}).items():
            if value:
                if key == "pressId":
                    label = self._press_label(self._to_int(value)) if self._is_valid_machine_id(value) else str(value)
                else:
                    label = value.get("label") if isinstance(value, dict) else str(value)
                changed.append(f"set {self._sticky_filter_label(key)} to {label}")
        summary = "Active analysis filters were updated." if changed else "No filter changes were applied."
        return self._response(
            answer={
                "title": "Active analysis filters updated.",
                "summary": summary,
                "sections": [{"label": "Changes", "text": " | ".join(changed) or "No changes"}],
            },
            evidence_metrics=[],
            chart=None,
            tools_used=[{"tool": "session_filters", "ok": True}],
            suggested_prompts=self._contextual_follow_up_prompts(
                response_kind="session-filter-update",
                filters={**filters, "sticky_filters": sticky_filters},
            ),
            filters=filters,
            data_semantics="session-filter-update",
        )

    def _sticky_filter_label(self, key: str) -> str:
        labels = {
            "analysisDomain": "analysis domain",
            "timeScope": "time scope",
            "pressId": "press",
            "job": "job",
            "reelScope": "reel scope",
            "feetFilter": "feet filter",
        }
        return labels.get(key, key)

    def _last_resolved_request(self, history: List[Dict[str, Any]]) -> tuple[Optional[Dict[str, Any]], Optional[int]]:
        for index in range(len(history) - 1, -1, -1):
            entry = history[index] or {}
            if str(entry.get("role") or "") != "assistant":
                continue
            resolved = entry.get("resolvedRequest") or ((entry.get("context") or {}).get("resolvedRequest") if isinstance(entry.get("context"), dict) else None)
            if isinstance(resolved, dict) and resolved.get("kind"):
                return resolved, index
        return None, None

    def _resolve_follow_up_intent(
        self,
        message: str,
        filters: Dict[str, Any],
        parsed_intent: Optional[Dict[str, Any]],
        prior_request: Optional[Dict[str, Any]],
    ) -> tuple[Optional[Dict[str, Any]], Dict[str, Any]]:
        diagnostics = {
            "used": False,
            "inheritedIntent": prior_request.get("kind") if isinstance(prior_request, dict) else None,
            "inheritedMachineId": self._to_int(prior_request.get("machine_id")) if isinstance(prior_request, dict) else None,
            "inheritedMetricKey": (prior_request or {}).get("metric_key") if isinstance(prior_request, dict) else None,
            "inheritedScope": (prior_request or {}).get("analysisScope") if isinstance(prior_request, dict) else None,
            "overriddenFields": [],
            "scopeSource": "filters",
        }
        if not prior_request:
            return parsed_intent, diagnostics
        if not self._is_follow_up_candidate(message, parsed_intent):
            return parsed_intent, diagnostics

        lowered = self._normalize_message(message)
        explicit_press_ids = [self._machine_id_for_press_reference(press_id) for press_id in self._extract_press_ids(lowered)]
        explicit_metric_key = self._resolve_metric_key(lowered)
        explicit_phase2a_metric_key = self._resolve_phase2a_metric_key(lowered)
        explicit_scope = self._parse_analysis_scope(lowered)
        explicit_category_key = self._resolve_ranking_category_key(lowered)
        compare_direction = "worse" if any(token in lowered for token in (" which is worse ", " who is worse ", " worse ")) else "better"
        explanation_focus = self._phase2b_explanation_focus(lowered)
        compare_follow_up_requested = any(
            token in lowered
            for token in (
                " what stands out between them ",
                " which one is worse ",
                " is the gap big or small ",
                " which metric differs most ",
                " what should i check next ",
                " what should i check ",
            )
        )
        discovery_follow_up_requested = any(
            token in lowered
            for token in (
                " what stands out ",
                " why is it worse ",
                " why was it worse ",
                " did it recover ",
                " did it recover after the shift ",
                " was it spikes or sustained ",
                " spikes or sustained ",
                " sustained or spikes ",
                " concentrated or broad ",
                " where did behavior shift ",
                " is it a few bad reels or the whole run ",
                " few bad reels or the whole run ",
                " few bad reels or the whole job ",
            )
        )
        job_selected_follow_up_requested = any(
            token in lowered
            for token in (
                " how is it performing ",
                " how is it doing ",
                " is it worse than recent jobs ",
                " this job worse than this machine s recent runs ",
                " this current job performing ",
                " this job performing ",
                " what stands out ",
            )
        )
        job_concentration_follow_up_requested = any(
            token in lowered
            for token in (
                " concentrated in one recent job ",
                " concentrated in one job ",
                " spread across jobs ",
                " spread across recent jobs ",
                " issue concentrated or broad ",
                " concentrated or broad ",
            )
        )
        job_rank_follow_up = (
            "worst"
            if any(token in lowered for token in (" which one was worst ", " which one is worst ", " weakest recent job ", " recent job performed the worst ", " use the worst one ", " use the weakest recent job ", " analyze the weakest recent job "))
            else "best"
            if any(token in lowered for token in (" which one was best ", " which one is best ", " strongest recent job ", " recent job performed the best ", " use the best one ", " use the strongest recent job ", " analyze the strongest recent job "))
            else None
        )

        merged = self._intent_from_resolved_request(prior_request)
        if not merged:
            return parsed_intent, diagnostics

        sticky_filters = (filters or {}).get("sticky_filters") or {}
        sticky_job = str(sticky_filters.get("job") or "").strip()
        sticky_press_id = self._to_int(sticky_filters.get("pressId"))

        if merged.get("kind") == "compare" and compare_follow_up_requested:
            merged = dict(merged)
            diagnostics["used"] = True
            diagnostics["overriddenFields"].append("kind")
            merged["validationError"] = self._validate_merged_intent(merged, filters)
            diagnostics["overriddenFields"] = list(dict.fromkeys(diagnostics["overriddenFields"]))
            return merged, diagnostics

        if (
            merged.get("kind") in {"status", "activity", "discovery", "reel_summary", "trend"}
            and discovery_follow_up_requested
            and (self._is_valid_machine_id(merged.get("machine_id")) or self._is_valid_machine_id(sticky_press_id))
        ):
            inherited_metric_key = (
                explicit_phase2a_metric_key
                or explicit_metric_key
                or str(merged.get("metric_key") or "").strip()
                or "rlm_bad_feet_pct"
            )
            discovery_kind = "discovery" if merged.get("kind") in {"status", "discovery"} else "activity"
            merged = {
                "kind": discovery_kind,
                "machine_id": self._to_int(merged.get("machine_id")) or sticky_press_id,
                "metric_key": inherited_metric_key,
                "analysisScope": explicit_scope or merged.get("analysisScope"),
                "comparisonMode": str(merged.get("comparisonMode") or "none"),
                "trendRequested": True,
                "grouping": explanation_focus or merged.get("grouping") or "decision",
                "output_shape": "summary",
                "tools": ["run_discovery_analysis"] if discovery_kind == "discovery" else ["get_rlm_metric_analysis"],
                "validationError": None,
                "job": str(merged.get("job") or "").strip(),
            }
            diagnostics["used"] = True
            diagnostics["overriddenFields"].extend(["kind", "metric_key", "machine_id", "trendRequested", "grouping"])
            if explicit_scope:
                diagnostics["overriddenFields"].append("analysisScope")
                diagnostics["scopeSource"] = "inherited_followup"
            merged["validationError"] = self._validate_merged_intent(merged, filters)
            diagnostics["overriddenFields"] = list(dict.fromkeys(diagnostics["overriddenFields"]))
            return merged, diagnostics

        if merged.get("kind") in {"job_list", "job_analysis"}:
            target_machine_id = sticky_press_id or self._to_int(merged.get("machine_id"))
            if job_rank_follow_up:
                selected_ranked_job = (
                    self._ranked_job_reference(target_machine_id, filters, job_rank_follow_up)
                    if self._is_valid_machine_id(target_machine_id)
                    else None
                )
                merged = {
                    "kind": "job_analysis",
                    "machine_id": target_machine_id,
                    "analysisScope": explicit_scope or merged.get("analysisScope"),
                    "jobAnalysisMode": "selected_job_vs_recent" if lowered.startswith(" use ") or lowered.startswith(" analyze ") else f"{job_rank_follow_up}_recent_job",
                    "job": selected_ranked_job,
                    "tools": ["get_machine_job_analysis"],
                    "validationError": (
                        "missing_machine"
                        if not self._is_valid_machine_id(target_machine_id)
                        else "ranked_job_reference_unavailable"
                        if not selected_ranked_job
                        else None
                    ),
                }
                diagnostics["used"] = True
                diagnostics["overriddenFields"].extend(["kind", "machine_id", "jobAnalysisMode", "job"])
                merged["validationError"] = self._validate_merged_intent(merged, filters)
                diagnostics["overriddenFields"] = list(dict.fromkeys(diagnostics["overriddenFields"]))
                return merged, diagnostics

            if job_selected_follow_up_requested or job_concentration_follow_up_requested:
                mode = "concentration" if job_concentration_follow_up_requested else "selected_job_vs_recent"
                merged = {
                    "kind": "job_analysis",
                    "machine_id": target_machine_id,
                    "analysisScope": explicit_scope or merged.get("analysisScope"),
                    "jobAnalysisMode": mode,
                    "job": sticky_job,
                    "tools": ["get_machine_job_analysis"],
                    "validationError": (
                        "missing_machine"
                        if not self._is_valid_machine_id(target_machine_id)
                        else "missing_job_for_machine_job_analysis"
                        if mode == "selected_job_vs_recent" and not sticky_job
                        else None
                    ),
                }
                diagnostics["used"] = True
                diagnostics["overriddenFields"].extend(["kind", "machine_id", "jobAnalysisMode", "job"])
                merged["validationError"] = self._validate_merged_intent(merged, filters)
                diagnostics["overriddenFields"] = list(dict.fromkeys(diagnostics["overriddenFields"]))
                return merged, diagnostics

        if merged.get("kind") == "job_list" and " use the weakest recent job " in lowered:
            return (
                {
                    "kind": "job_list",
                    "machine_id": self._to_int(merged.get("machine_id")),
                    "analysisScope": merged.get("analysisScope"),
                    "tools": ["get_press_job_list"],
                    "validationError": "job_selection_requires_specific_job",
                },
                {**diagnostics, "used": True},
            )

        if (
            merged.get("kind") == "job_list"
            and sticky_job
            and any(token in lowered for token in (" compare ", " average "))
            and any(token in lowered for token in (" that job ", " this job ", " it "))
        ):
            merged = {
                "kind": "activity",
                "machine_id": sticky_press_id or self._to_int(merged.get("machine_id")),
                "metric_key": explicit_phase2a_metric_key or explicit_metric_key or "delta_variation",
                "analysisScope": merged.get("analysisScope"),
                "comparisonMode": "press_vs_average" if " average " in lowered else "none",
                "trendRequested": False,
                "grouping": explanation_focus,
                "output_shape": "summary",
                "tools": ["get_rlm_metric_analysis"],
                "validationError": None,
                "job": sticky_job,
            }
            diagnostics["overriddenFields"].extend(["kind", "metric_key", "comparisonMode", "job"])

        if (
            merged.get("kind") in {"job_list", "job_analysis"}
            and any(
                token in lowered
                for token in (
                    " this job worse than this machine s recent runs ",
                    " this current job performing ",
                    " this job performing ",
                    " weakest recent job ",
                    " recent job performed the worst ",
                    " concentrated in one recent job ",
                    " spread across jobs ",
                    " spread across recent jobs ",
                )
            )
        ):
            mode = (
                "selected_job_vs_recent"
                if any(token in lowered for token in (" this job worse than this machine s recent runs ", " this current job performing ", " this job performing "))
                else "concentration"
                if any(token in lowered for token in (" concentrated in one recent job ", " spread across jobs ", " spread across recent jobs "))
                else "weakest_recent_job"
            )
            merged = {
                "kind": "job_analysis",
                "machine_id": sticky_press_id or self._to_int(merged.get("machine_id")),
                "analysisScope": merged.get("analysisScope"),
                "jobAnalysisMode": mode,
                "job": sticky_job,
                "tools": ["get_machine_job_analysis"],
                "validationError": "missing_job_for_machine_job_analysis" if mode == "selected_job_vs_recent" and not sticky_job else None,
            }
            diagnostics["used"] = True
            diagnostics["overriddenFields"].extend(["kind", "jobAnalysisMode", "job"])

        if (
            any(token in lowered for token in (" reel to reel", " reel-to-reel "))
            and not explicit_press_ids
            and (self._is_valid_machine_id(merged.get("machine_id")) or self._is_valid_machine_id(sticky_press_id))
        ):
            merged = {
                "kind": "reel_summary",
                "machine_id": self._to_int(merged.get("machine_id")) or sticky_press_id,
                "analysisScope": merged.get("analysisScope"),
                "tools": ["get_reel_to_reel_summary"],
                "validationError": None,
            }
            diagnostics["overriddenFields"].extend(["kind", "machine_id"])

        if (
            merged.get("kind") in {"trend", "reel_summary"}
            and any(token in lowered for token in (" compare ", " average "))
            and any(token in lowered for token in (" it ", " this ", " that "))
        ):
            inherited_metric_key = self._follow_up_comparison_metric_key(str(merged.get("metric_key") or ""))
            if inherited_metric_key:
                merged = {
                    "kind": "activity",
                    "machine_id": self._to_int(merged.get("machine_id")),
                    "metric_key": inherited_metric_key,
                    "analysisScope": merged.get("analysisScope"),
                    "comparisonMode": "press_vs_average" if " average " in lowered else "none",
                    "trendRequested": False,
                    "grouping": explanation_focus or "decision",
                    "output_shape": "summary",
                    "tools": ["get_rlm_metric_analysis"],
                    "validationError": None,
                    "job": str(merged.get("job") or "").strip(),
                }
                diagnostics["overriddenFields"].extend(["kind", "metric_key", "comparisonMode"])

        if (
            merged.get("kind") == "job_list"
            and explicit_press_ids
            and parsed_intent
            and parsed_intent.get("kind") in {"status", "trend", "activity", "discovery", "reel_summary"}
            and not any(token in lowered for token in (" that job ", " this job ", " use job ", " analyze only that job "))
        ):
            return parsed_intent, diagnostics

        explicit_new_question = bool(
            parsed_intent
            and parsed_intent.get("kind") in {"status", "trend", "activity", "discovery", "reel_summary", "job_list"}
            and explicit_press_ids
            and (
                explicit_metric_key
                or explicit_phase2a_metric_key
                or explicit_scope
                or any(
                    token in lowered
                    for token in (
                        " show ",
                        " plot ",
                        " trend",
                        " trending ",
                        " what changed ",
                        " investigate ",
                        " discover ",
                        " getting worse ",
                        " getting better ",
                        " reel to reel",
                        " reel-to-reel",
                    )
                )
            )
            and not any(
                token in lowered
                for token in (
                    " what about ",
                    " between them ",
                    " between the two ",
                    " which one is worse ",
                    " which is worse ",
                    " which is better ",
                    " that job ",
                    " this job ",
                    " it ",
                )
            )
        )
        if (
            explicit_new_question
            and parsed_intent
            and merged.get("kind") != parsed_intent.get("kind")
            and merged.get("kind") in {"ranking_summary", "compare", "ranking", "job_list", "discovery", "trend", "status", "activity", "reel_summary"}
        ):
            return parsed_intent, diagnostics

        if explicit_press_ids:
            if merged.get("kind") == "compare" and len(explicit_press_ids) >= 2:
                merged["machine_ids"] = explicit_press_ids[:2]
                merged["compareRequestedLabels"] = [self._press_label(machine_id) for machine_id in merged["machine_ids"]]
                diagnostics["overriddenFields"].append("machine_ids")
            elif merged.get("kind") != "compare":
                merged["machine_id"] = explicit_press_ids[0]
                diagnostics["overriddenFields"].append("machine_id")

        if (explicit_metric_key or explicit_phase2a_metric_key) and explanation_focus != "alignment":
            if merged.get("kind") == "trend":
                resolved_metric_key = explicit_metric_key or explicit_phase2a_metric_key
                merged["metric_key"] = resolved_metric_key
                diagnostics["overriddenFields"].append("metric_key")
            elif merged.get("kind") == "activity":
                resolved_metric_key = explicit_phase2a_metric_key or explicit_metric_key
                merged["metric_key"] = resolved_metric_key
                diagnostics["overriddenFields"].append("metric_key")
            elif merged.get("kind") == "compare":
                resolved_metric_key = explicit_phase2a_metric_key or explicit_metric_key
                merged["compareCategoryKey"] = explicit_category_key or resolved_metric_key
                merged["compareCategoryLabel"] = self._ranking_category_label(merged["compareCategoryKey"])
                merged["compareDirection"] = compare_direction
                diagnostics["overriddenFields"].append("compareCategoryKey")

        if explicit_category_key and merged.get("kind") == "compare":
            merged["compareCategoryKey"] = explicit_category_key
            merged["compareCategoryLabel"] = self._ranking_category_label(explicit_category_key)
            diagnostics["overriddenFields"].append("compareCategoryKey")

        if explicit_scope:
            if merged.get("kind") in {"status", "trend", "reel_summary", "compare", "activity", "discovery"}:
                merged["analysisScope"] = explicit_scope
                diagnostics["overriddenFields"].append("analysisScope")
                diagnostics["scopeSource"] = "inherited_followup"

        if merged.get("kind") in {"activity", "discovery"} and " average " in lowered:
            merged["comparisonMode"] = "press_vs_average"
            diagnostics["overriddenFields"].append("comparisonMode")
        if merged.get("kind") in {"activity", "discovery"} and len(explicit_press_ids) >= 2 and any(token in lowered for token in (" compare ", " versus ", " vs ")):
            merged["comparisonMode"] = "press_vs_press"
            merged["machine_ids"] = explicit_press_ids[:2]
            merged["machine_id"] = explicit_press_ids[0]
            diagnostics["overriddenFields"].extend(["comparisonMode", "machine_ids", "machine_id"])
        if merged.get("kind") in {"activity", "discovery"} and any(token in lowered for token in (" getting worse ", " getting better ", " trend", " trending ")):
            merged["trendRequested"] = True
            diagnostics["overriddenFields"].append("trendRequested")
        if merged.get("kind") in {"activity", "discovery"}:
            if explanation_focus:
                merged["grouping"] = explanation_focus
                merged["output_shape"] = "drilldown" if explanation_focus in {"reels", "jobs"} else "summary"
                diagnostics["overriddenFields"].append("grouping")
        if merged.get("kind") == "discovery" and any(
            token in lowered for token in (" previous window ", " prior window ", " previous 10 reels ", " previous reels ", " prior 10 reels ")
        ):
            merged["baselineRequested"] = True
            diagnostics["overriddenFields"].append("baselineComparison")

        if merged.get("kind") == "compare" and not explicit_press_ids:
            if any(token in lowered for token in (" between the two ", " between them ", " which press is better ", " which is better ", " which is worse ", " which one is worse ")):
                diagnostics["overriddenFields"].append("machine_ids")

        if (
            parsed_intent
            and not diagnostics["overriddenFields"]
            and parsed_intent.get("kind")
            and not (
                merged.get("kind") == "compare"
                and any(token in lowered for token in (" between them ", " which one is worse ", " which press is better ", " which is better ", " which is worse "))
            )
            and not (
                merged.get("kind") == "discovery"
                and any(token in lowered for token in (" did it recover ", " where did behavior shift ", " spikes or sustained ", " sustained or spikes ", " concentrated or broad "))
            )
        ):
            return parsed_intent, diagnostics

        merged["validationError"] = self._validate_merged_intent(merged, filters)
        diagnostics["used"] = True
        diagnostics["overriddenFields"] = list(dict.fromkeys(diagnostics["overriddenFields"]))
        if merged.get("analysisScope") and diagnostics["scopeSource"] == "filters":
            diagnostics["scopeSource"] = "inherited_followup"
        return merged, diagnostics

    def _intent_from_resolved_request(self, resolved_request: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        kind = str(resolved_request.get("kind") or "").strip()
        if not kind:
            return None
        intent = {
            "kind": kind,
            "machine_id": self._to_int(resolved_request.get("machine_id")),
            "machine_ids": [self._to_int(value) for value in resolved_request.get("machine_ids") or [] if self._to_int(value) is not None],
            "metric_key": resolved_request.get("metric_key"),
            "analysisScope": resolved_request.get("analysisScope"),
            "comparisonMode": resolved_request.get("comparison_mode") or resolved_request.get("comparisonMode"),
            "trendRequested": resolved_request.get("trendRequested"),
            "baselineRequested": resolved_request.get("baselineRequested"),
            "grouping": resolved_request.get("grouping"),
            "output_shape": resolved_request.get("output_shape") or "summary",
            "compareCategoryKey": resolved_request.get("compareCategoryKey"),
            "compareCategoryLabel": resolved_request.get("compareCategoryLabel"),
            "compareDirection": resolved_request.get("compareDirection"),
            "compareRequestedLabels": resolved_request.get("compareRequestedLabels") or [],
            "summary_focus": resolved_request.get("summary_focus"),
            "summaryCategoryKey": resolved_request.get("summaryCategoryKey"),
            "limit": resolved_request.get("limit"),
            "matchedKeywords": [],
        }
        tool_map = {
            "status": ["get_press_status"],
            "activity": ["get_rlm_metric_analysis"],
            "discovery": ["run_discovery_analysis"],
            "job_list": ["get_press_job_list"],
            "job_analysis": ["get_machine_job_analysis"],
            "compare": ["compare_presses"],
            "ranking": ["get_press_rankings", "get_press_category_breakdown"],
            "ranking_summary": ["get_press_rankings"],
            "reel_summary": ["get_reel_to_reel_summary"],
            "trend": ["get_press_metric_trend"],
        }
        intent["tools"] = tool_map.get(kind, [])
        return intent

    def _validate_merged_intent(self, intent: Dict[str, Any], filters: Dict[str, Any]) -> Optional[str]:
        kind = intent.get("kind")
        if kind == "compare":
            machine_ids = [value for value in intent.get("machine_ids") or [] if self._to_int(value) is not None]
            return None if len(machine_ids) >= 2 else "comparison_requires_two_presses"
        if kind == "trend" and str(intent.get("metric_key") or "") not in METRIC_ALIAS_MAP:
            return "unsupported_metric"
        if kind == "activity":
            if not str(intent.get("metric_key") or "").strip():
                return "unsupported_metric"
            if str(intent.get("comparisonMode") or "none") == "press_vs_press":
                machine_ids = [value for value in intent.get("machine_ids") or [] if self._to_int(value) is not None]
                return None if len(machine_ids) >= 2 else "comparison_requires_two_presses"
            return None if self._is_valid_machine_id(intent.get("machine_id")) else "missing_machine"
        if kind == "discovery":
            if not str(intent.get("metric_key") or "").strip():
                return "unsupported_metric"
            if intent.get("validationError") == "missing_machine_for_discovery":
                return "missing_machine_for_discovery"
            if str(intent.get("comparisonMode") or "none") == "press_vs_press":
                machine_ids = [value for value in intent.get("machine_ids") or [] if self._to_int(value) is not None]
                return None if len(machine_ids) >= 2 else "comparison_requires_two_presses"
            return None if self._is_valid_machine_id(intent.get("machine_id")) else "missing_machine_for_discovery"
        if kind == "job_list" and intent.get("validationError") == "job_selection_requires_specific_job":
            return "job_selection_requires_specific_job"
        if kind == "job_analysis":
            if intent.get("validationError") == "missing_job_for_machine_job_analysis":
                return "missing_job_for_machine_job_analysis"
            if intent.get("validationError") == "current_job_unknown_on_machine":
                return "current_job_unknown_on_machine"
            if intent.get("validationError") == "ranked_job_reference_unavailable":
                return "ranked_job_reference_unavailable"
            return None if self._is_valid_machine_id(intent.get("machine_id")) else "missing_machine"
        if kind in {"status", "ranking", "reel_summary", "trend", "job_list"}:
            return None if self._is_valid_machine_id(intent.get("machine_id")) else "missing_machine"
        return None

    def _is_follow_up_candidate(self, message: str, parsed_intent: Optional[Dict[str, Any]]) -> bool:
        lowered = self._normalize_message(message)
        stripped = lowered.strip()
        if stripped.startswith("what about ") or stripped.startswith("now "):
            return True
        if any(
            token in lowered
            for token in (
                " what stands out between them ",
                " which one is worse ",
                " is the gap big or small ",
                " which metric differs most ",
                " what should i check next ",
                " what should i check ",
                " where did behavior shift ",
                " did it recover ",
                " spikes or sustained ",
                " sustained or spikes ",
                " concentrated or broad ",
                " what stands out ",
            )
        ):
            return True
        if " that job " in lowered or " this job " in lowered:
            return True
        if re.fullmatch(r"(?:press|p)\s*\d+", stripped):
            return True
        if self._parse_analysis_scope(lowered) and not parsed_intent:
            return True
        metric_key = self._resolve_metric_key(lowered)
        phase2a_metric_key = self._resolve_phase2a_metric_key(lowered)
        if metric_key and (stripped == metric_key.replace("_", " ") or stripped.startswith("what about ") or stripped.startswith("now ")):
            return True
        if phase2a_metric_key and (stripped.startswith("what about ") or stripped.startswith("now ") or stripped in lowered):
            return True
        if " average " in lowered or " getting worse " in lowered or " getting better " in lowered:
            return True
        if self._phase2b_explanation_focus(lowered):
            return True
        alias_only = any(stripped == alias for aliases in METRIC_ALIAS_MAP.values() for alias in aliases)
        if alias_only:
            return True
        if parsed_intent and parsed_intent.get("kind") == "status" and "bare press reference" in (parsed_intent.get("matchedKeywords") or []):
            return True
        if parsed_intent:
            return False
        word_count = len([token for token in stripped.split(" ") if token])
        return 0 < word_count <= 4

    def _build_resolved_request(
        self,
        intent: Optional[Dict[str, Any]],
        filters: Dict[str, Any],
    ) -> Optional[Dict[str, Any]]:
        if not intent:
            return None
        machine_id = self._to_int(intent.get("machine_id"))
        machine_ids = [self._to_int(value) for value in intent.get("machine_ids") or [] if self._to_int(value) is not None]
        return {
            "kind": intent.get("kind"),
            "domain": filters.get("analysis_domain") or "auto",
            "comparison_mode": self._comparison_mode_from_intent(intent),
            "comparison_target": intent.get("compareDirection"),
            "trendRequested": intent.get("trendRequested"),
            "baselineRequested": intent.get("baselineRequested"),
            "grouping": intent.get("grouping"),
            "output_shape": intent.get("output_shape") or "summary",
            "machine_id": machine_id,
            "machine_label": self._press_label(machine_id) if machine_id is not None else None,
            "machine_ids": machine_ids,
            "machine_labels": [self._press_label(machine) for machine in machine_ids],
            "metric_key": intent.get("metric_key"),
            "analysisScope": intent.get("analysisScope"),
            "job": filters.get("job"),
            "min_reel_feet": filters.get("min_feet"),
            "reel_scope": filters.get("reel_scope"),
            "compareCategoryKey": intent.get("compareCategoryKey"),
            "compareCategoryLabel": intent.get("compareCategoryLabel"),
            "compareDirection": intent.get("compareDirection"),
            "compareRequestedLabels": intent.get("compareRequestedLabels") or [],
            "summary_focus": intent.get("summary_focus"),
            "summaryCategoryKey": intent.get("summaryCategoryKey"),
            "limit": intent.get("limit"),
            "effective_start": filters.get("start"),
            "effective_end": filters.get("end"),
        }

    def _log_chat_result(self, response: Dict[str, Any], diagnostics: Dict[str, Any]) -> None:
        context = response.get("context") or {}
        tools = [tool.get("tool") for tool in response.get("toolsUsed") or [] if tool.get("tool")]
        self.logger.info(
            "rlm_assistant.chat requested_mode=%s execution_mode=%s tools=%s fallback=%s fallback_reason=%s total_ms=%s",
            context.get("requestedMode"),
            context.get("executionMode"),
            ",".join(tools) or "-",
            diagnostics.get("fallbackTriggered"),
            diagnostics.get("fallbackReason") or "-",
            (diagnostics.get("timingMs") or {}).get("total", 0),
        )

    def _intent_machine_list(self, intent: Optional[Dict[str, Any]]) -> List[int]:
        if not intent:
            return []
        if isinstance(intent.get("machine_ids"), list):
            return [int(value) for value in intent.get("machine_ids") if self._to_int(value) is not None]
        machine_id = self._to_int(intent.get("machine_id"))
        return [machine_id] if machine_id is not None else []

    def _plan_machine_list(self, plan: Dict[str, Any]) -> List[int]:
        machines: List[int] = []
        for call in plan.get("toolCalls", []):
            args = call.get("arguments") or {}
            if isinstance(args.get("machine_ids"), list):
                machines.extend(self._to_int(value) for value in args.get("machine_ids") if self._to_int(value) is not None)
            else:
                machine_id = self._to_int(args.get("machine_id"))
                if machine_id is not None:
                    machines.append(machine_id)
        return list(dict.fromkeys(machines))

    def _executed_machine_list(self, tool_results: Dict[str, Any]) -> List[int]:
        machines: List[int] = []
        for result in tool_results.values():
            if not isinstance(result, dict):
                continue
            if isinstance(result.get("machineIds"), list):
                machines.extend(self._to_int(value) for value in result.get("machineIds") if self._to_int(value) is not None)
            else:
                machine_id = self._to_int(result.get("machineId"))
                if machine_id is not None:
                    machines.append(machine_id)
        return list(dict.fromkeys(machines))

    def _response_matches_entities(
        self,
        response: Dict[str, Any],
        parsed_intent: Optional[Dict[str, Any]],
        tool_results: Dict[str, Any],
    ) -> bool:
        if not parsed_intent:
            return True
        kind = parsed_intent.get("kind")
        answer = response.get("answer") or {}
        text = " ".join(
            [
                str(answer.get("title") or ""),
                str(answer.get("summary") or ""),
                " ".join(str(section.get("text") or "") for section in answer.get("sections") or [] if isinstance(section, dict)),
            ]
        ).lower()
        if kind == "compare":
            expected_ids = list(parsed_intent.get("machine_ids") or [])
            compare_result = tool_results.get("compare_presses_tool") or {}
            executed_ids = [self._to_int(value) for value in compare_result.get("requestedMachines") or compare_result.get("machineIds") or [] if self._to_int(value) is not None]
            expected_pair = expected_ids[:2]
            if expected_pair != executed_ids[:2]:
                return False
            rendered_ids = self._rendered_machine_list(response)
            if not rendered_ids:
                return False
            return sorted(set(rendered_ids)) == sorted(set(expected_pair))
        if kind == "ranking":
            expected_id = self._to_int(parsed_intent.get("machine_id"))
            ranking_result = tool_results.get("get_press_rankings_tool") or {}
            press_row = ranking_result.get("pressRow") or {}
            executed_id = self._to_int(press_row.get("machineId"))
            if expected_id is not None and executed_id != expected_id:
                return False
            expected_name = str(press_row.get("machineName") or f"Press {expected_id}").lower()
            return expected_name in text
        if kind == "ranking_summary":
            rendered_ids = self._rendered_machine_list(response)
            return bool(rendered_ids)
        return True

    def _init_diagnostics(self) -> Dict[str, Any]:
        return {
            "matchedKeywords": [],
            "parsedIntentKind": None,
            "rawExtractedPressIds": [],
            "selectedMachineId": None,
            "machineIdSource": None,
            "requestedPressLabel": None,
            "renderedPressLabel": None,
            "usedConversationContext": False,
            "contextSourceTurn": None,
            "inheritedIntent": None,
            "inheritedMachineId": None,
            "inheritedMetricKey": None,
            "inheritedScope": None,
            "overriddenFields": [],
            "finalResolvedRequest": None,
            "requestedScope": None,
            "requestedScopeType": None,
            "requestedScopeValue": None,
            "scopeSource": "filters",
            "scopeOverrideApplied": False,
            "effectiveReelCount": None,
            "effectiveTimeScope": None,
            "effectiveReelScope": None,
            "effectiveFeetFilter": None,
            "analysisDomain": "auto",
            "comparisonMode": "none",
            "comparisonScope": None,
            "stickyFiltersBefore": {},
            "stickyFiltersAfter": {},
            "filterUpdatesApplied": {},
            "activeStickyFilters": {},
            "filterSource": "filters",
            "originalFilterStart": None,
            "originalFilterEnd": None,
            "effectiveFilterStart": None,
            "effectiveFilterEnd": None,
            "timeRangeSource": None,
            "resolvedMachineId": None,
            "rankingToolsExecuted": [],
            "rankingFallbackUsed": False,
            "plannerAttempted": False,
            "plannerSucceeded": False,
            "plannerValidationPassed": False,
            "rewriteAttempted": False,
            "rewriteApplied": False,
            "fallbackTriggered": False,
            "fallbackReason": None,
            "parsedMachines": [],
            "plannedMachines": [],
            "executedMachines": [],
            "baseRenderedMachines": [],
            "rewriteRenderedMachines": [],
            "finalRenderedMachines": [],
            "timingMs": {
                "planner": 0,
                "tools": 0,
                "rewrite": 0,
                "total": 0,
            },
        }

    def _attach_scope_diagnostics(
        self,
        diagnostics: Dict[str, Any],
        parsed_intent: Optional[Dict[str, Any]],
        original_filters: Dict[str, Any],
        normalized_filters: Dict[str, Any],
        effective_filters: Dict[str, Any],
        time_range_source: str,
    ) -> None:
        scope = (parsed_intent or {}).get("analysisScope") or {}
        diagnostics["requestedScope"] = scope.get("label")
        diagnostics["requestedScopeType"] = scope.get("kind")
        diagnostics["requestedScopeValue"] = scope.get("count") if scope.get("kind") == "reels" else scope.get("value")
        diagnostics["originalFilterStart"] = original_filters.get("start")
        diagnostics["originalFilterEnd"] = original_filters.get("end")
        diagnostics["effectiveFilterStart"] = effective_filters.get("start")
        diagnostics["effectiveFilterEnd"] = effective_filters.get("end")
        diagnostics["timeRangeSource"] = time_range_source
        diagnostics["scopeOverrideApplied"] = bool(scope) and (
            time_range_source == "explicit_scope" or scope.get("kind") == "reels"
        )
        diagnostics["effectiveReelCount"] = scope.get("count") if scope.get("kind") == "reels" else None

    def _filters_with_intent_scope(
        self,
        filters: Dict[str, Any],
        intent: Optional[Dict[str, Any]],
    ) -> tuple[Dict[str, Any], str]:
        scope = (intent or {}).get("analysisScope") or {}
        if scope.get("kind") != "time":
            return filters, "filters"
        if (intent or {}).get("kind") not in {"status", "compare", "reel_summary", "trend"}:
            return filters, "filters"
        delta = self._scope_delta(scope)
        if delta is None:
            return filters, "filters"
        anchor = self._scope_anchor_datetime(filters)
        updated = dict(filters)
        updated["start_dt"] = anchor - delta
        updated["end_dt"] = anchor
        updated["start"] = updated["start_dt"].isoformat(timespec="seconds")
        updated["end"] = updated["end_dt"].isoformat(timespec="seconds")
        return updated, "explicit_scope"

    def _filters_with_discovery_scope(
        self,
        filters: Dict[str, Any],
        intent: Optional[Dict[str, Any]],
    ) -> Dict[str, Any]:
        scope = (intent or {}).get("analysisScope") or {}
        if scope.get("kind") == "time":
            return self._apply_time_scope_to_filters(filters, scope)
        if scope.get("kind") == "reels":
            updated = dict(filters)
            updated["reel_scope"] = scope
            return updated
        return dict(filters)

    def _scope_anchor_datetime(self, filters: Dict[str, Any]) -> datetime:
        now = datetime.utcnow()
        end_dt = filters.get("end_dt")
        if isinstance(end_dt, datetime):
            return min(end_dt, now)
        return now

    def _safe_get_press_rankings_tool(self, machine_id: int, filters: Dict[str, Any]) -> Dict[str, Any]:
        try:
            return self.get_press_rankings_tool(machine_id, filters)
        except Exception as exc:  # pragma: no cover
            self.logger.warning("rlm_assistant.ranking_tool_failed", extra={"machine_id": machine_id, "error": str(exc)})
            return {
                "machineId": machine_id,
                "pressRow": None,
                "overviewRow": None,
                "dataSemantics": "filtered-window",
            }

    def _safe_get_press_category_breakdown_tool(self, machine_id: int, filters: Dict[str, Any]) -> Dict[str, Any]:
        try:
            return self.get_press_category_breakdown_tool(machine_id, filters)
        except Exception as exc:  # pragma: no cover
            self.logger.warning("rlm_assistant.ranking_breakdown_tool_failed", extra={"machine_id": machine_id, "error": str(exc)})
            return {
                "machineId": machine_id,
                "categories": [],
                "dataSemantics": "filtered-window",
            }

    def _finalize_ranking_diagnostics(
        self,
        response: Dict[str, Any],
        diagnostics: Dict[str, Any],
        parsed_intent: Optional[Dict[str, Any]],
    ) -> None:
        if not parsed_intent or parsed_intent.get("kind") != "ranking":
            return
        diagnostics["resolvedMachineId"] = self._to_int(parsed_intent.get("machine_id"))
        diagnostics["rankingToolsExecuted"] = [
            tool.get("tool")
            for tool in response.get("toolsUsed") or []
            if tool.get("tool") in {"get_press_rankings", "get_press_category_breakdown"}
        ]
        answer = response.get("answer") or {}
        diagnostics["rankingFallbackUsed"] = bool(
            answer.get("title") == "No matching RLM data was found."
            or any(
                tool.get("ok") is False
                for tool in response.get("toolsUsed") or []
                if tool.get("tool") in {"get_press_rankings", "get_press_category_breakdown"}
            )
        )

    def _finalize_phase2a_diagnostics(
        self,
        response: Dict[str, Any],
        diagnostics: Dict[str, Any],
        parsed_intent: Optional[Dict[str, Any]],
    ) -> None:
        if not parsed_intent or parsed_intent.get("kind") not in {"activity", "discovery"}:
            return
        resolved_request = diagnostics.get("finalResolvedRequest") or {}
        metric_analysis = ((response.get("context") or {}).get("metricAnalysis")) or {}
        diagnostics["metricKeyUsed"] = (
            metric_analysis.get("metricKey")
            or parsed_intent.get("metric_key")
            or resolved_request.get("metric_key")
        )
        diagnostics["denominatorBasis"] = metric_analysis.get("denominatorBasis")
        diagnostics["comparisonPeerCount"] = metric_analysis.get("comparisonPeerCount")
        diagnostics["trendBasis"] = metric_analysis.get("trendBasis")
        diagnostics["runPositionPattern"] = metric_analysis.get("runPositionPattern")
        diagnostics["concentrationPattern"] = metric_analysis.get("concentrationPattern")
        diagnostics["driverReels"] = metric_analysis.get("driverReels") or []
        diagnostics["driverJobs"] = metric_analysis.get("driverJobs") or []
        diagnostics["comparisonConfidence"] = metric_analysis.get("comparisonConfidence")
        diagnostics["fairnessNotes"] = metric_analysis.get("fairnessNotes") or []
        diagnostics["deviationEpisodes"] = metric_analysis.get("deviationEpisodes") or []
        diagnostics["selectedJob"] = metric_analysis.get("selectedJob")
        diagnostics["explanationSummary"] = metric_analysis.get("explanationSummary")

    def _elapsed_ms(self, start: float) -> int:
        return int((time.perf_counter() - start) * 1000)

    def _assemble_status_response(
        self,
        tool_data: Dict[str, Any],
        filters: Dict[str, Any],
        intent: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        if not tool_data.get("found"):
            return self._empty_result_response(
                filters,
                ["get_press_status"],
                "No status data was found for that press in the selected filter window.",
                data_semantics=tool_data.get("dataSemantics", "filtered-window"),
            )

        if tool_data.get("dataSemantics") == "filtered-window":
            latest = tool_data.get("latest") or {}
            aggregate = tool_data.get("aggregate") or {}
            filtered_rows = tool_data.get("filteredRows") or []
            state = tool_data.get("state") or {}
            machine_id = self._to_int(tool_data.get("machineId"))
            status_performance_summary = self._status_category_summaries(
                machine_name=tool_data.get("machineName") or "This press",
                machine_id=machine_id,
                rows=filtered_rows,
                aggregate=aggregate,
                filters=filters,
                prompt_framing=str((intent or {}).get("promptFraming") or "performance"),
            )
            chart = self._status_chart(
                tool_data.get("machineName") or "This press",
                filtered_rows,
                filters,
                latest,
                aggregate,
                state,
            )
            sections = [
                {"label": "Latest reel in window", "text": self._filtered_latest_reel_text(latest)},
                {
                    "label": "Window summary",
                    "text": f"{aggregate.get('reelsRun') or 0} reels, {self._format_pct(aggregate.get('badFeetPct'))} bad feet, {self._format_number(aggregate.get('pointsPer1000Ft'))} pts/1k ft.",
                },
            ]
            breakdown_section = self._status_category_breakdown_section(status_performance_summary)
            if breakdown_section:
                sections.append(breakdown_section)
            scope_section = self._scope_section((intent or {}).get("analysisScope") or {}, [], filters)
            if scope_section:
                sections.insert(0, scope_section)
            production_section = self._production_context_section(aggregate)
            if production_section:
                sections.append(production_section)
            peer_section = self._status_peer_ranking_section(machine_id, filters)
            if peer_section:
                sections.append(peer_section)
            response = self._response(
                answer={
                    "title": f"{tool_data['machineName']} performance summary",
                    "summary": status_performance_summary.get("overallSummary") or state.get("statusMessage") or "Filtered repeat length status is available.",
                    "sections": sections,
                },
                evidence_metrics=[
                    self._metric("State", state.get("stateLabel") or "--"),
                    self._metric("Bad feet %", self._format_pct(aggregate.get("badFeetPct"))),
                    self._metric("OOB %", self._format_pct(aggregate.get("oobPointPct"))),
                    self._metric("Pts / 1k ft", self._format_number(aggregate.get("pointsPer1000Ft"))),
                    self._metric("Delta std dev", self._format_mm(latest.get("deltaStd"))),
                ],
                chart=chart,
                tools_used=[{"tool": "get_press_status", "ok": True}],
                suggested_prompts=self._contextual_follow_up_prompts(
                    response_kind="status",
                    filters=filters,
                    machine_label=tool_data.get("machineName"),
                ),
                filters=filters,
                data_semantics="filtered-window",
            )
            response.setdefault("context", {})["statusSimpleSummary"] = self._build_status_simple_summary(
                machine_id=machine_id,
                machine_name=tool_data.get("machineName") or "This press",
                filters=filters,
                latest=latest,
                aggregate=aggregate,
                state=state,
                rows=filtered_rows,
            )
            response.setdefault("context", {})["statusPerformanceSummary"] = status_performance_summary
            return self._attach_analysis_summary(response, self._status_analysis_summary(status_performance_summary, aggregate))

        card = tool_data.get("card") or {}
        metrics = card.get("metrics") or {}
        windows = tool_data.get("windows") or {}
        window_24h = windows.get("24h") or {}
        signal = tool_data.get("signal") or {}
        machine_id = self._to_int(tool_data.get("machineId"))
        live_aggregate = {
            "reelsRun": window_24h.get("qualifyingReels"),
            "feetTotal": metrics.get("feetTotal") or window_24h.get("feetTotal"),
            "estimatedBadFeet": metrics.get("estimatedBadFeet") or window_24h.get("estimatedBadFeet"),
            "badFeetPct": window_24h.get("badFeetPct", metrics.get("badFeetPct")),
            "deltaPointCount": metrics.get("deltaPointCount") or window_24h.get("deltaPointCount"),
            "oobPointCount": metrics.get("oobPointCount") or window_24h.get("oobPointCount"),
            "monitoringPointsTotal": metrics.get("monitoringPointsTotal") or window_24h.get("monitoringPointsTotal"),
            "pointsPer1000Ft": metrics.get("pointsPer1000Ft") or window_24h.get("pointsPer1000Ft"),
            "deltaVariation": window_24h.get("deltaStd"),
            "deltaDrift": window_24h.get("avgDelta"),
            "speedInstability": window_24h.get("webspeedRange"),
            "toleranceChanges": window_24h.get("toleranceChangeCount"),
        }
        live_rows: List[Dict[str, Any]] = []
        if any(
            value is not None
            for value in (
                live_aggregate.get("estimatedBadFeet"),
                live_aggregate.get("badFeetPct"),
                live_aggregate.get("pointsPer1000Ft"),
                live_aggregate.get("deltaVariation"),
                live_aggregate.get("deltaDrift"),
                live_aggregate.get("speedInstability"),
                live_aggregate.get("toleranceChanges"),
            )
        ):
            live_rows.append(
                {
                    "estimatedBadFeet": live_aggregate.get("estimatedBadFeet"),
                    "estimatedBadFeetPct": live_aggregate.get("badFeetPct"),
                    "pointsPer1000Ft": live_aggregate.get("pointsPer1000Ft"),
                    "deltaStd": live_aggregate.get("deltaVariation"),
                    "avgDelta": live_aggregate.get("deltaDrift"),
                    "webspeedRange": live_aggregate.get("speedInstability"),
                    "toleranceChangeCount": live_aggregate.get("toleranceChanges"),
                    "feetTotal": live_aggregate.get("feetTotal"),
                }
            )
        status_performance_summary = self._status_category_summaries(
            machine_name=tool_data.get("machineName") or "This press",
            machine_id=machine_id,
            rows=live_rows,
            aggregate=live_aggregate,
            filters=filters,
            prompt_framing=str((intent or {}).get("promptFraming") or "performance"),
        )
        sections = [
            {"label": "Latest reel", "text": self._latest_reel_text(card)},
            {
                "label": "Recent live window",
                "text": f"Last 24h bad feet is {self._format_pct(window_24h.get('badFeetPct'))} across {window_24h.get('qualifyingReels') or 0} qualifying reels.",
            },
            {
                "label": "Trend signal",
                "text": signal.get("detail")
                and f"{signal.get('detail')}. {signal.get('context') or ''}".strip()
                or "No active short-window trend signal was found.",
            },
        ]
        breakdown_section = self._status_category_breakdown_section(status_performance_summary)
        if breakdown_section:
            sections.append(breakdown_section)
        scope_section = self._scope_section((intent or {}).get("analysisScope") or {}, [], filters)
        if scope_section:
            sections.insert(0, scope_section)
        production_section = self._production_context_section(live_aggregate)
        if production_section:
            sections.append(production_section)
        peer_section = self._status_peer_ranking_section(machine_id, filters)
        if peer_section:
            sections.append(peer_section)
        response = self._response(
            answer={
                "title": f"{tool_data['machineName']} performance summary",
                "summary": (
                    status_performance_summary.get("overallSummary")
                    or "No filtered-window rows were found, so this response uses current live RLM status."
                ),
                "sections": sections,
            },
            evidence_metrics=[
                self._metric("State", card.get("stateLabel") or "--"),
                self._metric("Bad feet %", self._format_pct(metrics.get("badFeetPct"))),
                self._metric("OOB %", self._format_pct(metrics.get("oobPointPct"))),
                self._metric("Pts / 1k ft", self._format_number(metrics.get("pointsPer1000Ft"))),
                self._metric("Delta std dev", self._format_mm(metrics.get("deltaStd"))),
            ],
            chart=None,
            tools_used=[{"tool": "get_press_status", "ok": True}],
            suggested_prompts=self._contextual_follow_up_prompts(
                response_kind="status",
                filters=filters,
                machine_label=tool_data.get("machineName"),
            ),
            filters=filters,
            data_semantics="live-current-fallback",
        )
        response.setdefault("context", {})["statusSimpleSummary"] = self._build_status_simple_summary(
            machine_id=machine_id,
            machine_name=tool_data.get("machineName") or "This press",
            filters=filters,
            latest=metrics,
            aggregate=live_aggregate,
            state={"state": card.get("state"), "stateLabel": card.get("stateLabel"), "statusMessage": card.get("statusMessage")},
            rows=[],
            trend_signal=signal,
        )
        response.setdefault("context", {})["statusPerformanceSummary"] = status_performance_summary
        return self._attach_analysis_summary(response, self._status_analysis_summary(status_performance_summary, live_aggregate))

    def _build_status_simple_summary(
        self,
        *,
        machine_id: Optional[int],
        machine_name: str,
        filters: Dict[str, Any],
        latest: Dict[str, Any],
        aggregate: Dict[str, Any],
        state: Dict[str, Any],
        rows: List[Dict[str, Any]],
        trend_signal: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        signals = self._status_signal_snapshot(latest=latest, aggregate=aggregate, rows=rows)
        overall_standing = self._status_simple_standing(machine_id, filters)
        takeaways = self._status_simple_takeaways(signals, state)
        trend = self._status_simple_trend(signals, rows, trend_signal, state)
        next_check = self._status_simple_next_check(signals)
        return {
            "verdict": f"{machine_name} is {str(state.get('stateLabel') or 'Unknown').lower()}.",
            "overallStanding": overall_standing,
            "takeaways": takeaways,
            "trend": trend,
            "nextCheck": next_check,
        }

    def _status_category_tags(self, metric_key: str, severity: int, trend: str) -> List[str]:
        base_tags = {
            "monitoring_coverage": ["Read confidence"],
            "rlm_bad_feet_pct": ["Quality loss"],
            "rlm_bad_feet": ["Scrap driver"],
            "delta_variation": ["Control issue"],
            "delta_drift": ["Registration drift"],
            "speed_instability": ["Process instability"],
            "tolerance_changes": ["Operator intervention"],
        }.get(metric_key, [])
        tags = list(base_tags)
        trend_lower = str(trend or "").lower()
        if severity >= 3:
            tags.append("Immediate attention")
        elif severity >= 2:
            tags.append("Watch closely")
        if trend_lower == "worsening":
            tags.append("Getting worse")
        elif trend_lower == "improving":
            tags.append("Recovering")
        elif trend_lower == "mixed":
            tags.append("Uneven pattern")
        return tags[:3]

    def _status_delta_display(self, metric_key: str, baseline_context: Optional[Dict[str, Any]]) -> str:
        if not baseline_context:
            return "--"
        delta = baseline_context.get("delta")
        if delta is None:
            return "--"
        try:
            delta_value = float(delta)
        except (TypeError, ValueError):
            return "--"
        arrow = "↑" if delta_value > 0 else "↓" if delta_value < 0 else "→"
        abs_value = abs(delta_value)
        if metric_key in {"rlm_bad_feet_pct", "monitoring_coverage"}:
            formatted = self._format_pct(abs_value)
        elif metric_key in {"delta_variation", "delta_drift", "speed_instability"}:
            formatted = self._format_mm(abs_value)
        elif metric_key in {"rlm_bad_feet"}:
            formatted = self._format_feet_value(abs_value)
        elif metric_key in {"tolerance_changes"}:
            formatted = f"{abs_value:.2f}"
        else:
            formatted = self._format_number(abs_value)
        return f"{arrow} {formatted}"

    def _status_outcome_rank_phrase(self, rank: Optional[int], total: Optional[int]) -> str:
        if rank is None or total is None or total <= 0:
            return "position is unclear"
        if rank == total and total > 1:
            return "worst in the plant"
        if rank >= max(2, total - 1):
            return "among the worst in the plant"
        if rank >= max(1, total - total // 3):
            return "in the weaker end of the plant"
        if rank <= max(1, total // 3):
            return "in the stronger end of the plant"
        return "mid-pack in the plant"

    def _status_prompt_framing(self, lowered: str) -> str:
        if any(
            token in lowered
            for token in (
                " what is hurting ",
                " what s hurting ",
                " what is driving ",
                " what s driving ",
                " what is causing ",
                " what s causing ",
                " what is dragging down ",
                " what s dragging down ",
            )
        ):
            return "driver"
        if (
            " why " in lowered
            or " worst " in lowered
            or " rank " in lowered
            or " ranking " in lowered
            or " bad today " in lowered
            or " ranked low " in lowered
        ):
            return "cause"
        return "performance"

    def _status_quality_outcome(
        self,
        *,
        machine_id: Optional[int],
        machine_name: str,
        filters: Dict[str, Any],
        aggregate: Dict[str, Any],
        category_summaries: List[Dict[str, Any]],
    ) -> Dict[str, Any]:
        resolved_id = self._to_int(machine_id)
        if resolved_id is None:
            return {}
        rankings = self._safe_get_press_rankings_tool(resolved_id, filters)
        intelligence = self._get_press_intelligence(filters)
        category_breakdown = self._safe_get_press_category_breakdown_tool(resolved_id, filters)
        overview_row = rankings.get("overviewRow") or {}
        category_map = {str(item.get("key") or ""): item for item in (category_breakdown.get("categories") or [])}
        bad_feet_pct_rank = self._to_int((category_map.get("bad_feet_pct") or {}).get("rank"))
        bad_feet_total = len(intelligence.get("pressRankings") or [])
        bad_feet_rank = self._to_int((category_map.get("bad_feet") or {}).get("rank"))
        overall_total = len(intelligence.get("overviewRankings") or [])
        overall_rank = self._to_int(overview_row.get("rank"))
        bad_feet_pct_total = bad_feet_total or None
        outcome_categories = {
            str(item.get("key") or ""): item
            for item in category_summaries
            if str(item.get("key") or "") in {"rlm_bad_feet_pct", "rlm_bad_feet"}
        }
        bad_pct_item = outcome_categories.get("rlm_bad_feet_pct") or {}
        bad_feet_item = outcome_categories.get("rlm_bad_feet") or {}
        bad_pct_phrase = self._status_outcome_rank_phrase(bad_feet_pct_rank, bad_feet_pct_total)
        bad_feet_phrase = self._status_outcome_rank_phrase(bad_feet_rank, bad_feet_total)
        primary_trends = [str(item.get("trend") or "") for item in (bad_pct_item, bad_feet_item) if item]
        if primary_trends.count("worsening") >= 1:
            direction = "worsening"
        elif primary_trends and all(item == "improving" for item in primary_trends):
            direction = "improving"
        else:
            direction = "mostly holding steady"
        monitor_points = self._to_int(aggregate.get("monitoringPointsTotal"))
        bad_points = self._to_int(aggregate.get("oobPointCount"))
        evidence_display = "--"
        confidence_note = ""
        if monitor_points is not None and monitor_points > 0:
            evidence_display = f"{bad_points or 0} / {monitor_points} bad monitoring points"
            coverage_density = aggregate.get("pointsPer1000Ft")
            if monitor_points < 50 or (coverage_density is not None and float(coverage_density) < 5.0):
                confidence_note = "Coverage is light, so treat the bad-feet read as directional rather than fully locked in."
            elif (bad_points or 0) <= 0:
                confidence_note = "Coverage is broad, but there are very few bad monitoring points backing the current bad-feet result."
            else:
                confidence_note = "Coverage is broad enough that the bad-feet result is supported by the monitoring evidence."
        else:
            confidence_note = "Monitoring coverage is thin, so confidence in the bad-feet read is limited."

        overall_sentence = (
            f"{machine_name} is {bad_pct_phrase} on Bad Feet % at {bad_pct_item.get('currentDisplay') or self._format_pct(aggregate.get('badFeetPct'))} "
            f"(rank #{bad_feet_pct_rank or '--'} of {bad_feet_pct_total or '--'}), and total bad feet is "
            f"{'also elevated' if bad_feet_rank and bad_feet_total and bad_feet_rank >= max(2, bad_feet_total - 1) else bad_feet_phrase} "
            f"at {bad_feet_item.get('currentDisplay') or self._format_feet_value(aggregate.get('estimatedBadFeet'))} "
            f"(rank #{bad_feet_rank or '--'} of {bad_feet_total or '--'})."
        )
        direction_sentence = f"Across the active scope, quality outcome is {direction}."
        summary = f"{overall_sentence} {direction_sentence}".strip()
        return {
            "summary": summary,
            "badFeetPctRank": bad_feet_pct_rank,
            "badFeetPctTotal": bad_feet_pct_total,
            "badFeetRank": bad_feet_rank,
            "badFeetTotal": bad_feet_total,
            "overallRankDisplay": f"#{overall_rank} of {overall_total}" if overall_rank and overall_total else "--",
            "badFeetPctDisplay": bad_pct_item.get("currentDisplay") or self._format_pct(aggregate.get("badFeetPct")),
            "badFeetPctRankDisplay": f"#{bad_feet_pct_rank} of {bad_feet_pct_total}" if bad_feet_pct_rank and bad_feet_pct_total else "--",
            "badFeetDisplay": bad_feet_item.get("currentDisplay") or self._format_feet_value(aggregate.get("estimatedBadFeet")),
            "badFeetRankDisplay": f"#{bad_feet_rank} of {bad_feet_total}" if bad_feet_rank and bad_feet_total else "--",
            "monitoringEvidenceDisplay": evidence_display,
            "confidenceNote": confidence_note,
            "overallDirection": direction,
        }

    def _status_outcome_opening_sentence(
        self,
        *,
        machine_name: str,
        quality_outcome: Dict[str, Any],
        contributor_labels: List[str],
        stable_labels: List[str],
        prompt_framing: str,
    ) -> str:
        bad_pct_display = quality_outcome.get("badFeetPctDisplay") or "--"
        bad_pct_rank = quality_outcome.get("badFeetPctRank")
        bad_pct_total = quality_outcome.get("badFeetPctTotal")
        bad_feet_display = quality_outcome.get("badFeetDisplay") or "--"
        bad_feet_rank = quality_outcome.get("badFeetRank")
        bad_feet_total = quality_outcome.get("badFeetTotal")
        direction = str(quality_outcome.get("overallDirection") or "mostly holding steady")

        outcome_clause = (
            f"{machine_name} is {self._status_outcome_rank_phrase(bad_pct_rank, bad_pct_total)} on Bad Feet % "
            f"at {bad_pct_display}"
        )
        if bad_pct_rank and bad_pct_total:
            outcome_clause += f" (rank #{bad_pct_rank} of {bad_pct_total})"
        if bad_feet_rank and bad_feet_total:
            outcome_clause += (
                f", and total bad feet is {self._status_outcome_rank_phrase(bad_feet_rank, bad_feet_total)} "
                f"at {bad_feet_display} (rank #{bad_feet_rank} of {bad_feet_total})"
            )
        elif bad_feet_display != "--":
            outcome_clause += f", with total bad feet at {bad_feet_display}"

        if prompt_framing == "driver":
            if contributor_labels:
                sentence = f"{machine_name} is being hurt mainly by {', '.join(contributor_labels[:3]).lower()}."
            else:
                sentence = f"{machine_name} is being hurt mainly by elevated bad-feet outcome in the current scope."
            sentence += f" {outcome_clause}, and the overall direction is {direction}."
            return sentence

        if prompt_framing == "cause":
            sentence = f"{outcome_clause}, which is the main reason it is ranking poorly in the current scope."
            if contributor_labels:
                sentence += f" The biggest contributing signals are {', '.join(contributor_labels[:3]).lower()}."
            sentence += f" Overall, it is {direction}."
            return sentence

        sentence = f"{outcome_clause}."
        if contributor_labels:
            sentence += f" The main pressure is coming from {', '.join(contributor_labels[:3]).lower()}."
        if stable_labels:
            sentence += f" {', '.join(stable_labels[:2])} is staying steadier."
        sentence += f" Overall direction is {direction}."
        return sentence

    def _status_category_definitions(self) -> List[Dict[str, str]]:
        return [
            {"metric_key": "monitoring_coverage", "label": "Monitoring Coverage"},
            {"metric_key": "rlm_bad_feet_pct", "label": "Bad Feet %"},
            {"metric_key": "rlm_bad_feet", "label": "Bad Feet"},
            {"metric_key": "delta_variation", "label": "Repeat Length Variation"},
            {"metric_key": "delta_drift", "label": "Repeat Length Drift"},
            {"metric_key": "speed_instability", "label": "Speed Instability"},
            {"metric_key": "tolerance_changes", "label": "Tolerance Changes"},
        ]

    def _status_category_severity(
        self,
        metric_key: str,
        value: Optional[float],
        *,
        aggregate: Optional[Dict[str, Any]] = None,
    ) -> int:
        if value is None:
            return 0
        if metric_key == "monitoring_coverage":
            return self._status_signal_severity("monitoring_coverage", value)
        if metric_key == "rlm_bad_feet_pct":
            return self._status_signal_severity("bad_feet_pct", value)
        if metric_key == "rlm_bad_feet":
            severity_from_pct = self._status_signal_severity("bad_feet_pct", (aggregate or {}).get("badFeetPct"))
            if severity_from_pct > 0:
                return severity_from_pct
            if value >= 1500:
                return 3
            if value >= 750:
                return 2
            if value >= 250:
                return 1
            return 0
        if metric_key == "delta_variation":
            return self._status_signal_severity("delta_variation", value)
        if metric_key == "delta_drift":
            return self._status_signal_severity("delta_drift", value)
        if metric_key == "speed_instability":
            return self._status_signal_severity("speed_instability", value)
        if metric_key == "tolerance_changes":
            if value >= 12:
                return 3
            if value >= 6:
                return 2
            if value >= 2:
                return 1
            return 0
        return 0

    def _status_condition_label(
        self,
        metric_key: str,
        value: Optional[float],
        *,
        aggregate: Optional[Dict[str, Any]] = None,
    ) -> str:
        if value is None:
            return "Unavailable"
        severity = self._status_category_severity(metric_key, value, aggregate=aggregate)
        if severity >= 3:
            return "Critical"
        if severity == 2:
            return "Warning"
        if severity == 1:
            return "Watch"
        return "Stable" if metric_key == "rlm_bad_feet" and float(value or 0.0) > 0 else "Healthy"

    def _status_trend_direction(self, metric_key: str, rows: List[Dict[str, Any]]) -> Dict[str, str]:
        trend = self._compute_phase2a_trend(metric_key, rows)
        direction = str(trend.get("direction") or "stable").lower()
        scores = [self._phase2b_metric_score(metric_key, row) for row in rows]
        usable_scores = [float(score) for score in scores if score is not None]
        if direction == "stable" and len(usable_scores) >= 4:
            mean_value = sum(usable_scores) / len(usable_scores)
            span = max(usable_scores) - min(usable_scores)
            variability_threshold = max(abs(mean_value) * 0.35, 0.15)
            if span >= variability_threshold:
                direction = "mixed"
        basis = str(trend.get("basis") or "").strip()
        if direction == "mixed" and not basis:
            basis = "The first and second halves of the active scope do not move cleanly in one direction."
        return {
            "direction": direction,
            "basis": basis or "Trend uses the active scoped rows only.",
        }

    def _status_category_interpretation(
        self,
        *,
        label: str,
        metric_key: str,
        condition: str,
        trend_direction: str,
        value_display: str,
        baseline_context: Optional[Dict[str, Any]] = None,
        peer_context: Optional[Dict[str, Any]] = None,
    ) -> str:
        condition_lower = condition.lower()
        trend_lower = trend_direction.lower()
        baseline_clause = ""
        if baseline_context and baseline_context.get("label") and baseline_context.get("previousDisplay"):
            baseline_clause = (
                f" It is {baseline_context.get('relative')} the {baseline_context.get('label')} "
                f"({value_display} vs {baseline_context.get('previousDisplay')})."
            )
        peer_clause = ""
        if peer_context and peer_context.get("peerBand"):
            rank = peer_context.get("rank")
            rank_text = f" rank #{rank}" if rank is not None else ""
            peer_clause = f" It is {peer_context.get('peerBand')}{rank_text} in this scope."

        if metric_key == "monitoring_coverage":
            core = {
                "worsening": "Monitoring density is thinning out, which makes the rest of the scoped read less trustworthy.",
                "improving": "Monitoring density is recovering, so confidence in the read is getting better.",
                "mixed": "Monitoring density is uneven from reel to reel, so confidence in the read is not consistent.",
            }.get(trend_lower, f"Monitoring density is {condition_lower}, which sets how much trust to place in the rest of the metrics.")
        elif metric_key == "rlm_bad_feet_pct":
            core = {
                "worsening": "Quality loss is climbing, so a larger share of current footage is going bad.",
                "improving": "Quality loss is easing, so less of the run is being affected.",
                "mixed": "Quality loss is swinging around instead of holding a clean pattern.",
            }.get(trend_lower, f"Quality loss is {condition_lower} across the active scope.")
        elif metric_key == "rlm_bad_feet":
            core = {
                "worsening": "Scrap exposure is building in absolute feet, so the total hit is still accumulating.",
                "improving": "Scrap accumulation is easing, so the press is giving back less footage.",
                "mixed": "Scrap volume is uneven, with damage concentrated in parts of the scoped run.",
            }.get(trend_lower, f"Scrap volume is currently {condition_lower} in the active scope.")
        elif metric_key == "delta_variation":
            core = {
                "worsening": "Repeat length is getting less consistent, which can keep feeding print variation and bad feet.",
                "improving": "Repeat length control is settling down, which should reduce defect pressure if it holds.",
                "mixed": "Repeat length variation comes and goes, so the issue is not yet under control.",
            }.get(trend_lower, f"Repeat length variation is {condition_lower} right now.")
        elif metric_key == "delta_drift":
            core = {
                "worsening": "Repeat length is walking away over the run, which suggests a stability problem rather than isolated noise.",
                "improving": "Repeat length drift is easing, so the run is holding closer to target.",
                "mixed": "Repeat length drift is inconsistent, suggesting the press is not holding a steady center line.",
            }.get(trend_lower, f"Repeat length drift is {condition_lower} in the current scope.")
        elif metric_key == "speed_instability":
            core = {
                "worsening": "Speed behavior is getting rougher, which can keep feeding variation into the rest of the process.",
                "improving": "Speed control is settling, which should help the rest of the process stabilize.",
                "mixed": "Speed is moving around in bursts, so the process is not yet consistently calm.",
            }.get(trend_lower, f"Speed behavior is {condition_lower} across the active scope.")
        elif metric_key == "tolerance_changes":
            core = {
                "worsening": "The press needed more tolerance intervention than usual, which points to a harder-to-hold process.",
                "improving": "Tolerance intervention is backing off, which is a sign the press is easier to hold.",
                "mixed": "Tolerance moves are coming in clusters, which suggests the press is not fully settled.",
            }.get(trend_lower, f"Tolerance intervention is {condition_lower} for this scope.")
        else:
            core = f"{label} is {condition_lower} at {value_display}."
        return f"{core} Now at {value_display}.{baseline_clause}{peer_clause}"

    def _status_overall_summary(
        self,
        *,
        machine_name: str,
        machine_id: Optional[int],
        filters: Dict[str, Any],
        category_summaries: List[Dict[str, Any]],
        aggregate: Dict[str, Any],
        prompt_framing: str = "performance",
    ) -> Dict[str, Any]:
        quality_outcome = self._status_quality_outcome(
            machine_id=machine_id,
            machine_name=machine_name,
            filters=filters,
            aggregate=aggregate,
            category_summaries=category_summaries,
        )
        stable_areas = [
            item for item in category_summaries
            if str(item.get("key") or "") not in {"rlm_bad_feet_pct", "rlm_bad_feet"}
            and int(item.get("severity") or 0) == 0 and str(item.get("trend") or "") in {"stable", "improving"}
        ]
        contributor_labels = []
        for item in sorted(
            [item for item in category_summaries if str(item.get("key") or "") not in {"rlm_bad_feet_pct", "rlm_bad_feet"}],
            key=lambda item: (-int(item.get("severity") or 0), str(item.get("trend") or "") != "worsening", -(float(item.get("priorityScore") or 0.0))),
        ):
            if int(item.get("severity") or 0) >= 1 or str(item.get("trend") or "") in {"worsening", "mixed"}:
                contributor_labels.append(str(item.get("label") or ""))
            if len(contributor_labels) >= 3:
                break
        stable_labels = [str(item.get("label") or "") for item in stable_areas[:2] if item.get("label")]
        summary = self._status_outcome_opening_sentence(
            machine_name=machine_name,
            quality_outcome=quality_outcome,
            contributor_labels=contributor_labels,
            stable_labels=stable_labels,
            prompt_framing=prompt_framing,
        )
        if not summary.strip():
            summary = quality_outcome.get("summary") or f"{machine_name} quality outcome is available for the active scope."
        return {
            "summary": summary,
            "overallPerformance": quality_outcome.get("overallRankDisplay") or "",
            "overallTrend": quality_outcome.get("overallDirection") or "",
            "stableAreas": [item for item in stable_areas[:3] if item.get("label")],
            "standing": quality_outcome.get("confidenceNote") or "",
            "qualityOutcome": quality_outcome,
        }

    def _status_category_summaries(
        self,
        *,
        machine_name: str,
        machine_id: Optional[int],
        rows: List[Dict[str, Any]],
        aggregate: Dict[str, Any],
        filters: Dict[str, Any],
        prompt_framing: str = "performance",
    ) -> Dict[str, Any]:
        categories: List[Dict[str, Any]] = []
        for definition in self._status_category_definitions():
            metric_key = str(definition.get("metric_key") or "")
            metric = self._compute_phase2a_metric(metric_key, rows)
            trend = self._status_trend_direction(metric_key, rows)
            value = metric.get("value")
            condition = self._status_condition_label(metric_key, value, aggregate=aggregate)
            baseline_context = self._status_category_baseline_context(metric_key, machine_id, filters, rows)
            peer_context = self._status_category_peer_context(metric_key, machine_id, filters)
            severity = self._status_category_severity(metric_key, value, aggregate=aggregate)
            priority_score = float(severity * 10)
            if str(trend.get("direction") or "") == "worsening":
                priority_score += 4.0
            elif str(trend.get("direction") or "") == "mixed":
                priority_score += 2.0
            if baseline_context.get("relative") == "worse than":
                priority_score += 2.0
            if "weaker than most peers" == peer_context.get("peerBand"):
                priority_score += 2.0
            interpretation = self._status_category_interpretation(
                label=str(definition.get("label") or metric.get("metricLabel") or metric_key),
                metric_key=metric_key,
                condition=condition,
                trend_direction=str(trend.get("direction") or "stable"),
                value_display=str(metric.get("valueDisplay") or "--"),
                baseline_context=baseline_context,
                peer_context=peer_context,
            )
            categories.append(
                {
                    "key": metric_key,
                    "label": str(definition.get("label") or metric.get("metricLabel") or metric_key),
                    "currentValue": value,
                    "currentDisplay": str(metric.get("valueDisplay") or "--"),
                    "condition": condition,
                    "trend": str(trend.get("direction") or "stable"),
                    "trendBasis": str(trend.get("basis") or ""),
                    "interpretation": interpretation,
                    "severity": severity,
                    "role": "outcome" if metric_key in {"rlm_bad_feet_pct", "rlm_bad_feet"} else "contributor",
                    "baselineContext": baseline_context,
                    "peerContext": peer_context,
                    "previousDisplay": baseline_context.get("previousDisplay") or "--",
                    "previousLabel": baseline_context.get("label") or "previous window",
                    "peerRankDisplay": (
                        f"#{peer_context.get('rank')}" if peer_context.get("rank") is not None else "--"
                    ),
                    "peerBand": peer_context.get("peerBand") or "",
                    "deltaDisplay": self._status_delta_display(metric_key, baseline_context),
                    "deltaLabel": f"vs {baseline_context.get('label')}" if baseline_context.get("label") else "vs previous window",
                    "tags": self._status_category_tags(metric_key, severity, str(trend.get("direction") or "stable")),
                    "trendPoints": self._status_category_trend_points(metric_key, rows),
                    "priorityScore": priority_score,
                }
            )
        overall = self._status_overall_summary(
            machine_name=machine_name,
            machine_id=machine_id,
            filters=filters,
            category_summaries=categories,
            aggregate=aggregate,
            prompt_framing=prompt_framing,
        )
        return {
            "overallSummary": overall.get("summary"),
            "overallPerformance": overall.get("overallPerformance") or "",
            "overallTrend": overall.get("overallTrend") or "",
            "qualityOutcome": overall.get("qualityOutcome") or {},
            "stableAreas": overall.get("stableAreas") or [],
            "standing": overall.get("standing") or "",
            "categories": sorted(categories, key=lambda item: -float(item.get("priorityScore") or 0.0)),
        }

    def _status_category_breakdown_section(self, status_summary: Dict[str, Any]) -> Optional[Dict[str, str]]:
        categories = status_summary.get("categories") or []
        if not categories:
            return None
        parts = [
            (
                f"{item.get('label')}: {item.get('currentDisplay')} now | "
                f"{item.get('condition')} | {str(item.get('trend') or '').title()} | "
                f"{item.get('deltaLabel') or 'vs previous window'} {item.get('deltaDisplay') or '--'} | "
                f"Peer {item.get('peerRankDisplay') or '--'}"
            )
            for item in categories
            if item.get("label")
        ]
        if not parts:
            return None
        return {"label": "Category breakdown", "text": " | ".join(parts)}

    def _analysis_key_context_item(self, label: str, value: Any, auxiliary: Optional[Any] = None) -> Dict[str, str]:
        return {
            "label": str(label or "").strip() or "--",
            "value": str(value if value not in (None, "") else "--"),
            "auxiliary": str(auxiliary if auxiliary not in (None, "") else "").strip(),
        }

    def _analysis_meta_item(self, label: str, value: Any) -> Dict[str, str]:
        return {
            "label": str(label or "").strip() or "--",
            "value": str(value if value not in (None, "") else "--"),
        }

    def _analysis_card(
        self,
        *,
        title: str,
        value: Any,
        condition: Optional[str] = None,
        trend: Optional[str] = None,
        meta: Optional[List[Dict[str, str]]] = None,
        tags: Optional[List[str]] = None,
        trend_points: Optional[List[float]] = None,
        note: Optional[str] = None,
    ) -> Dict[str, Any]:
        return {
            "title": str(title or "").strip() or "--",
            "value": str(value if value not in (None, "") else "--"),
            "condition": str(condition or "").strip(),
            "trend": str(trend or "").strip(),
            "meta": [item for item in (meta or []) if item.get("label") and item.get("value")],
            "tags": [str(tag).strip() for tag in (tags or []) if str(tag or "").strip()],
            "trendPoints": [float(point) for point in (trend_points or []) if point is not None],
            "note": str(note or "").strip(),
        }

    def _analysis_summary_payload(
        self,
        *,
        family: str,
        lead: str,
        key_context: Optional[List[Dict[str, str]]] = None,
        primary_label: Optional[str] = None,
        primary_cards: Optional[List[Dict[str, Any]]] = None,
        supporting_label: Optional[str] = None,
        supporting_cards: Optional[List[Dict[str, Any]]] = None,
        production_label: Optional[str] = None,
        production_cards: Optional[List[Dict[str, Any]]] = None,
        next_checks: Optional[List[str]] = None,
    ) -> Dict[str, Any]:
        return {
            "family": str(family or "").strip() or "analysis",
            "lead": str(lead or "").strip(),
            "keyContext": [item for item in (key_context or []) if item.get("label")],
            "primaryLabel": str(primary_label or "").strip(),
            "primaryCards": [item for item in (primary_cards or []) if item.get("title")],
            "supportingLabel": str(supporting_label or "").strip(),
            "supportingCards": [item for item in (supporting_cards or []) if item.get("title")],
            "productionLabel": str(production_label or "").strip(),
            "productionCards": [item for item in (production_cards or []) if item.get("title")],
            "nextChecks": [str(item).strip() for item in (next_checks or []) if str(item or "").strip()],
        }

    def _attach_analysis_summary(self, response: Dict[str, Any], summary: Optional[Dict[str, Any]]) -> Dict[str, Any]:
        if summary:
            response.setdefault("context", {})["analysisSummary"] = summary
        return response

    def _status_analysis_summary(self, status_summary: Dict[str, Any], aggregate: Dict[str, Any]) -> Dict[str, Any]:
        quality_outcome = status_summary.get("qualityOutcome") or {}
        categories = status_summary.get("categories") or []
        contributor_cards = [
            self._analysis_card(
                title=str(item.get("label") or "--"),
                value=item.get("currentDisplay"),
                condition=item.get("condition"),
                trend=item.get("trend"),
                meta=[
                    self._analysis_meta_item(item.get("deltaLabel") or "vs previous window", item.get("deltaDisplay") or "--"),
                    self._analysis_meta_item("Peer rank", item.get("peerRankDisplay") or "--"),
                ],
                tags=item.get("tags") or [],
                trend_points=item.get("trendPoints") or [],
                note=item.get("interpretation"),
            )
            for item in categories
            if str(item.get("role") or "") != "outcome"
        ]
        production_cards = [
            self._analysis_card(
                title="Production context",
                value=f"{aggregate.get('reelsRun') or 0} reels",
                condition="Scope",
                meta=[
                    self._analysis_meta_item("Total feet", self._format_feet_value(aggregate.get("feetTotal"))),
                    self._analysis_meta_item("Pts / 1k ft", self._format_number(aggregate.get("pointsPer1000Ft"))),
                ],
            )
        ]
        return self._analysis_summary_payload(
            family="status",
            lead=str(status_summary.get("overallSummary") or ""),
            key_context=[
                self._analysis_key_context_item("Overall plant rank", quality_outcome.get("overallRankDisplay") or "--"),
                self._analysis_key_context_item("Bad Feet %", quality_outcome.get("badFeetPctDisplay") or "--", quality_outcome.get("badFeetPctRankDisplay") or ""),
                self._analysis_key_context_item("Bad Feet", quality_outcome.get("badFeetDisplay") or "--", quality_outcome.get("badFeetRankDisplay") or ""),
                self._analysis_key_context_item("Monitoring evidence", quality_outcome.get("monitoringEvidenceDisplay") or "--", quality_outcome.get("confidenceNote") or ""),
            ],
            primary_label="Contributing Signals",
            primary_cards=contributor_cards,
            production_label="Production Context",
            production_cards=production_cards,
        )

    def _status_category_peer_context(
        self,
        metric_key: str,
        machine_id: Optional[int],
        filters: Dict[str, Any],
    ) -> Dict[str, Any]:
        resolved_id = self._to_int(machine_id)
        if resolved_id is None:
            return {}
        category_key_map = {
            "monitoring_coverage": "monitoring_coverage",
            "rlm_bad_feet_pct": "bad_feet_pct",
            "delta_variation": "delta_variation",
            "delta_drift": "delta_drift",
            "speed_instability": "speed_instability",
            "tolerance_changes": "tolerance_changes",
        }
        category_key = category_key_map.get(metric_key)
        if category_key:
            categories = self.get_press_category_breakdown_tool(resolved_id, filters).get("categories") or []
            item = next((row for row in categories if str(row.get("key") or "") == category_key), None)
            if item and item.get("rank") is not None:
                rank = int(item.get("rank") or 0)
                total = len(categories) if categories else None
                if total and rank <= max(1, total // 3):
                    band = "strong versus peers"
                elif total and rank >= max(1, total - total // 3):
                    band = "weaker than most peers"
                else:
                    band = "middle of the peer set"
                return {
                    "rank": rank,
                    "peerBand": band,
                    "valueDisplay": item.get("valueDisplay"),
                    "contextLabel": item.get("contextLabel"),
                }
        if metric_key == "rlm_bad_feet":
            intelligence = self._get_press_intelligence(filters)
            rows = intelligence.get("pressRankings") or []
            press_row = next((row for row in rows if self._to_int(row.get("machineId")) == resolved_id), None)
            if press_row and press_row.get("rank") is not None:
                rank = int(press_row.get("rank") or 0)
                total = len(rows)
                if rank <= max(1, total // 3):
                    band = "strong versus peers"
                elif rank >= max(1, total - total // 3):
                    band = "weaker than most peers"
                else:
                    band = "middle of the peer set"
                return {
                    "rank": rank,
                    "peerBand": band,
                    "valueDisplay": self._format_feet_value(press_row.get("estimatedBadFeet")),
                    "contextLabel": "estimated bad feet in the active scope",
                }
        return {}

    def _status_category_baseline_context(
        self,
        metric_key: str,
        machine_id: Optional[int],
        filters: Dict[str, Any],
        rows: List[Dict[str, Any]],
    ) -> Dict[str, Any]:
        resolved_id = self._to_int(machine_id)
        if resolved_id is None or not rows:
            return {}
        previous_filters = self._previous_window_filters(filters, resolved_id)
        if not previous_filters:
            return {}
        previous_dataset = self._build_filtered_dataset(previous_filters, resolved_id)
        previous_rows = list(previous_dataset.get("rows") or [])
        if not previous_rows:
            return {}
        current_metric = self._compute_phase2a_metric(metric_key, rows)
        previous_metric = self._compute_phase2a_metric(metric_key, previous_rows, qualification=previous_dataset.get("qualification"))
        current_value = current_metric.get("value")
        previous_value = previous_metric.get("value")
        if current_value is None or previous_value is None:
            return {}
        higher_is_better = METRIC_REGISTRY.get(metric_key, {}).get("higher_is_better")
        delta = float(current_value) - float(previous_value)
        threshold = max(abs(float(previous_value)) * 0.08, 0.02)
        if abs(delta) < threshold:
            relative = "in line with"
        elif higher_is_better:
            relative = "better than" if delta > 0 else "worse than"
        else:
            relative = "better than" if delta < 0 else "worse than"
        return {
            "label": self._previous_window_label(filters),
            "previousValue": previous_value,
            "previousDisplay": previous_metric.get("valueDisplay"),
            "relative": relative,
            "delta": delta,
        }

    def _status_category_trend_points(self, metric_key: str, rows: List[Dict[str, Any]]) -> List[float]:
        points = [float(self._phase2b_metric_score(metric_key, row)) for row in rows if self._phase2b_metric_score(metric_key, row) is not None]
        if len(points) <= 12:
            return points
        stride = max(1, len(points) // 12)
        sampled = [points[index] for index in range(0, len(points), stride)]
        if sampled[-1] != points[-1]:
            sampled.append(points[-1])
        return sampled[:12]

    def _status_priority_label(self, severity: int, trend: str) -> str:
        if severity >= 2:
            return "Main concern"
        if severity == 1 or trend == "mixed":
            return "Secondary concern"
        return "Relatively stable area"

    def _status_why_it_matters(self, metric_key: str, priority_label: str) -> str:
        if metric_key == "monitoring_coverage":
            return "Low coverage weakens confidence in every other read for this scope."
        if metric_key in {"rlm_bad_feet_pct", "rlm_bad_feet"}:
            return "This directly reflects quality loss and scrap risk."
        if metric_key in {"delta_variation", "delta_drift"}:
            return "This points to repeat-length control issues that can keep driving defects."
        if metric_key == "speed_instability":
            return "This suggests unstable process conditions that can feed downstream quality swings."
        if metric_key == "tolerance_changes":
            return "Frequent tolerance moves suggest the press needed more intervention than usual."
        if priority_label == "Relatively stable area":
            return "This is not driving the current performance read."
        return "This is materially affecting the current performance read."

    def _status_signal_snapshot(
        self,
        *,
        latest: Dict[str, Any],
        aggregate: Dict[str, Any],
        rows: List[Dict[str, Any]],
    ) -> Dict[str, Dict[str, Any]]:
        def _as_float(value: Any) -> Optional[float]:
            try:
                return float(value) if value is not None else None
            except (TypeError, ValueError):
                return None

        def _series(key: str, *, absolute: bool = False) -> List[float]:
            values: List[float] = []
            for row in rows:
                raw = _as_float(row.get(key))
                if raw is None:
                    continue
                values.append(abs(raw) if absolute else raw)
            return values

        def _avg(values: List[float]) -> Optional[float]:
            return sum(values) / len(values) if values else None

        bad_values = _series("estimatedBadFeetPct")
        variation_values = _series("deltaStd")
        drift_values = _series("avgDelta", absolute=True)
        speed_values = _series("webspeedRange")
        coverage_values = _series("pointsPer1000Ft")

        return {
            "bad_feet_pct": {
                "value": _as_float(aggregate.get("badFeetPct")) if aggregate.get("badFeetPct") is not None else _avg(bad_values),
                "latest": _as_float(latest.get("estimatedBadFeetPct") or latest.get("badFeetPct")),
                "display": self._format_pct(_as_float(aggregate.get("badFeetPct")) if aggregate.get("badFeetPct") is not None else _avg(bad_values)),
                "series": bad_values,
            },
            "delta_variation": {
                "value": _avg(variation_values) if variation_values else _as_float(aggregate.get("deltaVariation") or latest.get("deltaStd")),
                "latest": _as_float(latest.get("deltaStd")),
                "display": self._format_mm(_avg(variation_values) if variation_values else _as_float(aggregate.get("deltaVariation") or latest.get("deltaStd"))),
                "series": variation_values,
                "spread": (max(variation_values) - min(variation_values)) if len(variation_values) >= 2 else None,
            },
            "delta_drift": {
                "value": _avg(drift_values) if drift_values else abs(_as_float(aggregate.get("deltaDrift") or latest.get("avgDelta")) or 0.0),
                "latest": abs(_as_float(latest.get("avgDelta")) or 0.0) if latest.get("avgDelta") is not None else None,
                "display": self._format_mm(_avg(drift_values) if drift_values else abs(_as_float(aggregate.get("deltaDrift") or latest.get("avgDelta")) or 0.0)),
                "series": drift_values,
            },
            "speed_instability": {
                "value": _avg(speed_values) if speed_values else _as_float(aggregate.get("speedInstability") or latest.get("webspeedRange")),
                "latest": _as_float(latest.get("webspeedRange")),
                "display": self._format_number(_avg(speed_values) if speed_values else _as_float(aggregate.get("speedInstability") or latest.get("webspeedRange"))),
                "series": speed_values,
            },
            "monitoring_coverage": {
                "value": _as_float(aggregate.get("pointsPer1000Ft")) if aggregate.get("pointsPer1000Ft") is not None else _avg(coverage_values),
                "latest": _as_float(latest.get("pointsPer1000Ft")),
                "display": f"{self._format_number(_as_float(aggregate.get('pointsPer1000Ft')) if aggregate.get('pointsPer1000Ft') is not None else _avg(coverage_values))} pts/1k ft",
                "series": coverage_values,
            },
        }

    def _status_signal_severity(self, key: str, value: Optional[float]) -> int:
        if value is None:
            return 0
        if key == "bad_feet_pct":
            if value >= 5.0:
                return 3
            if value >= 3.0:
                return 2
            if value >= 2.0:
                return 1
            return 0
        if key == "delta_variation":
            if value >= 0.7:
                return 3
            if value >= 0.5:
                return 2
            if value >= 0.35:
                return 1
            return 0
        if key == "delta_drift":
            if value >= 1.0:
                return 3
            if value >= 0.5:
                return 2
            if value >= 0.3:
                return 1
            return 0
        if key == "speed_instability":
            if value >= 20.0:
                return 3
            if value >= 12.0:
                return 2
            if value >= 8.0:
                return 1
            return 0
        if key == "monitoring_coverage":
            if value <= 0:
                return 3
            if value < 20.0:
                return 2
            if value < 25.0:
                return 1
            return 0
        return 0

    def _status_simple_standing(self, machine_id: Optional[int], filters: Dict[str, Any]) -> str:
        resolved_id = self._to_int(machine_id)
        if resolved_id is None:
            return ""
        intelligence = self._get_press_intelligence(filters)
        overview_rows = intelligence.get("overviewRankings", []) or []
        overview_row = next((row for row in overview_rows if self._to_int(row.get("machineId")) == resolved_id), None)
        if not overview_row:
            return ""
        total = len(overview_rows)
        rank = int(overview_row.get("rank") or 0)
        if rank <= max(1, total // 3):
            band = "Upper tier in this window"
        elif rank >= max(1, total - total // 3):
            band = "Lower tier in this window"
        else:
            band = "Middle of the pack in this window"
        category_map = {
            str(item.get("key") or ""): item
            for item in (self.get_press_category_breakdown_tool(resolved_id, filters).get("categories") or [])
        }
        weak_rank_rows: List[tuple[int, str]] = []
        for key, label in (
            ("bad_feet_pct", "Bad feet"),
            ("delta_variation", "Repeat variation"),
            ("delta_drift", "Drift"),
            ("speed_instability", "Speed instability"),
        ):
            item = category_map.get(key)
            if item and item.get("rank") is not None:
                weak_rank_rows.append((int(item.get("rank") or 0), f"{label} #{item.get('rank')}"))
        weak_rank_rows.sort(key=lambda item: item[0], reverse=True)
        detail = ", ".join(label for _, label in weak_rank_rows[:2])
        return f"{band} | Overall rank #{rank} of {total}" + (f" | Weakest ranks: {detail}" if detail else "")

    def _status_simple_takeaways(self, signals: Dict[str, Dict[str, Any]], state: Dict[str, Any]) -> List[str]:
        takeaways: List[str] = []
        primary_keys = ["bad_feet_pct", "delta_variation", "delta_drift", "speed_instability"]
        ranked = sorted(
            primary_keys,
            key=lambda key: (
                -self._status_signal_severity(key, signals.get(key, {}).get("value")),
                -float(signals.get(key, {}).get("value") or 0.0),
            ),
        )
        for key in ranked:
            signal = signals.get(key) or {}
            severity = self._status_signal_severity(key, signal.get("value"))
            if severity <= 0:
                continue
            if key == "bad_feet_pct":
                takeaways.append(f"Bad feet is elevated at {signal.get('display')}")
            elif key == "delta_variation":
                line = f"Repeat variation is elevated at {signal.get('display')}"
                if signal.get("spread") is not None and float(signal.get("spread") or 0.0) >= 0.15:
                    line += f" | Window spread is {self._format_mm(signal.get('spread'))}"
                takeaways.append(line)
            elif key == "delta_drift":
                takeaways.append(f"Drift is elevated at {signal.get('display')}")
            elif key == "speed_instability":
                takeaways.append(f"Speed instability is elevated at {signal.get('display')}")
            if len(takeaways) >= 2:
                break
        if not takeaways:
            takeaways.append("Main quality and process signals look steady")
        coverage = signals.get("monitoring_coverage") or {}
        coverage_severity = self._status_signal_severity("monitoring_coverage", coverage.get("value"))
        if coverage_severity >= 2:
            takeaways.append(f"Monitoring density is weak at {coverage.get('display')} | Treat this as a coverage caveat")
        elif not takeaways and state.get("statusMessage"):
            takeaways.append(str(state.get("statusMessage")))
        return takeaways[:3]

    def _status_simple_trend(
        self,
        signals: Dict[str, Dict[str, Any]],
        rows: List[Dict[str, Any]],
        trend_signal: Optional[Dict[str, Any]],
        state: Dict[str, Any],
    ) -> str:
        coverage = signals.get("monitoring_coverage") or {}
        if self._status_signal_severity("monitoring_coverage", coverage.get("value")) >= 3:
            return "Monitoring is too weak to trust a trend call."
        if trend_signal and trend_signal.get("detail"):
            detail = str(trend_signal.get("detail") or "").strip()
            context = str(trend_signal.get("context") or "").strip()
            return detail + (f" | {context}" if context else "")
        priority_keys = ["bad_feet_pct", "delta_variation", "delta_drift", "speed_instability"]
        ranked = sorted(
            priority_keys,
            key=lambda key: (
                -self._status_signal_severity(key, signals.get(key, {}).get("value")),
                -float(signals.get(key, {}).get("value") or 0.0),
            ),
        )
        labels = {
            "bad_feet_pct": "Bad feet",
            "delta_variation": "Repeat variation",
            "delta_drift": "Drift",
            "speed_instability": "Speed instability",
        }
        metric_keys = {
            "bad_feet_pct": "rlm_bad_feet_pct",
            "delta_variation": "delta_variation",
            "delta_drift": "delta_drift",
            "speed_instability": "speed_instability",
        }
        for key in ranked:
            series = list(signals.get(key, {}).get("series") or [])
            if len(series) < 3:
                continue
            assessment = self._trend_assessment(metric_keys[key], series)
            if assessment.get("direction") == "unclear":
                continue
            if assessment.get("direction") == "stable":
                return f"{labels[key]} is broadly stable in this window."
            if assessment.get("direction") == "worsening":
                return f"{labels[key]} is trending worse in this window."
            if assessment.get("direction") == "improving":
                return f"{labels[key]} is easing in this window."
        return str(state.get("statusMessage") or "").strip()

    def _status_simple_next_check(self, signals: Dict[str, Dict[str, Any]]) -> str:
        coverage = signals.get("monitoring_coverage") or {}
        if self._status_signal_severity("monitoring_coverage", coverage.get("value")) >= 2:
            return "Confirm monitoring density before trusting the rest of the read."
        if self._status_signal_severity("delta_variation", (signals.get("delta_variation") or {}).get("value")) >= 2:
            if self._status_signal_severity("speed_instability", (signals.get("speed_instability") or {}).get("value")) >= 1:
                return "Check the last few reels for repeat variation and speed swings."
            return "Check whether the last few reels recovered or stayed unstable."
        if self._status_signal_severity("bad_feet_pct", (signals.get("bad_feet_pct") or {}).get("value")) >= 2:
            return "Check which recent reels are driving the bad feet."
        return "Check the latest reels to confirm the pattern is holding."

    def _status_chart_candidates(self) -> List[Dict[str, Any]]:
        return [
            {
                "metric_key": "rlm_bad_feet_pct",
                "label": "Bad Feet %",
                "row_key": "estimatedBadFeetPct",
                "formatter": self._format_pct,
            },
            {
                "metric_key": "delta_variation",
                "label": "Delta Std Dev",
                "row_key": "deltaStd",
                "formatter": self._format_mm,
            },
            {
                "metric_key": "monitoring_coverage",
                "label": "Monitoring Density",
                "row_key": "pointsPer1000Ft",
                "formatter": self._format_number,
            },
        ]

    def _status_issue_bonus(
        self,
        candidate: Dict[str, Any],
        latest: Dict[str, Any],
        aggregate: Dict[str, Any],
        state: Dict[str, Any],
    ) -> float:
        def as_float(value: Any) -> Optional[float]:
            try:
                return float(value) if value is not None else None
            except (TypeError, ValueError):
                return None

        metric_key = str(candidate.get("metric_key") or "")
        latest_coverage = as_float(latest.get("pointsPer1000Ft"))
        latest_bad_pct = as_float(latest.get("estimatedBadFeetPct"))
        latest_delta_std = as_float(latest.get("deltaStd"))
        aggregate_bad_pct = as_float(aggregate.get("badFeetPct"))
        aggregate_coverage = as_float(aggregate.get("pointsPer1000Ft"))
        state_label = str(state.get("state") or "").lower()

        if metric_key == "monitoring_coverage":
            if latest_coverage in (None, 0):
                return 4.0
            if latest_coverage is not None and latest_coverage < 20:
                return 3.5
            if state_label in {"warning", "critical"} and aggregate_coverage is not None and aggregate_coverage < 20:
                return 2.5
            return 0.0
        if metric_key == "rlm_bad_feet_pct":
            if aggregate_bad_pct is not None and aggregate_bad_pct >= 5:
                return 4.0
            if latest_bad_pct is not None and latest_bad_pct >= 5:
                return 3.5
            if aggregate_bad_pct is not None and aggregate_bad_pct >= 3:
                return 3.0
            if latest_bad_pct is not None and latest_bad_pct >= 3:
                return 2.5
            return 0.0
        if metric_key == "delta_variation":
            if latest_delta_std is not None and latest_delta_std >= 0.7:
                return 3.5
            if latest_delta_std is not None and latest_delta_std >= 0.5:
                return 2.5
            return 0.0
        return 0.0

    def _status_chart_metric(
        self,
        rows: List[Dict[str, Any]],
        latest: Dict[str, Any],
        aggregate: Dict[str, Any],
        state: Dict[str, Any],
    ) -> Optional[Dict[str, Any]]:
        best_candidate: Optional[Dict[str, Any]] = None
        best_score = float("-inf")

        for candidate in self._status_chart_candidates():
            row_key = str(candidate.get("row_key") or "")
            series_rows = [row for row in rows if row.get(row_key) is not None]
            if not self._should_render_series_chart([{"value": row.get(row_key)} for row in series_rows]):
                continue
            values = [float(row.get(row_key) or 0.0) for row in series_rows]
            if len(values) < 2:
                continue
            span = max(values) - min(values)
            change = abs(values[-1] - values[0])
            baseline = max(abs(values[0]), 0.01)
            normalized_span = span / baseline
            normalized_change = change / baseline
            trend = self._trend_assessment(str(candidate.get("metric_key") or ""), values)
            confidence_bonus = 0.75 if str(trend.get("confidence") or "") == "high" else 0.35 if str(trend.get("confidence") or "") == "medium" else 0.0
            score = (
                self._status_issue_bonus(candidate, latest, aggregate, state)
                + normalized_span * 1.2
                + normalized_change * 0.8
                + confidence_bonus
            )
            enriched = {
                **candidate,
                "series_rows": series_rows,
                "informative_score": round(score, 3),
                "selection_reason": (
                    f"issue_bonus={self._status_issue_bonus(candidate, latest, aggregate, state):.2f}; "
                    f"normalized_span={normalized_span:.2f}; normalized_change={normalized_change:.2f}; "
                    f"trend_confidence={trend.get('confidence') or 'low'}"
                ),
            }
            if score > best_score:
                best_score = score
                best_candidate = enriched

        return best_candidate

    def _status_chart_x_values(
        self,
        rows: List[Dict[str, Any]],
        filters: Dict[str, Any],
    ) -> List[str]:
        reel_scope = filters.get("reel_scope") or {}
        if reel_scope:
            return [str(row.get("reelId") or f"Reel {index + 1}") for index, row in enumerate(rows)]
        values: List[str] = []
        for index, row in enumerate(rows):
            stamp = row.get("productionStart") or row.get("date")
            if stamp:
                values.append(str(stamp))
            else:
                values.append(str(row.get("reelId") or f"Point {index + 1}"))
        return values

    def _chart_scope_description(
        self,
        *,
        filters: Dict[str, Any],
        scope: Optional[Dict[str, Any]] = None,
        rows: Optional[List[Dict[str, Any]]] = None,
        fallback: str = "selected window",
    ) -> str:
        label = str((scope or {}).get("label") or "").strip()
        if label:
            return label
        window_text = self._scope_window_text(rows or [], filters)
        if window_text:
            return window_text
        window_phrase = self._window_phrase(filters)
        if window_phrase != "in the selected window":
            return window_phrase
        return fallback

    def _chart_metric_value_display(
        self,
        metric_key: Optional[str],
        metric_label: Optional[str],
        value: Any,
    ) -> str:
        if value in (None, ""):
            return "--"
        normalized_key = str(metric_key or "").strip().lower()
        normalized_label = str(metric_label or "").strip().lower()
        try:
            numeric_value = float(value)
        except (TypeError, ValueError):
            return str(value)
        if normalized_key in {"rlm_bad_feet_pct", "bad_feet_pct"} or normalized_label == "bad feet %":
            return self._format_pct(numeric_value)
        if normalized_key in {"monitoring_coverage"} or normalized_label == "monitoring density":
            return f"{self._format_number(numeric_value)} pts/1k ft"
        if normalized_key in {"delta_variation", "delta_drift"} or "delta" in normalized_label:
            return self._format_mm(numeric_value)
        return self._format_number(numeric_value)

    def _chart_hover_time_display(
        self,
        value: Any,
        end_value: Any = None,
    ) -> Optional[str]:
        if not value and not end_value:
            return None
        start_dt = self._row_datetime({"productionStart": value, "date": value})
        end_dt = self._row_datetime({"productionStart": end_value, "date": end_value}) if end_value else None
        if start_dt and end_dt and end_dt != start_dt:
            return f"{self._format_scope_datetime(start_dt)} to {self._format_scope_datetime(end_dt)}"
        if start_dt:
            return self._format_scope_datetime(start_dt)
        if end_dt:
            return self._format_scope_datetime(end_dt)
        if value and end_value and value != end_value:
            return f"{value} to {end_value}"
        return str(value or end_value)

    def _chart_hover_text(
        self,
        *,
        reel: Any = None,
        job: Any = None,
        time_value: Any = None,
        end_time_value: Any = None,
        total_feet: Any = None,
        bad_feet_ft: Any = None,
        bad_feet_pct: Any = None,
        metric_key: Optional[str] = None,
        metric_label: Optional[str] = None,
        metric_value: Any = None,
        extra_lines: Optional[List[str]] = None,
    ) -> str:
        lines: List[str] = []
        if job not in (None, ""):
            lines.append(f"Job: {job}")
        if reel not in (None, ""):
            lines.append(f"Reel: {reel}")
        time_display = self._chart_hover_time_display(time_value, end_time_value)
        if time_display:
            lines.append(f"Time: {time_display}")
        if total_feet not in (None, ""):
            lines.append(f"Total feet: {self._format_feet_value(total_feet)}")
        if bad_feet_ft not in (None, ""):
            lines.append(f"Bad feet (ft): {self._format_feet_value(bad_feet_ft)}")
        if bad_feet_pct not in (None, ""):
            lines.append(f"Bad feet %: {self._format_pct(bad_feet_pct)}")
        if metric_label:
            lines.append(f"{metric_label}: {self._chart_metric_value_display(metric_key, metric_label, metric_value)}")
        for line in extra_lines or []:
            if line:
                lines.append(str(line))
        return "<br>".join(lines)

    def _attach_chart_scope_metadata(
        self,
        chart: Optional[Dict[str, Any]],
        *,
        total_points_in_scope: int,
        displayed_points: int,
        scope_description: str,
    ) -> Optional[Dict[str, Any]]:
        if not chart:
            return None
        normalized = dict(chart)
        metadata = dict(normalized.get("metadata") or {})
        metadata["totalPointsInScope"] = total_points_in_scope
        metadata["displayedPoints"] = displayed_points
        metadata["scopeDescription"] = scope_description
        if displayed_points < total_points_in_scope:
            metadata["displayLabel"] = f"Showing last {displayed_points} of {total_points_in_scope} points"
        normalized["metadata"] = metadata
        return normalized

    def _status_chart(
        self,
        machine_label: str,
        rows: List[Dict[str, Any]],
        filters: Dict[str, Any],
        latest: Dict[str, Any],
        aggregate: Dict[str, Any],
        state: Dict[str, Any],
    ) -> Optional[Dict[str, Any]]:
        if not rows:
            return None
        metric = self._status_chart_metric(rows, latest, aggregate, state)
        if not metric:
            return None
        row_key = str(metric.get("row_key") or "")
        series_rows = list(metric.get("series_rows") or [row for row in rows if row.get(row_key) is not None])
        x_values = self._status_chart_x_values(series_rows, filters)
        y_values = [float(row.get(row_key) or 0.0) for row in series_rows]
        if len(x_values) != len(y_values) or len(y_values) < 2:
            return None
        hover_text = [
            self._chart_hover_text(
                reel=row.get("reelId"),
                job=row.get("jobName"),
                time_value=row.get("productionStart") or row.get("date"),
                total_feet=row.get("feetTotal"),
                bad_feet_ft=row.get("estimatedBadFeet"),
                bad_feet_pct=row.get("estimatedBadFeetPct"),
                metric_key=metric.get("metric_key"),
                metric_label=metric.get("label"),
                metric_value=row.get(row_key),
            )
            for row in series_rows
        ]
        return self._attach_chart_scope_metadata({
            "type": "line",
            "title": f"{machine_label} {metric.get('label')}",
            "series": [
                {
                    "name": str(metric.get("label") or "Trend"),
                    "x": x_values,
                    "y": y_values,
                    "hoverText": hover_text,
                }
            ],
            "metadata": {
                "metricKey": metric.get("metric_key"),
                "metricLabel": metric.get("label"),
                "pointCount": len(y_values),
                "attachedAt": "evidence.chart",
                "selectionReason": metric.get("selection_reason"),
                "informativeScore": metric.get("informative_score"),
            },
        },
            total_points_in_scope=len(series_rows),
            displayed_points=len(series_rows),
            scope_description=self._chart_scope_description(filters=filters, rows=series_rows),
        )

    def _assemble_compare_response(
        self,
        tool_data: Dict[str, Any],
        filters: Dict[str, Any],
        intent: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        rows = tool_data.get("rows", [])
        if len(rows) < 2:
            return self._empty_result_response(
                filters,
                ["compare_presses"],
                "Comparison data was not available for both requested presses in the selected window.",
                data_semantics=tool_data.get("dataSemantics", "filtered-window"),
            )
        requested_ids = [self._to_int(value) for value in tool_data.get("requestedMachines") or tool_data.get("machineIds") or [] if self._to_int(value) is not None]
        requested_labels = (intent or {}).get("compareRequestedLabels") or tool_data.get("requestedMachineLabels") or [self._press_label(machine_id) for machine_id in requested_ids]
        row_map = {
            self._to_int(row.get("machineId")): row
            for row in rows
            if self._to_int(row.get("machineId")) is not None
        }
        if len(requested_ids) >= 2:
            left_id, right_id = requested_ids[:2]
            left_label, right_label = requested_labels[:2]
            left = dict(row_map.get(left_id) or {})
            right = dict(row_map.get(right_id) or {})
        else:
            left = dict(rows[0])
            right = dict(rows[1])
            left_id = self._to_int(left.get("machineId")) or 0
            right_id = self._to_int(right.get("machineId")) or 0
            left_label = self._press_label(left_id)
            right_label = self._press_label(right_id)
        left["machineName"] = left_label
        right["machineName"] = right_label
        ordered_rows = [left, right]
        better = min(ordered_rows, key=lambda row: (row.get("estimatedBadFeetPct") is None, row.get("estimatedBadFeetPct") or 9999))
        better_label = left_label if self._to_int(better.get("machineId")) == left_id else right_label
        categories_by_machine = tool_data.get("categoriesByMachine") or {}
        left_categories = categories_by_machine.get(left_id) or []
        right_categories = categories_by_machine.get(right_id) or []
        category_summary = self._category_comparison_summary(left_label, left_categories, right_label, right_categories)
        compare_category_key = str((intent or {}).get("compareCategoryKey") or "")
        compare_category_label = str((intent or {}).get("compareCategoryLabel") or "")
        compare_direction = str((intent or {}).get("compareDirection") or "better")
        category_result = self._category_compare_result(
            left_label,
            left_categories,
            right_label,
            right_categories,
            compare_category_key,
            compare_category_label,
            compare_direction,
        )
        chart = self._compare_micro_visual(
            left,
            right,
            compare_category_key,
            compare_category_label,
            category_result,
            scope_description=self._chart_scope_description(filters=filters, fallback="selected comparison window"),
        )
        if category_result:
            sections = [
                {"label": f"{compare_category_label} comparison", "text": category_result["comparisonText"]},
                {"label": "Overall comparison", "text": f"{left_label}: {self._comparison_summary(left)} | {right_label}: {self._comparison_summary(right)}"},
                {"label": "Category win summary", "text": category_summary["winText"]},
            ]
            scope_section = self._scope_section((intent or {}).get("analysisScope") or {}, [], filters)
            if scope_section:
                sections.insert(0, scope_section)
            production_section = self._compare_production_context_section(left_label, left, right_label, right)
            if production_section:
                sections.append(production_section)
            response = self._response(
                answer={
                    "title": category_result["title"],
                    "summary": category_result["summary"],
                    "sections": sections,
                },
                evidence_metrics=[
                    self._metric("Category", compare_category_label or "--"),
                    self._metric(f"{left_label} category rank", category_result["leftRank"]),
                    self._metric(f"{right_label} category rank", category_result["rightRank"]),
                    self._metric("Category result", category_result["winnerLabel"]),
                ],
                chart=chart,
                tools_used=[
                    {"tool": "compare_presses", "ok": True},
                    {"tool": "get_press_category_breakdown", "ok": True},
                ],
                suggested_prompts=self._contextual_follow_up_prompts(
                    response_kind="compare",
                    filters=filters,
                    machine_labels=[left_label, right_label],
                    metric_key=compare_category_key,
                    comparison_mode="press_vs_press",
                ),
                filters=filters,
                data_semantics="filtered-window",
            )
            return self._attach_analysis_summary(
                response,
                self._analysis_summary_payload(
                    family="compare",
                    lead=category_result["summary"],
                    key_context=[
                        self._analysis_key_context_item("Category", compare_category_label or "--"),
                        self._analysis_key_context_item(f"{left_label} rank", category_result["leftRank"]),
                        self._analysis_key_context_item(f"{right_label} rank", category_result["rightRank"]),
                        self._analysis_key_context_item("Category result", category_result["winnerLabel"]),
                    ],
                    primary_label="Category Comparison",
                    primary_cards=[
                        self._analysis_card(
                            title=left_label,
                            value=category_result["leftRank"],
                            condition="Category rank",
                            meta=[self._analysis_meta_item("Overall", self._comparison_summary(left))],
                        ),
                        self._analysis_card(
                            title=right_label,
                            value=category_result["rightRank"],
                            condition="Category rank",
                            meta=[self._analysis_meta_item("Overall", self._comparison_summary(right))],
                        ),
                    ],
                    supporting_label="Supporting Evidence",
                    supporting_cards=[
                        self._analysis_card(
                            title="Win summary",
                            value=category_result["winnerLabel"],
                            condition="Category result",
                            meta=[self._analysis_meta_item("Summary", category_summary["winText"])],
                            note=category_result["comparisonText"],
                        ),
                    ],
                ),
            )
        sections = [
            {"label": left_label, "text": self._comparison_summary(left)},
            {"label": right_label, "text": self._comparison_summary(right)},
            {"label": "Category ranking comparison", "text": category_summary["comparisonText"]},
            {"label": "Category win summary", "text": category_summary["winText"]},
        ]
        scope_section = self._scope_section((intent or {}).get("analysisScope") or {}, [], filters)
        if scope_section:
            sections.insert(0, scope_section)
        production_section = self._compare_production_context_section(left_label, left, right_label, right)
        if production_section:
            sections.append(production_section)
        response = self._response(
            answer={
                "title": f"{left_label} vs {right_label}: {better_label} is currently stronger on bad-feet rate.",
                "summary": f"{left_label} is at {self._format_pct(left.get('estimatedBadFeetPct'))} estimated bad feet versus {self._format_pct(right.get('estimatedBadFeetPct'))} for {right_label}.",
                "sections": sections,
            },
            evidence_metrics=[
                self._metric(f"{left_label} bad feet %", self._format_pct(left.get("estimatedBadFeetPct"))),
                self._metric(f"{right_label} bad feet %", self._format_pct(right.get("estimatedBadFeetPct"))),
                self._metric("Better press", better_label or "--"),
                self._metric("Category winner", category_summary["winnerLabel"]),
            ],
            chart=chart,
            tools_used=[
                {"tool": "compare_presses", "ok": True},
                {"tool": "get_press_category_breakdown", "ok": True},
            ],
            suggested_prompts=self._contextual_follow_up_prompts(
                response_kind="compare",
                filters=filters,
                machine_labels=[left_label, right_label],
                metric_key="rlm_bad_feet_pct",
                comparison_mode="press_vs_press",
            ),
            filters=filters,
            data_semantics="filtered-window",
        )
        return self._attach_analysis_summary(
            response,
            self._analysis_summary_payload(
                family="compare",
                lead=f"{better_label} has the stronger quality outcome in the active comparison window, mainly on bad-feet rate.",
                key_context=[
                    self._analysis_key_context_item("Current winner", better_label or "--"),
                    self._analysis_key_context_item(f"{left_label} Bad Feet %", self._format_pct(left.get("estimatedBadFeetPct"))),
                    self._analysis_key_context_item(f"{right_label} Bad Feet %", self._format_pct(right.get("estimatedBadFeetPct"))),
                    self._analysis_key_context_item("Category edge", category_summary.get("winnerLabel") or "--"),
                ],
                primary_label="Comparable Metrics",
                primary_cards=[
                    self._analysis_card(
                        title=left_label,
                        value=self._format_pct(left.get("estimatedBadFeetPct")),
                        condition="Current read",
                        meta=[
                            self._analysis_meta_item("Bad feet", self._format_feet_value(left.get("estimatedBadFeet"))),
                            self._analysis_meta_item("Monitoring", self._format_number(left.get("pointsPer1000Ft"))),
                            self._analysis_meta_item("Delta std", self._format_mm(left.get("deltaStd"))),
                        ],
                        tags=["Press comparison"],
                    ),
                    self._analysis_card(
                        title=right_label,
                        value=self._format_pct(right.get("estimatedBadFeetPct")),
                        condition="Current read",
                        meta=[
                            self._analysis_meta_item("Bad feet", self._format_feet_value(right.get("estimatedBadFeet"))),
                            self._analysis_meta_item("Monitoring", self._format_number(right.get("pointsPer1000Ft"))),
                            self._analysis_meta_item("Delta std", self._format_mm(right.get("deltaStd"))),
                        ],
                        tags=["Press comparison"],
                    ),
                ],
                supporting_label="Supporting Differences",
                supporting_cards=[
                    self._analysis_card(
                        title="Category win summary",
                        value=category_summary.get("winnerLabel") or "--",
                        condition="Supporting evidence",
                        meta=[self._analysis_meta_item("Summary", category_summary.get("winText") or "--")],
                        note=category_summary.get("comparisonText") or "",
                    ),
                ],
            ),
        )

    def _assemble_ranking_response(self, rankings: Dict[str, Any], breakdown: Dict[str, Any], filters: Dict[str, Any]) -> Dict[str, Any]:
        machine_id = self._to_int(rankings.get("machineId"))
        # Prefer the requested press label over any upstream machineName field to avoid entity drift in ranking copy.
        machine_label = self._press_label(machine_id) if machine_id is not None else "This press"
        press_row = rankings.get("pressRow")
        overview_row = rankings.get("overviewRow")
        if not press_row or not overview_row:
            # Missing ranking data should still produce a structured ranking response, not an unsupported response.
            return self._response(
                answer={
                    "title": f"Ranking data is not available for {machine_label} in the selected window.",
                    "summary": f"{machine_label} does not have enough ranking data in the current filter window.",
                    "sections": [{"label": "Scope", "text": SUPPORTED_SCOPE_MESSAGE}],
                },
                evidence_metrics=[self._metric("Result", "Empty")],
            chart=None,
            tools_used=[
                {"tool": "get_press_rankings", "ok": False},
                {"tool": "get_press_category_breakdown", "ok": False},
            ],
            suggested_prompts=self._contextual_follow_up_prompts(
                response_kind="status",
                filters={**filters, "machine_id": machine_id or filters.get("machine_id")},
                machine_label=machine_label,
            ),
            filters=filters,
            data_semantics="filtered-window",
        )
        categories = breakdown.get("categories", [])
        weakest = sorted(categories, key=lambda row: int(row.get("rank") or 999), reverse=True)[:2]
        driver_text = ", ".join(item.get("title") or "" for item in weakest) or "ranking pressure"
        sections = [
            {
                "label": "Ranking context",
                "text": f"{machine_label} is ranked #{overview_row.get('rank')} with an average category position of {overview_row.get('averageCategoryPosition')}.",
            },
            {
                "label": "Main drivers",
                "text": "; ".join(
                    f"{item.get('title')}: {item.get('valueDisplay')} ({item.get('contextLabel')})"
                    for item in weakest
                ) or "No category breakdown was available.",
            },
            {
                "label": f"{machine_label} category breakdown",
                "text": self._category_breakdown_text(categories, limit=6),
            },
        ]
        production_section = self._production_context_section(press_row)
        if production_section:
            sections.append(production_section)
        response = self._response(
            answer={
                "title": f"{machine_label} ranks low because {driver_text.lower()} are weak.",
                "summary": press_row.get("rankExplanation") or "The selected press is underperforming peers in the current RLM window.",
                "sections": sections,
            },
            evidence_metrics=[
                self._metric("Overall rank", f"#{overview_row.get('rank')}"),
                self._metric("Delta std dev", self._format_mm(press_row.get("deltaStd"))),
                self._metric("Pts / 1k ft", self._format_number(press_row.get("pointsPer1000Ft"))),
                self._metric("Bad feet %", self._format_pct(press_row.get("estimatedBadFeetPct"))),
            ],
            chart=None,
            tools_used=[
                {"tool": "get_press_rankings", "ok": True},
                {"tool": "get_press_category_breakdown", "ok": True},
            ],
            suggested_prompts=self._contextual_follow_up_prompts(
                response_kind="activity",
                filters={**filters, "machine_id": machine_id or filters.get("machine_id")},
                machine_label=machine_label,
                metric_key="rlm_bad_feet_pct",
            ),
            filters=filters,
            data_semantics="filtered-window",
        )
        return self._attach_analysis_summary(
            response,
            self._analysis_summary_payload(
                family="ranking",
                lead=press_row.get("rankExplanation") or f"{machine_label} is underperforming peers in the current window.",
                key_context=[
                    self._analysis_key_context_item("Overall rank", f"#{overview_row.get('rank')}"),
                    self._analysis_key_context_item("Bad feet %", self._format_pct(press_row.get("estimatedBadFeetPct"))),
                    self._analysis_key_context_item("Pts / 1k ft", self._format_number(press_row.get("pointsPer1000Ft"))),
                ],
                primary_label="Ranking Drivers",
                primary_cards=[
                    self._analysis_card(
                        title=str(item.get("title") or "--"),
                        value=item.get("valueDisplay") or "--",
                        condition="Driver",
                        meta=[self._analysis_meta_item("Context", item.get("contextLabel") or "--")],
                    )
                    for item in weakest
                ],
            ),
        )

    def _assemble_ranking_summary_response(self, intent: Dict[str, Any], filters: Dict[str, Any]) -> Dict[str, Any]:
        intelligence = self._get_press_intelligence(filters)
        category_key = intent.get("summaryCategoryKey")
        if category_key:
            return self._assemble_category_ranking_summary_response(intent, intelligence, filters)
        overview_rows = intelligence.get("overviewRankings", []) or []
        press_rows = intelligence.get("pressRankings", []) or []
        if not overview_rows or not press_rows:
            return self._empty_result_response(
                filters,
                ["get_press_rankings"],
                "Ranking data was not available for the selected window.",
                data_semantics="filtered-window",
            )

        press_map = {
            int(row.get("machineId") or 0): dict(row)
            for row in press_rows
            if self._to_int(row.get("machineId")) is not None
        }
        merged_rows = []
        for index, row in enumerate(overview_rows, start=1):
            machine_id = self._to_int(row.get("machineId"))
            if machine_id is None or machine_id not in press_map:
                continue
            merged = dict(press_map[machine_id])
            merged.update(row)
            merged["machineId"] = machine_id
            merged["machineName"] = self._press_label(machine_id)
            merged["rank"] = self._to_int(merged.get("rank")) or index
            merged_rows.append(merged)
        merged_rows.sort(key=lambda row: int(row.get("rank") or 999))
        if not merged_rows:
            return self._empty_result_response(
                filters,
                ["get_press_rankings"],
                "Ranking data was not available for the selected window.",
                data_semantics="filtered-window",
            )

        focus = intent.get("summary_focus") or "best"
        limit = max(1, int(intent.get("limit") or 1))
        if focus in {"worst", "bottom"}:
            selected = list(reversed(merged_rows))[:limit]
        else:
            selected = merged_rows[:limit]
        lead = selected[0]
        lead_breakdown = self.get_press_category_breakdown_tool(int(lead.get("machineId") or 0), filters)
        window_phrase = self._window_phrase(filters)
        descriptor = "strongest" if focus in {"best", "top"} else "weakest"
        count_label = None
        if focus == "top" and limit > 1:
            count_label = f"Top {limit}"
        elif focus == "bottom" and limit > 1:
            count_label = f"Bottom {limit}"
        if focus == "worst" and limit == 1:
            title = f"{lead.get('machineName')} is the weakest press {window_phrase}."
        elif focus == "top" and limit > 1:
            title = f"{count_label} presses {window_phrase} are led by {lead.get('machineName')}."
        elif focus == "bottom" and limit > 1:
            title = f"{count_label} presses {window_phrase} are anchored by {lead.get('machineName')}."
        else:
            title = f"{lead.get('machineName')} is the {descriptor} press {window_phrase}."
        summary = self._ranking_summary_text(selected, focus, window_phrase)
        sections = [
            {
                "label": "Ranking summary",
                "text": " | ".join(
                    f"#{row.get('rank')} {row.get('machineName')}: {self._format_pct(row.get('estimatedBadFeetPct'))} bad feet, {self._format_number(row.get('pointsPer1000Ft'))} pts/1k ft"
                    for row in selected
                ),
            },
            {
                "label": f"{lead.get('machineName')} category breakdown",
                "text": self._category_breakdown_text(lead_breakdown.get("categories") or []),
            },
        ]
        production_section = self._production_context_section(lead)
        if production_section:
            sections.append(production_section)
        evidence = [
            self._metric("Lead press", lead.get("machineName") or "--"),
            self._metric("Overall rank", f"#{lead.get('rank')}"),
            self._metric("Bad feet %", self._format_pct(lead.get("estimatedBadFeetPct"))),
            self._metric("Pts / 1k ft", self._format_number(lead.get("pointsPer1000Ft"))),
        ]
        chart = self._ranking_summary_visual(merged_rows, focus, filters)
        prompts = [
            f"Why is {lead.get('machineName')} the best {window_phrase}?" if focus != "worst" else f"Why is {lead.get('machineName')} the worst {window_phrase}?",
        ]
        if len(selected) > 1:
            prompts.append(f"Compare {selected[0].get('machineName')} vs {selected[-1].get('machineName')}")
        if selected:
            prompts.append(f"Show the bad feet trend for {lead.get('machineName')}")
        response = self._response(
            answer={"title": title, "summary": summary, "sections": sections},
            evidence_metrics=evidence,
            chart=chart,
            tools_used=[
                {"tool": "get_press_rankings", "ok": True},
                {"tool": "get_press_category_breakdown", "ok": True},
            ],
            suggested_prompts=prompts[:3],
            filters=filters,
            data_semantics="filtered-window",
        )
        return self._attach_analysis_summary(
            response,
            self._analysis_summary_payload(
                family="ranking_summary",
                lead=summary,
                key_context=[
                    self._analysis_key_context_item("Focus", focus.title()),
                    self._analysis_key_context_item("Lead press", lead.get("machineName") or "--"),
                    self._analysis_key_context_item("Lead rank", f"#{lead.get('rank')}"),
                    self._analysis_key_context_item("Window", window_phrase),
                ],
                primary_label="Ranking Snapshot",
                primary_cards=[
                    self._analysis_card(
                        title=str(row.get("machineName") or "--"),
                        value=self._format_pct(row.get("estimatedBadFeetPct")),
                        condition=f"Rank #{row.get('rank')}",
                        meta=[
                            self._analysis_meta_item("Pts / 1k ft", self._format_number(row.get("pointsPer1000Ft"))),
                            self._analysis_meta_item("Bad feet", self._format_feet_value(row.get("estimatedBadFeet"))),
                        ],
                        tags=["Ranking snapshot"],
                    )
                    for row in selected[:4]
                ],
                supporting_label="Lead Press Context",
                supporting_cards=[
                    self._analysis_card(
                        title=f"{lead.get('machineName')} breakdown",
                        value=self._format_pct(lead.get("estimatedBadFeetPct")),
                        condition="Lead press",
                        meta=[
                            self._analysis_meta_item("Pts / 1k ft", self._format_number(lead.get("pointsPer1000Ft"))),
                            self._analysis_meta_item("Bad feet", self._format_feet_value(lead.get("estimatedBadFeet"))),
                        ],
                        note=self._category_breakdown_text(lead_breakdown.get("categories") or []),
                    ),
                ],
            ),
        )

    def _assemble_category_ranking_summary_response(
        self,
        intent: Dict[str, Any],
        intelligence: Dict[str, Any],
        filters: Dict[str, Any],
    ) -> Dict[str, Any]:
        category_key = str(intent.get("summaryCategoryKey") or "")
        category_label = self._ranking_category_label(category_key)
        board = next(
            (row for row in intelligence.get("categoryLeaderboards", []) or [] if str(row.get("key") or "") == category_key),
            None,
        )
        if not board:
            return self._empty_result_response(
                filters,
                ["get_press_rankings"],
                f"{category_label} ranking data was not available for the selected window.",
                data_semantics="filtered-window",
            )
        items = []
        for index, item in enumerate(board.get("items", []) or [], start=1):
            machine_id = self._to_int(item.get("machineId"))
            if machine_id is None:
                continue
            normalized = dict(item)
            normalized["machineId"] = machine_id
            normalized["machineName"] = self._press_label(machine_id)
            normalized["rank"] = self._to_int(normalized.get("rank")) or index
            items.append(normalized)
        if not items:
            return self._empty_result_response(
                filters,
                ["get_press_rankings"],
                f"{category_label} ranking data was not available for the selected window.",
                data_semantics="filtered-window",
            )
        focus = intent.get("summary_focus") or "best"
        limit = max(1, int(intent.get("limit") or 1))
        selected = list(reversed(items))[:limit] if focus in {"worst", "bottom"} else items[:limit]
        lead = selected[0]
        window_phrase = self._window_phrase(filters)
        if focus == "best":
            title = f"Best press for {category_label} {window_phrase}: {lead.get('machineName')}."
        elif focus == "worst":
            title = f"Worst press for {category_label} {window_phrase}: {lead.get('machineName')}."
        elif focus == "top":
            title = f"Top {limit} presses for {category_label} {window_phrase} are led by {lead.get('machineName')}."
        else:
            title = f"Bottom {limit} presses for {category_label} {window_phrase} are anchored by {lead.get('machineName')}."
        summary = self._category_ranking_summary_text(selected, focus, category_label, window_phrase)
        sections = [
            {
                "label": f"{category_label} ranking",
                "text": " | ".join(
                    f"#{row.get('rank')} {row.get('machineName')}: {row.get('valueDisplay') or '--'}"
                    for row in selected
                ),
            },
            {
                "label": f"{lead.get('machineName')} category context",
                "text": self._category_breakdown_text(
                    self.get_press_category_breakdown_tool(int(lead.get("machineId") or 0), filters).get("categories") or []
                ),
            },
        ]
        production_section = self._production_context_section(lead)
        if production_section:
            sections.append(production_section)
        evidence = [
            self._metric("Category", category_label),
            self._metric("Lead press", lead.get("machineName") or "--"),
            self._metric("Category rank", f"#{lead.get('rank')}"),
            self._metric("Category value", lead.get("valueDisplay") or "--"),
        ]
        chart = self._category_ranking_visual(items, focus, category_label, filters)
        response = self._response(
            answer={"title": title, "summary": summary, "sections": sections},
            evidence_metrics=evidence,
            chart=chart,
            tools_used=[
                {"tool": "get_press_rankings", "ok": True},
                {"tool": "get_press_category_breakdown", "ok": True},
            ],
            suggested_prompts=self._contextual_follow_up_prompts(
                response_kind="activity",
                filters={**filters, "machine_id": int(lead.get("machineId") or 0) or filters.get("machine_id")},
                machine_label=lead.get("machineName"),
                metric_key=category_key,
            ),
            filters=filters,
            data_semantics="filtered-window",
        )
        return self._attach_analysis_summary(
            response,
            self._analysis_summary_payload(
                family="ranking_summary",
                lead=summary,
                key_context=[
                    self._analysis_key_context_item("Category", category_label),
                    self._analysis_key_context_item("Lead press", lead.get("machineName") or "--"),
                    self._analysis_key_context_item("Lead rank", f"#{lead.get('rank')}"),
                    self._analysis_key_context_item("Window", window_phrase),
                ],
                primary_label=f"{category_label} Snapshot",
                primary_cards=[
                    self._analysis_card(
                        title=str(row.get("machineName") or "--"),
                        value=row.get("valueDisplay") or "--",
                        condition=f"Rank #{row.get('rank')}",
                        tags=[category_label],
                    )
                    for row in selected[:4]
                ],
            ),
        )

    def _assemble_reel_summary_response(
        self,
        tool_data: Dict[str, Any],
        filters: Dict[str, Any],
        intent: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        reels = tool_data.get("reels", [])
        if not reels:
            return self._empty_result_response(
                filters,
                ["get_reel_to_reel_summary"],
                "No reel-to-reel data was found for that press in the selected filter window.",
                data_semantics="filtered-window",
            )
        scope = (intent or {}).get("analysisScope") or {}
        scoped_reels = self._scoped_reels(reels, scope, filters)
        if not scoped_reels:
            return self._empty_result_response(
                filters,
                ["get_reel_to_reel_summary"],
                "No reel-to-reel data matched the requested scope inside the selected window.",
                data_semantics="filtered-window",
            )
        recent = scoped_reels
        first_bad = recent[0].get("estimatedBadFeetPct") or 0
        last_bad = recent[-1].get("estimatedBadFeetPct") or 0
        title, summary = self._reel_question_first_text(tool_data.get("machineName") or "This press", "reel", recent)
        detail = (
            f"Recent filtered reels moved from {self._format_pct(first_bad)} bad feet on {recent[0].get('reelId')} "
            f"to {self._format_pct(last_bad)} on {recent[-1].get('reelId')}."
            if len(recent) >= 2
            else f"Only one qualified reel matched this scope: {recent[0].get('reelId')} at {self._format_pct(last_bad)} bad feet."
        )
        summary = f"{summary} {detail}".strip()
        chart = None
        if self._should_render_series_chart(recent):
            hover_text = [
                self._chart_hover_text(
                    reel=row.get("reelId"),
                    job=row.get("jobName"),
                    time_value=row.get("productionStart") or row.get("date"),
                    total_feet=row.get("feetTotal"),
                    bad_feet_ft=row.get("estimatedBadFeet"),
                    bad_feet_pct=row.get("estimatedBadFeetPct"),
                    metric_key="rlm_bad_feet_pct",
                    metric_label="Bad Feet %",
                    metric_value=row.get("estimatedBadFeetPct"),
                )
                for row in recent
            ]
            chart = self._attach_chart_scope_metadata({
                "type": "line",
                "title": f"{tool_data.get('machineName')} reel-to-reel bad feet %",
                "series": [
                    {
                        "name": "Bad Feet %",
                        "x": [row.get("reelId") for row in recent],
                        "y": [row.get("estimatedBadFeetPct") or 0 for row in recent],
                        "hoverText": hover_text,
                    }
                ],
            },
                total_points_in_scope=len(recent),
                displayed_points=len(recent),
                scope_description=self._chart_scope_description(filters=filters, scope=scope, rows=recent),
            )
        trend = self._trend_assessment("rlm_bad_feet_pct", [float(row.get("estimatedBadFeetPct") or 0.0) for row in recent]).get("direction") or "unclear"
        sections = [
            {
                "label": "Recent reels",
                "text": " | ".join(
                    f"{row.get('reelId')}: {self._format_pct(row.get('estimatedBadFeetPct'))} bad feet, {self._format_mm(row.get('deltaStd'))} delta std"
                    for row in recent
                ),
            }
        ]
        scope_section = self._scope_section(scope, recent, filters)
        if scope_section:
            sections.insert(0, scope_section)
        production_section = self._production_context_section(tool_data.get("summary") or {})
        if production_section:
            sections.append(production_section)
        response = self._response(
            answer={
                "title": title,
                "summary": summary,
                "sections": sections,
            },
            evidence_metrics=[
                self._metric("Trend", trend.title()),
                self._metric("Latest bad feet %", self._format_pct(recent[-1].get("estimatedBadFeetPct"))),
                self._metric("Latest delta std dev", self._format_mm(recent[-1].get("deltaStd"))),
            ],
            chart=chart,
            tools_used=[{"tool": "get_reel_to_reel_summary", "ok": True}],
            suggested_prompts=self._contextual_follow_up_prompts(
                response_kind="reel_summary",
                filters=filters,
                machine_label=tool_data.get("machineName"),
                metric_key="rlm_bad_feet_pct",
            ),
            filters=filters,
            data_semantics="filtered-window",
        )
        return self._attach_analysis_summary(
            response,
            self._analysis_summary_payload(
                family="reel_summary",
                lead=summary,
                key_context=[
                    self._analysis_key_context_item("Reels in scope", len(recent)),
                    self._analysis_key_context_item("Latest bad feet %", self._format_pct(recent[-1].get("estimatedBadFeetPct"))),
                    self._analysis_key_context_item("Trend", trend.title()),
                ],
                primary_label="Scoped Reels",
                primary_cards=[
                    self._analysis_card(
                        title=str(row.get("reelId") or "--"),
                        value=self._format_pct(row.get("estimatedBadFeetPct")),
                        condition="Reel read",
                        meta=[
                            self._analysis_meta_item("Delta std", self._format_mm(row.get("deltaStd"))),
                            self._analysis_meta_item("Feet", self._format_feet_value(row.get("feetTotal"))),
                        ],
                        trend_points=[float(item.get("estimatedBadFeetPct") or 0.0) for item in recent],
                        tags=["Reel summary"],
                    )
                    for row in recent[:4]
                ],
            ),
        )

    def _parse_display_number(self, value: Any) -> Optional[float]:
        if value in (None, ""):
            return None
        if isinstance(value, (int, float)):
            return float(value)
        match = re.search(r"-?\d+(?:\.\d+)?", str(value).replace(",", ""))
        if not match:
            return None
        try:
            return float(match.group(0))
        except ValueError:
            return None

    def _compare_micro_visual(
        self,
        left: Dict[str, Any],
        right: Dict[str, Any],
        category_key: str,
        category_label: str,
        category_result: Optional[Dict[str, Any]],
        scope_description: str,
    ) -> Optional[Dict[str, Any]]:
        left_label = str(left.get("machineName") or self._press_label(self._to_int(left.get("machineId")) or 0))
        right_label = str(right.get("machineName") or self._press_label(self._to_int(right.get("machineId")) or 0))
        if category_result and category_label:
            left_rank = self._parse_display_number(category_result.get("leftRank"))
            right_rank = self._parse_display_number(category_result.get("rightRank"))
            if left_rank is not None and right_rank is not None:
                return self._attach_chart_scope_metadata({
                    "type": "bar",
                    "title": f"{category_label} rank (lower is better)",
                    "series": [
                        {
                            "name": "Category rank",
                            "x": [left_label, right_label],
                            "y": [left_rank, right_rank],
                        }
                    ],
                    "metadata": {
                        "visualType": "compare-category-rank",
                        "categoryKey": category_key,
                        "categoryLabel": category_label,
                    },
                },
                    total_points_in_scope=2,
                    displayed_points=2,
                    scope_description=scope_description,
                )

        candidates = [
            ("estimatedBadFeetPct", "Bad Feet %"),
            ("deltaStd", "Delta Std Dev"),
            ("pointsPer1000Ft", "Monitoring Density"),
        ]
        scored: List[Tuple[float, str, str, float, float]] = []
        for row_key, label in candidates:
            left_value = self._parse_display_number(left.get(row_key))
            right_value = self._parse_display_number(right.get(row_key))
            if left_value is None or right_value is None:
                continue
            scale = max(abs(left_value), abs(right_value), 0.01)
            score = abs(left_value - right_value) / scale
            scored.append((score, row_key, label, left_value, right_value))
        if not scored:
            return None
        scored.sort(key=lambda item: item[0], reverse=True)
        _, row_key, label, left_value, right_value = scored[0]
        return self._attach_chart_scope_metadata({
            "type": "bar",
            "title": f"Largest gap: {label}",
            "series": [
                {
                    "name": label,
                    "x": [left_label, right_label],
                    "y": [left_value, right_value],
                }
            ],
            "metadata": {
                "visualType": "compare-largest-gap",
                "metricKey": row_key,
                "metricLabel": label,
            },
        },
            total_points_in_scope=2,
            displayed_points=2,
            scope_description=scope_description,
        )

    def _ranking_summary_visual(
        self,
        merged_rows: List[Dict[str, Any]],
        focus: str,
        filters: Dict[str, Any],
    ) -> Optional[Dict[str, Any]]:
        if not merged_rows:
            return None
        visual_rows = list(reversed(merged_rows)) if focus in {"worst", "bottom"} else list(merged_rows)
        if len(visual_rows) < 2:
            return None
        values = [self._parse_display_number(row.get("estimatedBadFeetPct")) for row in visual_rows]
        if sum(value is not None for value in values) < 2:
            return None
        return self._attach_chart_scope_metadata({
            "type": "bar",
            "title": "Bad Feet % ranking snapshot",
            "series": [
                {
                    "name": "Bad Feet %",
                    "x": [row.get("machineName") or self._press_label(self._to_int(row.get("machineId")) or 0) for row in visual_rows],
                    "y": [float(value or 0.0) for value in values],
                }
            ],
            "metadata": {
                "visualType": "ranking-bad-feet",
                "focus": focus,
            },
        },
            total_points_in_scope=len(merged_rows),
            displayed_points=len(visual_rows),
            scope_description=self._chart_scope_description(filters=filters),
        )

    def _category_ranking_visual(
        self,
        items: List[Dict[str, Any]],
        focus: str,
        category_label: str,
        filters: Dict[str, Any],
    ) -> Optional[Dict[str, Any]]:
        if not items:
            return None
        visual_rows = list(reversed(items)) if focus in {"worst", "bottom"} else list(items)
        if len(visual_rows) < 2:
            return None
        parsed_values = [self._parse_display_number(row.get("value")) for row in visual_rows]
        has_value_series = sum(value is not None for value in parsed_values) >= 2
        if has_value_series:
            title = f"{category_label} snapshot"
            series = [
                {
                    "name": category_label,
                    "x": [row.get("machineName") or self._press_label(self._to_int(row.get("machineId")) or 0) for row in visual_rows],
                    "y": [float(value or 0.0) for value in parsed_values],
                }
            ]
            metadata = {"visualType": "ranking-category-value", "categoryLabel": category_label, "focus": focus}
        else:
            ranks = [self._parse_display_number(row.get("rank")) for row in visual_rows]
            if sum(value is not None for value in ranks) < 2:
                return None
            title = f"{category_label} rank (lower is better)"
            series = [
                {
                    "name": "Category rank",
                    "x": [row.get("machineName") or self._press_label(self._to_int(row.get("machineId")) or 0) for row in visual_rows],
                    "y": [float(value or 0.0) for value in ranks],
                }
            ]
            metadata = {"visualType": "ranking-category-rank", "categoryLabel": category_label, "focus": focus}
        return self._attach_chart_scope_metadata({
            "type": "bar",
            "title": title,
            "series": series,
            "metadata": metadata,
        },
            total_points_in_scope=len(items),
            displayed_points=len(visual_rows),
            scope_description=self._chart_scope_description(filters=filters),
        )

    def _assemble_trend_response(
        self,
        tool_data: Dict[str, Any],
        filters: Dict[str, Any],
        intent: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        scope = (intent or {}).get("analysisScope") or {}
        machine_id = self._to_int(tool_data.get("machineId"))
        metric_key = str(tool_data.get("metricKey") or "")
        series = self._scoped_trend_series(tool_data.get("series", []), machine_id, metric_key, scope, filters)
        if not series:
            return self._empty_result_response(
                filters,
                ["get_press_metric_trend"],
                "No trend data was available for the selected press and metric.",
                data_semantics="filtered-window",
            )
        chart = None
        if self._should_render_series_chart(series):
            hover_text = [
                self._chart_hover_text(
                    reel=row.get("reelId"),
                    job=row.get("jobName"),
                    time_value=row.get("productionStart") or row.get("date"),
                    total_feet=row.get("feetTotal"),
                    bad_feet_ft=row.get("estimatedBadFeet"),
                    bad_feet_pct=row.get("estimatedBadFeetPct"),
                    metric_key=metric_key,
                    metric_label=tool_data.get("metricLabel"),
                    metric_value=row.get("value"),
                )
                for row in series
            ]
            chart = self._attach_chart_scope_metadata({
                "type": "line",
                "title": f"{tool_data.get('machineName')} {tool_data.get('metricLabel')}",
                "series": [
                    {
                        "name": tool_data.get("metricLabel"),
                        "x": [row.get("date") for row in series],
                        "y": [row.get("value") for row in series],
                        "hoverText": hover_text,
                    }
                ],
            },
                total_points_in_scope=len(series),
                displayed_points=len(series),
                scope_description=self._chart_scope_description(filters=filters, scope=scope, rows=series),
            )
        summary = tool_data.get("summary") or {}
        latest = series[-1]
        trend_context = self._press_row_for_machine(machine_id, filters) if machine_id is not None else None
        title, direct_summary = self._trend_question_first_text(
            tool_data.get("machineName") or "This press",
            tool_data.get("metricLabel") or self._phase2a_metric_label(metric_key),
            metric_key,
            series,
        )
        detail = summary.get("detail") or summary.get("headline") or ""
        if detail and detail.strip().lower() not in direct_summary.lower():
            direct_summary = f"{direct_summary} {detail}".strip()
        sections = [
            {"label": "Latest point", "text": f"{latest.get('date')}: {latest.get('valueDisplay') or latest.get('value')}"},
        ]
        scope_section = self._scope_section(scope, series, filters)
        if scope_section:
            sections.insert(0, scope_section)
        production_section = self._production_context_section(trend_context or {})
        if production_section:
            sections.append(production_section)
        trend_direction = str(self._trend_assessment(metric_key, [float(row.get("value") or 0.0) for row in series]).get("direction") or "--").title()
        response = self._response(
            answer={
                "title": title,
                "summary": direct_summary,
                "sections": sections,
            },
            evidence_metrics=[
                self._metric("Metric", tool_data.get("metricLabel") or "--"),
                self._metric("Latest value", latest.get("valueDisplay") or str(latest.get("value"))),
                self._metric("Points", str(len(series))),
                self._metric("Trend", trend_direction),
            ],
            chart=chart,
            tools_used=[{"tool": "get_press_metric_trend", "ok": True}],
            suggested_prompts=self._contextual_follow_up_prompts(
                response_kind="trend",
                filters=filters,
                machine_label=tool_data.get("machineName"),
                metric_key=metric_key,
            ),
            filters=filters,
            data_semantics="filtered-window",
        )
        movement = "--"
        if len(series) >= 2:
            movement = f"{series[0].get('valueDisplay') or series[0].get('value')} -> {latest.get('valueDisplay') or latest.get('value')}"
        return self._attach_analysis_summary(
            response,
            self._analysis_summary_payload(
                family="trend",
                lead=direct_summary,
                key_context=[
                    self._analysis_key_context_item("Metric", tool_data.get("metricLabel") or "--"),
                    self._analysis_key_context_item("Latest value", latest.get("valueDisplay") or str(latest.get("value"))),
                    self._analysis_key_context_item("Trend", trend_direction),
                    self._analysis_key_context_item("Points", len(series)),
                ],
                primary_label="Trend Read",
                primary_cards=[
                    self._analysis_card(
                        title=str(tool_data.get("metricLabel") or "--"),
                        value=latest.get("valueDisplay") or str(latest.get("value")),
                        condition="Latest point",
                        trend=str(trend_direction).lower(),
                        meta=[
                            self._analysis_meta_item("Movement", movement),
                            self._analysis_meta_item("Latest date", latest.get("date") or "--"),
                        ],
                        trend_points=[float(row.get("value") or 0.0) for row in series],
                        note=summary.get("detail") or summary.get("headline") or "",
                    )
                ],
            ),
        )

    def _assemble_phase2a_metric_response(
        self,
        tool_data: Dict[str, Any],
        filters: Dict[str, Any],
        intent: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        metric = tool_data.get("metricResult") or {}
        metric_key = str(tool_data.get("metricKey") or "")
        metric_label = str(tool_data.get("metricLabel") or self._phase2a_metric_label(metric_key))
        comparison = tool_data.get("comparison") or {}
        trend = tool_data.get("trend") or {}
        drivers = tool_data.get("drivers") or {}
        run_position = tool_data.get("runPosition") or {}
        concentration = tool_data.get("concentration") or {}
        alignment = tool_data.get("alignment") or {}
        episodes = tool_data.get("episodes") or {}
        scope = (intent or {}).get("analysisScope") or {}
        grouping = str((intent or {}).get("grouping") or "")
        trend_requested = bool((intent or {}).get("trendRequested"))
        metric_family = self._metric_family(metric_key)
        decision_summary = self._decision_summary_text(metric_key, comparison, concentration, run_position, episodes, alignment)
        pattern_summary = self._metric_pattern_summary(metric_key, concentration, run_position, episodes)
        signal_relationship = self._signal_relationship_summary(metric_key, alignment)
        sections = []
        scope_section = self._scope_section(scope, tool_data.get("rows") or [], filters)
        if scope_section:
            sections.append(scope_section)
        sections.append({"label": "Metric definition", "text": metric.get("denominatorBasis") or "--"})
        if metric.get("notes"):
            sections.append({"label": "Qualification notes", "text": " | ".join(metric.get("notes") or [])})
        if grouping == "decision" and decision_summary:
            sections.append({"label": "Decision summary", "text": decision_summary})
        if comparison:
            sections.append(
                {
                    "label": "Comparison summary",
                    "text": comparison.get("comparisonSummary")
                    or (
                        f"Primary press: {tool_data.get('machineName')} {metric.get('valueDisplay') or '--'} | "
                        f"Comparison: {comparison.get('peerValueDisplay') or '--'} | "
                        f"Peer count: {comparison.get('peerCount') or 0}"
                    ),
                }
            )
            if comparison.get("mainDrivers"):
                sections.append({"label": "Main drivers", "text": " | ".join(comparison.get("mainDrivers") or [])})
            fairness = comparison.get("fairness") or {}
            if fairness:
                sections.append({"label": "Comparison confidence", "text": fairness.get("summary") or "--"})
                if fairness.get("notes"):
                    sections.append({"label": "Fairness notes", "text": " | ".join(fairness.get("notes") or [])})
        if trend:
            sections.append(
                {
                    "label": "Trend basis",
                    "text": (
                        f"Direction: {trend.get('direction', 'stable').title()} | "
                        f"Basis: {trend.get('basis') or '--'} | "
                        f"Earlier: {trend.get('firstValue') or '--'} | "
                        f"Later: {trend.get('secondValue') or '--'}"
                    ),
                }
            )
        if run_position:
            sections.append({"label": "Run-position pattern", "text": run_position.get("summary") or "--"})
        if concentration:
            sections.append({"label": "Concentration pattern", "text": concentration.get("summary") or "--"})
        if pattern_summary and grouping in {"decision", "concentration", "run_position", "episodes"}:
            sections.append({"label": "Pattern summary", "text": pattern_summary})
        if drivers.get("topReels"):
            sections.append(
                {
                    "label": "Driver reels",
                    "text": " | ".join(
                        f"{item.get('reelId')}: {item.get('valueDisplay')} ({item.get('sharePct')}%)"
                        for item in drivers.get("topReels") or []
                    ),
                }
            )
        if drivers.get("topJobs"):
            sections.append(
                {
                    "label": "Driver jobs",
                    "text": " | ".join(
                        f"{item.get('jobName')}: {item.get('valueDisplay')} ({item.get('sharePct')}%)"
                        for item in drivers.get("topJobs") or []
                    ),
                }
            )
        if alignment and (grouping == "alignment" or metric_key in {"delta_variation", "delta_drift", "speed_instability", "tolerance_changes"}):
            sections.append({"label": "Signal alignment", "text": alignment.get("summary") or "--"})
        if signal_relationship and grouping in {"decision", "alignment"}:
            sections.append({"label": "Causation note", "text": signal_relationship})
        if episodes.get("summary"):
            sections.append({"label": "Deviation episode summary", "text": episodes.get("summary")})
        if episodes.get("episodes"):
            sections.append(
                {
                    "label": "Deviation episodes",
                    "text": " | ".join(
                        (
                            f"Episode {item.get('episodeIndex')}: {item.get('startPositionBucket')} "
                            f"{item.get('startReel')} to {item.get('endReel')} | "
                            f"{item.get('reelCount')} reels | avg {item.get('averageDeviationDisplay')} | "
                            f"peak {item.get('peakDeviationDisplay')} | feet {item.get('estimatedFeetDisplay')} | "
                            f"recovery after: {'yes' if item.get('recoveryAfter') else 'no'}"
                        )
                        for item in episodes.get("episodes") or []
                    ),
                }
            )
        title = f"{tool_data.get('machineName')} {metric_label}"
        comparison_title = None
        comparison_summary = None
        if comparison:
            comparison_title, comparison_summary = self._comparison_question_first_text(
                tool_data.get("machineName") or "This press",
                metric_key,
                metric_label,
                comparison,
            )
            title = comparison_title
        summary_parts: List[str] = []
        if grouping == "decision" and decision_summary:
            summary_parts.append(decision_summary)
            if comparison_summary:
                summary_parts.append(comparison_summary)
        elif comparison and comparison_summary:
            summary_parts.append(comparison_summary)
        elif trend_requested and trend:
            summary_parts.append(
                self._metric_trend_question_first_summary(
                    tool_data.get("machineName") or "This press",
                    metric_key,
                    metric_label,
                    trend,
                )
            )
        else:
            summary_parts.append(f"{tool_data.get('machineName')} {metric_label.lower()} is {metric.get('valueDisplay') or '--'}.")
        if comparison and grouping == "decision" and comparison.get("comparisonSummary") and not comparison_summary:
            summary_parts.append(comparison.get("comparisonSummary"))
        if trend and not trend_requested:
            summary_parts.append(f"Trend is {str(trend.get('direction') or 'stable').lower()}.")
        if pattern_summary:
            summary_parts.append(pattern_summary)
        elif concentration and concentration.get("pattern") and metric_family == "process":
            summary_parts.append(f"Pattern looks {concentration.get('pattern')}.")
        if (
            episodes.get("summary")
            and metric_key in {"delta_variation", "delta_drift"}
            and episodes.get("summary") not in " ".join(summary_parts)
        ):
            summary_parts.append(episodes.get("summary"))
        summary = " ".join(part.strip() for part in summary_parts if str(part or "").strip())
        response = self._response(
            answer={
                "title": title,
                "summary": summary,
                "sections": sections,
            },
            evidence_metrics=[
                self._metric("Metric", metric_label),
                self._metric("Value", metric.get("valueDisplay") or "--"),
                self._metric("Denominator", metric.get("denominatorBasis") or "--"),
                self._metric("Comparison mode", comparison.get("mode") if comparison else "--"),
                self._metric("Peer count", str(comparison.get("peerCount") or 0) if comparison else "--"),
                self._metric("Comparison confidence", ((comparison.get("fairness") or {}).get("confidence") if comparison else None) or "--"),
                self._metric("Trend", str(trend.get("direction") or "--").title()),
                self._metric("Run-position pattern", run_position.get("pattern") or "--"),
                self._metric("Concentration pattern", concentration.get("pattern") or "--"),
            ],
            chart=None,
            tools_used=[{"tool": "get_rlm_metric_analysis", "ok": True}],
            suggested_prompts=self._contextual_follow_up_prompts(
                response_kind="activity",
                filters={**filters, "machine_id": tool_data.get("machineId") or filters.get("machine_id")},
                machine_label=tool_data.get("machineName"),
                metric_key=metric_key,
                comparison_mode=(comparison or {}).get("mode") or (intent or {}).get("comparisonMode") or "none",
                selected_job=str(filters.get("job") or "").strip() or None,
                current_focus=grouping,
            ),
            filters={**filters, "machine_id": tool_data.get("machineId") or filters.get("machine_id")},
            data_semantics="filtered-window",
        )
        response.setdefault("context", {})["metricAnalysis"] = {
            "metricKey": metric_key,
            "metricLabel": metric_label,
            "denominatorBasis": metric.get("denominatorBasis"),
            "comparisonMode": (comparison or {}).get("mode") or (intent or {}).get("comparisonMode") or "none",
            "comparisonPeerCount": comparison.get("peerCount") if comparison else 0,
            "trendDirection": trend.get("direction"),
            "trendBasis": trend.get("basis"),
            "runPositionPattern": run_position.get("pattern"),
            "concentrationPattern": concentration.get("pattern"),
            "driverReels": drivers.get("topReels") or [],
            "driverJobs": drivers.get("topJobs") or [],
            "comparisonConfidence": ((comparison.get("fairness") or {}).get("confidence") if comparison else None),
            "fairnessNotes": ((comparison.get("fairness") or {}).get("notes") if comparison else []),
            "deviationEpisodes": episodes.get("episodes") or [],
            "selectedJob": str(filters.get("job") or "").strip() or None,
            "explanationSummary": decision_summary or comparison.get("comparisonSummary") or pattern_summary or concentration.get("summary") or run_position.get("summary"),
        }
        return self._attach_analysis_summary(
            response,
            self._analysis_summary_payload(
                family="activity",
                lead=summary,
                key_context=[
                    self._analysis_key_context_item("Metric", metric_label),
                    self._analysis_key_context_item("Current value", metric.get("valueDisplay") or "--"),
                    self._analysis_key_context_item("Trend", str(trend.get("direction") or "--").title()),
                    self._analysis_key_context_item("Comparison", (comparison or {}).get("mode") or (intent or {}).get("comparisonMode") or "none"),
                ],
                primary_label="Primary Findings",
                primary_cards=[
                    self._analysis_card(
                        title=metric_label,
                        value=metric.get("valueDisplay") or "--",
                        condition="Current read",
                        trend=str(trend.get("direction") or ""),
                        meta=[
                            self._analysis_meta_item("Denominator", metric.get("denominatorBasis") or "--"),
                            self._analysis_meta_item("Peer count", str(comparison.get("peerCount") or 0) if comparison else "--"),
                            self._analysis_meta_item("Confidence", ((comparison.get("fairness") or {}).get("confidence") if comparison else None) or "--"),
                        ],
                        trend_points=self._status_category_trend_points(metric_key, tool_data.get("rows") or []),
                        tags=[tag for tag in [run_position.get("pattern"), concentration.get("pattern")] if tag],
                        note=decision_summary or comparison.get("comparisonSummary") or pattern_summary or concentration.get("summary") or run_position.get("summary") or "",
                    ),
                    self._analysis_card(
                        title="Comparison",
                        value=comparison.get("peerValueDisplay") or comparison.get("comparisonSummary") or "--",
                        condition=(comparison or {}).get("mode") or "None",
                        meta=[
                            self._analysis_meta_item("Peer count", str(comparison.get("peerCount") or 0) if comparison else "--"),
                            self._analysis_meta_item("Confidence", ((comparison.get("fairness") or {}).get("confidence") if comparison else None) or "--"),
                        ],
                        note=comparison.get("comparisonSummary") or "",
                    ) if comparison else {},
                ],
                supporting_label="Supporting Factors",
                supporting_cards=[
                    self._analysis_card(
                        title="Driver reels",
                        value=f"{len(drivers.get('topReels') or [])} reels",
                        condition="Drivers",
                        meta=[
                            self._analysis_meta_item(item.get("reelId"), f"{item.get('valueDisplay')} ({item.get('sharePct')}%)")
                            for item in (drivers.get("topReels") or [])[:3]
                        ],
                    ) if drivers.get("topReels") else {},
                    self._analysis_card(
                        title="Driver jobs",
                        value=f"{len(drivers.get('topJobs') or [])} jobs",
                        condition="Drivers",
                        meta=[
                            self._analysis_meta_item(item.get("jobName"), f"{item.get('valueDisplay')} ({item.get('sharePct')}%)")
                            for item in (drivers.get("topJobs") or [])[:3]
                        ],
                    ) if drivers.get("topJobs") else {},
                ],
            ),
        )

    def _assemble_discovery_response(
        self,
        discovery: Dict[str, Any],
        filters: Dict[str, Any],
        intent: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        metric = discovery.get("metricResult") or {}
        comparison = discovery.get("comparison") or {}
        trend = discovery.get("trend") or {}
        drivers = discovery.get("drivers") or {}
        run_position = discovery.get("runPosition") or {}
        concentration = discovery.get("concentration") or {}
        alignment = discovery.get("alignment") or {}
        episodes = discovery.get("episodes") or {}
        baseline_comparison = discovery.get("baselineComparison") or {}
        change_point = discovery.get("changePoint") or {}
        shape = discovery.get("shape") or {}
        synthesis = discovery.get("synthesis") or {}
        scope = (intent or {}).get("analysisScope") or {}

        sections: List[Dict[str, str]] = []
        scope_section = self._scope_section(scope, discovery.get("rows") or [], filters)
        if scope_section:
            sections.append(scope_section)
        if synthesis.get("findings"):
            sections.append({"label": "Findings", "text": " | ".join(synthesis.get("findings") or [])})
        if synthesis.get("drivers"):
            sections.append({"label": "Drivers", "text": " | ".join(synthesis.get("drivers") or [])})
        if synthesis.get("comparison"):
            sections.append({"label": "Comparison", "text": str(synthesis.get("comparison"))})
        if baseline_comparison.get("summary"):
            sections.append({"label": "Previous-window comparison", "text": str(baseline_comparison.get("summary"))})
        if synthesis.get("confidence"):
            sections.append({"label": "Confidence", "text": str(synthesis.get("confidence"))})
        if change_point.get("summary"):
            sections.append({"label": "Change point", "text": str(change_point.get("summary"))})
        if shape.get("summary"):
            sections.append({"label": "Issue shape", "text": str(shape.get("summary"))})
        if run_position and run_position.get("summary"):
            sections.append({"label": "Run-position pattern", "text": run_position.get("summary") or "--"})
        if concentration and concentration.get("summary"):
            sections.append({"label": "Concentration pattern", "text": concentration.get("summary") or "--"})
        if drivers.get("topReels"):
            sections.append(
                {
                    "label": "Driver reels",
                    "text": " | ".join(
                        f"{item.get('reelId')}: {item.get('valueDisplay')} ({item.get('sharePct')}%)"
                        for item in drivers.get("topReels") or []
                    ),
                }
            )
        if drivers.get("topJobs"):
            sections.append(
                {
                    "label": "Driver jobs",
                    "text": " | ".join(
                        f"{item.get('jobName')}: {item.get('valueDisplay')} ({item.get('sharePct')}%)"
                        for item in drivers.get("topJobs") or []
                    ),
                }
            )
        if episodes.get("summary"):
            sections.append({"label": "Deviation episode summary", "text": episodes.get("summary")})
        if alignment and alignment.get("summary"):
            sections.append({"label": "Signal alignment", "text": alignment.get("summary")})
        if synthesis.get("next_checks"):
            sections.append({"label": "Next checks", "text": " | ".join(synthesis.get("next_checks") or [])})

        chart = self._discovery_chart(
            metric_key=str(discovery.get("metricKey") or ""),
            metric_label=str(discovery.get("metricLabel") or ""),
            rows=discovery.get("rows") or [],
            filters=filters,
            scope=scope,
            grouping=str((intent or {}).get("grouping") or "decision"),
            baseline_comparison=baseline_comparison,
            change_point=change_point,
            shape=shape,
            synthesis=synthesis,
        )
        answer_title = str(synthesis.get("direct_answer") or f"{discovery.get('machineName') or 'This press'} discovery analysis")
        answer_summary_parts = []
        if metric.get("valueDisplay"):
            answer_summary_parts.append(
                f"{discovery.get('machineName') or 'This press'} is currently at {metric.get('valueDisplay')} for {str(discovery.get('metricLabel') or '').lower()}."
            )
        if baseline_comparison.get("summary"):
            answer_summary_parts.append(str(baseline_comparison.get("summary")))
        if synthesis.get("comparison"):
            answer_summary_parts.append(str(synthesis.get("comparison")))
        if trend and trend.get("direction"):
            answer_summary_parts.append(f"Trend signal: {str(trend.get('direction')).lower()}.")
        answer_summary = " ".join(part for part in answer_summary_parts if part).strip()

        response = self._response(
            answer={
                "title": answer_title,
                "summary": answer_summary,
                "sections": sections,
            },
            evidence_metrics=[
                self._metric("Metric", discovery.get("metricLabel") or "--"),
                self._metric("Value", metric.get("valueDisplay") or "--"),
                self._metric("Trend", str(trend.get("direction") or "--").title()),
                self._metric("Comparison mode", comparison.get("mode") or "none"),
                self._metric("Comparison confidence", ((comparison.get("fairness") or {}).get("confidence")) or str(synthesis.get("confidence") or "--")),
                self._metric("Baseline", baseline_comparison.get("baselineLabel") or "--"),
                self._metric("Baseline outcome", baseline_comparison.get("outcome") or "--"),
                self._metric("Change point", change_point.get("candidate") or "--"),
                self._metric("Issue shape", shape.get("label") or discovery.get("sustainedVsSpike") or "--"),
            ],
            chart=chart,
            tools_used=[
                {"tool": "run_discovery_analysis", "ok": True},
                {"tool": "get_rlm_metric_analysis", "ok": True},
            ],
            suggested_prompts=self._contextual_follow_up_prompts(
                response_kind="discovery",
                filters={**filters, "machine_id": discovery.get("machineId") or filters.get("machine_id")},
                machine_label=discovery.get("machineName"),
                metric_key=discovery.get("metricKey"),
                comparison_mode=(comparison or {}).get("mode") or (intent or {}).get("comparisonMode") or "none",
                selected_job=str(filters.get("job") or "").strip() or None,
                current_focus=str((intent or {}).get("grouping") or "decision"),
                baseline_available=bool(baseline_comparison.get("available")),
                shift_detected=bool(change_point.get("available")),
                issue_shape=str(shape.get("label") or ""),
            ),
            filters={**filters, "machine_id": discovery.get("machineId") or filters.get("machine_id")},
            data_semantics="filtered-window",
        )
        response.setdefault("context", {})["metricAnalysis"] = {
            "metricKey": discovery.get("metricKey"),
            "metricLabel": discovery.get("metricLabel"),
            "denominatorBasis": metric.get("denominatorBasis"),
            "comparisonMode": (comparison or {}).get("mode") or (intent or {}).get("comparisonMode") or "none",
            "comparisonPeerCount": comparison.get("peerCount") if comparison else 0,
            "baselineComparison": baseline_comparison,
            "baselineSummary": baseline_comparison.get("summary"),
            "trendDirection": trend.get("direction"),
            "trendBasis": trend.get("basis"),
            "runPositionPattern": run_position.get("pattern"),
            "concentrationPattern": concentration.get("pattern"),
            "sustainedVsSpike": discovery.get("sustainedVsSpike"),
            "changePoint": change_point,
            "driverReels": drivers.get("topReels") or [],
            "driverJobs": drivers.get("topJobs") or [],
            "issueShape": shape,
            "comparisonConfidence": ((comparison.get("fairness") or {}).get("confidence") if comparison else None),
            "fairnessNotes": ((comparison.get("fairness") or {}).get("notes") if comparison else []),
            "deviationEpisodes": episodes.get("episodes") or [],
            "selectedJob": str(filters.get("job") or "").strip() or None,
            "explanationSummary": synthesis.get("direct_answer") or synthesis.get("comparison") or answer_summary,
        }
        response.setdefault("context", {})["discovery"] = {
            **synthesis,
            "baseline_comparison": baseline_comparison,
            "baseline_summary": baseline_comparison.get("summary"),
            "change_point": change_point,
            "sustained_vs_spike": discovery.get("sustainedVsSpike"),
            "issue_shape": shape,
        }
        return self._attach_analysis_summary(
            response,
            self._analysis_summary_payload(
                family="discovery",
                lead=answer_summary or str(synthesis.get("direct_answer") or ""),
                key_context=[
                    self._analysis_key_context_item("Metric", discovery.get("metricLabel") or "--"),
                    self._analysis_key_context_item("Current value", metric.get("valueDisplay") or "--"),
                    self._analysis_key_context_item("Trend", str(trend.get("direction") or "--").title()),
                    self._analysis_key_context_item("Issue shape", shape.get("label") or discovery.get("sustainedVsSpike") or "--"),
                ],
                primary_label="Primary Findings",
                primary_cards=[
                    self._analysis_card(
                        title="Scoped read",
                        value=metric.get("valueDisplay") or "--",
                        condition="Current",
                        trend=str(trend.get("direction") or ""),
                        meta=[
                            self._analysis_meta_item("Baseline", baseline_comparison.get("baselineLabel") or "--"),
                            self._analysis_meta_item("Baseline outcome", baseline_comparison.get("outcome") or "--"),
                            self._analysis_meta_item("Change point", change_point.get("candidate") or "--"),
                        ],
                        tags=[tag for tag in [shape.get("label"), concentration.get("pattern"), run_position.get("pattern")] if tag],
                        note=synthesis.get("comparison") or baseline_comparison.get("summary") or shape.get("summary") or "",
                    )
                ],
                supporting_label="Supporting Factors",
                supporting_cards=[
                    self._analysis_card(
                        title="Driver reels",
                        value=f"{len(drivers.get('topReels') or [])} reels",
                        condition="Drivers",
                        meta=[
                            self._analysis_meta_item(item.get("reelId"), f"{item.get('valueDisplay')} ({item.get('sharePct')}%)")
                            for item in (drivers.get("topReels") or [])[:3]
                        ],
                    ) if drivers.get("topReels") else {},
                    self._analysis_card(
                        title="Driver jobs",
                        value=f"{len(drivers.get('topJobs') or [])} jobs",
                        condition="Drivers",
                        meta=[
                            self._analysis_meta_item(item.get("jobName"), f"{item.get('valueDisplay')} ({item.get('sharePct')}%)")
                            for item in (drivers.get("topJobs") or [])[:3]
                        ],
                    ) if drivers.get("topJobs") else {},
                ],
                next_checks=synthesis.get("next_checks") or [],
            ),
        )

    def _assemble_job_list_response(
        self,
        tool_data: Dict[str, Any],
        filters: Dict[str, Any],
        intent: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        del intent
        jobs = tool_data.get("jobs") or []
        machine_name = tool_data.get("machineName") or "Press"
        job_lines = []
        for item in jobs:
            start = self._format_scope_datetime(item["start"]) if item.get("start") else "--"
            end = self._format_scope_datetime(item["end"]) if item.get("end") else "--"
            job_lines.append(
                f"{item.get('jobName')}: {int(item.get('reelCount') or 0)} reels | {self._format_feet_value(item.get('feetTotal'))} | {start} to {end}"
            )
        response = self._response(
            answer={
                "title": f"Jobs run on {machine_name}",
                "summary": f"{machine_name} ran {len(jobs)} jobs in the selected scope.",
                "sections": [
                    {"label": "Available jobs", "text": " | ".join(job_lines) if job_lines else "No jobs were found in the selected scope."},
                ],
            },
            evidence_metrics=[
                self._metric("Job count", len(jobs)),
                self._metric("Selected job", tool_data.get("selectedJob") or "--"),
            ],
            chart=None,
            tools_used=[{"tool": "get_press_job_list", "ok": True}],
            suggested_prompts=self._contextual_follow_up_prompts(
                response_kind="job_list",
                filters={**filters, "machine_id": tool_data.get("machineId") or filters.get("machine_id")},
                machine_label=machine_name,
                selected_job=tool_data.get("selectedJob"),
                available_jobs=jobs,
            ),
            filters={**filters, "machine_id": tool_data.get("machineId") or filters.get("machine_id")},
            data_semantics="filtered-window",
        )
        response.setdefault("context", {})["availableJobs"] = jobs
        response.setdefault("context", {})["selectedJob"] = tool_data.get("selectedJob")
        return self._attach_analysis_summary(
            response,
            self._analysis_summary_payload(
                family="job_list",
                lead=f"{machine_name} ran {len(jobs)} jobs in the selected scope.",
                key_context=[
                    self._analysis_key_context_item("Press", machine_name),
                    self._analysis_key_context_item("Job count", len(jobs)),
                    self._analysis_key_context_item("Selected job", tool_data.get("selectedJob") or "--"),
                ],
                primary_label="Recent Jobs",
                primary_cards=[
                    self._analysis_card(
                        title=str(item.get("jobName") or "--"),
                        value=f"{int(item.get('reelCount') or 0)} reels",
                        condition="Job activity",
                        meta=[
                            self._analysis_meta_item("Feet", self._format_feet_value(item.get("feetTotal"))),
                            self._analysis_meta_item("Window", f"{self._format_scope_datetime(item['start']) if item.get('start') else '--'} to {self._format_scope_datetime(item['end']) if item.get('end') else '--'}"),
                        ],
                    )
                    for item in jobs[:6]
                ],
            ),
        )

    def _assemble_job_analysis_response(
        self,
        tool_data: Dict[str, Any],
        filters: Dict[str, Any],
        intent: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        machine_name = str(tool_data.get("machineName") or "This press")
        selected_job = str(tool_data.get("selectedJob") or "").strip() or None
        selected = tool_data.get("selectedJobSummary") or {}
        ranked_jobs = tool_data.get("rankedJobs") or []
        recent_baseline = tool_data.get("recentBaseline") or {}
        concentration = tool_data.get("concentration") or {}
        mode = str(tool_data.get("jobAnalysisMode") or (intent or {}).get("jobAnalysisMode") or "")

        def comparison_text(selected_value: Optional[float], baseline_value: Optional[float], label: str, higher_worse: bool = True) -> str:
            if selected_value is None or baseline_value is None:
                return f"{label} could not be compared cleanly against recent jobs."
            delta = float(selected_value) - float(baseline_value)
            threshold = max(abs(float(baseline_value)) * 0.15, 0.05)
            if abs(delta) < threshold:
                return f"{label} is broadly in line with recent jobs on {machine_name}."
            if (delta > 0 and higher_worse) or (delta < 0 and not higher_worse):
                return f"{label} is worse than recent jobs on {machine_name}."
            return f"{label} is better than recent jobs on {machine_name}."

        chart = None
        title = f"Recent job summary for {machine_name}"
        summary = concentration.get("summary") or f"{machine_name} has {len(ranked_jobs)} recent jobs in scope."
        sections: List[Dict[str, str]] = []
        if mode == "selected_job_vs_recent" and selected_job and selected:
            title = f"{selected_job} on {machine_name} versus recent jobs"
            bad_feet_text = comparison_text(selected.get("badFeetPct"), recent_baseline.get("badFeetPct"), "Bad feet")
            delta_text = comparison_text(selected.get("deltaStd"), recent_baseline.get("deltaStd"), "Delta instability")
            coverage_text = comparison_text(selected.get("pointsPer1000Ft"), recent_baseline.get("pointsPer1000Ft"), "Monitoring density", higher_worse=False)
            summary = bad_feet_text
            sections = [
                {
                    "label": "Selected job",
                    "text": f"{selected_job}: {int(selected.get('reelCount') or 0)} reels | {self._format_feet_value(selected.get('feetTotal'))} | {self._format_pct(selected.get('badFeetPct'))} bad feet | {self._format_mm(selected.get('deltaStd'))} delta std | {self._format_number(selected.get('pointsPer1000Ft'))} pts/1k ft",
                },
                {
                    "label": "Recent-job baseline",
                    "text": f"{recent_baseline.get('jobCount') or 0} other jobs | {self._format_pct(recent_baseline.get('badFeetPct'))} bad feet | {self._format_mm(recent_baseline.get('deltaStd'))} delta std | {self._format_number(recent_baseline.get('pointsPer1000Ft'))} pts/1k ft",
                },
                {
                    "label": "Comparison summary",
                    "text": f"{bad_feet_text} | {delta_text} | {coverage_text}",
                },
            ]
            chart = {
                "type": "bar",
                "title": f"{selected_job} versus recent jobs",
                "series": [
                    {
                        "name": selected_job,
                        "x": ["Bad Feet %", "Delta Std Dev", "Monitoring Density"],
                        "y": [
                            float(selected.get("badFeetPct") or 0.0),
                            float(selected.get("deltaStd") or 0.0),
                            float(selected.get("pointsPer1000Ft") or 0.0),
                        ],
                        "hoverText": [
                            self._chart_hover_text(
                                job=selected_job,
                                time_value=selected.get("start"),
                                end_time_value=selected.get("end"),
                                total_feet=selected.get("feetTotal"),
                                bad_feet_ft=selected.get("estimatedBadFeetFeet"),
                                bad_feet_pct=selected.get("badFeetPct"),
                                metric_key="bad_feet_pct",
                                metric_label="Bad Feet %",
                                metric_value=selected.get("badFeetPct"),
                            ),
                            self._chart_hover_text(
                                job=selected_job,
                                time_value=selected.get("start"),
                                end_time_value=selected.get("end"),
                                total_feet=selected.get("feetTotal"),
                                bad_feet_ft=selected.get("estimatedBadFeetFeet"),
                                bad_feet_pct=selected.get("badFeetPct"),
                                metric_key="delta_variation",
                                metric_label="Delta Std Dev",
                                metric_value=selected.get("deltaStd"),
                            ),
                            self._chart_hover_text(
                                job=selected_job,
                                time_value=selected.get("start"),
                                end_time_value=selected.get("end"),
                                total_feet=selected.get("feetTotal"),
                                bad_feet_ft=selected.get("estimatedBadFeetFeet"),
                                bad_feet_pct=selected.get("badFeetPct"),
                                metric_key="monitoring_coverage",
                                metric_label="Monitoring Density",
                                metric_value=selected.get("pointsPer1000Ft"),
                            ),
                        ],
                    },
                    {
                        "name": "Recent jobs avg",
                        "x": ["Bad Feet %", "Delta Std Dev", "Monitoring Density"],
                        "y": [
                            float(recent_baseline.get("badFeetPct") or 0.0),
                            float(recent_baseline.get("deltaStd") or 0.0),
                            float(recent_baseline.get("pointsPer1000Ft") or 0.0),
                        ],
                        "hoverText": [
                            self._chart_hover_text(
                                job="Recent jobs avg",
                                bad_feet_pct=recent_baseline.get("badFeetPct"),
                                metric_key="bad_feet_pct",
                                metric_label="Bad Feet %",
                                metric_value=recent_baseline.get("badFeetPct"),
                                extra_lines=[f"Jobs: {recent_baseline.get('jobCount') or 0}"],
                            ),
                            self._chart_hover_text(
                                job="Recent jobs avg",
                                bad_feet_pct=recent_baseline.get("badFeetPct"),
                                metric_key="delta_variation",
                                metric_label="Delta Std Dev",
                                metric_value=recent_baseline.get("deltaStd"),
                                extra_lines=[f"Jobs: {recent_baseline.get('jobCount') or 0}"],
                            ),
                            self._chart_hover_text(
                                job="Recent jobs avg",
                                bad_feet_pct=recent_baseline.get("badFeetPct"),
                                metric_key="monitoring_coverage",
                                metric_label="Monitoring Density",
                                metric_value=recent_baseline.get("pointsPer1000Ft"),
                                extra_lines=[f"Jobs: {recent_baseline.get('jobCount') or 0}"],
                            ),
                        ],
                    },
                ],
                "metadata": {"visualType": "job-vs-recent", "selectedJob": selected_job},
            }
            chart = self._attach_chart_scope_metadata(
                chart,
                total_points_in_scope=2,
                displayed_points=2,
                scope_description="selected job and recent-job baseline",
            )
        elif mode in {"weakest_recent_job", "best_recent_job"} and ranked_jobs:
            weakest = ranked_jobs[0]
            strongest = ranked_jobs[-1]
            selected_job_row = strongest if mode == "best_recent_job" else weakest
            descriptor = "strongest" if mode == "best_recent_job" else "weakest"
            summary = (
                f"{selected_job_row.get('jobName')} stands out as the {descriptor} recent job on {machine_name}, "
                f"with {self._format_pct(selected_job_row.get('badFeetPct'))} bad feet and {self._format_mm(selected_job_row.get('deltaStd'))} delta std."
            )
            title = f"{descriptor.title()} recent job on {machine_name}: {selected_job_row.get('jobName')}"
            sections = [
                {
                    "label": f"{descriptor.title()} recent job",
                    "text": f"{selected_job_row.get('jobName')}: {int(selected_job_row.get('reelCount') or 0)} reels | {self._format_feet_value(selected_job_row.get('feetTotal'))} | {self._format_pct(selected_job_row.get('badFeetPct'))} bad feet | {self._format_mm(selected_job_row.get('deltaStd'))} delta std | {self._format_number(selected_job_row.get('pointsPer1000Ft'))} pts/1k ft",
                },
                {
                    "label": "Recent job ranking",
                    "text": " | ".join(
                        f"{item.get('jobName')}: {self._format_pct(item.get('badFeetPct'))} bad feet, {self._format_mm(item.get('deltaStd'))} delta std"
                        for item in ranked_jobs[:4]
                    ),
                },
            ]
            chart = {
                "type": "bar",
                "title": f"Recent job bad feet % on {machine_name}",
                "series": [
                    {
                        "name": "Bad Feet %",
                        "x": [item.get("jobName") for item in ranked_jobs],
                        "y": [float(item.get("badFeetPct") or 0.0) for item in ranked_jobs],
                        "hoverText": [
                            self._chart_hover_text(
                                job=item.get("jobName"),
                                time_value=item.get("start"),
                                end_time_value=item.get("end"),
                                total_feet=item.get("feetTotal"),
                                bad_feet_ft=item.get("estimatedBadFeetFeet"),
                                bad_feet_pct=item.get("badFeetPct"),
                                metric_key="bad_feet_pct",
                                metric_label="Bad Feet %",
                                metric_value=item.get("badFeetPct"),
                            )
                            for item in ranked_jobs
                        ],
                    }
                ],
                "metadata": {"visualType": "job-ranking", "machineName": machine_name},
            }
            chart = self._attach_chart_scope_metadata(
                chart,
                total_points_in_scope=len(ranked_jobs),
                displayed_points=len(ranked_jobs),
                scope_description="recent jobs in scope",
            )
        else:
            title = f"Recent-job concentration on {machine_name}"
            summary = concentration.get("summary") or f"Recent weakness is spread across jobs on {machine_name}."
            sections = [
                {"label": "Job concentration", "text": concentration.get("summary") or "--"},
                {
                    "label": "Recent job ranking",
                    "text": " | ".join(
                        f"{item.get('jobName')}: {self._format_pct(item.get('badFeetPct'))} bad feet, {self._format_mm(item.get('deltaStd'))} delta std"
                        for item in ranked_jobs[:4]
                    ),
                },
            ]
            chart = {
                "type": "bar",
                "title": f"Recent job bad feet % on {machine_name}",
                "series": [
                    {
                        "name": "Bad Feet %",
                        "x": [item.get("jobName") for item in ranked_jobs],
                        "y": [float(item.get("badFeetPct") or 0.0) for item in ranked_jobs],
                        "hoverText": [
                            self._chart_hover_text(
                                job=item.get("jobName"),
                                time_value=item.get("start"),
                                end_time_value=item.get("end"),
                                total_feet=item.get("feetTotal"),
                                bad_feet_ft=item.get("estimatedBadFeetFeet"),
                                bad_feet_pct=item.get("badFeetPct"),
                                metric_key="bad_feet_pct",
                                metric_label="Bad Feet %",
                                metric_value=item.get("badFeetPct"),
                            )
                            for item in ranked_jobs
                        ],
                    }
                ],
                "metadata": {"visualType": "job-concentration", "machineName": machine_name},
            } if len(ranked_jobs) >= 2 else None
            chart = self._attach_chart_scope_metadata(
                chart,
                total_points_in_scope=len(ranked_jobs),
                displayed_points=len(ranked_jobs),
                scope_description="recent jobs in scope",
            )

        response = self._response(
            answer={"title": title, "summary": summary, "sections": sections},
            evidence_metrics=[
                self._metric("Selected job", selected_job or "--"),
                self._metric("Recent jobs", str(len(ranked_jobs))),
                self._metric("Weakest recent job", (ranked_jobs[0].get("jobName") if ranked_jobs else "--") or "--"),
                self._metric("Concentration", concentration.get("label") or "--"),
            ],
            chart=chart,
            tools_used=[{"tool": "get_machine_job_analysis", "ok": True}],
            suggested_prompts=self._contextual_follow_up_prompts(
                response_kind="job_analysis",
                filters={**filters, "machine_id": tool_data.get("machineId") or filters.get("machine_id"), "job": selected_job or filters.get("job")},
                machine_label=machine_name,
                selected_job=selected_job,
            ),
            filters={**filters, "machine_id": tool_data.get("machineId") or filters.get("machine_id"), "job": selected_job or filters.get("job")},
            data_semantics="filtered-window",
        )
        response.setdefault("context", {})["selectedJob"] = selected_job
        response.setdefault("context", {})["jobAnalysis"] = {
            "selectedJob": selected_job,
            "recentBaseline": recent_baseline,
            "rankedJobs": ranked_jobs,
            "concentration": concentration,
            "jobAnalysisMode": mode,
        }
        primary_cards: List[Dict[str, Any]] = []
        if selected_job and selected:
            primary_cards.append(
                self._analysis_card(
                    title=selected_job,
                    value=self._format_pct(selected.get("badFeetPct")),
                    condition="Selected job",
                    meta=[
                        self._analysis_meta_item("Delta std", self._format_mm(selected.get("deltaStd"))),
                        self._analysis_meta_item("Monitoring", self._format_number(selected.get("pointsPer1000Ft"))),
                        self._analysis_meta_item("Feet", self._format_feet_value(selected.get("feetTotal"))),
                    ],
                )
            )
        if recent_baseline:
            primary_cards.append(
                self._analysis_card(
                    title="Recent-job baseline",
                    value=self._format_pct(recent_baseline.get("badFeetPct")),
                    condition="Baseline",
                    meta=[
                        self._analysis_meta_item("Delta std", self._format_mm(recent_baseline.get("deltaStd"))),
                        self._analysis_meta_item("Monitoring", self._format_number(recent_baseline.get("pointsPer1000Ft"))),
                        self._analysis_meta_item("Jobs", recent_baseline.get("jobCount") or "--"),
                    ],
                )
            )
        return self._attach_analysis_summary(
            response,
            self._analysis_summary_payload(
                family="job_analysis",
                lead=summary,
                key_context=[
                    self._analysis_key_context_item("Press", machine_name),
                    self._analysis_key_context_item("Selected job", selected_job or "--"),
                    self._analysis_key_context_item("Recent jobs", len(ranked_jobs)),
                    self._analysis_key_context_item("Concentration", concentration.get("label") or "--"),
                ],
                primary_label="Job Read",
                primary_cards=primary_cards,
                supporting_label="Recent Jobs",
                supporting_cards=[
                    self._analysis_card(
                        title=str(item.get("jobName") or "--"),
                        value=self._format_pct(item.get("badFeetPct")),
                        condition="Recent job",
                        meta=[
                            self._analysis_meta_item("Delta std", self._format_mm(item.get("deltaStd"))),
                            self._analysis_meta_item("Feet", self._format_feet_value(item.get("feetTotal"))),
                        ],
                    )
                    for item in ranked_jobs[:4]
                ],
            ),
        )

    def _get_press_intelligence(self, filters: Dict[str, Any]) -> Dict[str, Any]:
        if filters.get("reel_scope"):
            return self._build_press_intelligence_from_rows(
                self._filtered_reel_metrics(filters),
                filters,
            )
        return self.press_service.get_press_intelligence(
            PressIntelligenceFilters(
                start=filters["start_dt"],
                end=filters["end_dt"],
                job=filters.get("job") or None,
                min_feet=filters.get("min_feet"),
            )
        )

    def _build_press_intelligence_from_rows(self, reel_metrics: List[Dict[str, Any]], filters: Dict[str, Any]) -> Dict[str, Any]:
        press_metrics = self.press_service._aggregate_press_metrics(reel_metrics)
        comparisons = self.press_service._build_comparisons(press_metrics)
        self.press_service._annotate_rank_explanations(press_metrics, comparisons)
        category_leaderboards = self.press_service._build_category_leaderboards(press_metrics)
        category_trends = self.press_service._build_category_trends(reel_metrics)
        return {
            "decisionCards": self.press_service._build_decision_cards(press_metrics, comparisons),
            "pressRankings": press_metrics,
            "overviewRankings": self.press_service._build_overview_rankings(category_leaderboards),
            "categoryLeaderboards": category_leaderboards,
            "categoryTrends": category_trends,
            "comparisons": comparisons,
            "heatmap": self.press_service._build_heatmap(press_metrics, category_leaderboards),
            "trend": self.press_service._build_trend(reel_metrics),
            "outlierQueue": [],
            "outliers": [],
            "metadata": {
                "start": filters["start_dt"].isoformat(),
                "end": filters["end_dt"].isoformat(),
                "job": filters.get("job") or None,
                "minFeet": filters.get("min_feet"),
                "reelScope": ((filters.get("reel_scope") or {}).get("label")),
                "readOnly": True,
                "notes": [
                    "Estimated bad feet should be treated as a proxy derived from OOB monitoring-point share.",
                    "Delta and OOB values use the latest tolerance row per reel for MVP calculations.",
                ],
            },
        }

    def _press_row_for_machine(self, machine_id: Optional[int], filters: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        resolved_id = self._to_int(machine_id)
        if resolved_id is None:
            return None
        intelligence = self._get_press_intelligence(filters)
        return next(
            (
                row
                for row in intelligence.get("pressRankings", []) or []
                if self._to_int(row.get("machineId")) == resolved_id
            ),
            None,
        )

    def _overview_row_for_machine(self, machine_id: Optional[int], filters: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        resolved_id = self._to_int(machine_id)
        if resolved_id is None:
            return None
        intelligence = self._get_press_intelligence(filters)
        return next(
            (
                row
                for row in intelligence.get("overviewRankings", []) or []
                if self._to_int(row.get("machineId")) == resolved_id
            ),
            None,
        )

    def _production_context_text(self, row: Dict[str, Any]) -> Optional[str]:
        if not row:
            return None
        feet_total = row.get("feetTotal")
        reels_run = row.get("reelsRun")
        estimated_bad_feet = row.get("estimatedBadFeet")
        bad_feet_pct = row.get("estimatedBadFeetPct")
        if bad_feet_pct is None:
            bad_feet_pct = row.get("badFeetPct")
        if all(value in (None, "", 0) for value in (feet_total, reels_run, estimated_bad_feet, bad_feet_pct)):
            return None
        return " | ".join(
            [
                f"Total feet produced: {self._format_number(feet_total)}",
                f"Reel count: {int(reels_run or 0)}",
                f"Estimated bad feet: {self._format_number(estimated_bad_feet)}",
                f"Bad feet %: {self._format_pct(bad_feet_pct)}",
            ]
        )

    def _production_context_section(self, row: Dict[str, Any]) -> Optional[Dict[str, str]]:
        text = self._production_context_text(row)
        if not text:
            return None
        return {"label": "Production context", "text": text}

    def _build_filtered_dataset(
        self,
        filters: Dict[str, Any],
        machine_id: Optional[int] = None,
    ) -> Dict[str, Any]:
        domain = str(filters.get("analysis_domain") or "auto")
        if domain in {"auto", "rlm"}:
            return self._build_rlm_filtered_dataset(filters, machine_id)
        if domain == "bst_defects":
            return self._build_bst_defects_filtered_dataset(filters, machine_id)
        return self._build_rlm_filtered_dataset(filters, machine_id)

    def run_discovery_analysis(
        self,
        resolved_request: Dict[str, Any],
        dataset: Dict[str, Any],
    ) -> Dict[str, Any]:
        metric_key = str(resolved_request.get("metric_key") or "rlm_bad_feet")
        machine_id = self._to_int(resolved_request.get("machine_id"))
        filters = dict(dataset.get("effective_filters") or {})
        rows = list(dataset.get("rows") or [])
        qualification = dataset.get("qualification")
        metric_result = self._compute_phase2a_metric(metric_key, rows, qualification=qualification)
        comparison_mode = str(resolved_request.get("comparisonMode") or "none")
        comparison = None
        request_model = AssistantRequest(
            intent="discovery",
            domain=str(filters.get("analysis_domain") or "rlm"),
            metric_key=metric_key,
            comparison_mode=comparison_mode,
            press_id=machine_id,
            press_ids=[self._to_int(value) for value in resolved_request.get("machine_ids") or [] if self._to_int(value) is not None],
        )
        comparison_scope = self.resolve_comparison_scope(request_model, self._build_filtered_dataset(filters))
        if comparison_scope.get("valid") and comparison_mode in {"press_vs_average", "press_vs_press"}:
            comparison = self._compute_phase2b_comparison(
                metric_key=metric_key,
                primary_machine_id=machine_id,
                primary_rows=rows,
                filters=filters,
                comparison_scope=comparison_scope,
                comparison_mode=comparison_mode,
            )
        trend = self._compute_phase2a_trend(metric_key, rows)
        drivers = self._compute_phase2b_drivers(metric_key, rows)
        run_position = self._compute_phase2b_run_position(metric_key, rows)
        concentration = self._compute_phase2b_concentration(metric_key, rows)
        alignment = self._compute_phase2b_alignment(rows)
        episodes = self._compute_phase2c_delta_episodes(metric_key, rows)
        shape = self._classify_discovery_shape(metric_key, rows, concentration, episodes)
        baseline_comparison = self._compute_discovery_baseline_comparison(
            metric_key=metric_key,
            machine_id=machine_id,
            filters=filters,
            current_rows=rows,
            current_qualification=qualification,
        )
        change_point = self._compute_discovery_change_point(metric_key, rows)
        synthesis = self._synthesize_discovery_result(
            machine_name=self._press_label(machine_id) if machine_id is not None else "This press",
            metric_key=metric_key,
            metric_result=metric_result,
            comparison=comparison,
            baseline_comparison=baseline_comparison,
            trend=trend,
            concentration=concentration,
            run_position=run_position,
            episodes=episodes,
            alignment=alignment,
            change_point=change_point,
            shape=shape,
            grouping=str(resolved_request.get("grouping") or "decision"),
            trend_requested=bool(resolved_request.get("trendRequested")),
            baseline_requested=bool(resolved_request.get("baselineRequested")),
            qualification=qualification,
        )
        return {
            "machineId": machine_id,
            "machineName": self._press_label(machine_id) if machine_id is not None else None,
            "metricKey": metric_key,
            "metricLabel": self._phase2a_metric_label(metric_key),
            "metricResult": metric_result,
            "comparison": comparison,
            "trend": trend,
            "drivers": drivers,
            "runPosition": run_position,
            "concentration": concentration,
            "alignment": alignment,
            "episodes": episodes,
            "baselineComparison": baseline_comparison,
            "baselineSummary": baseline_comparison.get("summary") if baseline_comparison else None,
            "changePoint": change_point,
            "sustainedVsSpike": shape.get("label") or concentration.get("pattern"),
            "shape": shape,
            "qualification": qualification,
            "rows": rows,
            "effectiveFilters": filters,
            "previousWindowComparison": baseline_comparison,
            "synthesis": synthesis,
            "dataSemantics": "filtered-window",
        }

    def _build_rlm_filtered_dataset(
        self,
        filters: Dict[str, Any],
        machine_id: Optional[int] = None,
    ) -> Dict[str, Any]:
        base_filters = dict(filters)
        base_filters["min_feet"] = None
        base_filters["reel_scope"] = None
        matched_rows = self._filtered_reel_metrics(base_filters, machine_id)
        qualified_rows = self._filtered_reel_metrics(filters, machine_id)
        exclusion_counts: Dict[str, int] = {}
        if filters.get("min_feet") is not None:
            min_feet_rows = self._filtered_reel_metrics({**base_filters, "min_feet": filters.get("min_feet")}, machine_id)
            exclusion_counts[EXCLUSION_REASON_BELOW_MIN_FEET] = max(len(matched_rows) - len(min_feet_rows), 0)
            matched_for_reel_scope = min_feet_rows
        else:
            matched_for_reel_scope = matched_rows
        if filters.get("reel_scope"):
            exclusion_counts[EXCLUSION_REASON_OUTSIDE_REEL_SCOPE] = max(len(matched_for_reel_scope) - len(qualified_rows), 0)
        qualification = build_qualification_summary(
            matched_rows=matched_rows,
            qualified_rows=qualified_rows,
            exclusion_counts={key: value for key, value in exclusion_counts.items() if value > 0},
            denominator_label="Qualified reels in the effective analysis scope",
            notes=["Domain-agnostic qualification scaffolding is active; deeper exclusion semantics will expand in Phase 2."],
        )
        return {
            "rows": qualified_rows,
            "qualification": qualification,
            "effective_filters": dict(filters),
        }

    def _build_bst_defects_filtered_dataset(
        self,
        filters: Dict[str, Any],
        machine_id: Optional[int] = None,
    ) -> Dict[str, Any]:
        del machine_id
        qualification = build_qualification_summary(
            matched_rows=[],
            qualified_rows=[],
            exclusion_counts={},
            denominator_label="Qualified defect records in the effective analysis scope",
            notes=["BST defect domain dispatch is scaffolded but not implemented yet."],
        )
        return {
            "rows": [],
            "qualification": qualification,
            "effective_filters": dict(filters),
        }

    def resolve_comparison_scope(
        self,
        request: AssistantRequest,
        dataset: Dict[str, Any],
    ) -> Dict[str, Any]:
        rows = list(dataset.get("rows") or [])
        available_machine_ids: List[int] = []
        for row in rows:
            machine_id = self._to_int(row.get("machineId"))
            if machine_id is not None and machine_id not in available_machine_ids:
                available_machine_ids.append(machine_id)
        if request.comparison_mode == "press_vs_press":
            press_ids = [self._to_int(value) for value in request.press_ids if self._to_int(value) is not None]
            if len(press_ids) < 2:
                return {"valid": False, "mode": "press_vs_press", "reason": "comparison_requires_two_presses"}
            return {
                "valid": True,
                "mode": "press_vs_press",
                "primary_press_id": press_ids[0],
                "comparison_press_ids": press_ids[:2],
                "peer_set": press_ids[:2],
            }
        if request.comparison_mode == "press_vs_average":
            primary_press_id = self._to_int(request.press_id)
            peer_set = [machine_id for machine_id in available_machine_ids if machine_id != primary_press_id]
            if primary_press_id is None or not peer_set:
                return {"valid": False, "mode": "press_vs_average", "reason": "comparison_requires_peer_set"}
            return {
                "valid": True,
                "mode": "press_vs_average",
                "primary_press_id": primary_press_id,
                "comparison_press_ids": [],
                "peer_set": peer_set,
            }
        return {
            "valid": True,
            "mode": request.comparison_mode,
            "primary_press_id": self._to_int(request.press_id),
            "comparison_press_ids": [self._to_int(value) for value in request.press_ids if self._to_int(value) is not None],
            "peer_set": available_machine_ids,
        }

    def _discovery_chart_markers(
        self,
        metric_key: str,
        rows: List[Dict[str, Any]],
    ) -> Dict[str, Any]:
        ordered = sorted(rows, key=lambda row: row.get("productionStart") or "")
        if len(ordered) < 4:
            return {"shiftLabel": None, "shiftValue": None, "recoveryLabel": None, "recoveryValue": None}
        scores = [self._phase2b_metric_score(metric_key, row) for row in ordered]
        positive_scores = [float(score) for score in scores if float(score or 0.0) > 0]
        if len(positive_scores) < 2:
            return {"shiftLabel": None, "shiftValue": None, "recoveryLabel": None, "recoveryValue": None}
        mean_score = sum(positive_scores) / len(positive_scores)
        peak_score = max(positive_scores)
        threshold = max(mean_score * 1.1, peak_score * 0.45)
        affected_flags = [float(score or 0.0) >= threshold for score in scores]
        shift_index = None
        for index in range(1, len(scores)):
            if affected_flags[index] and index + 1 < len(scores) and affected_flags[index + 1]:
                shift_index = index
                break
        if shift_index is None:
            largest_jump = None
            for index in range(1, len(scores)):
                jump = abs(scores[index] - scores[index - 1])
                if largest_jump is None or jump > largest_jump[1]:
                    largest_jump = (index, jump)
            shift_index = largest_jump[0] if largest_jump else None
        if shift_index is None:
            return {"shiftLabel": None, "shiftValue": None, "recoveryLabel": None, "recoveryValue": None}

        recovery_index = None
        for index in range(shift_index + 1, len(affected_flags) - 1):
            if not affected_flags[index] and not affected_flags[index + 1]:
                recovery_index = index
                break
        shift_row = ordered[shift_index]
        recovery_row = ordered[recovery_index] if recovery_index is not None else None
        return {
            "shiftLabel": shift_row.get("reelId") or shift_row.get("productionStart"),
            "shiftValue": scores[shift_index],
            "recoveryLabel": (recovery_row.get("reelId") or recovery_row.get("productionStart")) if recovery_row else None,
            "recoveryValue": scores[recovery_index] if recovery_index is not None else None,
        }

    def _discovery_chart(
        self,
        *,
        metric_key: str,
        metric_label: str,
        rows: List[Dict[str, Any]],
        filters: Dict[str, Any],
        scope: Dict[str, Any],
        grouping: str,
        baseline_comparison: Dict[str, Any],
        change_point: Dict[str, Any],
        shape: Dict[str, Any],
        synthesis: Dict[str, Any],
    ) -> Optional[Dict[str, Any]]:
        ordered = sorted(rows, key=lambda row: row.get("productionStart") or "")
        series_rows = []
        for row in ordered:
            value = self._phase2b_metric_score(metric_key, row)
            label = row.get("reelId") or row.get("productionStart")
            if label is None:
                continue
            series_rows.append({"label": label, "value": value, "row": row})
        if len(series_rows) < 2:
            return None
        if len({round(float(item["value"]), 6) for item in series_rows}) <= 1:
            return None
        title_suffix = "by reel" if scope.get("kind") == "reels" else "across the selected scope"
        if grouping == "run_position":
            title = f"{metric_label} with the likely shift point {title_suffix}"
        elif grouping == "episodes":
            title = f"{metric_label} around the shift window"
        elif grouping == "concentration":
            title = f"{metric_label} shape across the scoped sequence"
        elif baseline_comparison.get("available"):
            title = f"{metric_label} with previous-window baseline"
        else:
            title = f"{metric_label} {title_suffix}"
        series = [
            {
                "name": metric_label,
                "x": [item["label"] for item in series_rows],
                "y": [item["value"] for item in series_rows],
                "hoverText": [
                    self._chart_hover_text(
                        reel=(item.get("row") or {}).get("reelId"),
                        job=(item.get("row") or {}).get("jobName"),
                        time_value=(item.get("row") or {}).get("productionStart") or (item.get("row") or {}).get("date"),
                        total_feet=(item.get("row") or {}).get("feetTotal"),
                        bad_feet_ft=(item.get("row") or {}).get("estimatedBadFeet"),
                        bad_feet_pct=(item.get("row") or {}).get("estimatedBadFeetPct"),
                        metric_key=metric_key,
                        metric_label=metric_label,
                        metric_value=item.get("value"),
                    )
                    for item in series_rows
                ],
            }
        ]
        if baseline_comparison.get("available") and baseline_comparison.get("previousValue") is not None:
            series.append(
                {
                    "name": str(baseline_comparison.get("baselineLabel") or "Previous window"),
                    "x": [item["label"] for item in series_rows],
                    "y": [float(baseline_comparison.get("previousValue") or 0.0) for _ in series_rows],
                    "hoverText": [
                        self._chart_hover_text(
                            reel=(item.get("row") or {}).get("reelId"),
                            job=(item.get("row") or {}).get("jobName"),
                            time_value=(item.get("row") or {}).get("productionStart") or (item.get("row") or {}).get("date"),
                            total_feet=(item.get("row") or {}).get("feetTotal"),
                            bad_feet_ft=(item.get("row") or {}).get("estimatedBadFeet"),
                            bad_feet_pct=(item.get("row") or {}).get("estimatedBadFeetPct"),
                            metric_key=metric_key,
                            metric_label=str(baseline_comparison.get("baselineLabel") or "Previous window"),
                            metric_value=baseline_comparison.get("previousValue"),
                        )
                        for item in series_rows
                    ],
                }
            )
        markers = self._discovery_chart_markers(metric_key, rows)
        shift_label = change_point.get("candidate") or markers.get("shiftLabel")
        shift_value = markers.get("shiftValue")
        if change_point.get("available") and shift_label is not None and shift_value is not None:
            shift_row = next((item.get("row") for item in series_rows if item.get("label") == shift_label), None) or {}
            series.append(
                {
                    "name": "Shift point",
                    "x": [shift_label],
                    "y": [shift_value],
                    "hoverText": [
                        self._chart_hover_text(
                            reel=shift_row.get("reelId"),
                            job=shift_row.get("jobName"),
                            time_value=shift_row.get("productionStart") or shift_row.get("date"),
                            total_feet=shift_row.get("feetTotal"),
                            bad_feet_ft=shift_row.get("estimatedBadFeet"),
                            bad_feet_pct=shift_row.get("estimatedBadFeetPct"),
                            metric_key=metric_key,
                            metric_label=metric_label,
                            metric_value=shift_value,
                            extra_lines=["Marker: Shift point"],
                        )
                    ],
                }
            )
        if shape.get("recoveryAfterShift") and markers.get("recoveryLabel") is not None and markers.get("recoveryValue") is not None:
            recovery_label = markers.get("recoveryLabel")
            recovery_row = next((item.get("row") for item in series_rows if item.get("label") == recovery_label), None) or {}
            series.append(
                {
                    "name": "Recovery",
                    "x": [recovery_label],
                    "y": [markers.get("recoveryValue")],
                    "hoverText": [
                        self._chart_hover_text(
                            reel=recovery_row.get("reelId"),
                            job=recovery_row.get("jobName"),
                            time_value=recovery_row.get("productionStart") or recovery_row.get("date"),
                            total_feet=recovery_row.get("feetTotal"),
                            bad_feet_ft=recovery_row.get("estimatedBadFeet"),
                            bad_feet_pct=recovery_row.get("estimatedBadFeetPct"),
                            metric_key=metric_key,
                            metric_label=metric_label,
                            metric_value=markers.get("recoveryValue"),
                            extra_lines=["Marker: Recovery"],
                        )
                    ],
                }
            )
        if not self._should_render_series_chart([{"value": item["value"]} for item in series_rows]):
            return None
        annotations = self._discovery_chart_annotations(
            series_rows=series_rows,
            baseline_comparison=baseline_comparison,
            change_point=change_point,
            shape=shape,
            markers=markers,
        )
        return self._attach_chart_scope_metadata(
            {
                "type": "line",
                "title": title,
                "series": series,
                "annotations": annotations,
                "metadata": {
                    "visualType": "discovery-sequence",
                    "metricKey": metric_key,
                    "metricLabel": metric_label,
                },
            },
            total_points_in_scope=len(series_rows),
            displayed_points=len(series_rows),
            scope_description=self._chart_scope_description(filters=filters, scope=scope, rows=ordered),
        )

    def _discovery_chart_annotations(
        self,
        *,
        series_rows: List[Dict[str, Any]],
        baseline_comparison: Dict[str, Any],
        change_point: Dict[str, Any],
        shape: Dict[str, Any],
        markers: Dict[str, Any],
    ) -> List[Dict[str, Any]]:
        if not series_rows:
            return []
        annotations: List[Dict[str, Any]] = []
        labels = [item.get("label") for item in series_rows if item.get("label") is not None]
        values = [float(item.get("value") or 0.0) for item in series_rows]
        if not labels or not values:
            return []

        shift_label = change_point.get("candidate") or markers.get("shiftLabel")
        if change_point.get("shift_detected") and shift_label in labels:
            annotations.append(
                {
                    "kind": "vertical-line",
                    "x": shift_label,
                    "label": "Shift",
                    "color": "#d97706",
                    "dash": "dot",
                }
            )

        if baseline_comparison.get("available"):
            annotations.append(
                {
                    "kind": "vertical-line",
                    "x": labels[0],
                    "label": "Current window",
                    "color": "#94a3b8",
                    "dash": "dash",
                }
            )

        recovery_label = markers.get("recoveryLabel")
        recovery_value = markers.get("recoveryValue")
        if shape.get("recoveryAfterShift") and recovery_label in labels and recovery_value is not None:
            annotations.append(
                {
                    "kind": "point-label",
                    "x": recovery_label,
                    "y": float(recovery_value),
                    "label": "Recovery",
                    "color": "#16a34a",
                }
            )
        elif change_point.get("shift_detected") and not shape.get("recoveryAfterShift"):
            annotations.append(
                {
                    "kind": "text-label",
                    "x": labels[-1],
                    "y": values[-1],
                    "label": "No clear recovery",
                    "color": "#b45309",
                }
            )

        return annotations[:3]

    def _compute_discovery_baseline_comparison(
        self,
        *,
        metric_key: str,
        machine_id: Optional[int],
        filters: Dict[str, Any],
        current_rows: List[Dict[str, Any]],
        current_qualification: Optional[QualificationSummary],
    ) -> Dict[str, Any]:
        if machine_id is None:
            return {"available": False, "baseline_available": False, "summary": "No previous-window comparison is available without a selected press."}
        previous_filters = self._previous_window_filters(filters, machine_id)
        if not previous_filters:
            return {"available": False, "baseline_available": False, "summary": "No previous-window comparison is available for this scope."}
        previous_dataset = self._build_filtered_dataset(previous_filters, machine_id)
        previous_rows = list(previous_dataset.get("rows") or [])
        previous_qualification = previous_dataset.get("qualification")
        if not previous_rows:
            return {"available": False, "baseline_available": False, "summary": "There is not enough prior scoped data to compare against the previous window."}

        current_metric = self._compute_phase2a_metric(metric_key, current_rows, qualification=current_qualification)
        previous_metric = self._compute_phase2a_metric(metric_key, previous_rows, qualification=previous_qualification)
        current_value = current_metric.get("value")
        previous_value = previous_metric.get("value")
        if current_value is None or previous_value is None:
            return {"available": False, "baseline_available": False, "summary": "There is not enough prior qualified data for a previous-window comparison."}

        higher_is_better = METRIC_REGISTRY.get(metric_key, {}).get("higher_is_better")
        delta_value = float(current_value) - float(previous_value)
        baseline = max(abs(float(previous_value)), 0.01)
        threshold = max(baseline * 0.08, 0.02)
        if abs(delta_value) < threshold:
            outcome = "roughly in line"
            meaningful = False
        elif higher_is_better:
            outcome = "better" if delta_value > 0 else "worse"
            meaningful = True
        else:
            outcome = "better" if delta_value < 0 else "worse"
            meaningful = True

        current_variability = self._metric_series_variability(metric_key, current_rows)
        previous_variability = self._metric_series_variability(metric_key, previous_rows)
        variability_delta = None
        if current_variability is not None and previous_variability is not None:
            variability_delta = current_variability - previous_variability

        fairness = self._compute_phase2c_comparison_fairness(
            primary_rows=current_rows,
            primary_qualification=current_qualification,
            comparator_rows=previous_rows,
            comparator_qualification=previous_qualification,
            comparison_mode="previous_window",
        )
        confidence = fairness.get("confidence") or "medium"
        if not meaningful:
            confidence = "medium" if confidence == "high" else confidence

        scope_kind = "reels" if filters.get("reel_scope") else "time"
        baseline_label = self._previous_window_label(filters)
        summary = (
            f"Compared with the {baseline_label}, {self._press_label(machine_id)} is {outcome} on "
            f"{self._phase2a_metric_label(metric_key).lower()}: {current_metric.get('valueDisplay') or '--'} versus "
            f"{previous_metric.get('valueDisplay') or '--'}."
        )
        if variability_delta is not None:
            variability_direction = "higher" if variability_delta > 0 else "lower" if variability_delta < 0 else "similar"
            summary += f" Sequence variability is {variability_direction} than the prior window."
        if not meaningful:
            summary += " The change looks weak rather than decisive."

        return {
            "available": True,
            "baseline_available": True,
            "scopeKind": scope_kind,
            "baseline_type": scope_kind,
            "baselineLabel": baseline_label,
            "currentValue": current_value,
            "currentValueDisplay": current_metric.get("valueDisplay"),
            "previousValue": previous_value,
            "previousValueDisplay": previous_metric.get("valueDisplay"),
            "deltaValue": delta_value,
            "deltaDisplay": self._phase2b_metric_display(metric_key, delta_value),
            "primary_metric_delta": self._phase2b_metric_display(metric_key, delta_value),
            "variabilityDelta": variability_delta,
            "variabilityDeltaDisplay": self._format_number(variability_delta) if variability_delta is not None else "--",
            "variability_delta": self._format_number(variability_delta) if variability_delta is not None else "--",
            "monitoringCaveats": fairness.get("notes") or [],
            "qualification_delta": " | ".join(fairness.get("notes") or []),
            "meaningfulChange": meaningful,
            "confidence": confidence,
            "outcome": outcome,
            "interpretation_summary": summary,
            "summary": summary,
        }

    def _previous_window_filters(
        self,
        filters: Dict[str, Any],
        machine_id: Optional[int],
    ) -> Optional[Dict[str, Any]]:
        if filters.get("reel_scope"):
            count = self._to_int((filters.get("reel_scope") or {}).get("count"))
            if not count or count <= 0:
                return None
            base_filters = dict(filters)
            base_filters["reel_scope"] = None
            base_dataset = self._build_filtered_dataset(base_filters, machine_id)
            base_rows = sorted(base_dataset.get("rows") or [], key=lambda row: row.get("productionStart") or "")
            if len(base_rows) < count * 2:
                return None
            start_index = len(base_rows) - (count * 2)
            end_index = len(base_rows) - count - 1
            if start_index < 0 or end_index < start_index:
                return None
            previous_start = base_rows[start_index].get("productionStart")
            previous_end = base_rows[end_index].get("productionStart")
            if not previous_start or not previous_end:
                return None
            updated = dict(base_filters)
            updated["start"] = str(previous_start)
            updated["end"] = str(previous_end)
            updated["start_dt"] = self._parse_datetime_value(previous_start)
            updated["end_dt"] = self._parse_datetime_value(previous_end)
            return updated

        start_dt = self._parse_datetime_value(filters.get("start_dt") or filters.get("start"))
        end_dt = self._parse_datetime_value(filters.get("end_dt") or filters.get("end"))
        if not start_dt or not end_dt or end_dt <= start_dt:
            return None
        delta = end_dt - start_dt
        updated = dict(filters)
        updated["start_dt"] = start_dt - delta
        updated["end_dt"] = start_dt
        updated["start"] = updated["start_dt"].isoformat(timespec="seconds")
        updated["end"] = updated["end_dt"].isoformat(timespec="seconds")
        return updated

    def _previous_window_label(self, filters: Dict[str, Any]) -> str:
        reel_scope = filters.get("reel_scope") or {}
        count = self._to_int(reel_scope.get("count"))
        if count:
            return f"previous {count} reels"
        start_dt = self._parse_datetime_value(filters.get("start_dt") or filters.get("start"))
        end_dt = self._parse_datetime_value(filters.get("end_dt") or filters.get("end"))
        if start_dt and end_dt and end_dt > start_dt:
            delta = end_dt - start_dt
            hours = int(round(delta.total_seconds() / 3600.0))
            if hours and hours % 24 == 0:
                days = max(1, hours // 24)
                return f"previous {days} day{'s' if days != 1 else ''}"
            if hours > 0:
                return f"previous {hours} hour{'s' if hours != 1 else ''}"
        return "previous window"

    def _metric_series_variability(self, metric_key: str, rows: List[Dict[str, Any]]) -> Optional[float]:
        scores = [self._phase2b_metric_score(metric_key, row) for row in rows]
        scores = [float(score) for score in scores if score is not None]
        if len(scores) < 2:
            return None
        mean = sum(scores) / len(scores)
        variance = sum((score - mean) ** 2 for score in scores) / len(scores)
        return variance ** 0.5

    def _parse_datetime_value(self, value: Any) -> Optional[datetime]:
        if isinstance(value, datetime):
            return value
        if not value:
            return None
        try:
            text = str(value)
            if len(text) == 10:
                return datetime.fromisoformat(f"{text}T00:00:00")
            return datetime.fromisoformat(text)
        except ValueError:
            return None

    def _classify_discovery_shape(
        self,
        metric_key: str,
        rows: List[Dict[str, Any]],
        concentration: Dict[str, Any],
        episodes: Dict[str, Any],
    ) -> Dict[str, Any]:
        scores = [self._phase2b_metric_score(metric_key, row) for row in rows]
        positive_scores = [float(score) for score in scores if float(score or 0.0) > 0]
        if len(positive_scores) < 4:
            return {
                "label": "limited evidence",
                "summary": "There is limited data to classify the issue shape confidently.",
                "affectedShare": 0.0,
                "longestRun": 0,
                "recoveryAfterShift": False,
                "confidence": "low",
            }

        mean_score = sum(positive_scores) / len(positive_scores)
        peak_score = max(positive_scores)
        threshold = max(mean_score * 1.1, peak_score * 0.45)
        affected_flags = [float(score or 0.0) >= threshold for score in scores]
        affected_share = (sum(1 for item in affected_flags if item) / len(affected_flags)) if affected_flags else 0.0
        longest_run = 0
        current_run = 0
        longest_run_end = -1
        for affected in affected_flags:
            if affected:
                current_run += 1
                longest_run = max(longest_run, current_run)
            else:
                current_run = 0
        current_run = 0
        for index, affected in enumerate(affected_flags):
            if affected:
                current_run += 1
                if current_run >= longest_run:
                    longest_run_end = index
            else:
                current_run = 0

        top_two_share = 0.0
        concentration_summary = str(concentration.get("summary") or "")
        match = re.search(r"top two reels contributing\s+(\d+)%", concentration_summary, flags=re.IGNORECASE)
        if match:
            top_two_share = int(match.group(1)) / 100.0
        recovery_after_shift = any(bool(item.get("recoveryAfter")) for item in episodes.get("episodes") or [])
        if not recovery_after_shift and longest_run_end >= 0 and longest_run_end + 2 < len(affected_flags):
            stable_span = 0
            for affected in affected_flags[longest_run_end + 1 :]:
                if not affected:
                    stable_span += 1
                else:
                    break
            recovery_after_shift = stable_span >= 2

        if top_two_share >= 0.55 and affected_share <= 0.35 and longest_run <= 2:
            label = "isolated spike"
            confidence = "medium"
        elif longest_run >= max(4, int(len(scores) * 0.35)) and affected_share >= 0.35:
            label = "sustained deterioration"
            confidence = "high"
        elif longest_run >= 2 or affected_share >= 0.25:
            label = "clustered issue"
            confidence = "medium"
        else:
            label = "isolated spike"
            confidence = "low"

        summary = (
            f"{self._discovery_shape_phrase(label).rstrip('.')}. "
            f"{affected_share:.0%} of qualified reels were affected, with a longest elevated run of {longest_run} reels."
        )
        if recovery_after_shift:
            summary += " The sequence recovered after the main elevated window."

        return {
            "label": label,
            "summary": summary,
            "affectedShare": affected_share,
            "longestRun": longest_run,
            "recoveryAfterShift": recovery_after_shift,
            "confidence": confidence,
        }

    def _discovery_shape_phrase(self, label: str) -> str:
        normalized = str(label or "").strip().lower()
        if normalized == "isolated spike":
            return "The issue looks like an isolated spike."
        if normalized == "clustered issue":
            return "The issue looks clustered rather than isolated."
        if normalized == "sustained deterioration":
            return "The issue looks like sustained deterioration."
        if normalized == "limited evidence":
            return "There is limited evidence to classify the issue shape confidently."
        return ""

    def _compute_discovery_change_point(
        self,
        metric_key: str,
        rows: List[Dict[str, Any]],
    ) -> Dict[str, Any]:
        ordered = sorted(rows, key=lambda row: row.get("productionStart") or "")
        if len(ordered) < 4:
            return {
                "available": False,
                "shift_detected": False,
                "summary": "There is not enough ordered data to identify a likely shift point.",
                "confidence": "low",
                "caveat": "Not enough ordered points were available.",
            }
        scores = [self._phase2b_metric_score(metric_key, row) for row in ordered]
        largest_jump = None
        first_sustained = None
        mean_score = sum(scores) / len(scores) if scores else 0.0
        jump_threshold = max(mean_score * 0.5, 0.05)
        for index in range(1, len(scores)):
            jump = scores[index] - scores[index - 1]
            if largest_jump is None or abs(jump) > abs(largest_jump[1]):
                largest_jump = (index, jump)
            if first_sustained is None and index + 1 < len(scores):
                if scores[index] > mean_score * 1.2 and scores[index + 1] > mean_score * 1.2:
                    first_sustained = index
        if first_sustained is not None:
            candidate_index = first_sustained
            reason = "first sustained worsening point"
            confidence = "medium"
        elif largest_jump and abs(largest_jump[1]) >= jump_threshold:
            candidate_index = largest_jump[0]
            reason = "largest jump in the scoped sequence"
            confidence = "medium"
        else:
            return {
                "available": False,
                "shift_detected": False,
                "summary": "No clear behavior-shift point stands out in the scoped sequence.",
                "confidence": "low",
                "caveat": "The scoped sequence does not show a decisive break.",
            }
        row = ordered[candidate_index]
        label = row.get("reelId") or row.get("productionStart") or f"point {candidate_index + 1}"
        return {
            "available": True,
            "shift_detected": True,
            "candidate": label,
            "driving_metric": self._phase2a_metric_label(metric_key),
            "supportingMetric": self._phase2a_metric_label(metric_key),
            "confidence": confidence,
            "reason": reason,
            "caveat": "This is a deterministic shift candidate, not a statistical proof of causation.",
            "summary": f"The clearest shift point is around {label}, based on the {reason} in {self._phase2a_metric_label(metric_key).lower()}.",
        }

    def _synthesize_discovery_result(
        self,
        *,
        machine_name: str,
        metric_key: str,
        metric_result: Dict[str, Any],
        comparison: Optional[Dict[str, Any]],
        baseline_comparison: Optional[Dict[str, Any]],
        trend: Dict[str, Any],
        concentration: Dict[str, Any],
        run_position: Dict[str, Any],
        episodes: Dict[str, Any],
        alignment: Dict[str, Any],
        change_point: Dict[str, Any],
        shape: Dict[str, Any],
        grouping: str,
        trend_requested: bool,
        baseline_requested: bool,
        qualification: Optional[QualificationSummary],
    ) -> Dict[str, Any]:
        family = self._metric_family(metric_key)
        metric_label = self._phase2a_metric_label(metric_key)
        comparison_summary = comparison.get("comparisonSummary") if comparison else None
        confidence = ((comparison or {}).get("fairness") or {}).get("confidence")
        if not confidence:
            confidence = "low" if (qualification and qualification.qualified_reels < 3) else "medium"

        baseline_available = bool(baseline_comparison and baseline_comparison.get("available"))
        baseline_label = str((baseline_comparison or {}).get("baselineLabel") or "previous window")
        baseline_outcome = str((baseline_comparison or {}).get("outcome") or "")
        trend_direction = str(trend.get("direction") or "")
        shape_label = str(shape.get("label") or "").strip()

        if grouping == "concentration":
            if shape_label == "isolated spike":
                direct_answer = "The issue appears concentrated in a short spike rather than spread across the whole run."
            elif shape_label == "clustered issue":
                direct_answer = "The issue appears concentrated in a short cluster rather than spread across the whole run."
            elif shape_label == "sustained deterioration":
                direct_answer = "The issue appears spread across much of the run rather than limited to a few spikes."
            else:
                direct_answer = "There is not enough evidence to tell whether the issue is concentrated or broad."
        elif grouping == "episodes":
            if shape.get("recoveryAfterShift"):
                direct_answer = "Yes — it appears to recover after the main shift."
            elif change_point.get("available"):
                direct_answer = "No — there is no clear recovery after the main shift."
            else:
                direct_answer = "Unclear — there is not enough evidence to tell whether it recovered."
        elif grouping == "run_position":
            if change_point.get("available"):
                direct_answer = f"Behavior appears to shift around {change_point.get('candidate')}."
            elif run_position.get("pattern") and run_position.get("pattern") != "limited data":
                direct_answer = f"The issue is mainly {str(run_position.get('pattern')).lower()}."
            else:
                direct_answer = "There is not enough evidence to identify where behavior shifted."
        elif baseline_requested and not baseline_available:
            direct_answer = "There is not enough prior scoped data to compare this window with the previous one."
        elif trend_requested:
            if baseline_available and baseline_outcome == "worse":
                direct_answer = f"Yes — {machine_name} is getting worse than the {baseline_label} on {metric_label.lower()}."
            elif baseline_available and baseline_outcome == "better":
                direct_answer = f"No — {machine_name} is not getting worse; it is better than the {baseline_label} on {metric_label.lower()}."
            elif baseline_available:
                direct_answer = f"Unclear — {machine_name} is not clearly different from the {baseline_label} on {metric_label.lower()}."
            elif trend_direction == "worsening":
                direct_answer = f"Yes — {machine_name} is getting worse in the current scope on {metric_label.lower()}."
            elif trend_direction == "improving":
                direct_answer = f"No — {machine_name} is not getting worse; it is improving on {metric_label.lower()}."
            elif trend_direction == "stable":
                direct_answer = f"No — {machine_name} is not clearly getting worse on {metric_label.lower()}."
            else:
                direct_answer = f"Unclear — there is not enough evidence to say whether {machine_name} is getting worse on {metric_label.lower()}."
        elif baseline_available:
            if baseline_outcome == "worse":
                direct_answer = f"{metric_label} is worse than the {baseline_label} for {machine_name}."
            elif baseline_outcome == "better":
                direct_answer = f"{metric_label} is better than the {baseline_label} for {machine_name}."
            else:
                direct_answer = f"{metric_label} is not clearly different from the {baseline_label} for {machine_name}."
        elif trend_direction == "worsening":
            direct_answer = f"{metric_label} is worsening for {machine_name} in the current scope."
        elif trend_direction == "improving":
            direct_answer = f"{metric_label} is improving for {machine_name} in the current scope."
        elif trend_direction == "stable":
            direct_answer = f"{metric_label} is broadly stable for {machine_name} in the current scope."
        else:
            direct_answer = f"There is not enough evidence to say what changed for {machine_name} on {metric_label.lower()}."

        shape_phrase = self._discovery_shape_phrase(shape_label)
        if shape_phrase and shape_label != "limited evidence" and grouping not in {"concentration"}:
            direct_answer += f" {shape_phrase}"
        if change_point.get("available") and grouping not in {"run_position"}:
            direct_answer += f" Behavior appears to shift around {change_point.get('candidate')}."
        if shape.get("recoveryAfterShift") and grouping not in {"episodes"}:
            direct_answer += " It recovered after the main shift."
        elif change_point.get("available") and not shape.get("recoveryAfterShift") and grouping not in {"episodes"}:
            direct_answer += " There is no clear recovery after the main shift."

        findings: List[str] = []
        if baseline_comparison and baseline_comparison.get("summary"):
            findings.append(str(baseline_comparison.get("summary")))
        if trend.get("basis"):
            findings.append(f"Trend basis: {trend.get('basis')}")
        if shape.get("summary"):
            findings.append(str(shape.get("summary")))
        if run_position.get("pattern") and run_position.get("pattern") != "limited data":
            findings.append(f"Run shape: {run_position.get('pattern')}")
        if concentration.get("pattern") and concentration.get("pattern") != "limited data":
            findings.append(f"Concentration: {concentration.get('pattern')}")
        if episodes.get("summary") and metric_key in {"delta_variation", "delta_drift"}:
            findings.append(str(episodes.get("summary")))
        if change_point.get("summary"):
            findings.append(str(change_point.get("summary")))

        drivers: List[str] = []
        if comparison and comparison.get("mainDrivers"):
            drivers.extend(str(item) for item in comparison.get("mainDrivers")[:3])
        elif family == "process":
            drivers.append(metric_label)
        elif family == "operational":
            drivers.append("Monitoring / qualification")
        else:
            drivers.append("Production impact")

        next_checks = []
        if family == "process":
            next_checks = ["Which reels drove this?", "Did it recover?", "Compare it to average"]
        elif family == "outcome":
            next_checks = ["Was this just a few reels or the whole job?", "Which reels drove this?", "Did speed instability line up too?"]
        else:
            next_checks = ["Was this comparison fair?", "Compare delta behavior too", "What really changed?"]

        if qualification and qualification.qualified_reels < 3:
            findings.append("Limited data: there are too few qualified reels for a strong discovery conclusion.")
            confidence = "low"

        if alignment.get("summary") and family == "process":
            findings.append(str(alignment.get("summary")))

        return {
            "direct_answer": direct_answer,
            "findings": findings,
            "drivers": drivers,
            "comparison": comparison_summary or "",
            "confidence": f"{confidence.title()} confidence",
            "baseline_summary": (baseline_comparison or {}).get("summary") or "",
            "change_point": change_point,
            "shift_detected": bool(change_point.get("shift_detected")),
            "sustained_vs_spike": shape_label or (concentration.get("pattern") if concentration else ""),
            "recovery_after_shift": bool(shape.get("recoveryAfterShift")),
            "baseline_available": bool((baseline_comparison or {}).get("available")),
            "baseline_type": (baseline_comparison or {}).get("scopeKind"),
            "primary_metric_delta": (baseline_comparison or {}).get("primary_metric_delta") or (baseline_comparison or {}).get("deltaDisplay"),
            "variability_delta": (baseline_comparison or {}).get("variability_delta") or (baseline_comparison or {}).get("variabilityDeltaDisplay"),
            "qualification_delta": (baseline_comparison or {}).get("qualification_delta") or " | ".join((baseline_comparison or {}).get("monitoringCaveats") or []),
            "next_checks": next_checks,
        }

    def _compare_production_context_section(
        self,
        left_label: str,
        left_row: Dict[str, Any],
        right_label: str,
        right_row: Dict[str, Any],
    ) -> Optional[Dict[str, str]]:
        left_text = self._production_context_text(left_row)
        right_text = self._production_context_text(right_row)
        if not left_text and not right_text:
            return None
        parts: List[str] = []
        if left_text:
            parts.append(f"{left_label}: {left_text}")
        if right_text:
            parts.append(f"{right_label}: {right_text}")
        return {"label": "Production context", "text": " | ".join(parts)}

    def _status_peer_ranking_section(self, machine_id: Optional[int], filters: Dict[str, Any]) -> Optional[Dict[str, str]]:
        resolved_id = self._to_int(machine_id)
        if resolved_id is None:
            return None
        intelligence = self._get_press_intelligence(filters)
        overview_rows = intelligence.get("overviewRankings", []) or []
        overview_row = next(
            (
                row
                for row in overview_rows
                if self._to_int(row.get("machineId")) == resolved_id
            ),
            None,
        )
        if not overview_row:
            return None
        category_breakdown = self.get_press_category_breakdown_tool(resolved_id, filters)
        categories = category_breakdown.get("categories") or []
        category_map = {
            str(item.get("key") or ""): item
            for item in categories
        }
        rank_bits = [
            f"Overall rank: #{overview_row.get('rank')} of {len(overview_rows)}",
        ]
        for key, label in (
            ("bad_feet_pct", "Bad feet rank"),
            ("monitoring_coverage", "Monitoring density rank"),
            ("delta_drift", "Drift rank"),
        ):
            item = category_map.get(key)
            if not item:
                continue
            rank_bits.append(f"{label}: #{item.get('rank')}")
        return {"label": "Peer ranking in selected window", "text": " | ".join(rank_bits)}

    def _scope_section(self, scope: Dict[str, Any], rows: List[Dict[str, Any]], filters: Dict[str, Any]) -> Optional[Dict[str, str]]:
        if not scope:
            return None
        label = str(scope.get("label") or "").strip()
        if not label:
            return None
        window_text = self._scope_window_text(rows, filters)
        text = f"Showing {label}"
        if window_text:
            text = f"{text} | Window: {window_text}"
        return {"label": "Scope used", "text": text}

    def _scope_window_text(self, rows: List[Dict[str, Any]], filters: Dict[str, Any]) -> Optional[str]:
        start_dt = None
        end_dt = None
        for row in rows:
            row_start = self._row_datetime(row)
            if row_start is None:
                continue
            start_dt = row_start if start_dt is None or row_start < start_dt else start_dt
            end_dt = row_start if end_dt is None or row_start > end_dt else end_dt
        if start_dt and end_dt:
            return f"{self._format_scope_datetime(start_dt)} to {self._format_scope_datetime(end_dt)}"
        if rows and rows[0].get("date") and rows[-1].get("date"):
            return f"{rows[0].get('date')} to {rows[-1].get('date')}"
        start = filters.get("start")
        end = filters.get("end")
        if start and end:
            return f"{start} to {end}"
        return None

    def _row_datetime(self, row: Dict[str, Any]) -> Optional[datetime]:
        for key in ("productionStart", "date"):
            raw_value = row.get(key)
            if not raw_value:
                continue
            try:
                text = str(raw_value)
                if len(text) == 10:
                    return datetime.fromisoformat(f"{text}T00:00:00")
                return datetime.fromisoformat(text)
            except ValueError:
                continue
        return None

    def _format_scope_datetime(self, value: datetime) -> str:
        return value.strftime("%b %d %I:%M %p").replace(" 0", " ")

    def _scope_delta(self, scope: Dict[str, Any]) -> Optional[timedelta]:
        if not scope or scope.get("kind") != "time":
            return None
        value = max(1, int(scope.get("value") or 0))
        if scope.get("unit") == "hours":
            return timedelta(hours=value)
        if scope.get("unit") == "days":
            return timedelta(days=value)
        return None

    def _scoped_reels(self, reels: List[Dict[str, Any]], scope: Dict[str, Any], filters: Dict[str, Any]) -> List[Dict[str, Any]]:
        if not scope:
            return reels
        if scope.get("kind") == "reels":
            count = max(1, int(scope.get("count") or 1))
            return reels[-count:]
        if scope.get("kind") == "time":
            delta = self._scope_delta(scope)
            if delta is None:
                return reels
            anchor = max((self._row_datetime(row) for row in reels if self._row_datetime(row) is not None), default=None)
            if anchor is None:
                anchor = filters.get("end_dt")
            if anchor is None:
                return reels
            cutoff = anchor - delta
            return [row for row in reels if (self._row_datetime(row) or cutoff) >= cutoff]
        return reels

    def _scoped_trend_series(
        self,
        series: List[Dict[str, Any]],
        machine_id: Optional[int],
        metric_key: str,
        scope: Dict[str, Any],
        filters: Dict[str, Any],
    ) -> List[Dict[str, Any]]:
        if not scope or scope.get("kind") != "time":
            return series
        if scope.get("unit") == "hours":
            return self._reel_metric_series_for_scope(machine_id, metric_key, scope, filters)
        delta = self._scope_delta(scope)
        if delta is None:
            return series
        dated_rows = [(self._row_datetime(row), row) for row in series]
        dated_rows = [(row_dt, row) for row_dt, row in dated_rows if row_dt is not None]
        if not dated_rows:
            return series
        anchor = max(row_dt for row_dt, _ in dated_rows)
        cutoff = anchor - delta
        filtered = [row for row_dt, row in dated_rows if row_dt >= cutoff]
        return filtered or series

    def _reel_metric_series_for_scope(
        self,
        machine_id: Optional[int],
        metric_key: str,
        scope: Dict[str, Any],
        filters: Dict[str, Any],
    ) -> List[Dict[str, Any]]:
        resolved_id = self._to_int(machine_id)
        if resolved_id is None:
            return []
        reels = self._filtered_reel_metrics(filters, resolved_id)
        scoped_reels = self._scoped_reels(reels, scope, filters)
        value_key = {
            "bad_feet_pct": "estimatedBadFeetPct",
            "monitoring_coverage": "pointsPer1000Ft",
            "delta_variation": "deltaStd",
            "delta_drift": "avgDelta",
            "speed_instability": "webspeedRange",
        }.get(metric_key)
        if not value_key:
            return []
        scoped_rows = []
        for row in scoped_reels:
            value = row.get(value_key)
            if value is None:
                continue
            timestamp = row.get("productionStart")
            scoped_rows.append(
                {
                    "date": timestamp or row.get("reelId"),
                    "value": value,
                    "valueDisplay": self._format_metric_value(metric_key, value),
                    "reelId": row.get("reelId"),
                    "jobName": row.get("jobName"),
                    "productionStart": row.get("productionStart"),
                    "feetTotal": row.get("feetTotal"),
                    "estimatedBadFeet": row.get("estimatedBadFeet"),
                    "estimatedBadFeetPct": row.get("estimatedBadFeetPct"),
                }
            )
        return scoped_rows

    def _format_metric_value(self, metric_key: str, value: Any) -> str:
        if value in (None, ""):
            return "--"
        if metric_key == "bad_feet_pct":
            return self._format_pct(float(value))
        if metric_key == "monitoring_coverage":
            return f"{self._format_number(float(value))} pts/1k ft"
        if metric_key in {"delta_variation", "delta_drift"}:
            return self._format_mm(float(value))
        return self._format_number(float(value))

    def _filtered_reel_metrics(self, filters: Dict[str, Any], machine_id: Optional[int] = None) -> List[Dict[str, Any]]:
        query_filters = PressIntelligenceFilters(
            start=filters["start_dt"],
            end=filters["end_dt"],
            job=filters.get("job") or None,
            min_feet=filters.get("min_feet"),
        )
        with RLMSessionLocal() as session:
            reels = self.press_service._get_reels(session, query_filters)
            if machine_id is not None:
                reels = [row for row in reels if int(row.machine_id or 0) == int(machine_id)]
            reel_ids = [row.reel_db_id for row in reels]
            repeat_length = self.press_service._get_repeat_length_batch(session, reel_ids)
            phase_aggregates = self._get_phase_interval_aggregates(session, reel_ids)
        rows = self.press_service._compute_reel_metrics(
            reels,
            repeat_length,
        )
        for row in rows:
            aggregate = phase_aggregates.get(int(row.get("reelDbId") or 0), {})
            row.update(aggregate)
        return self._apply_reel_scope_to_rows(rows, filters.get("reel_scope"))

    def _get_phase_interval_aggregates(self, session, reel_ids: List[int]) -> Dict[int, Dict[str, Any]]:
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
            bucket = by_reel[int(reel_id)]
            key = str(phase_name or "").strip().lower()
            duration = max(float(duration_seconds or 0.0), 0.0)
            if key == "active":
                bucket["active"] += duration
            elif key == "inactive":
                bucket["inactive"] += duration
            else:
                bucket["other"] += duration
        aggregates: Dict[int, Dict[str, Any]] = {}
        for reel_id in clean_ids:
            bucket = by_reel.get(int(reel_id), {"active": 0.0, "inactive": 0.0, "other": 0.0})
            known = bucket["active"] + bucket["inactive"]
            active_pct = (bucket["active"] / known * 100.0) if known > 0 else None
            inactive_pct = (bucket["inactive"] / known * 100.0) if known > 0 else None
            aggregates[int(reel_id)] = {
                "rlmActiveSeconds": round(bucket["active"], 3),
                "rlmInactiveSeconds": round(bucket["inactive"], 3),
                "rlmOtherSeconds": round(bucket["other"], 3),
                "rlmKnownPhaseSeconds": round(known, 3),
                "rlmActivePct": round(active_pct, 3) if active_pct is not None else None,
                "rlmInactivePct": round(inactive_pct, 3) if inactive_pct is not None else None,
                "rlmActivityState": self._phase_activity_state(bucket["active"], bucket["inactive"], known),
            }
        return aggregates

    def _phase_activity_state(self, active_seconds: float, inactive_seconds: float, known_seconds: float) -> str:
        if known_seconds <= 0:
            return "not_running"
        if active_seconds <= 0 and inactive_seconds > 0:
            return "inactive"
        if active_seconds > 0:
            return "active"
        return "not_running"

    def _apply_reel_scope_to_rows(
        self,
        rows: List[Dict[str, Any]],
        reel_scope: Optional[Dict[str, Any]],
    ) -> List[Dict[str, Any]]:
        if not rows or not isinstance(reel_scope, dict) or reel_scope.get("kind") != "reels":
            return rows
        count = max(1, int(reel_scope.get("count") or 1))
        by_machine: Dict[int, List[Dict[str, Any]]] = {}
        for row in rows:
            machine_id = self._to_int(row.get("machineId"))
            if machine_id is None:
                continue
            by_machine.setdefault(machine_id, []).append(row)
        scoped: List[Dict[str, Any]] = []
        for machine_rows in by_machine.values():
            machine_rows.sort(key=lambda row: row.get("productionStart") or "")
            scoped.extend(machine_rows[-count:])
        scoped.sort(key=lambda row: ((self._to_int(row.get("machineId")) or 0), row.get("productionStart") or ""))
        return scoped

    def _aggregate_filtered_rows(self, rows: List[Dict[str, Any]]) -> Dict[str, Any]:
        if not rows:
            return {}
        feet_total = sum(float(row.get("feetTotal") or 0.0) for row in rows)
        bad_feet = sum(float(row.get("estimatedBadFeet") or 0.0) for row in rows)
        delta_points = sum(int(row.get("deltaPointCount") or 0) for row in rows)
        oob_points = sum(int(row.get("oobPointCount") or 0) for row in rows)
        monitor_points = sum(int(row.get("monitoringPointsTotal") or 0) for row in rows)
        latest = rows[-1]
        return {
            "reelsRun": len(rows),
            "feetTotal": round(feet_total, 3),
            "estimatedBadFeet": round(bad_feet, 3),
            "badFeetPct": round((bad_feet / feet_total * 100.0), 3) if feet_total else None,
            "deltaPointCount": delta_points,
            "oobPointCount": oob_points,
            "monitoringPointsTotal": monitor_points,
            "oobPointPct": round((oob_points / delta_points * 100.0), 3) if delta_points else None,
            "pointsPer1000Ft": round((monitor_points / feet_total * 1000.0), 3) if feet_total else None,
            "latestReelId": latest.get("reelId"),
        }

    def _compute_phase2a_metric(
        self,
        metric_key: str,
        rows: List[Dict[str, Any]],
        qualification: Optional[QualificationSummary] = None,
    ) -> Dict[str, Any]:
        registry_entry = METRIC_REGISTRY.get(metric_key) or {}
        total_feet = sum(float(row.get("feetTotal") or 0.0) for row in rows)
        total_bad_feet = sum(float(row.get("estimatedBadFeet") or 0.0) for row in rows)
        total_good_feet = max(total_feet - total_bad_feet, 0.0)
        total_monitor_points = sum(int(row.get("monitoringPointsTotal") or 0) for row in rows)
        active_seconds = sum(float(row.get("rlmActiveSeconds") or 0.0) for row in rows)
        inactive_seconds = sum(float(row.get("rlmInactiveSeconds") or 0.0) for row in rows)
        known_phase_seconds = active_seconds + inactive_seconds
        reels_with_phase = sum(1 for row in rows if float(row.get("rlmKnownPhaseSeconds") or 0.0) > 0)
        reels_missing_monitoring = sum(1 for row in rows if int(row.get("monitoringPointsTotal") or 0) <= 0)
        qualified_reels = int(qualification.qualified_reels) if qualification else len(rows)
        excluded_reels = int(qualification.excluded_reels) if qualification else 0

        if metric_key == "rlm_active_duration":
            value = active_seconds
            value_display = self._format_duration_seconds(active_seconds)
        elif metric_key == "rlm_inactive_duration":
            value = inactive_seconds
            value_display = self._format_duration_seconds(inactive_seconds)
        elif metric_key == "rlm_active_pct":
            value = (active_seconds / known_phase_seconds * 100.0) if known_phase_seconds > 0 else None
            value_display = self._format_pct(value)
        elif metric_key == "rlm_inactive_pct":
            value = (inactive_seconds / known_phase_seconds * 100.0) if known_phase_seconds > 0 else None
            value_display = self._format_pct(value)
        elif metric_key == "rlm_good_feet":
            value = total_good_feet
            value_display = self._format_feet_value(total_good_feet)
        elif metric_key == "rlm_bad_feet":
            value = total_bad_feet
            value_display = self._format_feet_value(total_bad_feet)
        elif metric_key == "rlm_bad_feet_pct":
            value = (total_bad_feet / total_feet * 100.0) if total_feet > 0 else None
            value_display = self._format_pct(value)
        elif metric_key == "rlm_total_qualifying_feet":
            value = total_feet
            value_display = self._format_feet_value(total_feet)
        elif metric_key == "delta_variation":
            values = [float(row.get("deltaStd")) for row in rows if row.get("deltaStd") is not None]
            value = (sum(values) / len(values)) if values else None
            value_display = self._format_mm(value)
        elif metric_key == "delta_drift":
            values = [abs(float(row.get("avgDelta"))) for row in rows if row.get("avgDelta") is not None]
            value = (sum(values) / len(values)) if values else None
            value_display = self._format_mm(value)
        elif metric_key == "speed_instability":
            values = [float(row.get("webspeedRange")) for row in rows if row.get("webspeedRange") is not None]
            value = (sum(values) / len(values)) if values else None
            value_display = self._format_number(value)
        elif metric_key == "tolerance_changes":
            value = sum(int(row.get("toleranceChangeCount") or 0) for row in rows)
            value_display = self._format_number(value)
        elif metric_key == "monitoring_coverage":
            value = (total_monitor_points / total_feet * 1000.0) if total_feet > 0 else None
            value_display = f"{self._format_number(value)} pts/1k ft" if value is not None else "--"
        elif metric_key == "monitoring_points_total":
            value = total_monitor_points
            value_display = self._format_number(value)
        elif metric_key == "monitoring_points_per_reel":
            value = (total_monitor_points / len(rows)) if rows else None
            value_display = self._format_number(value)
        elif metric_key == "monitoring_points_per_foot":
            value = (total_monitor_points / total_feet) if total_feet > 0 else None
            value_display = self._format_number(value)
        elif metric_key == "reels_missing_monitoring":
            value = reels_missing_monitoring
            value_display = self._format_number(value)
        elif metric_key == "qualified_reels":
            value = qualified_reels
            value_display = self._format_number(value)
        elif metric_key == "excluded_reels":
            value = excluded_reels
            value_display = self._format_number(value)
        else:
            value = None
            value_display = "--"

        notes = []
        if metric_key.startswith("rlm_active") or metric_key.startswith("rlm_inactive"):
            notes.append(f"Phase denominator is known active+inactive phase time across {reels_with_phase} qualified reels with phase data.")
        elif metric_key in {"monitoring_coverage", "monitoring_points_total", "monitoring_points_per_reel", "monitoring_points_per_foot", "reels_missing_monitoring"}:
            notes.append("Monitoring denominator is the qualified reel set after sticky filters and exclusions.")
        elif metric_key in {"qualified_reels", "excluded_reels"}:
            notes.append("Qualification denominator reflects the unified dataset contract for the effective analysis scope.")
        elif metric_key in {"delta_variation", "delta_drift", "speed_instability", "tolerance_changes"}:
            notes.append("Signal denominator is the qualified reel set after sticky filters and exclusions.")
        else:
            notes.append("Feet denominator is qualified reel footage after sticky filters and exclusions.")
        if reels_missing_monitoring > 0:
            notes.append(f"{reels_missing_monitoring} qualified reels had missing monitoring points.")
        if qualification and qualification.exclusion_counts and metric_key in {"excluded_reels", "qualified_reels"}:
            notes.append(
                "Exclusion mix: " + ", ".join(f"{key}={value}" for key, value in qualification.exclusion_counts.items())
            )
        return {
            "metricKey": metric_key,
            "metricLabel": self._phase2a_metric_label(metric_key),
            "value": value,
            "valueDisplay": value_display,
            "denominatorBasis": registry_entry.get("denominator_basis") or "Qualified rows in the effective analysis scope.",
            "notes": notes,
            "higherIsBetter": registry_entry.get("higher_is_better"),
        }

    def _compute_phase2a_trend(self, metric_key: str, rows: List[Dict[str, Any]]) -> Dict[str, Any]:
        if len(rows) < 2:
            return {"direction": "stable", "basis": "Not enough qualified reels for a trend comparison."}
        ordered = sorted(rows, key=lambda row: row.get("productionStart") or "")
        midpoint = max(1, len(ordered) // 2)
        first_window = ordered[:midpoint]
        second_window = ordered[midpoint:]
        if not second_window:
            second_window = ordered[-1:]
        first_metric = self._compute_phase2a_metric(metric_key, first_window)
        second_metric = self._compute_phase2a_metric(metric_key, second_window)
        first_value = first_metric.get("value")
        second_value = second_metric.get("value")
        if first_value is None or second_value is None:
            return {"direction": "stable", "basis": "Not enough qualified metric values for trend interpretation."}
        higher_is_better = METRIC_REGISTRY.get(metric_key, {}).get("higher_is_better")
        delta = float(second_value) - float(first_value)
        threshold = max(abs(float(first_value)) * 0.05, 0.01)
        if abs(delta) < threshold:
            direction = "stable"
        elif higher_is_better:
            direction = "improving" if delta > 0 else "worsening"
        else:
            direction = "improving" if delta < 0 else "worsening"
        return {
            "direction": direction,
            "basis": f"Compared the first {len(first_window)} qualified reels to the last {len(second_window)} qualified reels.",
            "firstValue": first_metric.get("valueDisplay"),
            "secondValue": second_metric.get("valueDisplay"),
        }

    def _phase2b_metric_score(self, metric_key: str, row: Dict[str, Any]) -> float:
        if metric_key == "rlm_active_duration":
            return max(float(row.get("rlmActiveSeconds") or 0.0), 0.0)
        if metric_key == "rlm_inactive_duration":
            return max(float(row.get("rlmInactiveSeconds") or 0.0), 0.0)
        if metric_key == "rlm_active_pct":
            return max(float(row.get("rlmActivePct") or 0.0), 0.0)
        if metric_key == "rlm_inactive_pct":
            return max(float(row.get("rlmInactivePct") or 0.0), 0.0)
        if metric_key == "rlm_good_feet":
            return max(float(row.get("feetTotal") or 0.0) - float(row.get("estimatedBadFeet") or 0.0), 0.0)
        if metric_key == "rlm_bad_feet":
            return max(float(row.get("estimatedBadFeet") or 0.0), 0.0)
        if metric_key == "rlm_bad_feet_pct":
            return max(float(row.get("estimatedBadFeet") or 0.0), 0.0)
        if metric_key == "rlm_total_qualifying_feet":
            return max(float(row.get("feetTotal") or 0.0), 0.0)
        if metric_key == "delta_variation":
            return max(float(row.get("deltaStd") or 0.0), 0.0)
        if metric_key == "delta_drift":
            return abs(float(row.get("avgDelta") or 0.0))
        if metric_key == "speed_instability":
            return max(float(row.get("webspeedRange") or 0.0), 0.0)
        if metric_key == "tolerance_changes":
            return max(float(row.get("toleranceChangeCount") or 0.0), 0.0)
        if metric_key == "monitoring_coverage":
            feet_total = float(row.get("feetTotal") or 0.0)
            monitor_points = float(row.get("monitoringPointsTotal") or 0.0)
            return (monitor_points / feet_total * 1000.0) if feet_total > 0 else 0.0
        if metric_key == "monitoring_points_total":
            return max(float(row.get("monitoringPointsTotal") or 0.0), 0.0)
        if metric_key == "monitoring_points_per_reel":
            return max(float(row.get("monitoringPointsTotal") or 0.0), 0.0)
        if metric_key == "monitoring_points_per_foot":
            feet_total = float(row.get("feetTotal") or 0.0)
            monitor_points = float(row.get("monitoringPointsTotal") or 0.0)
            return (monitor_points / feet_total) if feet_total > 0 else 0.0
        if metric_key == "reels_missing_monitoring":
            return 1.0 if int(row.get("monitoringPointsTotal") or 0) <= 0 else 0.0
        if metric_key == "qualified_reels":
            return 1.0
        if metric_key == "excluded_reels":
            return 0.0
        return 0.0

    def _phase2b_metric_display(self, metric_key: str, value: Optional[float]) -> str:
        if metric_key in {"rlm_active_duration", "rlm_inactive_duration"}:
            return self._format_duration_seconds(value)
        if metric_key in {"rlm_active_pct", "rlm_inactive_pct", "rlm_bad_feet_pct"}:
            return self._format_pct(value)
        if metric_key in {"rlm_good_feet", "rlm_bad_feet", "rlm_total_qualifying_feet"}:
            return self._format_feet_value(value)
        if metric_key == "monitoring_coverage":
            return f"{self._format_number(value)} pts/1k ft"
        if metric_key in {"delta_variation", "delta_drift"}:
            return self._format_mm(value)
        return self._format_number(value)

    def _phase2b_supporting_signals(self, rows: List[Dict[str, Any]]) -> Dict[str, float]:
        if not rows:
            return {}
        def _avg(values: List[float]) -> float:
            return sum(values) / len(values) if values else 0.0
        return {
            "bad_feet_pct": _avg([float(row.get("estimatedBadFeetPct") or 0.0) for row in rows if row.get("estimatedBadFeetPct") is not None]),
            "delta_variation": _avg([float(row.get("deltaStd") or 0.0) for row in rows if row.get("deltaStd") is not None]),
            "delta_drift": _avg([abs(float(row.get("avgDelta") or 0.0)) for row in rows if row.get("avgDelta") is not None]),
            "speed_instability": _avg([float(row.get("webspeedRange") or 0.0) for row in rows if row.get("webspeedRange") is not None]),
            "tolerance_changes": float(sum(int(row.get("toleranceChangeCount") or 0) for row in rows)),
        }

    def _phase2b_top_driver_labels(
        self,
        primary_signals: Dict[str, float],
        comparison_signals: Dict[str, float],
    ) -> List[str]:
        driver_scores: List[tuple[float, str]] = []
        for key, primary_value in primary_signals.items():
            comparison_value = float(comparison_signals.get(key) or 0.0)
            baseline = max(abs(comparison_value), 0.001)
            delta = (float(primary_value) - comparison_value) / baseline
            if delta > 0.1:
                driver_scores.append((delta, self._phase2a_metric_label(key)))
        driver_scores.sort(key=lambda item: item[0], reverse=True)
        return [label for _, label in driver_scores[:3]]

    def _compute_phase2b_comparison(
        self,
        *,
        metric_key: str,
        primary_machine_id: Optional[int],
        primary_rows: List[Dict[str, Any]],
        filters: Dict[str, Any],
        comparison_scope: Dict[str, Any],
        comparison_mode: str,
    ) -> Optional[Dict[str, Any]]:
        if primary_machine_id is None:
            return None
        comparator_rows: List[Dict[str, Any]] = []
        comparator_machine_ids: List[int] = []
        comparator_qualifications: List[QualificationSummary] = []
        if comparison_mode == "press_vs_press":
            comparator_machine_ids = [machine_id for machine_id in comparison_scope.get("comparison_press_ids") or [] if machine_id != primary_machine_id]
        else:
            comparator_machine_ids = list(comparison_scope.get("peer_set") or [])
        for comparator_machine_id in comparator_machine_ids:
            peer_dataset = self._build_filtered_dataset(filters, comparator_machine_id)
            comparator_rows.extend(peer_dataset.get("rows") or [])
            if peer_dataset.get("qualification"):
                comparator_qualifications.append(peer_dataset.get("qualification"))
        if not comparator_rows:
            return None
        primary_dataset = self._build_filtered_dataset(filters, primary_machine_id)
        primary_qualification = primary_dataset.get("qualification")
        peer_qualification = self._combine_qualification_summaries(comparator_qualifications)
        primary_metric = self._compute_phase2a_metric(metric_key, primary_rows, qualification=primary_qualification)
        comparator_metric = self._compute_phase2a_metric(metric_key, comparator_rows, qualification=peer_qualification)
        primary_signals = self._phase2b_supporting_signals(primary_rows)
        comparator_signals = self._phase2b_supporting_signals(comparator_rows)
        delta_value = None
        if primary_metric.get("value") is not None and comparator_metric.get("value") is not None:
            delta_value = float(primary_metric.get("value")) - float(comparator_metric.get("value"))
        higher_is_better = METRIC_REGISTRY.get(metric_key, {}).get("higher_is_better")
        if delta_value is None:
            outcome = "no clear comparison"
        elif abs(delta_value) < max(abs(float(comparator_metric.get("value") or 0.0)) * 0.05, 0.01):
            outcome = "roughly in line"
        elif higher_is_better:
            outcome = "better" if delta_value > 0 else "worse"
        else:
            outcome = "better" if delta_value < 0 else "worse"
        return {
            "mode": comparison_mode,
            "peerCount": len(comparator_machine_ids),
            "peerValue": comparator_metric.get("value"),
            "peerValueDisplay": comparator_metric.get("valueDisplay"),
            "peerDenominator": comparator_metric.get("denominatorBasis"),
            "comparisonMachineIds": comparator_machine_ids,
            "comparisonLabel": (
                self._press_label(comparator_machine_ids[0])
                if comparison_mode == "press_vs_press" and comparator_machine_ids
                else f"peer average across {len(comparator_machine_ids)} presses"
            ),
            "deltaValue": delta_value,
            "deltaDisplay": self._phase2b_metric_display(metric_key, delta_value) if delta_value is not None else "--",
            "outcome": outcome,
            "mainDrivers": self._phase2b_top_driver_labels(primary_signals, comparator_signals),
            "primarySignals": primary_signals,
            "comparisonSignals": comparator_signals,
            "comparisonSummary": self._phase2b_comparison_summary_text(
                metric_key,
                primary_machine_id,
                comparator_machine_ids,
                comparison_mode,
                primary_metric,
                comparator_metric,
                outcome,
            ),
            "fairness": self._compute_phase2c_comparison_fairness(
                primary_rows=primary_rows,
                primary_qualification=primary_qualification,
                comparator_rows=comparator_rows,
                comparator_qualification=peer_qualification,
                comparison_mode=comparison_mode,
            ),
        }

    def _combine_qualification_summaries(
        self,
        qualifications: List[QualificationSummary],
    ) -> QualificationSummary:
        if not qualifications:
            return QualificationSummary()
        combined_counts: Dict[str, int] = defaultdict(int)
        notes: List[str] = []
        for qualification in qualifications:
            for key, value in qualification.exclusion_counts.items():
                combined_counts[str(key)] += int(value)
            for note in qualification.notes:
                if note not in notes:
                    notes.append(note)
        return QualificationSummary(
            matched_reels=sum(int(item.matched_reels) for item in qualifications),
            qualified_reels=sum(int(item.qualified_reels) for item in qualifications),
            excluded_reels=sum(int(item.excluded_reels) for item in qualifications),
            exclusion_counts=dict(combined_counts),
            denominator_label=qualifications[0].denominator_label,
            notes=notes,
        )

    def _compute_phase2c_comparison_fairness(
        self,
        *,
        primary_rows: List[Dict[str, Any]],
        primary_qualification: Optional[QualificationSummary],
        comparator_rows: List[Dict[str, Any]],
        comparator_qualification: Optional[QualificationSummary],
        comparison_mode: str,
    ) -> Dict[str, Any]:
        primary_coverage = self._compute_phase2a_metric("monitoring_coverage", primary_rows, qualification=primary_qualification).get("value") or 0.0
        comparator_coverage = self._compute_phase2a_metric("monitoring_coverage", comparator_rows, qualification=comparator_qualification).get("value") or 0.0
        primary_missing = int(self._compute_phase2a_metric("reels_missing_monitoring", primary_rows, qualification=primary_qualification).get("value") or 0)
        comparator_missing = int(self._compute_phase2a_metric("reels_missing_monitoring", comparator_rows, qualification=comparator_qualification).get("value") or 0)
        primary_qualified = int(primary_qualification.qualified_reels) if primary_qualification else len(primary_rows)
        comparator_qualified = int(comparator_qualification.qualified_reels) if comparator_qualification else len(comparator_rows)
        primary_excluded = int(primary_qualification.excluded_reels) if primary_qualification else 0
        comparator_excluded = int(comparator_qualification.excluded_reels) if comparator_qualification else 0
        notes: List[str] = []
        if abs(primary_coverage - comparator_coverage) > max(comparator_coverage * 0.25, 2.0):
            notes.append(
                f"Monitoring coverage differs materially: {self._phase2b_metric_display('monitoring_coverage', primary_coverage)} vs {self._phase2b_metric_display('monitoring_coverage', comparator_coverage)}."
            )
        if primary_missing != comparator_missing:
            notes.append(f"Missing monitoring differs: {primary_missing} vs {comparator_missing} reels.")
        if abs(primary_qualified - comparator_qualified) >= 3:
            notes.append(f"Qualified reel counts differ: {primary_qualified} vs {comparator_qualified}.")
        if abs(primary_excluded - comparator_excluded) >= 3:
            notes.append(f"Excluded reel counts differ: {primary_excluded} vs {comparator_excluded}.")
        if primary_qualified < 3 or comparator_qualified < 3:
            confidence = "low"
        elif len(notes) >= 3:
            confidence = "low"
        elif notes:
            confidence = "medium"
        else:
            confidence = "high"
        if not notes:
            notes.append("Monitoring coverage and qualification levels look broadly comparable.")
        summary = (
            f"Comparison confidence is {confidence} for this {comparison_mode.replace('_', ' ')} comparison."
            if notes
            else "Comparison confidence is high; monitoring and qualification look broadly comparable."
        )
        return {
            "confidence": confidence,
            "notes": notes,
            "summary": summary,
        }

    def _phase2b_comparison_summary_text(
        self,
        metric_key: str,
        primary_machine_id: int,
        comparator_machine_ids: List[int],
        comparison_mode: str,
        primary_metric: Dict[str, Any],
        comparator_metric: Dict[str, Any],
        outcome: str,
    ) -> str:
        primary_label = self._press_label(primary_machine_id)
        comparison_label = (
            self._press_label(comparator_machine_ids[0])
            if comparison_mode == "press_vs_press" and comparator_machine_ids
            else f"the average of {len(comparator_machine_ids)} peer presses"
        )
        relation = "compared with" if outcome == "roughly in line" else "than"
        return (
            f"{primary_label} is {outcome} on {self._phase2a_metric_label(metric_key).lower()} {relation} {comparison_label}: "
            f"{primary_metric.get('valueDisplay') or '--'} versus {comparator_metric.get('valueDisplay') or '--'}."
        )

    def _compute_phase2b_drivers(self, metric_key: str, rows: List[Dict[str, Any]]) -> Dict[str, Any]:
        ordered = sorted(rows, key=lambda row: row.get("productionStart") or "")
        scored_rows = []
        for index, row in enumerate(ordered):
            score = self._phase2b_metric_score(metric_key, row)
            scored_rows.append((score, index, row))
        scored_rows = [item for item in scored_rows if item[0] > 0]
        scored_rows.sort(key=lambda item: item[0], reverse=True)
        total_score = sum(score for score, _, _ in scored_rows)
        top_reels = []
        for score, _, row in scored_rows[:3]:
            share = (score / total_score * 100.0) if total_score > 0 else 0.0
            top_reels.append(
                {
                    "reelId": row.get("reelId"),
                    "jobName": row.get("jobName"),
                    "valueDisplay": self._phase2b_metric_display(metric_key, score),
                    "sharePct": round(share, 1),
                }
            )
        by_job: Dict[str, float] = defaultdict(float)
        for score, _, row in scored_rows:
            by_job[str(row.get("jobName") or "Unknown job")] += score
        top_jobs = []
        for job_name, score in sorted(by_job.items(), key=lambda item: item[1], reverse=True)[:3]:
            share = (score / total_score * 100.0) if total_score > 0 else 0.0
            top_jobs.append(
                {
                    "jobName": job_name,
                    "valueDisplay": self._phase2b_metric_display(metric_key, score),
                    "sharePct": round(share, 1),
                }
            )
        return {"topReels": top_reels, "topJobs": top_jobs, "totalScore": total_score}

    def _compute_phase2b_run_position(self, metric_key: str, rows: List[Dict[str, Any]]) -> Dict[str, Any]:
        ordered = sorted(rows, key=lambda row: row.get("productionStart") or "")
        if len(ordered) < 4:
            return {"pattern": "limited data", "summary": "Limited data: not enough qualified reels to determine where in the run the issue was concentrated."}
        third = max(1, len(ordered) // 3)
        segments = {
            "beginning": ordered[:third],
            "middle": ordered[third : third * 2],
            "end": ordered[third * 2 :],
        }
        segment_scores = {
            key: sum(self._phase2b_metric_score(metric_key, row) for row in segment_rows)
            for key, segment_rows in segments.items()
        }
        total_score = sum(segment_scores.values())
        if total_score <= 0:
            return {"pattern": "no concentration", "summary": "No meaningful run-position concentration was detected."}
        shares = {key: value / total_score for key, value in segment_scores.items()}
        strongest = max(shares, key=shares.get)
        if shares["beginning"] >= 0.5:
            pattern = "beginning-heavy issue"
        elif shares["middle"] >= 0.5:
            pattern = "middle-heavy issue"
        elif shares["end"] >= 0.5:
            pattern = "end-heavy issue"
        elif shares["beginning"] >= 0.4 and shares["end"] <= 0.25:
            pattern = "recovery after early instability"
        elif shares["end"] >= 0.4 and shares["end"] > shares["beginning"] + 0.1:
            pattern = "worsening toward later reels"
        else:
            pattern = "broadly distributed across the run"
        return {
            "pattern": pattern,
            "summary": (
                f"{pattern.title()} based on contribution share: "
                f"beginning {shares['beginning']:.0%}, middle {shares['middle']:.0%}, end {shares['end']:.0%}."
            ),
        }

    def _compute_phase2b_concentration(self, metric_key: str, rows: List[Dict[str, Any]]) -> Dict[str, Any]:
        scores = sorted((self._phase2b_metric_score(metric_key, row) for row in rows), reverse=True)
        scores = [score for score in scores if score > 0]
        if not scores:
            return {"pattern": "no concentration", "summary": "No meaningful concentration pattern was detected."}
        if len(scores) < 4:
            return {
                "pattern": "limited data",
                "summary": f"Limited data: only {len(scores)} qualified reels had measurable signal, so concentration is not reliable.",
            }
        total_score = sum(scores)
        top_two_share = (sum(scores[:2]) / total_score) if total_score > 0 else 0.0
        mean_score = total_score / len(scores)
        elevated_count = sum(1 for score in scores if score >= mean_score * 0.75)
        if top_two_share >= 0.55:
            pattern = "isolated spikes"
        elif elevated_count >= max(3, int(len(scores) * 0.6)):
            pattern = "sustained elevated instability"
        else:
            pattern = "mixed pattern"
        return {
            "pattern": pattern,
            "summary": (
                f"{pattern.title()} with the top two reels contributing {top_two_share:.0%} "
                f"and {elevated_count} of {len(scores)} reels at materially elevated levels."
            ),
        }

    def _compute_phase2b_alignment(self, rows: List[Dict[str, Any]]) -> Dict[str, Any]:
        delta_values = [float(row.get("deltaStd") or 0.0) for row in rows]
        speed_values = [float(row.get("webspeedRange") or 0.0) for row in rows]
        paired = [(delta, speed) for delta, speed in zip(delta_values, speed_values) if delta > 0 and speed > 0]
        if len(paired) < 3:
            return {"pattern": "not enough data", "summary": "Not enough qualified reels to compare speed instability with delta behavior."}
        delta_threshold = sorted(delta for delta, _ in paired)[max(0, len(paired) * 3 // 4 - 1)]
        speed_threshold = sorted(speed for _, speed in paired)[max(0, len(paired) * 3 // 4 - 1)]
        overlap = sum(1 for delta, speed in paired if delta >= delta_threshold and speed >= speed_threshold)
        if overlap >= max(2, len(paired) // 2):
            pattern = "speed instability lined up with delta problems"
        elif overlap == 0:
            pattern = "speed instability did not line up strongly with delta problems"
        else:
            pattern = "speed instability partially lined up with delta problems"
        return {
            "pattern": pattern,
            "summary": f"{pattern.title()} on {overlap} of {len(paired)} qualified reels in the top quartile of both signals.",
        }

    def _compute_phase2c_delta_episodes(self, metric_key: str, rows: List[Dict[str, Any]]) -> Dict[str, Any]:
        if metric_key not in {"delta_variation", "delta_drift"}:
            return {"summary": None, "episodes": []}
        ordered = sorted(rows, key=lambda row: row.get("productionStart") or "")
        if len(ordered) < 3:
            return {"summary": "Not enough qualified reels to identify deviation episodes.", "episodes": []}
        scores = [self._phase2b_metric_score(metric_key, row) for row in ordered]
        positive_scores = [score for score in scores if score > 0]
        if not positive_scores:
            return {"summary": "No measurable deviation episodes were detected.", "episodes": []}
        mean_score = sum(positive_scores) / len(positive_scores)
        peak_score = max(positive_scores)
        threshold = max(mean_score * 1.15, peak_score * 0.45)
        episodes: List[Dict[str, Any]] = []
        start_index = None
        for index, score in enumerate(scores):
            is_episode = score >= threshold
            if is_episode and start_index is None:
                start_index = index
            if not is_episode and start_index is not None:
                episodes.append(self._build_phase2c_episode(metric_key, ordered, scores, start_index, index - 1))
                start_index = None
        if start_index is not None:
            episodes.append(self._build_phase2c_episode(metric_key, ordered, scores, start_index, len(ordered) - 1))
        for index, episode in enumerate(episodes):
            end_index = int(episode.get("_endIndex") or 0)
            stable_span = 0
            for score in scores[end_index + 1 :]:
                if score < threshold:
                    stable_span += 1
                else:
                    break
            episode["recoveryAfter"] = stable_span >= 2
            episode["nextStableSpan"] = stable_span
            episode["episodeIndex"] = index + 1
        if not episodes:
            return {"summary": "Deviation was not strongly segmented into distinct episodes.", "episodes": []}
        if len(episodes) == 1:
            episode = episodes[0]
            if int(episode.get("reelCount") or 0) <= 2:
                summary = f"The run was mostly good except for a short deviation spike averaging {episode.get('averageDeviationDisplay')} across {episode.get('reelCount')} reels."
            else:
                summary = f"The run had one main deviation episode in the {episode.get('startPositionBucket')} averaging {episode.get('averageDeviationDisplay')} across {episode.get('reelCount')} reels."
            if episode.get("recoveryAfter"):
                summary += f" It recovered afterward for {episode.get('nextStableSpan')} stable reels."
        else:
            summary = f"The run had {len(episodes)} distinct deviation episodes rather than being broadly unstable throughout."
        for episode in episodes:
            episode.pop("_endIndex", None)
        return {"summary": summary, "episodes": episodes}

    def _build_phase2c_episode(
        self,
        metric_key: str,
        ordered_rows: List[Dict[str, Any]],
        scores: List[float],
        start_index: int,
        end_index: int,
    ) -> Dict[str, Any]:
        episode_rows = ordered_rows[start_index : end_index + 1]
        episode_scores = scores[start_index : end_index + 1]
        average_score = sum(episode_scores) / len(episode_scores) if episode_scores else 0.0
        peak_score = max(episode_scores) if episode_scores else 0.0
        total_feet = sum(float(row.get("feetTotal") or 0.0) for row in episode_rows)
        start_bucket = self._episode_position_bucket(len(ordered_rows), start_index, end_index)
        return {
            "startReel": episode_rows[0].get("reelId") if episode_rows else None,
            "endReel": episode_rows[-1].get("reelId") if episode_rows else None,
            "startPositionBucket": start_bucket,
            "reelCount": len(episode_rows),
            "averageDeviation": round(average_score, 3),
            "averageDeviationDisplay": self._phase2b_metric_display(metric_key, average_score),
            "peakDeviation": round(peak_score, 3),
            "peakDeviationDisplay": self._phase2b_metric_display(metric_key, peak_score),
            "estimatedFeet": round(total_feet, 1),
            "estimatedFeetDisplay": self._format_feet_value(total_feet),
            "_endIndex": end_index,
        }

    def _episode_position_bucket(self, total_rows: int, start_index: int, end_index: int) -> str:
        midpoint = (start_index + end_index) / 2.0
        if midpoint < total_rows / 3.0:
            return "beginning"
        if midpoint < (total_rows * 2.0 / 3.0):
            return "middle"
        return "end"

    def _phase2a_metric_label(self, metric_key: str) -> str:
        labels = {
            "rlm_active_duration": "RLM Active Duration",
            "rlm_inactive_duration": "RLM Inactive Duration",
            "rlm_active_pct": "RLM Active %",
            "rlm_inactive_pct": "RLM Inactive %",
            "rlm_good_feet": "Good Feet",
            "rlm_bad_feet": "Bad Feet",
            "rlm_bad_feet_pct": "Bad Feet %",
            "rlm_total_qualifying_feet": "Total Qualifying Feet",
            "monitoring_coverage": "Monitoring Coverage",
            "monitoring_points_total": "Monitoring Points Total",
            "monitoring_points_per_reel": "Monitoring Points Per Reel",
            "monitoring_points_per_foot": "Monitoring Points Per Foot",
            "reels_missing_monitoring": "Reels With Missing Monitoring",
            "qualified_reels": "Qualified Reels",
            "excluded_reels": "Excluded Reels",
            "delta_variation": "Delta Behavior",
            "delta_drift": "Repeat Length Drift",
            "speed_instability": "Speed Instability",
            "tolerance_changes": "Tolerance Changes",
        }
        return labels.get(metric_key, metric_key.replace("_", " ").title())

    def _prompt_subject(self, filters: Dict[str, Any], machine_label: Optional[str] = None) -> str:
        if machine_label:
            return machine_label
        machine_id = self._to_int(filters.get("machine_id"))
        if self._is_valid_machine_id(machine_id):
            return self._press_label(machine_id)
        sticky_press = self._to_int(((filters.get("sticky_filters") or {}).get("pressId")))
        if self._is_valid_machine_id(sticky_press):
            return self._press_label(sticky_press)
        return "this press"

    def _selected_job_name(self, filters: Dict[str, Any], explicit_job: Optional[str] = None) -> Optional[str]:
        if explicit_job:
            return explicit_job
        job = str(filters.get("job") or "").strip()
        if job:
            return job
        sticky = filters.get("sticky_filters") or {}
        sticky_job = str(sticky.get("job") or "").strip()
        return sticky_job or None

    def _dedupe_prompts(self, prompts: List[str], limit: int = 5) -> List[str]:
        cleaned: List[str] = []
        seen = set()
        for prompt in prompts:
            text = str(prompt or "").strip()
            if not text:
                continue
            key = text.lower()
            if key in seen:
                continue
            seen.add(key)
            cleaned.append(text)
            if len(cleaned) >= limit:
                break
        return cleaned

    def _contextual_follow_up_prompts(
        self,
        *,
        response_kind: str,
        filters: Dict[str, Any],
        machine_label: Optional[str] = None,
        machine_labels: Optional[List[str]] = None,
        metric_key: Optional[str] = None,
        comparison_mode: str = "none",
        selected_job: Optional[str] = None,
        available_jobs: Optional[List[Dict[str, Any]]] = None,
        current_focus: Optional[str] = None,
        baseline_available: bool = False,
        shift_detected: bool = False,
        issue_shape: Optional[str] = None,
    ) -> List[str]:
        subject = self._prompt_subject(filters, machine_label)
        metric_family = self._metric_family(str(metric_key or ""))
        job_name = self._selected_job_name(filters, selected_job)
        sticky = filters.get("sticky_filters") or {}
        has_scope = bool(((sticky.get("timeScope") or {}).get("label")) or ((sticky.get("reelScope") or {}).get("label")))
        focus = str(current_focus or "").strip().lower()
        shape = str(issue_shape or "").strip().lower()
        compare_labels = [str(label or "").strip() for label in (machine_labels or []) if str(label or "").strip()]
        compare_subject = " and ".join(compare_labels[:2]) if len(compare_labels) >= 2 else None

        def job_or_subject(template: str) -> str:
            if job_name:
                return template.replace("it", "this job")
            return template

        if response_kind == "session-filter-update":
            if job_name:
                return self._dedupe_prompts(
                    [
                        f"How is {job_name} performing?",
                        f"Is {job_name} worse than recent runs?",
                        f"Show delta behavior for {job_name}",
                        "Which recent job performed the worst?",
                        "Are the problems concentrated in one job?",
                    ]
                )
            if has_scope or self._is_valid_machine_id(self._to_int(sticky.get("pressId"))):
                return self._dedupe_prompts(
                    [
                        f"How is {subject} performing?",
                        f"What changed on {subject}?",
                        f"Show delta behavior for {subject}",
                        f"Compare {subject} to average",
                        f"Show recent jobs for {subject}",
                    ]
                )
            return self._dedupe_prompts(
                [
                    "How is Press 8 performing?",
                    "What changed on Press 8 today?",
                    "Show delta behavior for Press 8",
                    "Compare Press 8 to average",
                    "Show recent jobs for Press 8",
                ]
            )

        if response_kind == "ranking_summary":
            return self._dedupe_prompts(
                [
                    f"How is {subject} performing?" if self._is_valid_machine_id(self._to_int(filters.get("machine_id"))) or self._is_valid_machine_id(self._to_int(sticky.get("pressId"))) else "",
                    "Which press should I check first?",
                    "What stands out in the ranking?",
                    "Compare the top two presses",
                    "Show delta behavior for the weakest press",
                ]
            )

        if response_kind == "job_list":
            first_job = None
            if available_jobs:
                first_job = str((available_jobs[0] or {}).get("jobName") or "").strip() or None
            return self._dedupe_prompts(
                [
                    f"Use Job {first_job}" if first_job else "",
                    "Which one was worst?",
                    "Which one was best?",
                    "Use the worst one",
                    "Are problems concentrated in one job or spread across jobs?",
                ]
            )

        if response_kind == "job_analysis":
            if job_name:
                return self._dedupe_prompts(
                    [
                        "How is it performing?",
                        "Is this job worse than this machine's recent runs?",
                        "What stands out?",
                        "Are the problems concentrated in one job or spread across jobs?",
                        "Which recent job performed the worst?",
                    ]
                )
            return self._dedupe_prompts(
                [
                    f"Show me the weakest recent job on {subject}",
                    f"Show me the strongest recent job on {subject}",
                    "Are the problems concentrated in one recent job or spread across jobs?",
                    "Show me recent jobs",
                ]
            )

        if response_kind == "compare":
            if metric_family == "operational":
                return self._dedupe_prompts(
                    [
                        "Which metric differs most?",
                        "Is the gap big or small?",
                        f"What stands out between {compare_subject}?" if compare_subject else "What stands out between them?",
                        "Which side should I check first?",
                    ]
                )
            return self._dedupe_prompts(
                [
                    f"What stands out between {compare_subject}?" if compare_subject else "What stands out between them?",
                    "Which metric differs most?",
                    "Is the gap big or small?",
                    "Which side should I check first?",
                    "Was this comparison fair?",
                ]
            )

        if response_kind == "discovery":
            prompts: List[str] = []
            prompts.append("What really changed?")
            if focus != "run_position":
                prompts.append("Where did behavior shift?" if shift_detected or baseline_available else "Where in the run did this show up?")
            if focus != "concentration":
                if shape == "isolated spike":
                    prompts.append(job_or_subject("Was this just a few reels or the whole run?"))
                elif shape == "sustained deterioration":
                    prompts.append(job_or_subject("Was this just a few reels or the whole run?"))
                else:
                    prompts.append(job_or_subject("Was it spikes or sustained?"))
            if focus != "episodes":
                prompts.append("Did it recover after the shift?" if shift_detected else "Did it recover?")
            prompts.append("Where did behavior shift?")
            return self._dedupe_prompts(prompts[:5])

        if response_kind == "activity":
            if metric_family == "operational" and comparison_mode in {"press_vs_press", "press_vs_average"}:
                return self._dedupe_prompts(
                    [
                        "Which metric differs most?",
                        "Is the gap big or small?",
                        "What stands out versus average?" if comparison_mode == "press_vs_average" else f"What stands out between {compare_subject}?" if compare_subject else "What stands out between them?",
                        "Which side should I check first?",
                    ]
                )
            if comparison_mode in {"press_vs_press", "press_vs_average"}:
                return self._dedupe_prompts(
                    [
                        "What stands out versus average?" if comparison_mode == "press_vs_average" else f"What stands out between {compare_subject}?" if compare_subject else "What stands out between them?",
                        "Which metric differs most?",
                        "Is the gap big or small?",
                        "Which side should I check first?",
                        "Was this comparison fair?",
                    ]
                )
            if metric_family == "process":
                return self._dedupe_prompts(
                    [
                        "What stands out?",
                        "What changed?",
                        "Compare it to average",
                        "Is it getting worse reel to reel?",
                        "Where did behavior shift?",
                    ]
                )
            if metric_family == "outcome":
                return self._dedupe_prompts(
                    [
                        "What stands out?",
                        "What changed?",
                        "Is it getting worse reel to reel?",
                        "Compare it to average" if comparison_mode == "none" else "Was this comparison fair?",
                        "Show delta behavior",
                    ]
                )

        if response_kind in {"trend", "reel_summary"}:
            return self._dedupe_prompts(
                [
                    "What stands out?",
                    "What changed?",
                    "Is it getting worse reel to reel?",
                    "Compare it to average",
                    "Show delta behavior",
                ]
            )

        if response_kind == "status":
            return self._dedupe_prompts(
                [
                    f"What changed on {subject}?",
                    f"Is {subject} getting worse reel to reel?",
                    f"Show delta behavior for {subject}",
                    f"Compare {subject} to average",
                    f"What stands out on {subject}?",
                ]
            )

        return self._dedupe_prompts([])

    def _metric_family(self, metric_key: str) -> str:
        if metric_key in {
            "monitoring_coverage",
            "monitoring_points_total",
            "monitoring_points_per_reel",
            "monitoring_points_per_foot",
            "reels_missing_monitoring",
            "qualified_reels",
            "excluded_reels",
            "rlm_active_duration",
            "rlm_inactive_duration",
            "rlm_active_pct",
            "rlm_inactive_pct",
        }:
            return "operational"
        if metric_key in {"rlm_good_feet", "rlm_bad_feet", "rlm_bad_feet_pct", "rlm_total_qualifying_feet"}:
            return "outcome"
        if metric_key in {"delta_variation", "delta_drift", "speed_instability", "tolerance_changes"}:
            return "process"
        return "generic"

    def _metric_polarity(self, metric_key: str) -> str:
        higher_worse = {
            "rlm_inactive_duration",
            "rlm_inactive_pct",
            "rlm_bad_feet",
            "rlm_bad_feet_pct",
            "delta_variation",
            "delta_drift",
            "speed_instability",
            "tolerance_changes",
            "reels_missing_monitoring",
            "excluded_reels",
        }
        higher_better = {
            "rlm_active_duration",
            "rlm_active_pct",
            "rlm_good_feet",
            "rlm_total_qualifying_feet",
            "monitoring_coverage",
            "monitoring_points_total",
            "monitoring_points_per_reel",
            "monitoring_points_per_foot",
            "qualified_reels",
        }
        if metric_key in higher_worse:
            return "higher_worse"
        if metric_key in higher_better:
            return "higher_better"
        return "neutral"

    def _should_render_series_chart(self, series: List[Dict[str, Any]]) -> bool:
        if len(series) < 2:
            return False
        values = [float(row.get("value") or row.get("estimatedBadFeetPct") or 0.0) for row in series]
        distinct = {round(value, 6) for value in values}
        return len(distinct) > 1

    def _trend_assessment(
        self,
        metric_key: str,
        values: List[float],
    ) -> Dict[str, Any]:
        cleaned = [float(value) for value in values if value is not None]
        if len(cleaned) < 3:
            return {
                "direction": "unclear",
                "confidence": "low",
                "summary": "There is not enough evidence to call a trend confidently.",
            }
        first = cleaned[0]
        last = cleaned[-1]
        span = max(cleaned) - min(cleaned)
        change = last - first
        threshold = max(span * 0.2, abs(first) * 0.08, 0.01)
        if abs(change) < threshold:
            return {
                "direction": "stable",
                "confidence": "medium",
                "summary": "It is not clearly changing over the selected scope.",
            }
        polarity = self._metric_polarity(metric_key)
        if polarity == "higher_worse":
            direction = "worsening" if change > 0 else "improving"
        elif polarity == "higher_better":
            direction = "improving" if change > 0 else "worsening"
        else:
            direction = "up" if change > 0 else "down"
        confidence = "high" if abs(change) >= threshold * 1.75 else "medium"
        if direction == "worsening":
            summary = "It is trending worse over the selected scope."
        elif direction == "improving":
            summary = "It is trending better over the selected scope."
        elif direction == "stable":
            summary = "It is broadly stable over the selected scope."
        else:
            summary = f"It is trending {direction} over the selected scope."
        return {
            "direction": direction,
            "confidence": confidence,
            "summary": summary,
        }

    def _reel_question_first_text(
        self,
        machine_name: str,
        trend: str,
        recent: List[Dict[str, Any]],
    ) -> tuple[str, str]:
        values = [float(row.get("estimatedBadFeetPct") or 0.0) for row in recent]
        assessment = self._trend_assessment("rlm_bad_feet_pct", values)
        if assessment["direction"] == "worsening":
            title = f"{machine_name} is getting worse reel to reel in the selected window."
        elif assessment["direction"] == "improving":
            title = f"{machine_name} is improving reel to reel in the selected window."
        elif assessment["direction"] == "stable":
            title = f"{machine_name} is not clearly changing reel to reel in the selected window."
        else:
            title = f"{machine_name} does not have enough reel-to-reel evidence for a clear trend call."
        summary = assessment["summary"]
        if assessment["confidence"] == "low":
            summary += " Confidence is limited because the sample is small."
        return title, summary

    def _trend_question_first_text(
        self,
        machine_name: str,
        metric_label: str,
        metric_key: str,
        series: List[Dict[str, Any]],
    ) -> tuple[str, str]:
        values = [float(row.get("value") or 0.0) for row in series]
        assessment = self._trend_assessment(metric_key, values)
        metric_name = metric_label.lower()
        if assessment["direction"] == "worsening":
            title = f"{machine_name} {metric_name} is trending worse in the selected window."
        elif assessment["direction"] == "improving":
            title = f"{machine_name} {metric_name} is trending better in the selected window."
        elif assessment["direction"] == "stable":
            title = f"{machine_name} {metric_name} is broadly stable in the selected window."
        elif assessment["direction"] == "up":
            title = f"{machine_name} {metric_name} is trending up in the selected window."
        elif assessment["direction"] == "down":
            title = f"{machine_name} {metric_name} is trending down in the selected window."
        else:
            title = f"{machine_name} {metric_name} does not have enough evidence for a clear trend call."
        summary = assessment["summary"]
        if assessment["confidence"] == "low":
            summary += " A chart is less useful here because there are too few points."
        return title, summary

    def _comparison_question_first_text(
        self,
        machine_name: str,
        metric_key: str,
        metric_label: str,
        comparison: Dict[str, Any],
    ) -> tuple[str, str]:
        comparison_label = str(comparison.get("comparisonLabel") or "the comparison set")
        outcome = str(comparison.get("outcome") or "")
        metric_name = metric_label.lower()
        if outcome == "better":
            title = f"{machine_name} is better than {comparison_label} on {metric_name}."
        elif outcome == "worse":
            title = f"{machine_name} is worse than {comparison_label} on {metric_name}."
        elif outcome == "roughly in line":
            title = f"{machine_name} is broadly in line with {comparison_label} on {metric_name}."
        else:
            title = f"{machine_name} does not show a clear difference versus {comparison_label} on {metric_name}."
        summary = comparison.get("comparisonSummary") or (
            f"{machine_name} is {outcome or 'mixed'} on {metric_name} versus {comparison_label}."
        )
        fairness = comparison.get("fairness") or {}
        if fairness.get("confidence"):
            summary += f" Comparison confidence is {fairness.get('confidence')}."
        return title, summary

    def _metric_trend_question_first_summary(
        self,
        machine_name: str,
        metric_key: str,
        metric_label: str,
        trend: Dict[str, Any],
    ) -> str:
        direction = str(trend.get("direction") or "").lower()
        metric_name = metric_label.lower()
        if direction == "worsening":
            return f"{machine_name} is trending worse on {metric_name}. {trend.get('basis') or ''}".strip()
        if direction == "improving":
            return f"{machine_name} is trending better on {metric_name}. {trend.get('basis') or ''}".strip()
        if direction == "stable":
            return f"{machine_name} is broadly stable on {metric_name}. {trend.get('basis') or ''}".strip()
        if direction in {"up", "down"}:
            return f"{machine_name} is trending {direction} on {metric_name}. {trend.get('basis') or ''}".strip()
        family = self._metric_family(metric_key)
        if family == "process":
            return f"There is not enough evidence to say whether {machine_name} is getting better or worse on {metric_name}."
        return f"There is not enough evidence to call a clear trend for {machine_name} on {metric_name}."

    def _resolve_decision_metric_key(self, lowered: str, explicit_metric_key: Optional[str]) -> str:
        if " something else " in lowered or " what really changed " in lowered or (" why was " in lowered and " worse " in lowered):
            return "rlm_bad_feet"
        if explicit_metric_key:
            return explicit_metric_key
        return "rlm_bad_feet"

    def _metric_pattern_summary(
        self,
        metric_key: str,
        concentration: Dict[str, Any],
        run_position: Dict[str, Any],
        episodes: Dict[str, Any],
    ) -> Optional[str]:
        family = self._metric_family(metric_key)
        concentration_pattern = str(concentration.get("pattern") or "")
        run_pattern = str(run_position.get("pattern") or "")
        if concentration_pattern == "limited data" or run_pattern == "limited data":
            return "Limited data reduces confidence in shape and concentration interpretation."
        if family == "operational":
            if run_pattern and run_pattern not in {"no concentration", "broadly distributed across the run"}:
                return f"Coverage and qualification differences were strongest in the {run_pattern.replace('-heavy issue', '')} of the run."
            return None
        if family == "outcome":
            if concentration_pattern in {"isolated spikes", "mixed pattern"}:
                return "Production impact was concentrated in a smaller set of reels rather than evenly spread across the run."
            if concentration_pattern == "sustained elevated instability":
                return "Production impact was sustained across much of the run rather than driven by only a few reels."
            return None
        if episodes.get("summary"):
            return episodes.get("summary")
        if concentration_pattern == "sustained elevated instability":
            return "The process stayed elevated across many reels rather than being limited to a few spikes."
        if concentration_pattern == "isolated spikes":
            return "The process issue was concentrated in a few reels rather than broad across the run."
        return None

    def _decision_summary_text(
        self,
        metric_key: str,
        comparison: Dict[str, Any],
        concentration: Dict[str, Any],
        run_position: Dict[str, Any],
        episodes: Dict[str, Any],
        alignment: Dict[str, Any],
    ) -> Optional[str]:
        family = self._metric_family(metric_key)
        primary_driver = "mixed"
        if comparison.get("mainDrivers"):
            primary_driver = str((comparison.get("mainDrivers") or ["mixed"])[0])
        elif family == "operational":
            primary_driver = "monitoring / qualification"
        elif family == "outcome":
            primary_driver = "production impact"
        elif family == "process":
            primary_driver = self._phase2a_metric_label(metric_key)
        structure = "isolated"
        concentration_pattern = str(concentration.get("pattern") or "")
        if concentration_pattern == "sustained elevated instability":
            structure = "sustained"
        elif episodes.get("episodes") and len(episodes.get("episodes") or []) > 1:
            structure = "segmented"
        fairness = comparison.get("fairness") or {}
        confidence = fairness.get("confidence") or "high"
        signal_alignment = alignment.get("summary") if alignment and family == "process" else None
        parts = [
            f"Primary driver: {primary_driver}.",
            f"Issue shape: {structure}.",
            f"Comparison confidence: {confidence}.",
        ]
        if signal_alignment:
            parts.append(f"Cross-signal note: {signal_alignment}")
        return " ".join(parts)

    def _signal_relationship_summary(self, metric_key: str, alignment: Dict[str, Any]) -> Optional[str]:
        if not alignment:
            return None
        if metric_key in {"delta_variation", "delta_drift", "speed_instability"}:
            return f"{alignment.get('summary')} This is alignment, not proof of causation."
        if metric_key == "tolerance_changes":
            return "Tolerance changes may have contributed if they occurred in the same reels or just before improvement, but this does not prove causation."
        return None

    def _format_duration_seconds(self, value: Optional[float]) -> str:
        if value is None:
            return "--"
        seconds = int(round(float(value)))
        hours, remainder = divmod(seconds, 3600)
        minutes, _ = divmod(remainder, 60)
        if hours:
            return f"{hours}h {minutes}m"
        return f"{minutes}m"

    def _format_feet_value(self, value: Optional[float]) -> str:
        if value is None:
            return "--"
        return f"{float(value):.0f} ft"

    def _filtered_status_from_row(self, row: Dict[str, Any]) -> Dict[str, str]:
        coverage = row.get("pointsPer1000Ft")
        bad_pct = row.get("estimatedBadFeetPct")
        delta_std = row.get("deltaStd")
        if coverage in (None, 0):
            return {"state": "critical", "stateLabel": "Critical", "statusMessage": "No monitoring on latest filtered reel"}
        if coverage is not None and coverage < 20:
            return {"state": "warning", "stateLabel": "Warning", "statusMessage": f"Low monitoring density ({coverage:.1f} pts/1k ft)"}
        if bad_pct is not None and bad_pct >= 10:
            return {"state": "critical", "stateLabel": "Critical", "statusMessage": "Estimated bad-feet rate is critically high in the latest filtered reel"}
        if (bad_pct is not None and bad_pct >= 3) or (delta_std is not None and delta_std >= 0.5):
            return {"state": "warning", "stateLabel": "Warning", "statusMessage": "Repeat length quality is elevated in the latest filtered reel"}
        return {"state": "healthy", "stateLabel": "Healthy", "statusMessage": "Filtered repeat length metrics look stable"}

    def _normalize_filters(self, filters: Dict[str, Any]) -> Dict[str, Any]:
        machine_id = self._to_int(filters.get("machine_id"))
        start_raw = str(filters.get("start") or datetime.utcnow().date().isoformat()).strip()
        end_raw = str(filters.get("end") or start_raw).strip()
        sticky_filters = filters.get("sticky_filters") if isinstance(filters.get("sticky_filters"), dict) else self._default_sticky_filters()
        return {
            "analysis_domain": str(filters.get("analysis_domain") or "auto"),
            "machine_id": machine_id,
            "start": start_raw,
            "end": end_raw,
            "job": str(filters.get("job") or "").strip(),
            "order": str(filters.get("order") or "").strip(),
            "reel_ids": filters.get("reel_ids") or filters.get("reel_id") or [],
            "min_feet": filters.get("min_feet"),
            "reel_scope": filters.get("reel_scope"),
            "sticky_filters": sticky_filters,
            "start_dt": self._parse_filter_date(start_raw, is_end=False),
            "end_dt": self._parse_filter_date(end_raw, is_end=True),
        }

    def _normalize_message(self, message: str) -> str:
        lowered = f" {message.lower().strip()} "
        lowered = re.sub(r"([a-z])([0-9])", r"\1 \2", lowered)
        lowered = re.sub(r"[^a-z0-9%]+", " ", lowered)
        return f" {lowered.strip()} "

    def _apply_time_phrase_override(self, filters: Dict[str, Any], message: str) -> Dict[str, Any]:
        updated = dict(filters or {})
        lowered = self._normalize_message(message or "")
        today = datetime.utcnow().date()
        if " today " in lowered:
            updated["start"] = today.isoformat()
            updated["end"] = today.isoformat()
        elif " this week " in lowered:
            week_start = today - timedelta(days=today.weekday())
            updated["start"] = week_start.isoformat()
            updated["end"] = today.isoformat()
        return updated

    def _parse_analysis_scope(self, lowered: str) -> Optional[Dict[str, Any]]:
        reel_match = re.search(r"\b(?:over|for)?\s*(?:the\s+)?last\s+(\d+)\s+reels\b", lowered)
        if reel_match:
            count = max(1, min(int(reel_match.group(1)), 25))
            return {
                "kind": "reels",
                "count": count,
                "label": f"last {count} reel{'s' if count != 1 else ''}",
            }
        time_match = re.search(r"\b(?:over|for)?\s*(?:the\s+)?last\s+(\d+)\s+(hour|hours|day|days)\b", lowered)
        if time_match:
            value = max(1, int(time_match.group(1)))
            unit = time_match.group(2)
            normalized_unit = "hours" if unit.startswith("hour") else "days"
            if normalized_unit == "hours":
                value = min(value, 168)
            else:
                value = min(value, 30)
            return {
                "kind": "time",
                "unit": normalized_unit,
                "value": value,
                "label": f"last {value} {normalized_unit}",
            }
        if " last week " in lowered:
            return {"kind": "time", "unit": "days", "value": 7, "label": "last week"}
        return None

    def _parse_ranking_summary(self, lowered: str) -> Optional[Dict[str, Any]]:
        def _normalized_limit(raw_limit: Optional[str], default: int = 1) -> int:
            if raw_limit in (None, ""):
                return default
            text = str(raw_limit).strip().lower()
            word_map = {
                "one": 1,
                "two": 2,
                "three": 3,
                "four": 4,
                "five": 5,
                "six": 6,
                "seven": 7,
                "eight": 8,
                "nine": 9,
                "ten": 10,
            }
            if text in word_map:
                value = word_map[text]
            else:
                try:
                    value = int(text)
                except ValueError:
                    value = default
            return max(1, min(value, 10))

        category_key = self._resolve_ranking_category_key(lowered)
        category_label = self._ranking_category_label(category_key) if category_key else None
        category_match = re.search(
            r"\b(best|worst|top|bottom)\s+(?:(\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s+)?press(?:es)?\s+for\s+",
            lowered,
        )
        if category_key and category_match:
            raw_focus = category_match.group(1)
            raw_limit = category_match.group(2)
            focus_map = {
                "best": "best",
                "worst": "worst",
                "top": "top",
                "bottom": "bottom",
            }
            return {
                "kind": "ranking_summary",
                "summary_focus": focus_map[raw_focus],
                "limit": _normalized_limit(raw_limit, default=1 if raw_focus in {"best", "worst"} else 3),
                "summaryCategoryKey": category_key,
                "summaryCategoryLabel": category_label,
                "requestedLabel": raw_focus,
                "tools": ["get_press_rankings"],
                "validationError": None,
            }
        if category_key and " who has the best " in lowered:
            return {
                "kind": "ranking_summary",
                "summary_focus": "best",
                "limit": 1,
                "summaryCategoryKey": category_key,
                "summaryCategoryLabel": category_label,
                "requestedLabel": "best",
                "tools": ["get_press_rankings"],
                "validationError": None,
            }
        if category_key and " which press is worst for " in lowered:
            return {
                "kind": "ranking_summary",
                "summary_focus": "worst",
                "limit": 1,
                "summaryCategoryKey": category_key,
                "summaryCategoryLabel": category_label,
                "requestedLabel": "worst",
                "tools": ["get_press_rankings"],
                "validationError": None,
            }
        if category_key and any(
            phrase in lowered
            for phrase in (
                " which press has the weakest ",
                " which press has the worst ",
                " which press is the weakest ",
                " which press is worst on ",
            )
        ):
            return {
                "kind": "ranking_summary",
                "summary_focus": "worst",
                "limit": 1,
                "summaryCategoryKey": category_key,
                "summaryCategoryLabel": category_label,
                "requestedLabel": "worst",
                "tools": ["get_press_rankings"],
                "validationError": None,
            }

        if any(phrase in lowered for phrase in (" best press ", " strongest press ")):
            return {
                "kind": "ranking_summary",
                "summary_focus": "best",
                "limit": 1,
                "tools": ["get_press_rankings"],
                "validationError": None,
            }
        if any(phrase in lowered for phrase in (" worst press ", " weakest press ")):
            return {
                "kind": "ranking_summary",
                "summary_focus": "worst",
                "limit": 1,
                "tools": ["get_press_rankings"],
                "validationError": None,
            }
        if any(
            phrase in lowered
            for phrase in (
                " which press is performing the best ",
                " which press is the best ",
                " which press is strongest ",
                " who is the best press ",
            )
        ):
            return {
                "kind": "ranking_summary",
                "summary_focus": "best",
                "limit": 1,
                "tools": ["get_press_rankings"],
                "validationError": None,
            }
        if any(
            phrase in lowered
            for phrase in (
                " which press is performing the worst ",
                " which press is the worst ",
                " which press is weakest ",
                " who is the worst press ",
            )
        ):
            return {
                "kind": "ranking_summary",
                "summary_focus": "worst",
                "limit": 1,
                "tools": ["get_press_rankings"],
                "validationError": None,
            }
        grouped_match = re.search(
            r"\b(top|bottom|best|worst)\s+(\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s+press(?:es)?\b",
            lowered,
        )
        if grouped_match:
            raw_focus = grouped_match.group(1)
            raw_limit = grouped_match.group(2)
            focus_map = {
                "top": "top",
                "best": "top",
                "bottom": "bottom",
                "worst": "bottom",
            }
            return {
                "kind": "ranking_summary",
                "summary_focus": focus_map[raw_focus],
                "limit": _normalized_limit(raw_limit, default=3),
                "requestedLabel": raw_focus,
                "tools": ["get_press_rankings"],
                "validationError": None,
            }
        return None

    def _extract_press_ids(self, message: str) -> List[int]:
        return [int(match) for match in re.findall(r"\b(?:press\s*|p\s*)(\d+)\b", message, flags=re.IGNORECASE)]

    def _resolve_primary_machine_id(
        self,
        message: str,
        press_ids: List[int],
        filters: Dict[str, Any],
    ) -> Optional[int]:
        machine_id, _ = self._resolve_primary_machine_selection(message, press_ids, filters)
        return machine_id

    def _resolve_primary_machine_selection(
        self,
        message: str,
        press_ids: List[int],
        filters: Dict[str, Any],
    ) -> tuple[Optional[int], Optional[str]]:
        if press_ids:
            return self._machine_id_for_press_reference(press_ids[0]), "message"
        normalized = self._normalize_message(message or "")
        stripped = normalized.strip()
        if re.fullmatch(r"\d+", stripped):
            return self._machine_id_for_press_reference(int(stripped)), "fallback"
        if any(token in normalized for token in (" compare ", " versus ", " vs ", " next to ")):
            numeric_tokens = [int(match) for match in re.findall(r"\b(\d+)\b", message or "")]
            unique_tokens = []
            for value in numeric_tokens:
                if value not in unique_tokens:
                    unique_tokens.append(value)
            if len(unique_tokens) == 1:
                return self._machine_id_for_press_reference(unique_tokens[0]), "fallback"
        filter_machine_id = filters.get("machine_id")
        if self._is_valid_machine_id(filter_machine_id):
            return filter_machine_id, "filters"
        return None, None

    def _resolve_metric_key(self, lowered: str) -> Optional[str]:
        for key, aliases in METRIC_ALIAS_MAP.items():
            for alias in sorted(aliases, key=len, reverse=True):
                if f" {alias} " in lowered:
                    return key
        return None

    def _resolve_phase2a_metric_key(self, lowered: str) -> Optional[str]:
        for key, aliases in PHASE2A_METRIC_ALIAS_MAP.items():
            for alias in sorted(aliases, key=len, reverse=True):
                if f" {alias} " in lowered:
                    return key
        return None

    def _phase2b_explanation_focus(self, lowered: str) -> Optional[str]:
        if any(token in lowered for token in (" which reels drove ", " top reels ", " drove this ")):
            return "reels"
        if any(token in lowered for token in (" why was ", " because of ", " what really changed ", " real difference ")):
            return "decision"
        if any(token in lowered for token in (" less fair ", " affected by missing monitoring ", " comparison less fair ", " fairer ")):
            return "fairness"
        if any(token in lowered for token in (" one bad delta period or multiple ", " multiple deviation ", " recover ", " recovered after the shift ", " stabilize ", " around 5 mm off ", " deviation episode ", " deviation periods ")):
            return "episodes"
        if any(token in lowered for token in (" high peaks ", " generally elevated ", " sustained ", " isolated spikes ", " throughout the run ", " few reels ", " few spikes ", " broadly unstable ", " whole job ", " whole run ", " few bad reels ", " spikes or sustained ", " sustained or spikes ", " concentrated or broad ")):
            return "concentration"
        if any(token in lowered for token in (" which jobs drove ",)):
            return "jobs"
        if any(token in lowered for token in (" start of the job ", " beginning ", " middle ", " end of the job ", " where in the run ", " toward the end ", " after the start ", " where did behavior shift ")):
            return "run_position"
        if (" line up " in lowered and (" speed instability " in lowered or " delta " in lowered)) or any(
            token in lowered for token in (" tolerance changes affect ", " improvement happen after tolerance changes ")
        ):
            return "alignment"
        return None

    def _parse_filter_date(self, value: str, *, is_end: bool) -> datetime:
        raw = value.strip()
        if len(raw) == 10:
            raw = f"{raw}T23:59:59" if is_end else f"{raw}T00:00:00"
        return datetime.fromisoformat(raw)

    def _window_label(self, filters: Dict[str, Any]) -> str:
        return f"{filters.get('start')} to {filters.get('end')}"

    def _window_phrase(self, filters: Dict[str, Any]) -> str:
        today = datetime.utcnow().date()
        start = filters.get("start_dt").date() if filters.get("start_dt") else None
        end = filters.get("end_dt").date() if filters.get("end_dt") else None
        if start == today and end == today:
            return "today"
        week_start = today - timedelta(days=today.weekday())
        if start == week_start and end == today:
            return "this week"
        return "in the selected window"

    def _ranking_summary_text(self, rows: List[Dict[str, Any]], focus: str, window_phrase: str) -> str:
        if not rows:
            return "Ranking data was not available."
        if focus == "worst":
            row = rows[0]
            return (
                f"{row.get('machineName')} is currently the weakest press {window_phrase}, "
                f"with {self._format_pct(row.get('estimatedBadFeetPct'))} bad feet and "
                f"{self._format_number(row.get('pointsPer1000Ft'))} pts/1k ft."
            )
        if focus == "bottom" and len(rows) > 1:
            return (
                f"The bottom {len(rows)} presses {window_phrase} are "
                + ", ".join(f"#{row.get('rank')} {row.get('machineName')}" for row in rows)
                + "."
            )
        if focus == "top" and len(rows) > 1:
            return (
                f"The top {len(rows)} presses {window_phrase} are "
                + ", ".join(f"#{row.get('rank')} {row.get('machineName')}" for row in rows)
                + "."
            )
        row = rows[0]
        return (
            f"{row.get('machineName')} is currently the strongest press {window_phrase}, "
            f"with {self._format_pct(row.get('estimatedBadFeetPct'))} bad feet and "
            f"{self._format_number(row.get('pointsPer1000Ft'))} pts/1k ft."
        )

    def _category_ranking_summary_text(
        self,
        rows: List[Dict[str, Any]],
        focus: str,
        category_label: str,
        window_phrase: str,
    ) -> str:
        if not rows:
            return f"{category_label} ranking data was not available."
        row = rows[0]
        if focus in {"worst", "bottom"} and len(rows) > 1:
            return (
                f"The bottom {len(rows)} presses for {category_label} {window_phrase} are "
                + ", ".join(f"#{item.get('rank')} {item.get('machineName')}" for item in rows)
                + "."
            )
        if focus in {"top"} and len(rows) > 1:
            return (
                f"The top {len(rows)} presses for {category_label} {window_phrase} are "
                + ", ".join(f"#{item.get('rank')} {item.get('machineName')}" for item in rows)
                + "."
            )
        descriptor = "best" if focus in {"best", "top"} else "worst"
        return (
            f"{row.get('machineName')} is currently the {descriptor} press for {category_label} {window_phrase}, "
            f"at {row.get('valueDisplay') or '--'}."
        )

    def _resolve_ranking_category_key(self, lowered: str) -> Optional[str]:
        for key, aliases in RANKING_CATEGORY_ALIAS_MAP.items():
            for alias in sorted(aliases, key=len, reverse=True):
                if f" {alias} " in lowered:
                    return key
        return None

    def _ranking_category_label(self, key: Optional[str]) -> str:
        if not key:
            return "Category"
        labels = {
            "bad_feet_pct": "Bad Feet %",
            "monitoring_coverage": "Monitoring Coverage",
            "delta_variation": "Repeat Length Variation",
            "delta_drift": "Repeat Length Drift",
            "speed_instability": "Speed Instability",
            "tolerance_changes": "Tolerance Changes",
        }
        return labels.get(str(key), str(key).replace("_", " ").title())

    def _category_breakdown_text(self, categories: List[Dict[str, Any]], limit: int = 4) -> str:
        if not categories:
            return "No category breakdown was available."
        top_categories = sorted(categories, key=lambda row: int(row.get("rank") or 999))[:limit]
        return "; ".join(
            f"{item.get('title')}: rank #{item.get('rank')} ({item.get('valueDisplay') or '--'}; {item.get('contextLabel') or 'no context'})"
            for item in top_categories
        )

    def _category_comparison_summary(
        self,
        left_label: str,
        left_categories: List[Dict[str, Any]],
        right_label: str,
        right_categories: List[Dict[str, Any]],
    ) -> Dict[str, str]:
        if not left_categories or not right_categories:
            return {
                "comparisonText": "Category-by-category ranking breakdown was not available for both presses.",
                "winText": "No category win summary was available.",
                "winnerLabel": "--",
            }
        left_map = {str(item.get("key") or ""): item for item in left_categories}
        right_map = {str(item.get("key") or ""): item for item in right_categories}
        shared_keys = [key for key in left_map if key and key in right_map]
        if not shared_keys:
            return {
                "comparisonText": "Category-by-category ranking breakdown was not available for both presses.",
                "winText": "No category win summary was available.",
                "winnerLabel": "--",
            }
        comparison_lines: List[str] = []
        left_wins = 0
        right_wins = 0
        ties = 0
        for key in shared_keys:
            left_item = left_map[key]
            right_item = right_map[key]
            left_rank = int(left_item.get("rank") or 999)
            right_rank = int(right_item.get("rank") or 999)
            category_title = left_item.get("title") or right_item.get("title") or key
            comparison_lines.append(f"{category_title}: {left_label} #{left_rank} vs {right_label} #{right_rank}")
            if left_rank < right_rank:
                left_wins += 1
            elif right_rank < left_rank:
                right_wins += 1
            else:
                ties += 1
        winner_label = left_label if left_wins > right_wins else right_label if right_wins > left_wins else "Tie"
        return {
            "comparisonText": "; ".join(comparison_lines),
            "winText": f"{left_label} wins {left_wins} categories, {right_label} wins {right_wins}, ties {ties}.",
            "winnerLabel": winner_label,
        }

    def _category_compare_result(
        self,
        left_label: str,
        left_categories: List[Dict[str, Any]],
        right_label: str,
        right_categories: List[Dict[str, Any]],
        category_key: str,
        category_label: str,
        direction: str,
    ) -> Optional[Dict[str, str]]:
        if not category_key:
            return None
        left_item = next((item for item in left_categories if str(item.get("key") or "") == category_key), None)
        right_item = next((item for item in right_categories if str(item.get("key") or "") == category_key), None)
        if not left_item or not right_item:
            return None
        left_rank = int(left_item.get("rank") or 999)
        right_rank = int(right_item.get("rank") or 999)
        if direction == "worse":
            winner_label = left_label if left_rank > right_rank else right_label if right_rank > left_rank else "Tie"
            descriptor = "worse"
        else:
            winner_label = left_label if left_rank < right_rank else right_label if right_rank < left_rank else "Tie"
            descriptor = "better"
        winner_prompt_label = left_label if winner_label == left_label else right_label if winner_label == right_label else left_label
        return {
            "title": f"{category_label}: {winner_label} is {descriptor} between {left_label} and {right_label}." if winner_label != "Tie" else f"{category_label}: {left_label} and {right_label} are tied.",
            "summary": f"{left_label} is ranked #{left_rank} at {left_item.get('valueDisplay') or '--'} versus #{right_rank} at {right_item.get('valueDisplay') or '--'} for {right_label}.",
            "comparisonText": f"{left_label}: rank #{left_rank} ({left_item.get('valueDisplay') or '--'}; {left_item.get('contextLabel') or 'no context'}) | {right_label}: rank #{right_rank} ({right_item.get('valueDisplay') or '--'}; {right_item.get('contextLabel') or 'no context'})",
            "winnerLabel": winner_label,
            "winnerPromptLabel": winner_prompt_label,
            "leftRank": f"#{left_rank}",
            "rightRank": f"#{right_rank}",
        }

    def _should_live_fallback(self, filters: Dict[str, Any]) -> bool:
        if filters.get("min_feet") is not None or filters.get("reel_scope"):
            return False
        if len(str(filters.get("start") or "")) > 10 or len(str(filters.get("end") or "")) > 10:
            return False
        today = datetime.utcnow().date()
        return filters["start_dt"].date() <= today <= filters["end_dt"].date()

    def _filtered_latest_reel_text(self, latest: Dict[str, Any]) -> str:
        return f"Latest filtered reel {latest.get('reelId') or '--'} on {latest.get('jobName') or 'unknown job'} started at {latest.get('productionStart') or 'unknown time'}."

    def _latest_reel_text(self, card: Dict[str, Any]) -> str:
        latest = card.get("latestReel") or {}
        if not latest:
            return "No latest reel record was available."
        return f"Latest reel {latest.get('reelId') or '--'} on {latest.get('jobName') or 'unknown job'} started at {latest.get('productionStartLocal') or latest.get('productionStart') or 'unknown time'}."

    def _comparison_summary(self, row: Dict[str, Any]) -> str:
        return f"Rank #{row.get('rank') or '--'}; {self._format_pct(row.get('estimatedBadFeetPct'))} bad feet; {self._format_mm(row.get('deltaStd'))} delta std dev; {self._format_number(row.get('pointsPer1000Ft'))} pts/1k ft."

    def _press_label(self, machine_id: int) -> str:
        machine_name = self._machine_catalog()[1].get(int(machine_id)) if self._to_int(machine_id) is not None else None
        return machine_name or f"Press {machine_id}"

    def _machine_id_for_press_reference(self, press_number: int) -> int:
        candidate = self._to_int(press_number)
        if candidate is None:
            return int(press_number)
        if candidate in KNOWN_PRESS_NUMBER_TO_MACHINE_ID:
            return KNOWN_PRESS_NUMBER_TO_MACHINE_ID[candidate]
        machine_id = self._machine_catalog()[0].get(f"press {candidate}")
        return machine_id if machine_id is not None else candidate

    def _machine_catalog(self) -> tuple[Dict[str, int], Dict[int, str]]:
        if self.__class__._machine_catalog_by_label is not None and self.__class__._machine_catalog_by_id is not None:
            return self.__class__._machine_catalog_by_label, self.__class__._machine_catalog_by_id

        by_label = {f"press {press_number}": machine_id for press_number, machine_id in KNOWN_PRESS_NUMBER_TO_MACHINE_ID.items()}
        by_id = dict(KNOWN_MACHINE_ID_TO_PRESS_LABEL)
        try:
            with RLMSessionLocal() as session:
                rows = (
                    session.query(RLMMachine.machine_id, RLMMachine.machine_name)
                    .filter(RLMMachine.machine_name.isnot(None))
                    .all()
                )
            for row in rows:
                machine_id = self._to_int(row.machine_id)
                machine_name = str(row.machine_name or "").strip()
                if machine_id is None or not machine_name:
                    continue
                by_id[machine_id] = machine_name
                by_label[machine_name.lower()] = machine_id
        except Exception:  # pragma: no cover
            pass

        self.__class__._machine_catalog_by_label = by_label
        self.__class__._machine_catalog_by_id = by_id
        return by_label, by_id

    def _rendered_machine_list(self, payload: Any) -> List[int]:
        if not isinstance(payload, dict):
            return []
        answer = payload.get("answer") or payload
        sections = answer.get("sections") or []
        text = " ".join(
            [
                str(answer.get("title") or ""),
                str(answer.get("summary") or ""),
                " ".join(
                    " ".join(
                        [
                            str(section.get("label") or ""),
                            str(section.get("text") or ""),
                        ]
                    )
                    for section in sections
                    if isinstance(section, dict)
                ),
            ]
        )
        seen: List[int] = []
        for machine_id in self._extract_press_ids(self._normalize_message(text)):
            if machine_id not in seen:
                seen.append(machine_id)
        return seen

    def _unsupported_response(
        self,
        filters: Dict[str, Any],
        title: str,
        summary: str,
        *,
        tools: Optional[List[str]] = None,
        data_semantics: str,
    ) -> Dict[str, Any]:
        return self._response(
            answer={
                "title": title,
                "summary": summary,
                "sections": [],
            },
            evidence_metrics=[],
            chart=None,
            tools_used=[{"tool": tool, "ok": False} for tool in (tools or ["unsupported"])],
            suggested_prompts=self._contextual_follow_up_prompts(
                response_kind="session-filter-update",
                filters=filters,
            ),
            filters=filters,
            data_semantics=data_semantics,
        )

    def _empty_result_response(
        self,
        filters: Dict[str, Any],
        tools: List[str],
        summary: str,
        *,
        data_semantics: str,
    ) -> Dict[str, Any]:
        return self._response(
            answer={
                "title": "No matching RLM data was found.",
                "summary": summary,
                "sections": [{"label": "Scope", "text": SUPPORTED_SCOPE_MESSAGE}],
            },
            evidence_metrics=[self._metric("Result", "Empty")],
            chart=None,
            tools_used=[{"tool": tool, "ok": False} for tool in tools],
            suggested_prompts=self._contextual_follow_up_prompts(
                response_kind="session-filter-update",
                filters=filters,
            ),
            filters=filters,
            data_semantics=data_semantics,
        )

    def _clarification_response(
        self,
        filters: Dict[str, Any],
        title: str,
        summary: str,
        *,
        tools: Optional[List[str]] = None,
        data_semantics: str,
    ) -> Dict[str, Any]:
        return self._response(
            answer={
                "title": title,
                "summary": summary,
                "sections": [],
            },
            evidence_metrics=[self._metric("Status", "Needs clarification")],
            chart=None,
            tools_used=[{"tool": tool, "ok": False} for tool in (tools or ["clarification"])],
            suggested_prompts=self._contextual_follow_up_prompts(
                response_kind="session-filter-update",
                filters=filters,
            ),
            filters=filters,
            data_semantics=data_semantics,
        )

    def _error_response(
        self,
        filters: Dict[str, Any],
        tools: List[str],
        error: str,
        *,
        data_semantics: str,
    ) -> Dict[str, Any]:
        return self._response(
            answer={
                "title": "The assistant could not complete that request.",
                "summary": "A tool-level failure occurred while building the RLM response.",
                "sections": [
                    {"label": "Scope", "text": SUPPORTED_SCOPE_MESSAGE},
                    {"label": "Error", "text": error},
                ],
            },
            evidence_metrics=[self._metric("Status", "Tool failure")],
            chart=None,
            tools_used=[{"tool": tool, "ok": False} for tool in tools] or [{"tool": "unknown", "ok": False}],
            suggested_prompts=self._contextual_follow_up_prompts(
                response_kind="session-filter-update",
                filters=filters,
            ),
            filters=filters,
            data_semantics=data_semantics,
        )

    def _response(
        self,
        *,
        answer: Dict[str, Any],
        evidence_metrics: Optional[List[Dict[str, str]]],
        chart: Optional[Dict[str, Any]],
        tools_used: List[Dict[str, Any]],
        suggested_prompts: List[str],
        filters: Dict[str, Any],
        data_semantics: str,
    ) -> Dict[str, Any]:
        normalized_answer = dict(answer)
        dataset = self._build_filtered_dataset(filters)
        sections = list(normalized_answer.get("sections") or [])
        qualification_section = self._qualification_section(filters, dataset)
        if qualification_section:
            sections = [qualification_section] + sections
        normalized_answer["sections"] = sections
        qualification = dataset.get("qualification").to_dict()
        return {
            "answer": normalized_answer,
            "evidence": {
                "metrics": evidence_metrics if evidence_metrics is not None else [self._metric("Mode", "RLM-only MVP")],
                "chart": chart,
            },
            "toolsUsed": tools_used,
            "suggestedPrompts": suggested_prompts,
            "context": {
                "mode": filters.get("analysis_domain") or "auto",
                "filtersApplied": {
                    "analysis_domain": filters.get("analysis_domain"),
                    "machine_id": filters.get("machine_id"),
                    "start": filters.get("start"),
                    "end": filters.get("end"),
                    "job": filters.get("job"),
                    "order": filters.get("order"),
                    "reel_ids": filters.get("reel_ids"),
                    "reel_scope": filters.get("reel_scope"),
                    "min_feet": filters.get("min_feet"),
                },
                "dataSemantics": data_semantics,
                "qualification": qualification,
                "datasetContract": {
                    "rows": len(dataset.get("rows") or []),
                    "effectiveFilters": {
                        "analysis_domain": filters.get("analysis_domain"),
                        "machine_id": filters.get("machine_id"),
                        "start": filters.get("start"),
                        "end": filters.get("end"),
                        "job": filters.get("job"),
                        "reel_scope": filters.get("reel_scope"),
                        "min_feet": filters.get("min_feet"),
                    },
                },
            },
        }

    def _qualification_section(self, filters: Dict[str, Any], dataset: Optional[Dict[str, Any]] = None) -> Optional[Dict[str, str]]:
        qualification = (dataset or self._build_filtered_dataset(filters)).get("qualification")
        if not qualification:
            return None
        return {
            "label": "Qualification summary",
            "text": (
                f"Matched reels: {qualification.matched_reels} | "
                f"Qualified reels: {qualification.qualified_reels} | "
                f"Excluded reels: {qualification.excluded_reels} | "
                f"Denominator: {qualification.denominator_label or '--'}"
            ),
        }

    def _metric(self, label: str, value: Any) -> Dict[str, str]:
        return {"label": label, "value": str(value if value not in (None, "") else "--")}

    def _format_pct(self, value: Optional[float]) -> str:
        if value is None:
            return "--"
        return f"{float(value):.2f}%"

    def _format_mm(self, value: Optional[float]) -> str:
        if value is None:
            return "--"
        return f"{float(value):.2f} mm"

    def _format_number(self, value: Optional[float]) -> str:
        if value is None:
            return "--"
        return f"{float(value):.2f}"

    def _to_int(self, value: Any) -> Optional[int]:
        try:
            return int(value)
        except (TypeError, ValueError):
            return None

    def _is_valid_machine_id(self, machine_id: Optional[int]) -> bool:
        return machine_id is not None and machine_id > 0
