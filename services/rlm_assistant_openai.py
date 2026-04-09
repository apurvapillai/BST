from __future__ import annotations

import json
import logging
import os
from dataclasses import dataclass
from typing import Any, Dict, List, Optional

import requests
from dotenv import load_dotenv


load_dotenv()
logger = logging.getLogger(__name__)


class RLMAssistantLLMError(RuntimeError):
    pass


class RLMAssistantLLMConfigError(RLMAssistantLLMError):
    pass


@dataclass(frozen=True)
class RLMAssistantOpenAIConfig:
    api_key: str
    model: str
    base_url: str = "https://api.openai.com/v1"
    timeout_seconds: int = 20

    @classmethod
    def from_env(cls, *, required: bool = False) -> Optional["RLMAssistantOpenAIConfig"]:
        api_key = os.environ.get("OPENAI_API_KEY", "").strip()
        model = (
            os.environ.get("RLM_ASSISTANT_MODEL", "").strip()
            or os.environ.get("OPENAI_MODEL", "").strip()
        )
        base_url = os.environ.get("OPENAI_BASE_URL", "").strip() or "https://api.openai.com/v1"

        if not api_key or not model:
            if required:
                missing = []
                if not api_key:
                    missing.append("OPENAI_API_KEY")
                if not model:
                    missing.append("RLM_ASSISTANT_MODEL/OPENAI_MODEL")
                raise RLMAssistantLLMConfigError(
                    f"LLM-assisted mode requested, but missing env vars: {', '.join(missing)}"
                )
            return None

        return cls(api_key=api_key, model=model, base_url=base_url.rstrip("/"))


class RLMAssistantOpenAIClient:
    def __init__(self, config: RLMAssistantOpenAIConfig) -> None:
        self.config = config

    def build_plan(
        self,
        *,
        message: str,
        filters: Dict[str, Any],
        tool_registry: List[Dict[str, Any]],
    ) -> Dict[str, Any]:
        system = (
            "You plan tool calls for a repeat-length monitoring assistant. "
            "Return JSON only. Use only the allowed tools. "
            "Do not invent tool names. Do not query databases. "
            "Choose at most 3 tool calls."
        )
        user = {
            "message": message,
            "filters": filters,
            "allowedTools": tool_registry,
            "requiredOutput": {
                "intent": "short_intent_label",
                "toolCalls": [
                    {
                        "tool": "allowed_tool_name",
                        "arguments": {"field": "value"},
                    }
                ],
            },
        }
        return self._chat_json(
            [
                {"role": "system", "content": system},
                {"role": "user", "content": json.dumps(user)},
            ]
        )

    def compose_copy(
        self,
        *,
        message: str,
        base_response: Dict[str, Any],
        tool_results: Dict[str, Any],
    ) -> Dict[str, Any]:
        system = (
            "You rewrite assistant output for operators. Return JSON only. "
            "Do not change factual values. Keep it concise and grounded in the provided data."
        )
        user = {
            "message": message,
            "baseResponse": {
                "answer": base_response.get("answer"),
                "suggestedPrompts": base_response.get("suggestedPrompts"),
            },
            "toolResults": tool_results,
            "requiredOutput": {
                "title": "short title",
                "summary": "short summary",
                "sections": [
                    {"label": "Section label", "text": "section text"},
                ],
                "suggestedPrompts": ["prompt 1", "prompt 2"],
            },
        }
        return self._chat_json(
            [
                {"role": "system", "content": system},
                {"role": "user", "content": json.dumps(user)},
            ]
        )

    def _chat_json(self, messages: List[Dict[str, str]]) -> Dict[str, Any]:
        url = f"{self.config.base_url}/chat/completions"
        payload = {
            "model": self.config.model,
            "temperature": 0,
            "response_format": {"type": "json_object"},
            "messages": messages,
        }
        try:
            response = requests.post(
                url,
                headers={
                    "Authorization": f"Bearer {self.config.api_key}",
                    "Content-Type": "application/json",
                },
                json=payload,
                timeout=self.config.timeout_seconds,
            )
        except requests.Timeout as exc:
            logger.warning("rlm_assistant.provider_timeout model=%s timeout_s=%s", self.config.model, self.config.timeout_seconds)
            raise RLMAssistantLLMError("LLM planning timed out.") from exc
        except requests.RequestException as exc:
            logger.warning("rlm_assistant.provider_request_error model=%s error=%s", self.config.model, exc.__class__.__name__)
            raise RLMAssistantLLMError("LLM provider request failed.") from exc
        if not response.ok:
            logger.warning(
                "rlm_assistant.provider_http_error model=%s status=%s body_preview=%s",
                self.config.model,
                response.status_code,
                (response.text or "")[:160],
            )
            raise RLMAssistantLLMError(
                f"LLM provider request failed ({response.status_code})."
            )
        data = response.json()
        choices = data.get("choices") or []
        if not choices:
            raise RLMAssistantLLMError("OpenAI returned no choices.")
        message = choices[0].get("message") or {}
        content = message.get("content") or ""
        if not content:
            raise RLMAssistantLLMError("OpenAI returned empty content.")
        try:
            return json.loads(content)
        except json.JSONDecodeError as exc:
            raise RLMAssistantLLMError(f"OpenAI returned invalid JSON: {exc}") from exc
