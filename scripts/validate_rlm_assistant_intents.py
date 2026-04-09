from __future__ import annotations

from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from services.rlm_assistant_service import RLMAssistantService


CASES = [
    {
        "message": "What is the status of Press 5 today?",
        "expected_kind": "status",
        "expected_machine_ids": [5],
        "expected_tools": ["get_press_status"],
    },
    {
        "message": "Compare Press 6 vs Press 8",
        "expected_kind": "compare",
        "expected_machine_ids": [6, 8],
        "expected_tools": ["compare_presses"],
    },
    {
        "message": "Why is Press 11 ranked low?",
        "expected_kind": "ranking",
        "expected_machine_ids": [11],
        "expected_tools": ["get_press_rankings", "get_press_category_breakdown"],
    },
    {
        "message": "Is Press 8 getting worse reel to reel?",
        "expected_kind": "reel_summary",
        "expected_machine_ids": [8],
        "expected_tools": ["get_reel_to_reel_summary"],
    },
    {
        "message": "Show the bad feet trend for Press 7",
        "expected_kind": "trend",
        "expected_machine_ids": [7],
        "expected_tools": ["get_press_metric_trend"],
    },
    {
        "message": "show delta std trend for p11",
        "expected_kind": "trend",
        "expected_machine_ids": [11],
        "expected_tools": ["get_press_metric_trend"],
    },
    {
        "message": "compare press6 versus press8",
        "expected_kind": "compare",
        "expected_machine_ids": [6, 8],
        "expected_tools": ["compare_presses"],
    },
    {
        "message": "how is p5 doing",
        "expected_kind": "status",
        "expected_machine_ids": [5],
        "expected_tools": ["get_press_status"],
    },
    {
        "message": "best press today",
        "expected_kind": "ranking_summary",
        "expected_machine_ids": [],
        "expected_tools": ["get_press_rankings"],
    },
    {
        "message": "worst press this week",
        "expected_kind": "ranking_summary",
        "expected_machine_ids": [],
        "expected_tools": ["get_press_rankings"],
    },
    {
        "message": "top 3 presses today",
        "expected_kind": "ranking_summary",
        "expected_machine_ids": [],
        "expected_tools": ["get_press_rankings"],
    },
    {
        "message": "strongest press in this window",
        "expected_kind": "ranking_summary",
        "expected_machine_ids": [],
        "expected_tools": ["get_press_rankings"],
    },
    {
        "message": "weakest press in this window",
        "expected_kind": "ranking_summary",
        "expected_machine_ids": [],
        "expected_tools": ["get_press_rankings"],
    },
]


def main() -> None:
    service = RLMAssistantService(live_service=object(), press_service=object())
    base_filters = {
        "machine_id": 5,
        "start": "2026-04-07",
        "end": "2026-04-07",
        "job": "",
        "order": "",
        "reel_ids": [],
    }
    failures = []
    for case in CASES:
        intent = service.classify_message(case["message"], base_filters)
        kind = intent.get("kind") if intent else None
        tools = intent.get("tools") if intent else None
        if kind != case["expected_kind"]:
            failures.append(f"{case['message']}: expected kind {case['expected_kind']}, got {kind}")
            continue
        if tools != case["expected_tools"]:
            failures.append(f"{case['message']}: expected tools {case['expected_tools']}, got {tools}")
        if kind == "compare":
            machine_ids = intent.get("machine_ids") or []
        elif kind == "ranking_summary":
            machine_ids = []
        else:
            machine_id = intent.get("machine_id")
            machine_ids = [machine_id] if machine_id is not None else []
        if machine_ids != case["expected_machine_ids"]:
            failures.append(
                f"{case['message']}: expected machines {case['expected_machine_ids']}, got {machine_ids}"
            )
    if failures:
        raise SystemExit("\n".join(failures))
    print(f"Validated {len(CASES)} deterministic RLM assistant intent cases.")


if __name__ == "__main__":
    main()
