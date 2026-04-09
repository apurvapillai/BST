from __future__ import annotations

import re
from typing import Any, Dict, List, Optional

from services.assistant_models import (
    AssistantRequest,
    ConversationContext,
    RequestResolution,
    StickyFilters,
)


class AssistantRequestResolver:
    def __init__(self, service: Any) -> None:
        self.service = service

    def resolve(
        self,
        *,
        message: str,
        filters: Optional[Dict[str, Any]],
        history: Optional[List[Dict[str, Any]]],
    ) -> RequestResolution:
        clean_message = (message or "").strip()
        original_filters = self.service._normalize_filters(filters or {})
        sticky_before = StickyFilters.from_dict(self.service._last_sticky_filters(history or []))
        filter_updates = self.service._parse_sticky_filter_updates(clean_message)
        normalized_filters = self.service._normalize_filters(self.service._apply_time_phrase_override(filters or {}, clean_message))
        sticky_preview = self.service._apply_sticky_filter_updates(sticky_before.to_dict(), filter_updates)
        preview_filters, _ = self.service._filters_with_sticky_filters(
            normalized_filters,
            sticky_preview,
            filter_updates,
        )
        parsed_intent = self.service.classify_message(clean_message, preview_filters)
        prior_request_dict, source_turn = self.service._last_resolved_request(history or [])
        prior_request = AssistantRequest.from_legacy_dict(prior_request_dict)
        resolved_intent, conversation_debug = self.service._resolve_follow_up_intent(
            clean_message,
            preview_filters,
            parsed_intent,
            prior_request_dict,
        )

        sticky_after = self._build_sticky_filters_after(
            sticky_before=sticky_before,
            updates=filter_updates,
            resolved_intent=resolved_intent,
            normalized_filters=normalized_filters,
            message=clean_message,
        )
        resolved_intent = self._apply_sticky_context_to_intent(
            message=clean_message,
            resolved_intent=resolved_intent,
            sticky_filters=sticky_after,
        )
        filters_with_sticky, sticky_filter_source = self.service._filters_with_sticky_filters(
            normalized_filters,
            sticky_after.to_dict(),
            filter_updates,
        )
        effective_filters, time_range_source = self.service._filters_with_intent_scope(filters_with_sticky, resolved_intent)
        conversation_context = ConversationContext(
            sticky_filters=sticky_after,
            last_resolved_request=AssistantRequest.from_legacy_dict(
                self.service._build_resolved_request(resolved_intent, effective_filters)
            ),
            source_turn=source_turn,
        )
        return RequestResolution(
            original_filters=original_filters,
            normalized_filters=normalized_filters,
            effective_filters=effective_filters,
            parsed_intent=parsed_intent,
            resolved_intent=resolved_intent,
            conversation_context=conversation_context,
            sticky_filters_before=sticky_before,
            sticky_filters_after=sticky_after,
            filter_updates=filter_updates,
            time_range_source=time_range_source,
            sticky_filter_source=sticky_filter_source,
            conversation_debug=conversation_debug,
        )

    def _build_sticky_filters_after(
        self,
        *,
        sticky_before: StickyFilters,
        updates: Dict[str, Any],
        resolved_intent: Optional[Dict[str, Any]],
        normalized_filters: Dict[str, Any],
        message: str,
    ) -> StickyFilters:
        merged = sticky_before.to_dict()
        legacy_after = self.service._apply_sticky_filter_updates(merged, updates)
        domain = self._parse_analysis_domain(message) or str(merged.get("analysisDomain") or "auto")
        lowered = self.service._normalize_message(message)
        explicit_press_ids = self.service._extract_press_ids(lowered)
        explicit_press_machine_id = (
            self.service._machine_id_for_press_reference(explicit_press_ids[0])
            if explicit_press_ids
            else None
        )
        if resolved_intent and resolved_intent.get("kind") == "compare":
            pass
        elif (
            resolved_intent
            and self.service._is_valid_machine_id(resolved_intent.get("machine_id"))
            and (
                explicit_press_ids
                or not self.service._is_valid_machine_id(legacy_after.get("pressId"))
            )
        ):
            legacy_after["pressId"] = self.service._to_int(resolved_intent.get("machine_id"))
        elif not self.service._is_valid_machine_id(legacy_after.get("pressId")) and self.service._is_valid_machine_id(normalized_filters.get("machine_id")):
            legacy_after["pressId"] = self.service._to_int(normalized_filters.get("machine_id"))

        job_value = self._parse_job(message) or normalized_filters.get("job") or merged.get("job")
        if job_value:
            legacy_after["job"] = job_value
        if any(token in self.service._normalize_message(message) for token in (" clear job filter ", " clear the job filter ")):
            legacy_after["job"] = None
        if (
            self.service._is_valid_machine_id(explicit_press_machine_id)
            and explicit_press_machine_id != self.service._to_int(sticky_before.press_id)
            and not self._parse_job(message)
        ):
            legacy_after["job"] = None

        legacy_after["analysisDomain"] = domain
        return StickyFilters.from_dict(legacy_after)

    def _apply_sticky_context_to_intent(
        self,
        *,
        message: str,
        resolved_intent: Optional[Dict[str, Any]],
        sticky_filters: StickyFilters,
    ) -> Optional[Dict[str, Any]]:
        if not resolved_intent:
            return resolved_intent
        lowered = self.service._normalize_message(message)
        explicit_press_ids = self.service._extract_press_ids(lowered)
        sticky_press_id = sticky_filters.press_id
        if not explicit_press_ids and self.service._is_valid_machine_id(sticky_press_id):
            kind = str(resolved_intent.get("kind") or "")
            if kind in {"status", "trend", "reel_summary", "ranking", "job_list", "activity", "discovery"}:
                resolved_intent = dict(resolved_intent)
                resolved_intent["machine_id"] = sticky_press_id
            elif kind == "compare":
                machine_ids = [self.service._to_int(value) for value in resolved_intent.get("machine_ids") or [] if self.service._to_int(value) is not None]
                if machine_ids:
                    resolved_intent = dict(resolved_intent)
                    resolved_intent["machine_ids"] = [sticky_press_id] + [machine_id for machine_id in machine_ids if machine_id != sticky_press_id]
        if not explicit_press_ids and not resolved_intent.get("job") and sticky_filters.job:
            resolved_intent = dict(resolved_intent)
            resolved_intent["job"] = sticky_filters.job
        return resolved_intent

    def _parse_analysis_domain(self, message: str) -> Optional[str]:
        lowered = self.service._normalize_message(message)
        if any(token in lowered for token in (" bst defects ", " defects ", " defect system ")):
            return "bst_defects"
        if " rlm " in lowered:
            return "rlm"
        if " auto domain " in lowered:
            return "auto"
        return None

    def _parse_job(self, message: str) -> Optional[str]:
        match = re.search(r"\bjob\s+([a-z0-9]+(?:[-_][a-z0-9]+)+)\b", message or "", flags=re.IGNORECASE)
        return str(match.group(1)).strip() if match else None
