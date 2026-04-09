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

        if self._is_filter_only_request(filter_updates, resolved_intent):
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
            return self._unsupported_response(
                filters,
                "I need a specific job selection to analyze.",
                "You can pick a job from the recent list, for example 'Use Job JOB-1-A'.",
                tools=intent.get("tools", []),
                data_semantics="request-validation",
            )
        if validation_error == "missing_machine":
            return self._unsupported_response(
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
        job_list_requested = (
            (" what jobs " in lowered or lowered_stripped.startswith("what jobs"))
            and any(token in lowered for token in (" ran ", " run ", " produced "))
        )
        if not job_list_requested and any(token in lowered for token in (" recent jobs ", " latest jobs ")):
            job_list_requested = (" show me " in lowered or " show " in lowered or " what " in lowered) and self._is_valid_machine_id(machine_id)
        if not job_list_requested and " show jobs " in lowered and self._is_valid_machine_id(machine_id):
            job_list_requested = True
        if " use the weakest recent job " in lowered:
            return {
                "kind": "job_list",
                "machine_id": machine_id,
                "analysisScope": analysis_scope if analysis_scope and analysis_scope.get("kind") in {"time", "reels"} else None,
                "tools": ["get_press_job_list"],
                "validationError": "job_selection_requires_specific_job",
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
        if status_requested:
            return {
                "kind": "status",
                "machine_id": machine_id,
                "analysisScope": analysis_scope if analysis_scope and analysis_scope.get("kind") == "time" else None,
                "tools": ["get_press_status"],
                "validationError": None if self._is_valid_machine_id(machine_id) else "missing_machine",
                "matchedKeywords": status_matches,
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
            "job": filters.get("job"),
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

    def _is_filter_only_request(self, updates: Dict[str, Any], resolved_intent: Optional[Dict[str, Any]]) -> bool:
        if not updates or not updates.get("filterOnly"):
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

        merged = self._intent_from_resolved_request(prior_request)
        if not merged:
            return parsed_intent, diagnostics

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

        sticky_filters = (filters or {}).get("sticky_filters") or {}
        sticky_job = str(sticky_filters.get("job") or "").strip()
        sticky_press_id = self._to_int(sticky_filters.get("pressId"))

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
        if kind in {"status", "ranking", "reel_summary", "trend", "job_list"}:
            return None if self._is_valid_machine_id(intent.get("machine_id")) else "missing_machine"
        return None

    def _is_follow_up_candidate(self, message: str, parsed_intent: Optional[Dict[str, Any]]) -> bool:
        lowered = self._normalize_message(message)
        stripped = lowered.strip()
        if stripped.startswith("what about ") or stripped.startswith("now "):
            return True
        if any(token in lowered for token in (" what stands out between them ", " which one is worse ", " where did behavior shift ", " did it recover ", " spikes or sustained ", " sustained or spikes ", " concentrated or broad ")):
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
            state = tool_data.get("state") or {}
            machine_id = self._to_int(tool_data.get("machineId"))
            sections = [
                {"label": "Latest reel in window", "text": self._filtered_latest_reel_text(latest)},
                {
                    "label": "Window summary",
                    "text": f"{aggregate.get('reelsRun') or 0} reels, {self._format_pct(aggregate.get('badFeetPct'))} bad feet, {self._format_number(aggregate.get('pointsPer1000Ft'))} pts/1k ft.",
                },
            ]
            scope_section = self._scope_section((intent or {}).get("analysisScope") or {}, [], filters)
            if scope_section:
                sections.insert(0, scope_section)
            production_section = self._production_context_section(aggregate)
            if production_section:
                sections.append(production_section)
            peer_section = self._status_peer_ranking_section(machine_id, filters)
            if peer_section:
                sections.append(peer_section)
            return self._response(
                answer={
                    "title": f"{tool_data['machineName']} is {str(state.get('stateLabel') or 'Unknown').lower()} in the selected window.",
                    "summary": state.get("statusMessage") or "Filtered repeat length status is available.",
                    "sections": sections,
                },
                evidence_metrics=[
                    self._metric("State", state.get("stateLabel") or "--"),
                    self._metric("Bad feet %", self._format_pct(aggregate.get("badFeetPct"))),
                    self._metric("OOB %", self._format_pct(aggregate.get("oobPointPct"))),
                    self._metric("Pts / 1k ft", self._format_number(aggregate.get("pointsPer1000Ft"))),
                    self._metric("Delta std dev", self._format_mm(latest.get("deltaStd"))),
                ],
                chart=None,
                tools_used=[{"tool": "get_press_status", "ok": True}],
                suggested_prompts=self._contextual_follow_up_prompts(
                    response_kind="status",
                    filters=filters,
                    machine_label=tool_data.get("machineName"),
                ),
                filters=filters,
                data_semantics="filtered-window",
            )

        card = tool_data.get("card") or {}
        metrics = card.get("metrics") or {}
        windows = tool_data.get("windows") or {}
        window_24h = windows.get("24h") or {}
        signal = tool_data.get("signal") or {}
        machine_id = self._to_int(tool_data.get("machineId"))
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
        scope_section = self._scope_section((intent or {}).get("analysisScope") or {}, [], filters)
        if scope_section:
            sections.insert(0, scope_section)
        production_section = self._production_context_section(
            {
                "reelsRun": window_24h.get("qualifyingReels"),
                "feetTotal": metrics.get("feetTotal") or window_24h.get("feetTotal"),
                "estimatedBadFeet": metrics.get("estimatedBadFeet") or window_24h.get("estimatedBadFeet"),
                "estimatedBadFeetPct": metrics.get("badFeetPct") or window_24h.get("badFeetPct"),
            }
        )
        if production_section:
            sections.append(production_section)
        peer_section = self._status_peer_ranking_section(machine_id, filters)
        if peer_section:
            sections.append(peer_section)
        return self._response(
            answer={
                "title": f"{tool_data['machineName']} is {card.get('stateLabel', 'Unknown').lower()} right now.",
                "summary": "No filtered-window rows were found, so this response uses current live RLM status.",
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
        chart = {
            "type": "bar",
            "title": "Estimated Bad Feet %",
            "series": [
                {
                    "name": "Estimated Bad Feet %",
                    "x": [left_label, right_label],
                    "y": [left.get("estimatedBadFeetPct") or 0, right.get("estimatedBadFeetPct") or 0],
                }
            ],
        }
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
            return self._response(
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
                chart=None,
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
        return self._response(
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
        return self._response(
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
        prompts = [
            f"Why is {lead.get('machineName')} the best {window_phrase}?" if focus != "worst" else f"Why is {lead.get('machineName')} the worst {window_phrase}?",
        ]
        if len(selected) > 1:
            prompts.append(f"Compare {selected[0].get('machineName')} vs {selected[-1].get('machineName')}")
        if selected:
            prompts.append(f"Show the bad feet trend for {lead.get('machineName')}")
        return self._response(
            answer={"title": title, "summary": summary, "sections": sections},
            evidence_metrics=evidence,
            chart=None,
            tools_used=[
                {"tool": "get_press_rankings", "ok": True},
                {"tool": "get_press_category_breakdown", "ok": True},
            ],
            suggested_prompts=prompts[:3],
            filters=filters,
            data_semantics="filtered-window",
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
        return self._response(
            answer={"title": title, "summary": summary, "sections": sections},
            evidence_metrics=evidence,
            chart=None,
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
        recent = scoped_reels if scope else reels[-3:] if len(reels) >= 3 else reels
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
            chart = {
                "type": "line",
                "title": f"{tool_data.get('machineName')} reel-to-reel bad feet %",
                "series": [
                    {
                        "name": "Bad Feet %",
                        "x": [row.get("reelId") for row in recent],
                        "y": [row.get("estimatedBadFeetPct") or 0 for row in recent],
                    }
                ],
            }
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
        return self._response(
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
            chart = {
                "type": "line",
                "title": f"{tool_data.get('machineName')} {tool_data.get('metricLabel')}",
                "series": [
                    {
                        "name": tool_data.get("metricLabel"),
                        "x": [row.get("date") for row in series],
                        "y": [row.get("value") for row in series],
                    }
                ],
            }
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
        return self._response(
            answer={
                "title": title,
                "summary": direct_summary,
                "sections": sections,
            },
            evidence_metrics=[
                self._metric("Metric", tool_data.get("metricLabel") or "--"),
                self._metric("Latest value", latest.get("valueDisplay") or str(latest.get("value"))),
                self._metric("Points", str(len(series))),
                self._metric(
                    "Trend",
                    str(self._trend_assessment(metric_key, [float(row.get("value") or 0.0) for row in series]).get("direction") or "--").title(),
                ),
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
        return response

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
        return response

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
        return response

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
            series_rows.append({"label": label, "value": value})
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
            }
        ]
        if baseline_comparison.get("available") and baseline_comparison.get("previousValue") is not None:
            series.append(
                {
                    "name": str(baseline_comparison.get("baselineLabel") or "Previous window"),
                    "x": [item["label"] for item in series_rows],
                    "y": [float(baseline_comparison.get("previousValue") or 0.0) for _ in series_rows],
                }
            )
        markers = self._discovery_chart_markers(metric_key, rows)
        shift_label = change_point.get("candidate") or markers.get("shiftLabel")
        shift_value = markers.get("shiftValue")
        if change_point.get("available") and shift_label is not None and shift_value is not None:
            series.append(
                {
                    "name": "Shift point",
                    "x": [shift_label],
                    "y": [shift_value],
                }
            )
        if shape.get("recoveryAfterShift") and markers.get("recoveryLabel") is not None and markers.get("recoveryValue") is not None:
            series.append(
                {
                    "name": "Recovery",
                    "x": [markers.get("recoveryLabel")],
                    "y": [markers.get("recoveryValue")],
                }
            )
        if not self._should_render_series_chart([{"value": item["value"]} for item in series_rows]):
            return None
        return {
            "type": "line",
            "title": title,
            "series": series,
        }

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
            latest_tolerances = self.press_service._get_latest_tolerances(session, reel_ids)
            tolerance_change_counts = self.press_service._get_tolerance_change_counts(session, reel_ids)
            monitoring = self.press_service._get_monitoring_aggregates(session, reel_ids)
            phase_aggregates = self._get_phase_interval_aggregates(session, reel_ids)
        rows = self.press_service._compute_reel_metrics(
            reels,
            monitoring,
            latest_tolerances,
            tolerance_change_counts,
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

        def job_or_subject(template: str) -> str:
            if job_name:
                return template.replace("it", "this job")
            return template

        if response_kind == "session-filter-update":
            if job_name:
                return self._dedupe_prompts(
                    [
                        "Analyze this job's delta behavior",
                        "Compare this job to average",
                        "Was this job broadly unstable or just spikes?",
                        "Did speed instability line up for this job?",
                        "Which reels drove the bad feet for this job?",
                    ]
                )
            if has_scope or self._is_valid_machine_id(self._to_int(sticky.get("pressId"))):
                return self._dedupe_prompts(
                    [
                        f"What changed on {subject}?",
                        f"Show delta behavior for {subject}",
                        "What really changed?",
                        "Compare it to average",
                        "Was this just a few reels or the whole run?",
                    ]
                )
            return self._dedupe_prompts(
                [
                    "What changed on Press 8 today?",
                    "Investigate Press 5 in the last 10 reels",
                    "What jobs ran on Press 5 in the last 24 hours?",
                ]
            )

        if response_kind == "job_list":
            first_job = None
            if available_jobs:
                first_job = str((available_jobs[0] or {}).get("jobName") or "").strip() or None
            return self._dedupe_prompts(
                [
                    f"Use Job {first_job}" if first_job else "",
                    "Analyze only that job",
                    "Compare that job's delta behavior to average",
                    "Which job had the most bad feet?",
                    "Did one job stand out as the weakest?",
                ]
            )

        if response_kind == "compare":
            if metric_family == "operational":
                return self._dedupe_prompts(
                    [
                        "Did weaker monitoring affect the comparison?",
                        "Compare delta behavior too",
                        "Was the system active less often for this job?" if job_name else "Was the system active less often too?",
                        "Is this difference still true over the last 10 reels?",
                    ]
                )
            return self._dedupe_prompts(
                [
                    "What stands out between them?",
                    "Was this just a few reels or the whole job?",
                    "Was the issue at the beginning, middle, or end?",
                    "Was this comparison fair?",
                    "Did speed instability line up too?",
                ]
            )

        if response_kind == "discovery":
            prompts: List[str] = []
            if focus != "run_position":
                prompts.append("Where did behavior shift?" if shift_detected or baseline_available else "Where in the run did this show up?")
            if focus != "concentration":
                if shape == "isolated spike":
                    prompts.append(job_or_subject("Was it just a short spike or did it spread later?"))
                elif shape == "sustained deterioration":
                    prompts.append(job_or_subject("Was it sustained across the run or did it concentrate in one section?"))
                else:
                    prompts.append(job_or_subject("Was it spikes or sustained?"))
            if focus != "episodes":
                prompts.append("Did it recover after the shift?" if shift_detected else "Did it recover?")
            prompts.append("Which reels drove this?")
            if comparison_mode == "none":
                prompts.append("Compare it to average")
            if metric_family != "process":
                prompts.append("Did speed instability line up too?")
            else:
                prompts.append("Did tolerance changes happen?")
            return self._dedupe_prompts(prompts[:5])

        if response_kind == "activity":
            if metric_family == "operational" and comparison_mode in {"press_vs_press", "press_vs_average"}:
                return self._dedupe_prompts(
                    [
                        "Did weaker monitoring affect the comparison?",
                        "Compare delta behavior too",
                        "Was the system active less often for this job?" if job_name else f"Was the system active less often on {subject}?",
                        "Is this difference still true over the last 10 reels?",
                    ]
                )
            if comparison_mode in {"press_vs_press", "press_vs_average"}:
                return self._dedupe_prompts(
                    [
                        "What stands out between them?" if comparison_mode == "press_vs_press" else "What stands out versus average?",
                        "Was this just a few reels or the whole job?",
                        "Was the issue at the beginning, middle, or end?",
                        "Was this comparison fair?",
                        "Did speed instability line up too?",
                    ]
                )
            if metric_family == "process":
                return self._dedupe_prompts(
                    [
                        "Did it recover?",
                        "Compare it to average" if comparison_mode == "none" else "Was this comparison fair?",
                        "Where did behavior shift?",
                        "Did tolerance changes happen?",
                        "Which reels drove this?",
                    ]
                )
            if metric_family == "outcome":
                return self._dedupe_prompts(
                    [
                        "Was this just a few reels or the whole job?",
                        "Where did behavior shift?",
                        "Which reels drove this?",
                        "Compare it to average" if comparison_mode == "none" else "Was this comparison fair?",
                        "Did speed instability line up too?",
                    ]
                )

        if response_kind in {"trend", "reel_summary"}:
            return self._dedupe_prompts(
                [
                    "Did it recover?",
                    "Where did behavior shift?",
                    "Was it spikes or sustained?",
                    "Compare it to average",
                    "Did tolerance changes happen?",
                    "Which reels drove this?",
                ]
            )

        if response_kind == "status":
            return self._dedupe_prompts(
                [
                    f"Show delta behavior for {subject}",
                    f"Is {subject} getting worse reel to reel?",
                    "What really changed?",
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
