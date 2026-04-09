from __future__ import annotations

from pathlib import Path
import argparse
import sys

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from services.rlm_assistant_service import (  # noqa: E402
    EXECUTION_MODE_DETERMINISTIC,
    EXECUTION_MODE_LLM,
    RLMAssistantService,
)


CASES = [
    {
        "message": "Compare Press 6 vs Press 8",
        "filters": {
            "machine_id": 6,
            "start": "2026-04-07",
            "end": "2026-04-07",
            "job": "",
            "order": "",
            "reel_ids": [],
        },
    },
    {
        "message": "Why is Press 11 ranked low?",
        "filters": {
            "machine_id": 11,
            "start": "2026-04-07",
            "end": "2026-04-07",
            "job": "",
            "order": "",
            "reel_ids": [],
        },
    },
]


def summarize_response(response: dict) -> str:
    context = response.get("context") or {}
    diagnostics = response.get("diagnostics") or {}
    answer = response.get("answer") or {}
    tools = ", ".join(tool.get("tool", "?") for tool in response.get("toolsUsed") or [])
    fallback_reason = context.get("fallbackReason") or diagnostics.get("fallbackReason") or ""
    return "\n".join(
        [
            f"requestedMode: {context.get('requestedMode')}",
            f"executionMode: {context.get('executionMode')}",
            f"dataSemantics: {context.get('dataSemantics')}",
            f"toolsUsed: {tools}",
            f"parsedMachines: {diagnostics.get('parsedMachines')}",
            f"plannedMachines: {diagnostics.get('plannedMachines')}",
            f"executedMachines: {diagnostics.get('executedMachines')}",
            f"baseRenderedMachines: {diagnostics.get('baseRenderedMachines')}",
            f"rewriteRenderedMachines: {diagnostics.get('rewriteRenderedMachines')}",
            f"finalRenderedMachines: {diagnostics.get('finalRenderedMachines')}",
            f"fallbackReason: {fallback_reason or '-'}",
            "diagnostics: "
            f"plannerAttempted={diagnostics.get('plannerAttempted')} "
            f"plannerSucceeded={diagnostics.get('plannerSucceeded')} "
            f"plannerValidationPassed={diagnostics.get('plannerValidationPassed')} "
            f"rewriteAttempted={diagnostics.get('rewriteAttempted')} "
            f"rewriteApplied={diagnostics.get('rewriteApplied')} "
            f"fallbackTriggered={diagnostics.get('fallbackTriggered')}",
            "timingMs: "
            f"planner={((diagnostics.get('timingMs') or {}).get('planner'))} "
            f"tools={((diagnostics.get('timingMs') or {}).get('tools'))} "
            f"rewrite={((diagnostics.get('timingMs') or {}).get('rewrite'))} "
            f"total={((diagnostics.get('timingMs') or {}).get('total'))}",
            f"title: {(answer.get('title') or '')[:140]}",
            f"summary: {(answer.get('summary') or '')[:220]}",
        ]
    )


def run_case(service: RLMAssistantService, mode: str, case: dict) -> None:
    print("=" * 80)
    print(f"mode: {mode}")
    print(f"message: {case['message']}")
    response = service.handle_chat(
        message=case["message"],
        filters=case["filters"],
        mode=mode,
        diagnostic=True,
    )
    print(summarize_response(response))


def main() -> None:
    parser = argparse.ArgumentParser(description="Manual live verification for the RLM Assistant.")
    parser.add_argument(
        "--mode",
        choices=["deterministic", "llm-assisted", "both"],
        default="both",
        help="Which execution mode to run.",
    )
    args = parser.parse_args()

    service = RLMAssistantService()
    modes = (
        [EXECUTION_MODE_DETERMINISTIC, EXECUTION_MODE_LLM]
        if args.mode == "both"
        else [args.mode]
    )
    for mode in modes:
        for case in CASES:
            run_case(service, mode, case)


if __name__ == "__main__":
    main()
