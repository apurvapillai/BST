from __future__ import annotations

import argparse
from collections import Counter, defaultdict
from datetime import UTC, datetime, timedelta
import json
import logging
from pathlib import Path
import re
import sys
from typing import Any, Dict, List

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

logging.getLogger("services.rlm_assistant_service").setLevel(logging.ERROR)

from services.rlm_assistant_service import (  # noqa: E402
    EXECUTION_MODE_DETERMINISTIC,
    EXECUTION_MODE_LLM,
    KNOWN_PRESS_NUMBER_TO_MACHINE_ID,
    RLMAssistantService,
)
from services.rlm_assistant_openai import RLMAssistantLLMError  # noqa: E402


PRESS_RE = re.compile(r"\b(?:press|p)\s*(\d+)\b", flags=re.IGNORECASE)

SAFE_PROMPTS = [
    "What is the status of Press 5 today?",
    "How is Press 8 doing?",
    "Status for Press 11",
    "Is Press 6 healthy right now?",
    "Compare Press 6 vs Press 8",
    "Compare Press 11 versus Press 12",
    "Why is Press 11 ranked low?",
    "Why is Press 6 low?",
    "Is Press 6 getting worse reel to reel?",
    "Show reel to reel for Press 8",
    "Show the bad feet trend for Press 7",
    "Show monitoring density for Press 6",
    "Show delta std for Press 9",
    "Plot drift for Press 12",
    "Show speed instability for Press 14",
]

LLM_ASSISTED_PROMPTS = [
    "What stands out on Press 9 right now?",
    "Which is running better, Press 9 or Press 14?",
    "What’s hurting Press 9 in the rankings?",
    "What categories are dragging Press 8 down?",
    "How are the recent reels looking on Press 12?",
    "Is Press 7 getting cleaner or dirtier lately?",
    "Can you show how drift has been moving on Press 13?",
    "Operator view: is Press 8 in trouble today?",
    "Why does Press 15 look weak this week?",
    "Put Press 6 next to Press 8 and tell me what stands out",
]

HARD_PROMPTS = [
    "How are all presses doing today?",
    "What rank is Press 8?",
    "Compare 6 and 8",
    "Show delta for Press 8",
    "Show temperature trend for Press 6",
    "Why is Press 11 ranked low and show the drift trend too",
    "Best press today and compare it to Press 8",
    "What stands out today?",
    "How did the last three reels look for Press 5?",
    "What is Press 8 best at?",
]

RANKING_SUMMARY_PROMPTS = [
    "best press today",
    "worst press this week",
    "top 3 presses today",
    "bottom 3 presses today",
    "best 5 presses",
    "worst 5 presses",
    "strongest press today",
    "weakest press this week",
]

CATEGORY_RANKING_PROMPTS = [
    "best press for bad feet today",
    "worst press for drift this week",
    "who has the best monitoring density",
    "bottom 3 presses for speed instability",
    "top 5 presses for delta std",
    "which press is worst for repeat length drift",
]

CATEGORY_COMPARE_PROMPTS = [
    "Compare Press 6 vs Press 8 on drift",
    "Which is better on monitoring density, Press 6 or Press 9?",
    "Compare Press 5 and Press 8 for bad feet",
    "Who is worse on speed instability, Press 7 or Press 11?",
    "Compare Press 10 versus Press 12 on delta std",
]

SCOPED_ANALYSIS_PROMPTS = [
    "Is Press 11 getting worse reel to reel over the last 10 reels?",
    "Show reel to reel for Press 8 for the last 5 reels",
    "Show drift for Press 12 over the last 2 hours",
    "Show bad feet trend for Press 7 over the last 24 hours",
]

COMPARE_SCOPE_PROMPTS = [
    "Compare Press 6 vs Press 8 over the last 3 hours",
    "Compare Press 6 vs Press 8 over the last 24 hours",
]

PHASE2A_PROMPTS = [
    "How long was RLM active on Press 5 in the last 10 reels?",
    "How long was RLM inactive on Press 6 today?",
    "What is the RLM active percentage for Press 8 over the last 24 hours?",
    "Show bad feet for Press 11 in the last 10 reels",
    "Show good feet for Press 12 today",
    "Show total qualifying feet for Press 14 today",
]

PHASE2B_PROMPTS = [
    "Compare Press 5 and Press 8 on delta behavior",
    "Compare Press 6 and Press 11 on speed instability",
    "Compare Press 6 and Press 11 on tolerance changes",
]

PHASE2C_PROMPTS = [
    "Was Press 5 monitored less than Press 8?",
    "Did Press 5 have weaker monitoring coverage than the others?",
    "Was the system active less often than average?",
    "What jobs ran on Press 5 in the last 24 hours?",
]

PHASE2D_PROMPTS = [
    "Why was Press 5 worse?",
    "Why was Press 5 worse in the last 10 reels?",
    "Is Press 5 worse than average because of delta or something else?",
    "What really changed on Press 5?",
    "Did tolerance changes affect the results?",
]

DISCOVERY_PROMPTS = [
    "What stands out on Press 9 right now?",
    "Investigate Press 5 in the last 10 reels",
    "Discover what changed on Press 8 today",
]

DISCOVERY_TIME_SEQUENCES = [
    {
        "name": "discovery_previous_reels_available",
        "suite": "discovery_time",
        "prompt": "Investigate Press 5 in the last 10 reels",
        "mode": EXECUTION_MODE_DETERMINISTIC,
        "expected_tool": "run_discovery_analysis",
        "expected_machine_count": 1,
        "expects_metric": True,
        "expected_outcome": "should_pass",
        "extended_history": True,
        "expected_baseline_available": True,
        "expected_change_point_available": False,
        "require_sustained_vs_spike": True,
        "expected_shape_contains": "clustered",
        "expected_recovery_after_shift": False,
        "expected_chart": True,
        "expected_chart_title_contains": "previous-window baseline",
    },
    {
        "name": "discovery_previous_time_available",
        "suite": "discovery_time",
        "prompt": "Investigate Press 5 in the last 6 hours",
        "mode": EXECUTION_MODE_DETERMINISTIC,
        "expected_tool": "run_discovery_analysis",
        "expected_machine_count": 1,
        "expects_metric": True,
        "expected_outcome": "should_pass",
        "expected_baseline_available": True,
        "expected_change_point_available": True,
        "require_sustained_vs_spike": True,
        "expected_shape_contains": "sustained",
        "expected_answer_substring": "no clear recovery after the main shift",
        "expected_chart": True,
        "expected_chart_title_contains": "previous-window baseline",
    },
    {
        "name": "discovery_previous_window_insufficient",
        "suite": "discovery_time",
        "prompt": "Investigate Press 8 in the last 24 hours",
        "mode": EXECUTION_MODE_DETERMINISTIC,
        "expected_tool": "run_discovery_analysis",
        "expected_machine_count": 1,
        "expects_metric": True,
        "expected_outcome": "should_pass",
        "expected_baseline_available": False,
        "expected_change_point_available": True,
        "require_sustained_vs_spike": True,
        "expected_shape_contains": "sustained",
        "expected_answer_substring": "not enough prior scoped data",
        "expected_chart": True,
        "expected_chart_title_contains": "Bad Feet",
    },
    {
        "name": "discovery_isolated_spike_case",
        "suite": "discovery_time",
        "prompt": "Discover speed instability on Press 8 today",
        "mode": EXECUTION_MODE_DETERMINISTIC,
        "expected_tool": "run_discovery_analysis",
        "expected_machine_count": 1,
        "expects_metric": True,
        "expected_outcome": "should_pass",
        "expected_baseline_available": True,
        "expected_change_point_available": False,
        "require_sustained_vs_spike": True,
        "expected_shape_contains": "clustered",
        "expected_chart": True,
        "expected_chart_title_contains": "previous-window baseline",
    },
]

DISCOVERY_WORDING_SEQUENCES = [
    {
        "name": "discovery_wording_getting_worse",
        "suite": "discovery_wording",
        "prompt": "Investigate whether Press 5 is getting worse in the last 10 reels",
        "mode": EXECUTION_MODE_DETERMINISTIC,
        "expected_tool": "run_discovery_analysis",
        "expected_machine_count": 1,
        "expects_metric": True,
        "expected_outcome": "should_pass",
        "expected_answer_substring": "Yes — Press 5 is getting worse",
    },
    {
        "name": "discovery_wording_what_changed",
        "suite": "discovery_wording",
        "prompt": "What changed on Press 5 in the last 6 hours?",
        "mode": EXECUTION_MODE_DETERMINISTIC,
        "expected_tool": "run_discovery_analysis",
        "expected_machine_count": 1,
        "expects_metric": True,
        "expected_outcome": "should_pass",
        "expected_answer_substring": "Bad Feet is worse than the previous 6 hours for Press 5.",
    },
    {
        "name": "discovery_wording_spikes_vs_sustained",
        "suite": "discovery_wording",
        "prompt": "Investigate whether Press 8 was broadly unstable or just spikes today",
        "mode": EXECUTION_MODE_DETERMINISTIC,
        "expected_tool": "run_discovery_analysis",
        "expected_machine_count": 1,
        "expects_metric": True,
        "expected_outcome": "should_pass",
        "expected_answer_substring": "The issue appears",
    },
    {
        "name": "discovery_wording_recovery",
        "suite": "discovery_wording",
        "prompt": "Investigate whether Press 5 recovered after the shift in the last 6 hours",
        "mode": EXECUTION_MODE_DETERMINISTIC,
        "expected_tool": "run_discovery_analysis",
        "expected_machine_count": 1,
        "expects_metric": True,
        "expected_outcome": "should_pass",
        "expected_answer_substring": "No — there is no clear recovery after the main shift.",
    },
    {
        "name": "discovery_wording_insufficient_prior",
        "suite": "discovery_wording",
        "prompt": "Compare Press 8 to the previous window if supported over the last 24 hours",
        "mode": EXECUTION_MODE_DETERMINISTIC,
        "expected_tool": "run_discovery_analysis",
        "expected_machine_count": 1,
        "expects_metric": True,
        "expected_outcome": "should_pass",
        "expected_answer_substring": "There is not enough prior scoped data to compare this window with the previous one.",
    },
]

STARTER_PROMPTS = [
    "How is Press 8 performing?",
    "How is Press 5 performing in the last 10 reels?",
    "Which press is performing the worst right now?",
    "Which press is performing the best today?",
    "Compare Press 5 to Press 6",
    "Compare Press 5 to Average",
    "What jobs ran on Press 8 in the last 24 hours?",
    "Show me recent jobs for Press 5",
    "Show speed instability for Press 14",
    "Show delta behavior for Press 7",
]

FILTER_VISIBILITY_SEQUENCES = [
    {
        "name": "filter_visibility_scope_replacement",
        "suite": "filter_visibility",
        "turns": [
            "Show speed instability for Press 14 in the last 24 hours",
            "Now use last 10 reels instead",
        ],
        "mode": EXECUTION_MODE_DETERMINISTIC,
        "expected_tool": "get_press_metric_trend",
        "expected_machine_count": 1,
        "expects_metric": True,
        "expected_outcome": "should_pass",
        "expected_applied_filters": {
            "Press": "Press 14",
            "Reel scope": "last 10 reels",
            "Metric": "Speed Instability",
        },
        "required_absent_filters": ["Time scope"],
        "required_change_substrings": [
            "Replaced previous time scope with reel scope: last 10 reels",
        ],
    },
    {
        "name": "filter_visibility_job_selection",
        "suite": "filter_visibility",
        "turns": [
            "What jobs ran on Press 5 in the last 24 hours?",
            "Use Job JOB-1-A",
        ],
        "mode": EXECUTION_MODE_DETERMINISTIC,
        "expected_tool": "session_filters",
        "expected_machine_count": 0,
        "expects_metric": False,
        "expected_outcome": "should_pass",
        "expected_applied_filters": {
            "Press": "Press 5",
            "Job": "JOB-1-A",
            "Time scope": "last 24 hours",
        },
        "required_change_substrings": [
            "Updated job to JOB-1-A",
        ],
    },
    {
        "name": "filter_visibility_compare_to_average",
        "suite": "filter_visibility",
        "turns": [
            "Compare Press 5 to average",
        ],
        "mode": EXECUTION_MODE_DETERMINISTIC,
        "expected_tool": "get_rlm_metric_analysis",
        "expected_machine_count": 1,
        "expects_metric": True,
        "expected_outcome": "should_pass",
        "expected_applied_filters": {
            "Press": "Press 5",
            "Metric": "Bad Feet %",
        },
        "required_absent_filters": ["Time scope", "Reel scope", "Job"],
    },
]

FOLLOW_UP_SEQUENCES = [
    {
        "name": "follow_up_status_press6",
        "suite": "follow_up",
        "previous_prompt": "What is the status of Press 5 today?",
        "prompt": "Press 6",
        "mode": EXECUTION_MODE_DETERMINISTIC,
        "expected_tool": "get_press_status",
        "expected_machine_count": 1,
        "expects_metric": False,
        "expected_outcome": "should_pass",
        "expected_kind": "status",
        "expected_machine_id": 2,
    },
    {
        "name": "follow_up_status_what_about_press6",
        "suite": "follow_up",
        "previous_prompt": "What is the status of Press 5 today?",
        "prompt": "What about Press 6?",
        "mode": EXECUTION_MODE_DETERMINISTIC,
        "expected_tool": "get_press_status",
        "expected_machine_count": 1,
        "expects_metric": False,
        "expected_outcome": "should_pass",
        "expected_kind": "status",
        "expected_machine_id": 2,
    },
    {
        "name": "follow_up_trend_to_reel_summary",
        "suite": "follow_up",
        "previous_prompt": "Show the bad feet trend for Press 11",
        "prompt": "Is Press 11 getting worse reel to reel?",
        "mode": EXECUTION_MODE_DETERMINISTIC,
        "expected_tool": "get_reel_to_reel_summary",
        "expected_machine_count": 1,
        "expects_metric": False,
        "expected_outcome": "should_pass",
        "expected_kind": "reel_summary",
        "expected_machine_id": 6,
        "expected_context_inheritance": False,
    },
    {
        "name": "follow_up_trend_to_reel_summary_inherited_press",
        "suite": "follow_up",
        "previous_prompt": "Show the bad feet trend for Press 11",
        "prompt": "Is it getting worse reel to reel?",
        "mode": EXECUTION_MODE_DETERMINISTIC,
        "expected_tool": "get_reel_to_reel_summary",
        "expected_machine_count": 1,
        "expects_metric": False,
        "expected_outcome": "should_pass",
        "expected_kind": "reel_summary",
        "expected_machine_id": 6,
        "expected_context_inheritance": True,
    },
    {
        "name": "follow_up_trend_press8",
        "suite": "follow_up",
        "previous_prompt": "Show drift for Press 12 over the last 2 hours",
        "prompt": "What about Press 8?",
        "mode": EXECUTION_MODE_DETERMINISTIC,
        "expected_tool": "get_press_metric_trend",
        "expected_machine_count": 1,
        "expects_metric": True,
        "expected_outcome": "should_pass",
        "expected_kind": "trend",
        "expected_machine_id": 4,
        "expected_metric_key": "delta_drift",
        "expected_scope_kind": "time",
        "expected_scope_value": 2,
    },
    {
        "name": "follow_up_metric_bad_feet",
        "suite": "follow_up",
        "previous_prompt": "Show monitoring density for Press 5",
        "prompt": "What about bad feet?",
        "mode": EXECUTION_MODE_DETERMINISTIC,
        "expected_tool": "get_press_metric_trend",
        "expected_machine_count": 1,
        "expects_metric": True,
        "expected_outcome": "should_pass",
        "expected_kind": "trend",
        "expected_machine_id": 1,
        "expected_metric_key": "bad_feet_pct",
    },
    {
        "name": "follow_up_reel_press8",
        "suite": "follow_up",
        "previous_prompt": "Is Press 11 getting worse reel to reel over the last 10 reels?",
        "prompt": "What about Press 8?",
        "mode": EXECUTION_MODE_DETERMINISTIC,
        "expected_tool": "get_reel_to_reel_summary",
        "expected_machine_count": 1,
        "expects_metric": False,
        "expected_outcome": "should_pass",
        "expected_kind": "reel_summary",
        "expected_machine_id": 4,
        "expected_scope_kind": "reels",
        "expected_scope_value": 10,
    },
]

SCOPE_FOLLOW_UP_SEQUENCES = [
    {
        "name": "scope_follow_up_status_last_6_hours",
        "suite": "scope_follow_up",
        "previous_prompt": "What is the status of Press 6 today?",
        "prompt": "What about the last 6 hours?",
        "mode": EXECUTION_MODE_DETERMINISTIC,
        "expected_tool": "get_press_status",
        "expected_machine_count": 1,
        "expects_metric": False,
        "expected_outcome": "should_pass",
        "expected_kind": "status",
        "expected_machine_id": 2,
        "expected_scope_kind": "time",
        "expected_scope_value": 6,
        "expected_scope_source": "inherited_followup",
    },
    {
        "name": "scope_follow_up_reel_last_10_reels",
        "suite": "scope_follow_up",
        "previous_prompt": "Is Press 11 getting worse reel to reel?",
        "prompt": "What about the last 10 reels?",
        "mode": EXECUTION_MODE_DETERMINISTIC,
        "expected_tool": "get_reel_to_reel_summary",
        "expected_machine_count": 1,
        "expects_metric": False,
        "expected_outcome": "should_pass",
        "expected_kind": "reel_summary",
        "expected_machine_id": 6,
        "expected_scope_kind": "reels",
        "expected_scope_value": 10,
        "expected_scope_source": "inherited_followup",
    },
    {
        "name": "scope_follow_up_trend_last_2_hours",
        "suite": "scope_follow_up",
        "previous_prompt": "Show drift for Press 12 today",
        "prompt": "What about the last 2 hours?",
        "mode": EXECUTION_MODE_DETERMINISTIC,
        "expected_tool": "get_press_metric_trend",
        "expected_machine_count": 1,
        "expects_metric": True,
        "expected_outcome": "should_pass",
        "expected_kind": "trend",
        "expected_machine_id": 7,
        "expected_metric_key": "delta_drift",
        "expected_scope_kind": "time",
        "expected_scope_value": 2,
        "expected_scope_source": "inherited_followup",
    },
]

STICKY_FILTER_SEQUENCES = [
    {
        "name": "sticky_time_scope_status_follow_up",
        "suite": "sticky_filters",
        "turns": [
            "Look at the last 6 hours",
            "What is the status of Press 5?",
            "What about Press 6?",
        ],
        "mode": EXECUTION_MODE_DETERMINISTIC,
        "expected_tool": "get_press_status",
        "expected_machine_count": 1,
        "expects_metric": False,
        "expected_outcome": "should_pass",
        "expected_kind": "status",
        "expected_machine_id": 2,
        "expected_active_filters": {"timeScope": "last 6 hours"},
        "expected_filter_source": "inherited_session",
    },
    {
        "name": "sticky_feet_filter_compare",
        "suite": "sticky_filters",
        "turns": [
            "Look at reels over 5000 feet",
            "Best press today",
            "Compare Press 6 vs Press 8",
        ],
        "mode": EXECUTION_MODE_DETERMINISTIC,
        "expected_tool": "compare_presses",
        "expected_machine_count": 2,
        "expects_metric": False,
        "expected_outcome": "should_pass",
        "expected_kind": "compare",
        "expected_active_filters": {"feetFilter": "Over 5000 ft"},
        "expected_filter_source": "inherited_session",
    },
    {
        "name": "sticky_reel_scope_follow_up",
        "suite": "sticky_filters",
        "turns": [
            "Last 10 reels",
            "Is Press 11 getting worse reel to reel?",
            "What about Press 8?",
        ],
        "mode": EXECUTION_MODE_DETERMINISTIC,
        "expected_tool": "get_reel_to_reel_summary",
        "expected_machine_count": 1,
        "expects_metric": False,
        "expected_outcome": "should_pass",
        "expected_kind": "reel_summary",
        "expected_machine_id": 4,
        "expected_active_filters": {"reelScope": "last 10 reels"},
        "expected_filter_source": "inherited_session",
        "expected_effective_reel_scope": "last 10 reels",
    },
    {
        "name": "sticky_clear_time_filter",
        "suite": "sticky_filters",
        "turns": [
            "Last 6 hours",
            "Clear time filter",
            "What is the status of Press 5?",
        ],
        "mode": EXECUTION_MODE_DETERMINISTIC,
        "expected_tool": "get_press_status",
        "expected_machine_count": 1,
        "expects_metric": False,
        "expected_outcome": "should_pass",
        "expected_kind": "status",
        "expected_machine_id": 1,
        "expected_active_filters": {},
        "expected_filter_source": "filters",
    },
    {
        "name": "sticky_clear_feet_filter",
        "suite": "sticky_filters",
        "turns": [
            "Over 5000 feet only",
            "Clear the feet filter",
            "Best press today",
        ],
        "mode": EXECUTION_MODE_DETERMINISTIC,
        "expected_tool": "get_press_rankings",
        "expected_machine_count": 1,
        "expects_metric": False,
        "expected_outcome": "should_pass",
        "expected_kind": "ranking_summary",
        "expected_active_filters": {"timeScope": "today"},
        "expected_filter_source": "explicit_prompt",
    },
]

LIVE_STICKY_SEQUENCES = [
    {
        "name": "live_sticky_reel_scope_metric_follow_up",
        "suite": "sticky_live",
        "turns": [
            "Show delta behavior for Press 5 in the last 10 reels",
            "What about speed instability?",
            "Compare it to average.",
        ],
        "mode": EXECUTION_MODE_DETERMINISTIC,
        "use_live_ui_filters": True,
        "expected_tool": "get_rlm_metric_analysis",
        "expected_machine_count": 1,
        "expects_metric": True,
        "expected_outcome": "should_pass",
        "expected_kind": "activity",
        "expected_machine_id": 1,
        "expected_metric_key": "speed_instability",
        "expected_comparison_mode": "press_vs_average",
        "expected_active_filters": {"reelScope": "last 10 reels"},
        "expected_filter_source": "inherited_session",
        "expected_effective_reel_scope": "last 10 reels",
    },
    {
        "name": "live_sticky_time_scope_decision_follow_up",
        "suite": "sticky_live",
        "turns": [
            "Show delta behavior for Press 5 in the last 24 hours",
            "What really changed?",
        ],
        "mode": EXECUTION_MODE_DETERMINISTIC,
        "use_live_ui_filters": True,
        "expected_tool": "get_rlm_metric_analysis",
        "expected_machine_count": 1,
        "expects_metric": True,
        "expected_outcome": "should_pass",
        "expected_kind": "activity",
        "expected_machine_id": 1,
        "expected_metric_key": "delta_variation",
        "expected_active_filters": {"timeScope": "last 24 hours"},
        "expected_filter_source": "inherited_session",
    },
    {
        "name": "live_sticky_job_selection_flow",
        "suite": "sticky_live",
        "turns": [
            "What jobs ran on Press 5 in the last 24 hours?",
            "Use Job JOB-1-A",
            "Analyze only that job",
            "Compare that job to average",
        ],
        "mode": EXECUTION_MODE_DETERMINISTIC,
        "use_live_ui_filters": True,
        "expected_tool": "get_rlm_metric_analysis",
        "expected_machine_count": 1,
        "expects_metric": True,
        "expected_outcome": "should_pass",
        "expected_kind": "activity",
        "expected_machine_id": 1,
        "expected_metric_key": "delta_variation",
        "expected_active_filters": {"timeScope": "last 24 hours"},
        "expected_filter_source": "inherited_session",
        "expected_selected_job": "JOB-1-A",
    },
    {
        "name": "live_scope_override_reels_to_time",
        "suite": "sticky_live",
        "turns": [
            "Show delta behavior for Press 5 in the last 10 reels",
            "Now use last 6 hours instead",
            "What about bad feet?",
        ],
        "mode": EXECUTION_MODE_DETERMINISTIC,
        "use_live_ui_filters": True,
        "expected_tool": "get_rlm_metric_analysis",
        "expected_machine_count": 1,
        "expects_metric": True,
        "expected_outcome": "should_pass",
        "expected_kind": "activity",
        "expected_machine_id": 1,
        "expected_metric_key": "rlm_bad_feet",
        "expected_active_filters": {"timeScope": "last 6 hours"},
        "expected_filter_source": "inherited_session",
        "expected_absent_active_filters": ["reelScope"],
    },
    {
        "name": "live_cross_press_clears_incompatible_job",
        "suite": "sticky_live",
        "turns": [
            "What jobs ran on Press 5 in the last 24 hours?",
            "Use Job JOB-1-A",
            "Show speed instability for Press 14",
        ],
        "mode": EXECUTION_MODE_DETERMINISTIC,
        "use_live_ui_filters": True,
        "expected_tool": "get_press_metric_trend",
        "expected_machine_count": 1,
        "expects_metric": True,
        "expected_outcome": "should_pass",
        "expected_kind": "trend",
        "expected_machine_id": 9,
        "expected_metric_key": "speed_instability",
        "expected_active_filters": {"timeScope": "last 24 hours"},
        "expected_filter_source": "inherited_session",
        "expected_absent_active_filters": ["job"],
    },
    {
        "name": "live_ranking_summary_does_not_trap_explicit_trend",
        "suite": "sticky_live",
        "turns": [
            "Which press is performing the worst right now?",
            "Show the bad feet trend for Press 11",
        ],
        "mode": EXECUTION_MODE_DETERMINISTIC,
        "use_live_ui_filters": True,
        "expected_tool": "get_press_metric_trend",
        "expected_machine_count": 1,
        "expects_metric": True,
        "expected_outcome": "should_pass",
        "expected_kind": "trend",
        "expected_machine_id": 6,
        "expected_metric_key": "bad_feet_pct",
    },
    {
        "name": "live_compare_does_not_trap_explicit_trend",
        "suite": "sticky_live",
        "turns": [
            "Compare Press 6 and Press 8",
            "Show the bad feet trend for Press 11",
        ],
        "mode": EXECUTION_MODE_DETERMINISTIC,
        "use_live_ui_filters": True,
        "expected_tool": "get_press_metric_trend",
        "expected_machine_count": 1,
        "expects_metric": True,
        "expected_outcome": "should_pass",
        "expected_kind": "trend",
        "expected_machine_id": 6,
        "expected_metric_key": "bad_feet_pct",
    },
    {
        "name": "live_discovery_does_not_trap_explicit_trend",
        "suite": "sticky_live",
        "turns": [
            "What changed on Press 8 today?",
            "Show the bad feet trend for Press 11",
        ],
        "mode": EXECUTION_MODE_DETERMINISTIC,
        "use_live_ui_filters": True,
        "expected_tool": "get_press_metric_trend",
        "expected_machine_count": 1,
        "expects_metric": True,
        "expected_outcome": "should_pass",
        "expected_kind": "trend",
        "expected_machine_id": 6,
        "expected_metric_key": "bad_feet_pct",
    },
    {
        "name": "live_trend_compare_to_average_keeps_metric",
        "suite": "sticky_live",
        "turns": [
            "Show speed instability for Press 14",
            "Compare it to average",
        ],
        "mode": EXECUTION_MODE_DETERMINISTIC,
        "use_live_ui_filters": True,
        "expected_tool": "get_rlm_metric_analysis",
        "expected_machine_count": 1,
        "expects_metric": True,
        "expected_outcome": "should_pass",
        "expected_kind": "activity",
        "expected_machine_id": 9,
        "expected_metric_key": "speed_instability",
        "expected_comparison_mode": "press_vs_average",
    },
]

RESET_SEQUENCES = [
    {
        "name": "live_new_chat_clears_sticky_context",
        "suite": "sticky_live",
        "turns_before_reset": [
            "Show delta behavior for Press 5 in the last 10 reels",
        ],
        "prompt_after_reset": "What about speed instability?",
        "mode": EXECUTION_MODE_DETERMINISTIC,
        "use_live_ui_filters": True,
        "expected_tool": "get_rlm_metric_analysis",
        "expected_machine_count": 0,
        "expects_metric": False,
        "expected_outcome": "should_pass",
        "expected_machine_id": 0,
        "expected_metric_key": "speed_instability",
    },
]

PHASE2A_FOLLOW_UP_SEQUENCES = [
    {
        "name": "phase2a_follow_up_metric_compare_trend",
        "suite": "phase2a_follow_up",
        "turns": [
            "How long was RLM active on Press 5 in the last 10 reels?",
            "What about bad feet?",
            "Compare it to average.",
            "Is it getting worse?",
        ],
        "mode": EXECUTION_MODE_DETERMINISTIC,
        "expected_tool": "get_rlm_metric_analysis",
        "expected_machine_count": 1,
        "expects_metric": True,
        "expected_outcome": "should_pass",
        "expected_kind": "activity",
        "expected_machine_id": 1,
        "expected_metric_key": "rlm_bad_feet",
        "expected_comparison_mode": "press_vs_average",
        "expected_trend_requested": True,
        "expected_scope_kind": "reels",
        "expected_scope_value": 10,
    },
]

PHASE2B_FOLLOW_UP_SEQUENCES = [
    {
        "name": "phase2b_driver_reels_follow_up",
        "suite": "phase2b_follow_up",
        "turns": [
            "Show bad feet for Press 5 in the last 10 reels",
            "Which reels drove this?",
        ],
        "mode": EXECUTION_MODE_DETERMINISTIC,
        "expected_tool": "get_rlm_metric_analysis",
        "expected_machine_count": 1,
        "expects_metric": True,
        "expected_outcome": "should_pass",
        "expected_kind": "activity",
        "expected_machine_id": 1,
        "expected_metric_key": "rlm_bad_feet",
        "expected_grouping": "reels",
    },
    {
        "name": "phase2b_run_position_follow_up",
        "suite": "phase2b_follow_up",
        "turns": [
            "Show bad feet for Press 5 in the last 10 reels",
            "Was this only at the start of the job?",
        ],
        "mode": EXECUTION_MODE_DETERMINISTIC,
        "expected_tool": "get_rlm_metric_analysis",
        "expected_machine_count": 1,
        "expects_metric": True,
        "expected_outcome": "should_pass",
        "expected_kind": "activity",
        "expected_machine_id": 1,
        "expected_metric_key": "rlm_bad_feet",
        "expected_grouping": "run_position",
    },
    {
        "name": "phase2b_concentration_follow_up",
        "suite": "phase2b_follow_up",
        "turns": [
            "Show bad feet for Press 5 in the last 10 reels",
            "Was it high peaks or generally elevated?",
        ],
        "mode": EXECUTION_MODE_DETERMINISTIC,
        "expected_tool": "get_rlm_metric_analysis",
        "expected_machine_count": 1,
        "expects_metric": True,
        "expected_outcome": "should_pass",
        "expected_kind": "activity",
        "expected_machine_id": 1,
        "expected_metric_key": "rlm_bad_feet",
        "expected_grouping": "concentration",
    },
    {
        "name": "phase2b_alignment_follow_up",
        "suite": "phase2b_follow_up",
        "turns": [
            "Show delta behavior for Press 5 in the last 10 reels",
            "Did speed instability line up with delta problems?",
        ],
        "mode": EXECUTION_MODE_DETERMINISTIC,
        "expected_tool": "get_rlm_metric_analysis",
        "expected_machine_count": 1,
        "expects_metric": True,
        "expected_outcome": "should_pass",
        "expected_kind": "activity",
        "expected_machine_id": 1,
        "expected_metric_key": "delta_variation",
        "expected_grouping": "alignment",
    },
]

PHASE2C_FOLLOW_UP_SEQUENCES = [
    {
        "name": "phase2c_fairness_follow_up",
        "suite": "phase2c_follow_up",
        "turns": [
            "Was Press 5 monitored less than Press 8?",
            "Did monitoring coverage differences make this comparison less fair?",
        ],
        "mode": EXECUTION_MODE_DETERMINISTIC,
        "expected_tool": "get_rlm_metric_analysis",
        "expected_machine_count": 2,
        "expects_metric": True,
        "expected_outcome": "should_pass",
        "expected_kind": "activity",
        "expected_machine_id": 1,
        "expected_metric_key": "monitoring_coverage",
        "expected_grouping": "fairness",
        "expected_comparison_mode": "press_vs_press",
    },
    {
        "name": "phase2c_episode_follow_up",
        "suite": "phase2c_follow_up",
        "turns": [
            "Show delta behavior for Press 5 in the last 10 reels",
            "Did the run have one bad delta period or multiple?",
        ],
        "mode": EXECUTION_MODE_DETERMINISTIC,
        "expected_tool": "get_rlm_metric_analysis",
        "expected_machine_count": 1,
        "expects_metric": True,
        "expected_outcome": "should_pass",
        "expected_kind": "activity",
        "expected_machine_id": 1,
        "expected_metric_key": "delta_variation",
        "expected_grouping": "episodes",
    },
    {
        "name": "phase2c_recovery_follow_up",
        "suite": "phase2c_follow_up",
        "turns": [
            "Show delta behavior for Press 5 in the last 10 reels",
            "Was it around 5 mm off for part of the job and then recover?",
        ],
        "mode": EXECUTION_MODE_DETERMINISTIC,
        "expected_tool": "get_rlm_metric_analysis",
        "expected_machine_count": 1,
        "expects_metric": True,
        "expected_outcome": "should_pass",
        "expected_kind": "activity",
        "expected_machine_id": 1,
        "expected_metric_key": "delta_variation",
        "expected_grouping": "episodes",
    },
    {
        "name": "phase2c_job_selection_flow",
        "suite": "phase2c_follow_up",
        "turns": [
            "What jobs ran on Press 5 in the last 24 hours?",
            "Use Job JOB-1-A",
            "Analyze only that job",
            "Compare that job's delta behavior to average",
        ],
        "mode": EXECUTION_MODE_DETERMINISTIC,
        "expected_tool": "get_rlm_metric_analysis",
        "expected_machine_count": 1,
        "expects_metric": True,
        "expected_outcome": "should_pass",
        "expected_kind": "activity",
        "expected_machine_id": 1,
        "expected_metric_key": "delta_variation",
        "expected_comparison_mode": "press_vs_average",
        "expected_selected_job": "JOB-1-A",
    },
]

PHASE2D_FOLLOW_UP_SEQUENCES = [
    {
        "name": "phase2d_concentration_follow_up",
        "suite": "phase2d_follow_up",
        "turns": [
            "Show bad feet for Press 5 in the last 10 reels",
            "Was this just a few reels or the whole job?",
        ],
        "mode": EXECUTION_MODE_DETERMINISTIC,
        "expected_tool": "get_rlm_metric_analysis",
        "expected_machine_count": 1,
        "expects_metric": True,
        "expected_outcome": "should_pass",
        "expected_kind": "activity",
        "expected_machine_id": 1,
        "expected_metric_key": "rlm_bad_feet",
        "expected_grouping": "concentration",
        "required_section": "Pattern summary",
    },
    {
        "name": "phase2d_spikes_follow_up",
        "suite": "phase2d_follow_up",
        "turns": [
            "Show bad feet for Press 5 in the last 10 reels",
            "Was it broadly unstable or just spikes?",
        ],
        "mode": EXECUTION_MODE_DETERMINISTIC,
        "expected_tool": "get_rlm_metric_analysis",
        "expected_machine_count": 1,
        "expects_metric": True,
        "expected_outcome": "should_pass",
        "expected_kind": "activity",
        "expected_machine_id": 1,
        "expected_metric_key": "rlm_bad_feet",
        "expected_grouping": "concentration",
        "required_section": "Concentration pattern",
    },
    {
        "name": "phase2d_recovery_follow_up",
        "suite": "phase2d_follow_up",
        "turns": [
            "Show delta behavior for Press 5 in the last 10 reels",
            "Did it recover?",
        ],
        "mode": EXECUTION_MODE_DETERMINISTIC,
        "expected_tool": "get_rlm_metric_analysis",
        "expected_machine_count": 1,
        "expects_metric": True,
        "expected_outcome": "should_pass",
        "expected_kind": "activity",
        "expected_machine_id": 1,
        "expected_metric_key": "delta_variation",
        "expected_grouping": "episodes",
        "required_section": "Deviation episode summary",
    },
]

MINIMAL_SINGLE_PRESS_PROMPTS = [
    "Press 5",
    "press 5",
    "Press 11",
    "P5",
    "status press 5",
    "how is press 5",
]

EXPECTED_METADATA: Dict[str, Dict[str, Any]] = {
    "What is the status of Press 5 today?": {"expected_tool": "get_press_status", "expected_machine_count": 1, "expects_metric": False},
    "How is Press 8 doing?": {"expected_tool": "get_press_status", "expected_machine_count": 1, "expects_metric": False},
    "Status for Press 11": {"expected_tool": "get_press_status", "expected_machine_count": 1, "expects_metric": False},
    "Is Press 6 healthy right now?": {"expected_tool": "get_press_status", "expected_machine_count": 1, "expects_metric": False},
    "Compare Press 6 vs Press 8": {"expected_tool": "compare_presses", "expected_machine_count": 2, "expects_metric": False},
    "Compare Press 11 versus Press 12": {"expected_tool": "compare_presses", "expected_machine_count": 2, "expects_metric": False},
    "Why is Press 11 ranked low?": {"expected_tool": "get_press_rankings", "expected_machine_count": 1, "expects_metric": False},
    "Why is Press 6 low?": {"expected_tool": "get_press_rankings", "expected_machine_count": 1, "expects_metric": False},
    "Is Press 6 getting worse reel to reel?": {"expected_tool": "get_reel_to_reel_summary", "expected_machine_count": 1, "expects_metric": False},
    "Show reel to reel for Press 8": {"expected_tool": "get_reel_to_reel_summary", "expected_machine_count": 1, "expects_metric": False},
    "Show the bad feet trend for Press 7": {"expected_tool": "get_press_metric_trend", "expected_machine_count": 1, "expects_metric": True},
    "Show monitoring density for Press 6": {"expected_tool": "get_press_metric_trend", "expected_machine_count": 1, "expects_metric": True},
    "Show delta std for Press 9": {"expected_tool": "get_press_metric_trend", "expected_machine_count": 1, "expects_metric": True},
    "Plot drift for Press 12": {"expected_tool": "get_press_metric_trend", "expected_machine_count": 1, "expects_metric": True},
    "Show speed instability for Press 14": {"expected_tool": "get_press_metric_trend", "expected_machine_count": 1, "expects_metric": True},
    "What stands out on Press 9 right now?": {"expected_tool": "run_discovery_analysis", "expected_machine_count": 1, "expects_metric": True},
    "Which is running better, Press 9 or Press 14?": {"expected_tool": "compare_presses", "expected_machine_count": 2, "expects_metric": False},
    "What’s hurting Press 9 in the rankings?": {"expected_tool": "get_press_rankings", "expected_machine_count": 1, "expects_metric": False},
    "What categories are dragging Press 8 down?": {"expected_tool": "get_press_rankings", "expected_machine_count": 1, "expects_metric": False},
    "How are the recent reels looking on Press 12?": {"expected_tool": "get_reel_to_reel_summary", "expected_machine_count": 1, "expects_metric": False},
    "Is Press 7 getting cleaner or dirtier lately?": {"expected_tool": "get_reel_to_reel_summary", "expected_machine_count": 1, "expects_metric": False},
    "Can you show how drift has been moving on Press 13?": {"expected_tool": "get_press_metric_trend", "expected_machine_count": 1, "expects_metric": True},
    "Operator view: is Press 8 in trouble today?": {"expected_tool": "get_press_status", "expected_machine_count": 1, "expects_metric": False},
    "Why does Press 15 look weak this week?": {"expected_tool": "get_press_rankings", "expected_machine_count": 1, "expects_metric": False},
    "Put Press 6 next to Press 8 and tell me what stands out": {"expected_tool": "compare_presses", "expected_machine_count": 2, "expects_metric": False},
    "How are all presses doing today?": {"expected_tool": "get_press_status", "expected_machine_count": 0, "expects_metric": False},
    "What rank is Press 8?": {"expected_tool": "get_press_rankings", "expected_machine_count": 1, "expects_metric": False},
    "Compare 6 and 8": {"expected_tool": "compare_presses", "expected_machine_count": 2, "expects_metric": False},
    "Show delta for Press 8": {"expected_tool": "get_press_metric_trend", "expected_machine_count": 1, "expects_metric": True},
    "Show temperature trend for Press 6": {"expected_tool": "get_press_metric_trend", "expected_machine_count": 1, "expects_metric": True},
    "Why is Press 11 ranked low and show the drift trend too": {"expected_tool": "get_press_rankings", "expected_machine_count": 1, "expects_metric": False},
    "Best press today and compare it to Press 8": {"expected_tool": "compare_presses", "expected_machine_count": 2, "expects_metric": False},
    "What stands out today?": {"expected_tool": "get_press_status", "expected_machine_count": 0, "expects_metric": False},
    "How did the last three reels look for Press 5?": {"expected_tool": "get_reel_to_reel_summary", "expected_machine_count": 1, "expects_metric": False},
    "What is Press 8 best at?": {"expected_tool": "get_press_rankings", "expected_machine_count": 1, "expects_metric": False},
    "best press today": {"expected_tool": "get_press_rankings", "expected_machine_count": 1, "expects_metric": False},
    "worst press this week": {"expected_tool": "get_press_rankings", "expected_machine_count": 1, "expects_metric": False},
    "top 3 presses today": {"expected_tool": "get_press_rankings", "expected_machine_count": 3, "expects_metric": False},
    "bottom 3 presses today": {"expected_tool": "get_press_rankings", "expected_machine_count": 3, "expects_metric": False},
    "best 5 presses": {"expected_tool": "get_press_rankings", "expected_machine_count": 5, "expects_metric": False},
    "worst 5 presses": {"expected_tool": "get_press_rankings", "expected_machine_count": 5, "expects_metric": False},
    "strongest press today": {"expected_tool": "get_press_rankings", "expected_machine_count": 1, "expects_metric": False},
    "weakest press this week": {"expected_tool": "get_press_rankings", "expected_machine_count": 1, "expects_metric": False},
    "Press 5": {"expected_tool": "get_press_status", "expected_machine_count": 1, "expects_metric": False},
    "press 5": {"expected_tool": "get_press_status", "expected_machine_count": 1, "expects_metric": False},
    "Press 11": {"expected_tool": "get_press_status", "expected_machine_count": 1, "expects_metric": False},
    "P5": {"expected_tool": "get_press_status", "expected_machine_count": 1, "expects_metric": False},
    "status press 5": {"expected_tool": "get_press_status", "expected_machine_count": 1, "expects_metric": False},
    "how is press 5": {"expected_tool": "get_press_status", "expected_machine_count": 1, "expects_metric": False},
    "best press for bad feet today": {"expected_tool": "get_press_rankings", "expected_machine_count": 1, "expects_metric": False},
    "worst press for drift this week": {"expected_tool": "get_press_rankings", "expected_machine_count": 1, "expects_metric": False},
    "who has the best monitoring density": {"expected_tool": "get_press_rankings", "expected_machine_count": 1, "expects_metric": False},
    "bottom 3 presses for speed instability": {"expected_tool": "get_press_rankings", "expected_machine_count": 3, "expects_metric": False},
    "top 5 presses for delta std": {"expected_tool": "get_press_rankings", "expected_machine_count": 5, "expects_metric": False},
    "which press is worst for repeat length drift": {"expected_tool": "get_press_rankings", "expected_machine_count": 1, "expects_metric": False},
    "Compare Press 6 vs Press 8 on drift": {"expected_tool": "compare_presses", "expected_machine_count": 2, "expects_metric": False},
    "Which is better on monitoring density, Press 6 or Press 9?": {"expected_tool": "compare_presses", "expected_machine_count": 2, "expects_metric": False},
    "Compare Press 5 and Press 8 for bad feet": {"expected_tool": "compare_presses", "expected_machine_count": 2, "expects_metric": False},
    "Who is worse on speed instability, Press 7 or Press 11?": {"expected_tool": "compare_presses", "expected_machine_count": 2, "expects_metric": False},
    "Compare Press 10 versus Press 12 on delta std": {"expected_tool": "compare_presses", "expected_machine_count": 2, "expects_metric": False},
    "Is Press 11 getting worse reel to reel over the last 10 reels?": {"expected_tool": "get_reel_to_reel_summary", "expected_machine_count": 1, "expects_metric": False},
    "Show reel to reel for Press 8 for the last 5 reels": {"expected_tool": "get_reel_to_reel_summary", "expected_machine_count": 1, "expects_metric": False},
    "Show drift for Press 12 over the last 2 hours": {"expected_tool": "get_press_metric_trend", "expected_machine_count": 1, "expects_metric": True},
    "Show bad feet trend for Press 7 over the last 24 hours": {"expected_tool": "get_press_metric_trend", "expected_machine_count": 1, "expects_metric": True},
    "Compare Press 6 vs Press 8 over the last 3 hours": {"expected_tool": "compare_presses", "expected_machine_count": 2, "expects_metric": False},
    "Compare Press 6 vs Press 8 over the last 24 hours": {"expected_tool": "compare_presses", "expected_machine_count": 2, "expects_metric": False},
    "How long was RLM active on Press 5 in the last 10 reels?": {"expected_tool": "get_rlm_metric_analysis", "expected_machine_count": 1, "expects_metric": True},
    "How long was RLM inactive on Press 6 today?": {"expected_tool": "get_rlm_metric_analysis", "expected_machine_count": 1, "expects_metric": True},
    "What is the RLM active percentage for Press 8 over the last 24 hours?": {"expected_tool": "get_rlm_metric_analysis", "expected_machine_count": 1, "expects_metric": True},
    "Show bad feet for Press 11 in the last 10 reels": {"expected_tool": "get_rlm_metric_analysis", "expected_machine_count": 1, "expects_metric": True},
    "Show good feet for Press 12 today": {"expected_tool": "get_rlm_metric_analysis", "expected_machine_count": 1, "expects_metric": True},
    "Show total qualifying feet for Press 14 today": {"expected_tool": "get_rlm_metric_analysis", "expected_machine_count": 1, "expects_metric": True},
    "Compare Press 5 and Press 8 on delta behavior": {"expected_tool": "get_rlm_metric_analysis", "expected_machine_count": 2, "expects_metric": True},
    "Compare Press 6 and Press 11 on speed instability": {"expected_tool": "get_rlm_metric_analysis", "expected_machine_count": 2, "expects_metric": True},
    "Compare Press 6 and Press 11 on tolerance changes": {"expected_tool": "get_rlm_metric_analysis", "expected_machine_count": 2, "expects_metric": True},
    "Was Press 5 monitored less than Press 8?": {"expected_tool": "get_rlm_metric_analysis", "expected_machine_count": 2, "expects_metric": True},
    "Did Press 5 have weaker monitoring coverage than the others?": {"expected_tool": "get_rlm_metric_analysis", "expected_machine_count": 1, "expects_metric": True},
    "Was the system active less often than average?": {"expected_tool": "get_rlm_metric_analysis", "expected_machine_count": 1, "expects_metric": True},
    "What jobs ran on Press 5 in the last 24 hours?": {"expected_tool": "get_press_job_list", "expected_machine_count": 1, "expects_metric": False},
    "Why was Press 5 worse?": {"expected_tool": "get_rlm_metric_analysis", "expected_machine_count": 1, "expects_metric": True},
    "Why was Press 5 worse in the last 10 reels?": {"expected_tool": "get_rlm_metric_analysis", "expected_machine_count": 1, "expects_metric": True},
    "Is Press 5 worse than average because of delta or something else?": {"expected_tool": "get_rlm_metric_analysis", "expected_machine_count": 1, "expects_metric": True},
    "What really changed on Press 5?": {"expected_tool": "get_rlm_metric_analysis", "expected_machine_count": 1, "expects_metric": True},
    "Did tolerance changes affect the results?": {"expected_tool": "get_rlm_metric_analysis", "expected_machine_count": 1, "expects_metric": True},
    "Investigate Press 5 in the last 10 reels": {"expected_tool": "run_discovery_analysis", "expected_machine_count": 1, "expects_metric": True},
    "How is Press 8 performing?": {"expected_tool": "get_press_status", "expected_machine_count": 1, "expects_metric": False},
    "How is Press 5 performing in the last 10 reels?": {"expected_tool": "get_press_status", "expected_machine_count": 1, "expects_metric": False},
    "Discover what changed on Press 8 today": {"expected_tool": "run_discovery_analysis", "expected_machine_count": 1, "expects_metric": True},
    "Which press is performing the worst right now?": {"expected_tool": "get_press_rankings", "expected_machine_count": 1, "expects_metric": False},
    "What changed on Press 8 today?": {"expected_tool": "run_discovery_analysis", "expected_machine_count": 1, "expects_metric": True},
    "Compare Press 6 and Press 8": {"expected_tool": "compare_presses", "expected_machine_count": 2, "expects_metric": False},
    "Compare Press 5 to Press 6": {"expected_tool": "compare_presses", "expected_machine_count": 2, "expects_metric": False},
    "Compare Press 5 to average": {"expected_tool": "get_rlm_metric_analysis", "expected_machine_count": 1, "expects_metric": True},
    "Compare Press 5 to Average": {"expected_tool": "get_rlm_metric_analysis", "expected_machine_count": 1, "expects_metric": True},
    "Which press has the weakest monitoring coverage today?": {"expected_tool": "get_press_rankings", "expected_machine_count": 1, "expects_metric": False},
    "Which press is performing the best today?": {"expected_tool": "get_press_rankings", "expected_machine_count": 1, "expects_metric": False},
    "What jobs ran on Press 5 in the last 24 hours?": {"expected_tool": "get_press_job_list", "expected_machine_count": 1, "expects_metric": False},
    "What jobs ran on Press 8 in the last 24 hours?": {"expected_tool": "get_press_job_list", "expected_machine_count": 1, "expects_metric": False},
    "Show me the recent jobs for Press 8": {"expected_tool": "get_press_job_list", "expected_machine_count": 1, "expects_metric": False},
    "Show me recent jobs for Press 5": {"expected_tool": "get_press_job_list", "expected_machine_count": 1, "expects_metric": False},
    "Show delta behavior for Press 7": {"expected_tool": "get_rlm_metric_analysis", "expected_machine_count": 1, "expects_metric": True},
    "Show speed instability for Press 14": {"expected_tool": "get_press_metric_trend", "expected_machine_count": 1, "expects_metric": True},
    "Look at the last 6 hours": {"expected_tool": "unsupported", "expected_machine_count": 0, "expects_metric": False},
    "Look at reels over 5000 feet": {"expected_tool": "unsupported", "expected_machine_count": 0, "expects_metric": False},
    "Last 10 reels": {"expected_tool": "unsupported", "expected_machine_count": 0, "expects_metric": False},
    "Last 6 hours": {"expected_tool": "unsupported", "expected_machine_count": 0, "expects_metric": False},
    "Clear time filter": {"expected_tool": "unsupported", "expected_machine_count": 0, "expects_metric": False},
    "Over 5000 feet only": {"expected_tool": "unsupported", "expected_machine_count": 0, "expects_metric": False},
    "Clear the feet filter": {"expected_tool": "unsupported", "expected_machine_count": 0, "expects_metric": False},
}


def extract_press_ids(text: str) -> List[int]:
    seen: List[int] = []
    for match in PRESS_RE.findall(text or ""):
        machine_id = int(match)
        if machine_id not in seen:
            seen.append(machine_id)
    return seen


def map_press_number_to_machine_id(press_number: int) -> int:
    return KNOWN_PRESS_NUMBER_TO_MACHINE_ID.get(int(press_number), int(press_number))


def prompt_machine_ids(text: str) -> List[int]:
    return [map_press_number_to_machine_id(press_number) for press_number in extract_press_ids(text)]


def slugify(prompt: str) -> str:
    return re.sub(r"[^a-z0-9]+", "_", prompt.lower()).strip("_")


def infer_expected_tool(prompt: str) -> str:
    lowered = prompt.lower()
    if "compare" in lowered or " versus " in lowered or " vs " in lowered:
        return "compare_presses"
    if "ranked low" in lowered or re.search(r"\bwhy is press \d+ low\b", lowered):
        return "get_press_rankings"
    if "reel to reel" in lowered or "reel-to-reel" in lowered or "reel by reel" in lowered:
        return "get_reel_to_reel_summary"
    if any(token in lowered for token in ("trend", "show", "plot")) and any(
        token in lowered
        for token in ("bad feet", "monitoring density", "monitoring coverage", "delta std", "drift", "speed instability", "webspeed")
    ):
        return "get_press_metric_trend"
    if any(token in lowered for token in ("status", "how is", "healthy right now")):
        return "get_press_status"
    if "best press" in lowered or "worst press" in lowered or "top " in lowered:
        return "get_press_rankings"
    return "unsupported"


def infer_metric_required(prompt: str) -> bool:
    return infer_expected_tool(prompt) == "get_press_metric_trend"


def infer_machine_count(prompt: str) -> int:
    presses = extract_press_ids(prompt)
    expected_tool = infer_expected_tool(prompt)
    if expected_tool == "compare_presses":
        return 2
    if presses:
        return 1
    return 1 if expected_tool == "get_press_rankings" and "best press" in prompt.lower() else 0


def build_case(prompt: str, *, suite: str, recommended_mode: str, expected_outcome: str) -> Dict[str, Any]:
    metadata = EXPECTED_METADATA[prompt]
    return {
        "name": slugify(prompt),
        "suite": suite,
        "prompt": prompt,
        "mode": recommended_mode,
        "recommended_mode": recommended_mode,
        "expected_tool": metadata["expected_tool"],
        "expected_machine_count": metadata["expected_machine_count"],
        "expects_metric": metadata["expects_metric"],
        "expected_outcome": expected_outcome,
    }


CASES: List[Dict[str, Any]] = (
    [build_case(prompt, suite="safe", recommended_mode=EXECUTION_MODE_DETERMINISTIC, expected_outcome="should_pass") for prompt in SAFE_PROMPTS]
    + [build_case(prompt, suite="llm", recommended_mode=EXECUTION_MODE_LLM, expected_outcome="may_fallback") for prompt in LLM_ASSISTED_PROMPTS]
    + [build_case(prompt, suite="hard", recommended_mode=EXECUTION_MODE_LLM, expected_outcome="should_fail") for prompt in HARD_PROMPTS]
    + [build_case(prompt, suite="summary", recommended_mode=EXECUTION_MODE_DETERMINISTIC, expected_outcome="should_pass") for prompt in RANKING_SUMMARY_PROMPTS]
    + [build_case(prompt, suite="minimal", recommended_mode=EXECUTION_MODE_DETERMINISTIC, expected_outcome="should_pass") for prompt in MINIMAL_SINGLE_PRESS_PROMPTS]
    + [build_case(prompt, suite="category", recommended_mode=EXECUTION_MODE_DETERMINISTIC, expected_outcome="should_pass") for prompt in CATEGORY_RANKING_PROMPTS]
    + [build_case(prompt, suite="category_compare", recommended_mode=EXECUTION_MODE_DETERMINISTIC, expected_outcome="should_pass") for prompt in CATEGORY_COMPARE_PROMPTS]
    + [build_case(prompt, suite="scope", recommended_mode=EXECUTION_MODE_DETERMINISTIC, expected_outcome="should_pass") for prompt in SCOPED_ANALYSIS_PROMPTS]
    + [build_case(prompt, suite="compare_scope", recommended_mode=EXECUTION_MODE_DETERMINISTIC, expected_outcome="should_pass") for prompt in COMPARE_SCOPE_PROMPTS]
    + [build_case(prompt, suite="phase2a", recommended_mode=EXECUTION_MODE_DETERMINISTIC, expected_outcome="should_pass") for prompt in PHASE2A_PROMPTS]
    + [build_case(prompt, suite="phase2b", recommended_mode=EXECUTION_MODE_DETERMINISTIC, expected_outcome="should_pass") for prompt in PHASE2B_PROMPTS]
    + [build_case(prompt, suite="phase2c", recommended_mode=EXECUTION_MODE_DETERMINISTIC, expected_outcome="should_pass") for prompt in PHASE2C_PROMPTS]
    + [build_case(prompt, suite="phase2d", recommended_mode=EXECUTION_MODE_DETERMINISTIC, expected_outcome="should_pass") for prompt in PHASE2D_PROMPTS]
    + [build_case(prompt, suite="discovery", recommended_mode=EXECUTION_MODE_DETERMINISTIC, expected_outcome="should_pass") for prompt in DISCOVERY_PROMPTS]
    + [build_case(prompt, suite="starter", recommended_mode=EXECUTION_MODE_DETERMINISTIC, expected_outcome="should_pass") for prompt in STARTER_PROMPTS]
)


class FakeLLMClient:
    def __init__(self, case: Dict[str, Any]):
        self.case = case

    def build_plan(self, *, message, filters, tool_registry):
        del filters, tool_registry
        if self.case.get("plan_error"):
            raise RLMAssistantLLMError(str(self.case["plan_error"]))
        if self.case.get("plan") is not None:
            return self.case.get("plan")
        return default_plan_for_case(self.case, message)

    def compose_copy(self, *, message, base_response, tool_results):
        del message, base_response, tool_results
        return self.case.get("rewrite")


def default_plan_for_case(case: Dict[str, Any], message: str) -> Dict[str, Any]:
    prompt_presses = prompt_machine_ids(message)
    expected_tool = case["expected_tool"]
    lowered = message.lower()

    if case["suite"] == "hard":
        if message == "What rank is Press 8?":
            return {"intent": "ranking_lookup", "toolCalls": [{"tool": "get_press_rankings_tool", "arguments": {"machine_id": map_press_number_to_machine_id(8)}}]}
        if message == "Compare 6 and 8":
            return {"intent": "compare", "toolCalls": [{"tool": "compare_presses_tool", "arguments": {"machine_ids": []}}]}
        if message == "Show delta for Press 8":
            return {"intent": "trend", "toolCalls": [{"tool": "get_press_metric_trend_tool", "arguments": {"machine_id": map_press_number_to_machine_id(8), "metric_key": "delta"}}]}
        if message == "Show temperature trend for Press 6":
            return {"intent": "trend", "toolCalls": [{"tool": "get_press_metric_trend_tool", "arguments": {"machine_id": map_press_number_to_machine_id(6), "metric_key": "temperature"}}]}
        if message == "Why is Press 11 ranked low and show the drift trend too":
            return {
                "intent": "ranking_plus_trend",
                "toolCalls": [
                    {"tool": "get_press_rankings_tool", "arguments": {"machine_id": map_press_number_to_machine_id(11)}},
                    {"tool": "get_press_metric_trend_tool", "arguments": {"machine_id": map_press_number_to_machine_id(11), "metric_key": "delta_drift"}},
                ],
            }
        if message == "Best press today and compare it to Press 8":
            return {
                "intent": "ranking_compare_combo",
                "toolCalls": [
                    {"tool": "get_press_rankings_tool", "arguments": {"machine_id": map_press_number_to_machine_id(8)}},
                    {"tool": "compare_presses_tool", "arguments": {"machine_ids": [map_press_number_to_machine_id(8), map_press_number_to_machine_id(6)]}},
                ],
            }
        if message == "What stands out today?":
            return {"intent": "overview", "toolCalls": [{"tool": "get_press_status_tool", "arguments": {"machine_id": 5}}]}
        if message == "How did the last three reels look for Press 5?":
            return {"intent": "recent_reels", "toolCalls": [{"tool": "get_reel_to_reel_summary_tool", "arguments": {"machine_id": 5}}]}
        if message == "What is Press 8 best at?":
            return {"intent": "best_category", "toolCalls": [{"tool": "get_press_category_breakdown_tool", "arguments": {"machine_id": 8}}]}

    if case["suite"] == "llm":
        if message == "What categories are dragging Press 8 down?":
            return {"intent": "category_breakdown", "toolCalls": [{"tool": "get_press_category_breakdown_tool", "arguments": {"machine_id": map_press_number_to_machine_id(8)}}]}
        if message == "What’s hurting Press 9 in the rankings?":
            return {"intent": "ranking", "toolCalls": [{"tool": "get_press_rankings_tool", "arguments": {"machine_id": map_press_number_to_machine_id(9)}}]}
        if message == "How are the recent reels looking on Press 12?":
            return {"intent": "reel_summary", "toolCalls": [{"tool": "get_reel_to_reel_summary_tool", "arguments": {"machine_id": map_press_number_to_machine_id(12)}}]}
        if message == "Is Press 7 getting cleaner or dirtier lately?":
            return {"intent": "reel_summary", "toolCalls": [{"tool": "get_reel_to_reel_summary_tool", "arguments": {"machine_id": map_press_number_to_machine_id(7)}}]}
        if message == "Operator view: is Press 8 in trouble today?":
            return {"intent": "status", "toolCalls": [{"tool": "get_press_status_tool", "arguments": {"machine_id": map_press_number_to_machine_id(8)}}]}
        if message == "Why does Press 15 look weak this week?":
            return {"intent": "ranking", "toolCalls": [{"tool": "get_press_rankings_tool", "arguments": {"machine_id": map_press_number_to_machine_id(15)}}]}
        if message == "Put Press 6 next to Press 8 and tell me what stands out":
            return {"intent": "compare", "toolCalls": [{"tool": "compare_presses_tool", "arguments": {"machine_ids": [map_press_number_to_machine_id(6), map_press_number_to_machine_id(8)]}}]}

    if expected_tool == "get_press_status":
        machine_id = prompt_presses[0] if prompt_presses else filters_machine_id_from_message(lowered)
        return {"intent": "status", "toolCalls": [{"tool": "get_press_status_tool", "arguments": {"machine_id": machine_id}}]}
    if expected_tool == "compare_presses":
        machine_ids = prompt_presses[:2]
        return {"intent": "compare", "toolCalls": [{"tool": "compare_presses_tool", "arguments": {"machine_ids": machine_ids}}]}
    if expected_tool == "get_press_rankings":
        if "best press" in lowered or "worst press" in lowered or "top " in lowered:
            return {"intent": "ranking_summary", "toolCalls": [{"tool": "get_press_rankings_tool", "arguments": {"machine_id": 6}}]}
        machine_id = prompt_presses[0] if prompt_presses else 5
        return {"intent": "ranking", "toolCalls": [{"tool": "get_press_rankings_tool", "arguments": {"machine_id": machine_id}}]}
    if expected_tool == "get_reel_to_reel_summary":
        machine_id = prompt_presses[0] if prompt_presses else 5
        return {"intent": "reel_summary", "toolCalls": [{"tool": "get_reel_to_reel_summary_tool", "arguments": {"machine_id": machine_id}}]}
    if expected_tool == "get_press_metric_trend":
        machine_id = prompt_presses[0] if prompt_presses else 5
        metric_key = infer_metric_key(message)
        return {"intent": "trend", "toolCalls": [{"tool": "get_press_metric_trend_tool", "arguments": {"machine_id": machine_id, "metric_key": metric_key}}]}
    return {"intent": "unsupported", "toolCalls": [{"tool": "get_press_status_tool", "arguments": {"machine_id": 5}}]}


def infer_metric_key(prompt: str) -> str:
    lowered = prompt.lower()
    if "bad feet" in lowered:
        return "bad_feet_pct"
    if "monitoring density" in lowered or "monitoring coverage" in lowered:
        return "monitoring_coverage"
    if "delta std" in lowered:
        return "delta_variation"
    if "drift" in lowered:
        return "delta_drift"
    if "speed instability" in lowered or "webspeed" in lowered:
        return "speed_instability"
    return "bad_feet_pct"


def filters_machine_id_from_message(message: str) -> int:
    prompt_presses = prompt_machine_ids(message)
    return prompt_presses[0] if prompt_presses else 5


class StubAssistantService(RLMAssistantService):
    def __init__(self, case: Dict[str, Any]):
        self.case = case
        llm_client = FakeLLMClient(case) if case.get("mode") == EXECUTION_MODE_LLM else None
        super().__init__(live_service=object(), press_service=object(), llm_client=llm_client)
        self.executed_tools: List[Any] = []

    def get_press_status_tool(self, machine_id, filters):
        del filters
        self.executed_tools.append(("get_press_status_tool", machine_id))
        press_label = self._press_label(machine_id)
        return {
            "found": True,
            "machineId": machine_id,
            "machineName": press_label,
            "latest": {
                "machineName": press_label,
                "reelId": "R-5001",
                "jobName": "JOB-STATUS",
                "productionStart": "2026-04-07T08:00:00",
                "deltaStd": 0.44,
            },
            "aggregate": {
                "reelsRun": 3,
                "badFeetPct": 1.2,
                "oobPointPct": 2.1,
                "pointsPer1000Ft": 24.3,
            },
            "state": {
                "state": "healthy",
                "stateLabel": "Healthy",
                "statusMessage": "Filtered repeat length metrics look stable",
            },
            "dataSemantics": "filtered-window",
        }

    def compare_presses_tool(self, machine_ids, filters):
        del filters
        self.executed_tools.append(("compare_presses_tool", tuple(machine_ids)))
        requested_labels = [self._press_label(machine_id) for machine_id in machine_ids]
        intelligence = self._get_press_intelligence({})
        rows = []
        for machine_id, rank, bad_feet, delta_std, density in [
            (machine_ids[0], 2, 1.4, 0.31, 25.2),
            (machine_ids[1], 6, 4.8, 0.72, 14.8),
        ]:
            rows.append(
                {
                    "machineId": machine_id,
                    "machineName": self._press_label(machine_id),
                    "rank": rank,
                    "estimatedBadFeetPct": bad_feet,
                    "deltaStd": delta_std,
                    "pointsPer1000Ft": density,
                }
            )
        categories_by_machine = {machine_id: [] for machine_id in machine_ids}
        for board in intelligence.get("categoryLeaderboards", []) or []:
            for machine_id in machine_ids:
                item = next((entry for entry in board.get("items", []) if int(entry.get("machineId") or 0) == machine_id), None)
                if not item:
                    continue
                categories_by_machine[machine_id].append(
                    {
                        "key": board.get("key"),
                        "title": board.get("title"),
                        "rank": item.get("rank"),
                        "valueDisplay": item.get("valueDisplay"),
                        "contextLabel": item.get("contextLabel"),
                    }
                )
        return {
            "machineIds": machine_ids,
            "requestedMachines": machine_ids,
            "requestedMachineLabels": requested_labels,
            "rows": rows,
            "categoriesByMachine": categories_by_machine,
            "dataSemantics": "filtered-window",
        }

    def get_press_rankings_tool(self, machine_id, filters):
        del filters
        self.executed_tools.append(("get_press_rankings_tool", machine_id))
        press_label = self._press_label(machine_id)
        if machine_id == 12:
            return {
                "machineId": machine_id,
                "pressRow": None,
                "overviewRow": None,
                "dataSemantics": "filtered-window",
            }
        return {
            "machineId": machine_id,
            "pressRow": {
                "machineId": machine_id,
                "machineName": press_label,
                "rankExplanation": "Ranks low because delta variation is elevated.",
                "deltaStd": 0.71,
                "pointsPer1000Ft": 13.9,
                "estimatedBadFeetPct": 4.6,
            },
            "overviewRow": {
                "machineId": machine_id,
                "rank": 8,
                "averageCategoryPosition": 6.4,
            },
            "dataSemantics": "filtered-window",
        }

    def get_press_category_breakdown_tool(self, machine_id, filters):
        del filters
        self.executed_tools.append(("get_press_category_breakdown_tool", machine_id))
        if machine_id == 12:
            return {"machineId": machine_id, "categories": [], "dataSemantics": "filtered-window"}
        return {
            "machineId": machine_id,
            "categories": [
                {
                    "key": "monitoring_coverage",
                    "title": "Monitoring Coverage",
                    "rank": 8,
                    "valueDisplay": "13.9 pts/1k ft",
                    "contextLabel": "lowest risk",
                },
                {
                    "key": "delta_variation",
                    "title": "Repeat Length Variation",
                    "rank": 9,
                    "valueDisplay": "0.71 mm",
                    "contextLabel": "highest risk",
                },
            ],
            "dataSemantics": "filtered-window",
        }

    def get_reel_to_reel_summary_tool(self, machine_id, filters):
        del filters
        self.executed_tools.append(("get_reel_to_reel_summary_tool", machine_id))
        press_label = self._press_label(machine_id)
        reels = []
        for idx in range(1, 13):
            hour = 8 + idx
            reels.append(
                {
                    "reelId": f"R-{idx}",
                    "estimatedBadFeetPct": round(0.8 + idx * 0.35, 2),
                    "deltaStd": round(0.22 + idx * 0.04, 2),
                    "machineName": press_label,
                    "productionStart": f"2026-04-07T{hour:02d}:00:00",
                }
            )
        return {
            "machineId": machine_id,
            "machineName": press_label,
            "summary": {
                "reelsRun": len(reels),
                "feetTotal": 18200.0,
                "estimatedBadFeet": 512.4,
                "badFeetPct": 2.81,
            },
            "reels": reels,
            "windowLabel": "2026-04-07 to 2026-04-07",
            "dataSemantics": "filtered-window",
        }

    def get_press_metric_trend_tool(self, machine_id, metric_key, filters):
        del filters
        self.executed_tools.append(("get_press_metric_trend_tool", machine_id, metric_key))
        press_label = self._press_label(machine_id)
        label_map = {
            "bad_feet_pct": "Bad Feet %",
            "monitoring_coverage": "Monitoring Coverage",
            "delta_variation": "Repeat Length Variation",
            "delta_drift": "Repeat Length Drift",
            "speed_instability": "Speed Instability",
        }
        return {
            "machineId": machine_id,
            "machineName": press_label,
            "metricKey": metric_key,
            "metricLabel": label_map.get(metric_key, "Metric Trend"),
            "series": [
                {"date": "2026-04-01", "value": 1.2, "valueDisplay": "1.20%"},
                {"date": "2026-04-02", "value": 1.8, "valueDisplay": "1.80%"},
                {"date": "2026-04-03", "value": 2.0, "valueDisplay": "2.00%"},
                {"date": "2026-04-04", "value": 2.4, "valueDisplay": "2.40%"},
                {"date": "2026-04-05", "value": 2.6, "valueDisplay": "2.60%"},
                {"date": "2026-04-06", "value": 2.8, "valueDisplay": "2.80%"},
                {"date": "2026-04-07", "value": 3.1, "valueDisplay": "3.10%"},
            ],
            "summary": {"headline": "Metric trend is available for the selected window."},
            "dataSemantics": "filtered-window",
        }

    def _filtered_reel_metrics(self, filters, machine_id=None):
        rows = []
        target_machine_ids = [machine_id] if machine_id is not None else list(KNOWN_PRESS_NUMBER_TO_MACHINE_ID.values())
        now = datetime.utcnow().replace(microsecond=0, second=0)
        reel_count = 36 if self.case.get("extended_history") else 24
        interval_minutes = 10 if self.case.get("extended_history") else 30
        for machine_offset, target_machine_id in enumerate(target_machine_ids):
            press_label = self._press_label(target_machine_id)
            for idx in range(1, reel_count + 1):
                offset_from_end = reel_count - idx
                production_dt = now - timedelta(minutes=offset_from_end * interval_minutes)
                feet_total = 2200 + idx * 450 + machine_offset * 60
                if target_machine_id == 1:
                    bad_feet_pct = round((1.0 + idx * 0.18) if idx <= 4 else (3.2 + idx * 0.58), 2)
                    delta_std = round((0.24 + idx * 0.03) if idx <= 4 else (0.55 + idx * 0.07), 2)
                    speed_range = round((0.55 + idx * 0.03) if idx <= 4 else (1.05 + idx * 0.08), 2)
                    tolerance_changes = 0 if idx <= 5 else 1 + idx // 4
                elif target_machine_id == 4:
                    bad_feet_pct = round(1.2 + idx * 0.16, 2)
                    delta_std = round(0.26 + idx * 0.025, 2)
                    speed_range = round(0.6 + idx * 0.03, 2)
                    tolerance_changes = 1 if idx in {5, 10} else 0
                elif target_machine_id == 2:
                    bad_feet_pct = round(0.9 + idx * 0.14, 2)
                    delta_std = round(0.22 + idx * 0.02, 2)
                    speed_range = round(0.5 + idx * 0.025, 2)
                    tolerance_changes = 1 if idx in {7, 11} else 0
                elif target_machine_id == 6:
                    bad_feet_pct = round(1.8 + idx * 0.28, 2)
                    delta_std = round(0.32 + idx * 0.045, 2)
                    speed_range = round(0.75 + idx * 0.055, 2)
                    tolerance_changes = 1 + idx // 3
                else:
                    bad_feet_pct = round(0.8 + idx * 0.35 + machine_offset * 0.08, 2)
                    delta_std = round(0.22 + idx * 0.04 + machine_offset * 0.01, 2)
                    speed_range = round(0.5 + idx * 0.06 + machine_offset * 0.03, 2)
                    tolerance_changes = idx % 3
                active_seconds = float(900 + idx * 75 - machine_offset * 10)
                inactive_seconds = float(180 + idx * 20 + machine_offset * 12)
                known_seconds = active_seconds + inactive_seconds
                job_name = f"JOB-{target_machine_id}-A" if idx <= 6 else f"JOB-{target_machine_id}-B"
                rows.append(
                    {
                        "machineId": target_machine_id,
                        "machineName": press_label,
                        "reelId": f"R-{target_machine_id}-{idx}",
                        "productionStart": production_dt.isoformat(timespec="seconds"),
                        "jobName": job_name,
                        "feetTotal": feet_total,
                        "estimatedBadFeet": round(feet_total * (bad_feet_pct / 100.0), 2),
                        "estimatedBadFeetPct": bad_feet_pct,
                        "pointsPer1000Ft": round(14.0 + idx * 0.8 - machine_offset * 0.15, 2),
                        "deltaStd": delta_std,
                        "avgDelta": round(0.03 + idx * 0.01 + machine_offset * 0.005, 2),
                        "webspeedRange": speed_range,
                        "toleranceChangeCount": tolerance_changes,
                        "monitoringPointsTotal": 120 + idx * 4,
                        "rlmActiveSeconds": active_seconds,
                        "rlmInactiveSeconds": inactive_seconds,
                        "rlmKnownPhaseSeconds": known_seconds,
                        "rlmActivePct": round(active_seconds / known_seconds * 100.0, 2),
                        "rlmInactivePct": round(inactive_seconds / known_seconds * 100.0, 2),
                        "rlmActivityState": "active" if active_seconds > inactive_seconds else "inactive",
                    }
                )
        min_feet = filters.get("min_feet")
        if min_feet is not None:
            rows = [row for row in rows if float(row.get("feetTotal") or 0) >= float(min_feet)]
        start_dt = filters.get("start_dt")
        end_dt = filters.get("end_dt")
        if start_dt is not None and end_dt is not None:
            filtered_rows = []
            for row in rows:
                row_dt = datetime.fromisoformat(str(row["productionStart"]))
                if start_dt <= row_dt <= end_dt:
                    filtered_rows.append(row)
            rows = filtered_rows
        reel_scope = filters.get("reel_scope") or {}
        if reel_scope.get("kind") == "reels":
            rows = rows[-max(1, int(reel_scope.get("count") or 1)) :]
        return rows

    def _get_press_intelligence(self, filters):
        min_feet = filters.get("min_feet")
        suffix = " (5000+ ft)" if min_feet else ""
        return {
            "overviewRankings": [
                {"machineId": 2, "rank": 1, "averageCategoryPosition": 1.6},
                {"machineId": 4, "rank": 2, "averageCategoryPosition": 2.4},
                {"machineId": 1, "rank": 3, "averageCategoryPosition": 3.3},
                {"machineId": 3, "rank": 4, "averageCategoryPosition": 3.8},
                {"machineId": 5, "rank": 5, "averageCategoryPosition": 4.4},
                {"machineId": 7, "rank": 6, "averageCategoryPosition": 5.2},
                {"machineId": 8, "rank": 7, "averageCategoryPosition": 5.8},
                {"machineId": 6, "rank": 8, "averageCategoryPosition": 6.4},
                {"machineId": 9, "rank": 9, "averageCategoryPosition": 7.3},
                {"machineId": 10, "rank": 10, "averageCategoryPosition": 8.1},
            ],
            "pressRankings": [
                {"machineId": 1, "machineName": "Press 5", "estimatedBadFeetPct": 2.1, "deltaStd": 0.38, "pointsPer1000Ft": 24.0, "feetTotal": 18000.0, "estimatedBadFeet": 378.0, "reelsRun": 6},
                {"machineId": 2, "machineName": "Press 6", "estimatedBadFeetPct": 1.4, "deltaStd": 0.31, "pointsPer1000Ft": 25.2, "feetTotal": 19200.0, "estimatedBadFeet": 268.8, "reelsRun": 6},
                {"machineId": 3, "machineName": "Press 7", "estimatedBadFeetPct": 3.1, "deltaStd": 0.49, "pointsPer1000Ft": 21.4, "feetTotal": 17600.0, "estimatedBadFeet": 545.6, "reelsRun": 6},
                {"machineId": 4, "machineName": "Press 8", "estimatedBadFeetPct": 2.6, "deltaStd": 0.42, "pointsPer1000Ft": 21.1, "feetTotal": 18400.0, "estimatedBadFeet": 478.4, "reelsRun": 6},
                {"machineId": 5, "machineName": "Press 9", "estimatedBadFeetPct": 2.9, "deltaStd": 0.47, "pointsPer1000Ft": 20.4, "feetTotal": 18100.0, "estimatedBadFeet": 524.9, "reelsRun": 6},
                {"machineId": 6, "machineName": "Press 11", "estimatedBadFeetPct": 4.6, "deltaStd": 0.71, "pointsPer1000Ft": 13.9, "feetTotal": 16800.0, "estimatedBadFeet": 772.8, "reelsRun": 6},
                {"machineId": 7, "machineName": "Press 12", "estimatedBadFeetPct": 3.8, "deltaStd": 0.58, "pointsPer1000Ft": 18.2, "feetTotal": 17400.0, "estimatedBadFeet": 661.2, "reelsRun": 6},
                {"machineId": 8, "machineName": "Press 13", "estimatedBadFeetPct": 3.0, "deltaStd": 0.44, "pointsPer1000Ft": 19.6, "feetTotal": 17700.0, "estimatedBadFeet": 531.0, "reelsRun": 6},
                {"machineId": 9, "machineName": "Press 14", "estimatedBadFeetPct": 5.5, "deltaStd": 0.82, "pointsPer1000Ft": 12.4, "feetTotal": 16100.0, "estimatedBadFeet": 885.5, "reelsRun": 6},
                {"machineId": 10, "machineName": "Press 15", "estimatedBadFeetPct": 8.1, "deltaStd": 0.92, "pointsPer1000Ft": 9.4, "feetTotal": 15800.0, "estimatedBadFeet": 1279.8, "reelsRun": 6},
            ],
            "categoryLeaderboards": [
                {
                    "key": "monitoring_coverage",
                    "title": "Monitoring Coverage",
                    "items": [
                        {"machineId": 2, "rank": 1, "valueDisplay": "25.2 pts/1k ft", "contextLabel": "highest visibility"},
                        {"machineId": 1, "rank": 2, "valueDisplay": "24.0 pts/1k ft", "contextLabel": "stable visibility"},
                        {"machineId": 3, "rank": 3, "valueDisplay": "21.4 pts/1k ft", "contextLabel": "solid visibility"},
                        {"machineId": 4, "rank": 4, "valueDisplay": "21.1 pts/1k ft", "contextLabel": "strong visibility"},
                        {"machineId": 6, "rank": 5, "valueDisplay": "13.9 pts/1k ft", "contextLabel": "weaker visibility"},
                        {"machineId": 10, "rank": 6, "valueDisplay": "9.4 pts/1k ft", "contextLabel": "lowest visibility"},
                    ],
                },
                {
                    "key": "bad_feet_pct",
                    "title": "Bad Feet %",
                    "items": [
                        {"machineId": 2, "rank": 1, "valueDisplay": "1.4%", "contextLabel": "lowest bad feet"},
                        {"machineId": 1, "rank": 2, "valueDisplay": "2.1%", "contextLabel": "low bad feet"},
                        {"machineId": 4, "rank": 3, "valueDisplay": "2.6%", "contextLabel": "controlled bad feet"},
                        {"machineId": 3, "rank": 4, "valueDisplay": "3.1%", "contextLabel": "moderate bad feet"},
                        {"machineId": 6, "rank": 5, "valueDisplay": "4.6%", "contextLabel": "elevated bad feet"},
                        {"machineId": 10, "rank": 6, "valueDisplay": "8.1%", "contextLabel": "highest bad feet"},
                    ],
                },
                {
                    "key": "delta_variation",
                    "title": "Repeat Length Variation",
                    "items": [
                        {"machineId": 2, "rank": 1, "valueDisplay": "0.31 mm", "contextLabel": "lowest variation"},
                        {"machineId": 1, "rank": 2, "valueDisplay": "0.38 mm", "contextLabel": "stable variation"},
                        {"machineId": 4, "rank": 3, "valueDisplay": "0.42 mm", "contextLabel": "controlled variation"},
                        {"machineId": 3, "rank": 4, "valueDisplay": "0.49 mm", "contextLabel": "moderate variation"},
                        {"machineId": 6, "rank": 5, "valueDisplay": "0.71 mm", "contextLabel": "elevated variation"},
                        {"machineId": 10, "rank": 6, "valueDisplay": "0.92 mm", "contextLabel": "highest variation"},
                    ],
                },
                {
                    "key": "delta_drift",
                    "title": "Repeat Length Drift",
                    "items": [
                        {"machineId": 4, "rank": 1, "valueDisplay": "0.04 mm", "contextLabel": "closest to target"},
                        {"machineId": 2, "rank": 2, "valueDisplay": "0.06 mm", "contextLabel": "tight drift"},
                        {"machineId": 1, "rank": 3, "valueDisplay": "0.09 mm", "contextLabel": "steady drift"},
                        {"machineId": 7, "rank": 4, "valueDisplay": "0.12 mm", "contextLabel": "moderate drift"},
                        {"machineId": 6, "rank": 5, "valueDisplay": "0.23 mm", "contextLabel": "high drift"},
                        {"machineId": 10, "rank": 6, "valueDisplay": "0.31 mm", "contextLabel": "highest drift"},
                    ],
                },
                {
                    "key": "speed_instability",
                    "title": "Speed Instability",
                    "items": [
                        {"machineId": 2, "rank": 1, "valueDisplay": "0.8", "contextLabel": "lowest speed swing"},
                        {"machineId": 1, "rank": 2, "valueDisplay": "1.0", "contextLabel": "stable speed"},
                        {"machineId": 4, "rank": 3, "valueDisplay": "1.2", "contextLabel": "controlled speed"},
                        {"machineId": 3, "rank": 4, "valueDisplay": "1.4", "contextLabel": "moderate speed swing"},
                        {"machineId": 6, "rank": 5, "valueDisplay": "1.9", "contextLabel": "unstable speed"},
                        {"machineId": 10, "rank": 6, "valueDisplay": "2.5", "contextLabel": "highest speed swing"},
                    ],
                },
            ],
            "metadata": {"minFeet": min_feet, "note": suffix},
        }


def evaluate_discovery_time_sequence(sequence: Dict[str, Any]) -> Dict[str, Any]:
    service = StubAssistantService(sequence)
    response = service.handle_chat(
        sequence["prompt"],
        filters=build_live_ui_filters(sequence["prompt"]),
        history=[],
        mode=sequence["mode"],
        diagnostic=True,
    )
    assert_contract(response)
    validation = validate_response(sequence, response)
    context = response.get("context") or {}
    discovery = context.get("discovery") or {}
    baseline = discovery.get("baseline_comparison") or {}
    change_point = discovery.get("change_point") or {}
    sustained_vs_spike = str(discovery.get("sustained_vs_spike") or "")
    issue_shape = discovery.get("issue_shape") or {}
    chart = (response.get("evidence") or {}).get("chart") or {}
    answer = response.get("answer") or {}
    answer_text = " ".join(
        str(part)
        for part in [
            answer.get("title") or "",
            answer.get("summary") or "",
            " ".join(str(section.get("text") or "") for section in answer.get("sections") or []),
        ]
        if part
    )

    discovery_ok = True
    if sequence.get("expected_baseline_available") is not None:
        discovery_ok = discovery_ok and bool(baseline.get("available")) is bool(sequence.get("expected_baseline_available"))
    if sequence.get("expected_change_point_available") is not None:
        discovery_ok = discovery_ok and bool(change_point.get("available")) is bool(sequence.get("expected_change_point_available"))
    if sequence.get("require_sustained_vs_spike"):
        discovery_ok = discovery_ok and bool(sustained_vs_spike)
    if sequence.get("expected_shape_contains"):
        discovery_ok = discovery_ok and sequence["expected_shape_contains"].lower() in sustained_vs_spike.lower()
    if sequence.get("expected_recovery_after_shift") is not None:
        discovery_ok = discovery_ok and bool(issue_shape.get("recoveryAfterShift")) is bool(sequence.get("expected_recovery_after_shift"))
    if sequence.get("expected_answer_substring"):
        discovery_ok = discovery_ok and sequence["expected_answer_substring"].lower() in answer_text.lower()
    if sequence.get("expected_chart") is not None:
        discovery_ok = discovery_ok and bool(chart) is bool(sequence.get("expected_chart"))
    if sequence.get("expected_chart_title_contains"):
        discovery_ok = discovery_ok and sequence["expected_chart_title_contains"].lower() in str(chart.get("title") or "").lower()

    validation["passed"] = bool(validation["routing_ok"] and discovery_ok)
    validation["actual_outcome"] = "passed" if validation["passed"] else "failed"
    if not discovery_ok:
        validation["failure_category"] = validation["failure_category"] or "discovery baseline failure"
        validation["pass_fail_reason"] = "baseline comparison, change-point, or sustained/spike output was not present as expected"

    answer = response.get("answer") or {}
    return {
        "name": sequence["name"],
        "suite": sequence["suite"],
        "prompt": sequence["prompt"],
        "mode": sequence["mode"],
        "recommended_mode": sequence["mode"],
        "expected_tool": sequence["expected_tool"],
        "expected_machine_count": sequence["expected_machine_count"],
        "expects_metric": sequence["expects_metric"],
        "expected_outcome": sequence["expected_outcome"],
        "actual_tool": primary_tool_name(response),
        "actual_tools": validation["actual_tools"],
        "title": answer.get("title"),
        "summary": answer.get("summary"),
        "expected_vs_actual": {
            "expected_tool": sequence["expected_tool"],
            "actual_tools": validation["actual_tools"],
            "expected_outcome": sequence["expected_outcome"],
            "actual_outcome": validation["actual_outcome"],
            "pass_fail_reason": validation["pass_fail_reason"],
            "outcome_matches_expectation": validation["passed"],
        },
        "validation": validation,
        "diagnostics": {
            "baselineAvailable": baseline.get("available"),
            "baselineSummary": baseline.get("summary"),
            "changePointAvailable": change_point.get("available"),
            "changePointSummary": change_point.get("summary"),
            "sustainedVsSpike": sustained_vs_spike,
        },
    }

    def _get_press_intelligence(self, filters):
        min_feet = filters.get("min_feet")
        suffix = " (5000+ ft)" if min_feet else ""
        return {
            "overviewRankings": [
                {"machineId": 2, "rank": 1, "averageCategoryPosition": 1.6},
                {"machineId": 4, "rank": 2, "averageCategoryPosition": 2.4},
                {"machineId": 1, "rank": 3, "averageCategoryPosition": 3.3},
                {"machineId": 3, "rank": 4, "averageCategoryPosition": 3.8},
                {"machineId": 5, "rank": 5, "averageCategoryPosition": 4.4},
                {"machineId": 7, "rank": 6, "averageCategoryPosition": 5.2},
                {"machineId": 8, "rank": 7, "averageCategoryPosition": 5.8},
                {"machineId": 6, "rank": 8, "averageCategoryPosition": 6.4},
                {"machineId": 9, "rank": 9, "averageCategoryPosition": 7.3},
                {"machineId": 10, "rank": 10, "averageCategoryPosition": 8.1},
            ],
            "pressRankings": [
                {"machineId": 1, "machineName": "Press 5", "estimatedBadFeetPct": 2.1, "deltaStd": 0.38, "pointsPer1000Ft": 24.0, "feetTotal": 18000.0, "estimatedBadFeet": 378.0, "reelsRun": 6},
                {"machineId": 2, "machineName": "Press 6", "estimatedBadFeetPct": 1.4, "deltaStd": 0.31, "pointsPer1000Ft": 25.2, "feetTotal": 19200.0, "estimatedBadFeet": 268.8, "reelsRun": 6},
                {"machineId": 3, "machineName": "Press 7", "estimatedBadFeetPct": 3.1, "deltaStd": 0.49, "pointsPer1000Ft": 21.4, "feetTotal": 17600.0, "estimatedBadFeet": 545.6, "reelsRun": 6},
                {"machineId": 4, "machineName": "Press 8", "estimatedBadFeetPct": 2.6, "deltaStd": 0.42, "pointsPer1000Ft": 21.1, "feetTotal": 18400.0, "estimatedBadFeet": 478.4, "reelsRun": 6},
                {"machineId": 5, "machineName": "Press 9", "estimatedBadFeetPct": 2.9, "deltaStd": 0.47, "pointsPer1000Ft": 20.4, "feetTotal": 18100.0, "estimatedBadFeet": 524.9, "reelsRun": 6},
                {"machineId": 6, "machineName": "Press 11", "estimatedBadFeetPct": 4.6, "deltaStd": 0.71, "pointsPer1000Ft": 13.9, "feetTotal": 16800.0, "estimatedBadFeet": 772.8, "reelsRun": 6},
                {"machineId": 7, "machineName": "Press 12", "estimatedBadFeetPct": 3.8, "deltaStd": 0.58, "pointsPer1000Ft": 18.2, "feetTotal": 17400.0, "estimatedBadFeet": 661.2, "reelsRun": 6},
                {"machineId": 8, "machineName": "Press 13", "estimatedBadFeetPct": 3.0, "deltaStd": 0.44, "pointsPer1000Ft": 19.6, "feetTotal": 17700.0, "estimatedBadFeet": 531.0, "reelsRun": 6},
                {"machineId": 9, "machineName": "Press 14", "estimatedBadFeetPct": 5.5, "deltaStd": 0.82, "pointsPer1000Ft": 12.4, "feetTotal": 16100.0, "estimatedBadFeet": 885.5, "reelsRun": 6},
                {"machineId": 10, "machineName": "Press 15", "estimatedBadFeetPct": 8.1, "deltaStd": 0.92, "pointsPer1000Ft": 9.4, "feetTotal": 15800.0, "estimatedBadFeet": 1279.8, "reelsRun": 6},
            ],
            "categoryLeaderboards": [
                {
                    "key": "monitoring_coverage",
                    "title": "Monitoring Coverage",
                    "items": [
                        {"machineId": 2, "rank": 1, "valueDisplay": "25.2 pts/1k ft", "contextLabel": "highest visibility"},
                        {"machineId": 1, "rank": 2, "valueDisplay": "24.0 pts/1k ft", "contextLabel": "stable visibility"},
                        {"machineId": 3, "rank": 3, "valueDisplay": "21.4 pts/1k ft", "contextLabel": "solid visibility"},
                        {"machineId": 4, "rank": 4, "valueDisplay": "21.1 pts/1k ft", "contextLabel": "strong visibility"},
                        {"machineId": 6, "rank": 5, "valueDisplay": "13.9 pts/1k ft", "contextLabel": "weaker visibility"},
                        {"machineId": 10, "rank": 6, "valueDisplay": "9.4 pts/1k ft", "contextLabel": "lowest visibility"},
                    ],
                },
                {
                    "key": "bad_feet_pct",
                    "title": "Bad Feet %",
                    "items": [
                        {"machineId": 2, "rank": 1, "valueDisplay": "1.4%", "contextLabel": "lowest bad feet"},
                        {"machineId": 1, "rank": 2, "valueDisplay": "2.1%", "contextLabel": "low bad feet"},
                        {"machineId": 4, "rank": 3, "valueDisplay": "2.6%", "contextLabel": "controlled bad feet"},
                        {"machineId": 3, "rank": 4, "valueDisplay": "3.1%", "contextLabel": "moderate bad feet"},
                        {"machineId": 6, "rank": 5, "valueDisplay": "4.6%", "contextLabel": "elevated bad feet"},
                        {"machineId": 10, "rank": 6, "valueDisplay": "8.1%", "contextLabel": "highest bad feet"},
                    ],
                },
                {
                    "key": "delta_variation",
                    "title": "Repeat Length Variation",
                    "items": [
                        {"machineId": 2, "rank": 1, "valueDisplay": "0.31 mm", "contextLabel": "lowest variation"},
                        {"machineId": 1, "rank": 2, "valueDisplay": "0.38 mm", "contextLabel": "stable variation"},
                        {"machineId": 4, "rank": 3, "valueDisplay": "0.42 mm", "contextLabel": "controlled variation"},
                        {"machineId": 3, "rank": 4, "valueDisplay": "0.49 mm", "contextLabel": "moderate variation"},
                        {"machineId": 6, "rank": 5, "valueDisplay": "0.71 mm", "contextLabel": "elevated variation"},
                        {"machineId": 10, "rank": 6, "valueDisplay": "0.92 mm", "contextLabel": "highest variation"},
                    ],
                },
                {
                    "key": "delta_drift",
                    "title": "Repeat Length Drift",
                    "items": [
                        {"machineId": 4, "rank": 1, "valueDisplay": "0.04 mm", "contextLabel": "closest to target"},
                        {"machineId": 2, "rank": 2, "valueDisplay": "0.06 mm", "contextLabel": "tight drift"},
                        {"machineId": 1, "rank": 3, "valueDisplay": "0.09 mm", "contextLabel": "steady drift"},
                        {"machineId": 7, "rank": 4, "valueDisplay": "0.12 mm", "contextLabel": "moderate drift"},
                        {"machineId": 6, "rank": 5, "valueDisplay": "0.23 mm", "contextLabel": "high drift"},
                        {"machineId": 10, "rank": 6, "valueDisplay": "0.31 mm", "contextLabel": "highest drift"},
                    ],
                },
                {
                    "key": "speed_instability",
                    "title": "Speed Instability",
                    "items": [
                        {"machineId": 2, "rank": 1, "valueDisplay": "0.8", "contextLabel": "lowest speed swing"},
                        {"machineId": 1, "rank": 2, "valueDisplay": "1.0", "contextLabel": "stable speed"},
                        {"machineId": 4, "rank": 3, "valueDisplay": "1.2", "contextLabel": "controlled speed"},
                        {"machineId": 3, "rank": 4, "valueDisplay": "1.4", "contextLabel": "moderate speed swing"},
                        {"machineId": 6, "rank": 5, "valueDisplay": "1.9", "contextLabel": "unstable speed"},
                        {"machineId": 10, "rank": 6, "valueDisplay": "2.5", "contextLabel": "highest speed swing"},
                    ],
                },
            ],
            "metadata": {"minFeet": min_feet, "note": suffix},
        }


def assert_contract(response: Dict[str, Any]) -> None:
    assert isinstance(response, dict), "response must be an object"
    assert isinstance(response.get("answer"), dict), "answer missing"
    evidence = response.get("evidence")
    assert isinstance(evidence, dict), "evidence missing"
    assert isinstance(evidence.get("metrics"), list), "evidence.metrics missing"
    assert isinstance(response.get("toolsUsed"), list), "toolsUsed missing"
    assert isinstance(response.get("suggestedPrompts"), list), "suggestedPrompts missing"
    context = response.get("context")
    assert isinstance(context, dict), "context missing"
    assert isinstance(context.get("filtersApplied"), dict), "context.filtersApplied missing"
    assert isinstance(context.get("appliedFilters"), dict), "context.appliedFilters missing"
    assert isinstance(context.get("filterChanges"), list), "context.filterChanges missing"
    assert context.get("dataSemantics"), "context.dataSemantics missing"
    assert context.get("requestedMode"), "context.requestedMode missing"
    assert context.get("executionMode"), "context.executionMode missing"


def today_str() -> str:
    return datetime.now(UTC).date().isoformat()


def week_start_str() -> str:
    today = datetime.now(UTC).date()
    return (today - timedelta(days=today.weekday())).isoformat()


def build_filters(prompt: str) -> Dict[str, Any]:
    prompt_machines = prompt_machine_ids(prompt)
    start = today_str()
    end = today_str()
    if "this week" in (prompt or "").lower():
        start = week_start_str()
    return {
        "machine_id": prompt_machines[0] if prompt_machines else 5,
        "start": start,
        "end": end,
        "job": "",
        "order": "",
        "reel_ids": [],
    }


def build_live_ui_filters(prompt: str) -> Dict[str, Any]:
    start = today_str()
    end = today_str()
    if "this week" in (prompt or "").lower():
        start = week_start_str()
    return {
        "machine_id": None,
        "start": start,
        "end": end,
        "job": "",
        "order": "",
        "reel_ids": [],
    }


def primary_tool_name(response: Dict[str, Any]) -> str:
    tools = [tool.get("tool") for tool in response.get("toolsUsed") or [] if tool.get("tool")]
    return tools[0] if tools else "none"


def metric_present(response: Dict[str, Any]) -> bool:
    if primary_tool_name(response) == "get_press_metric_trend":
        return True
    for metric in (response.get("evidence") or {}).get("metrics") or []:
        if str(metric.get("label") or "").strip().lower() == "metric":
            return True
    return False


def classify_failure(case: Dict[str, Any], response: Dict[str, Any], validation: Dict[str, Any]) -> str | None:
    if validation["passed"]:
        return None
    answer = response.get("answer") or {}
    title = str(answer.get("title") or "").lower()
    summary = str(answer.get("summary") or "").lower()
    diagnostics = response.get("diagnostics") or {}
    fallback = response.get("context", {}).get("executionMode") != response.get("context", {}).get("requestedMode")

    if fallback and diagnostics.get("plannerAttempted") and not diagnostics.get("plannerValidationPassed"):
        return "LLM planner failure"
    if "unsupported" in validation["actual_tools"] or "question type not supported" in title:
        return "unsupported intent"
    if title == "no matching rlm data was found." or "not available" in summary:
        return "missing data"
    if not validation["routing_ok"]:
        return "routing failure"
    if not validation["machine_count_ok"] or not validation["machine_ids_ok"]:
        return "parameter extraction failure"
    return "routing failure"


def validate_response(case: Dict[str, Any], response: Dict[str, Any]) -> Dict[str, Any]:
    prompt_presses = extract_press_ids(case["prompt"])
    answer = response.get("answer") or {}
    sections_text = " ".join(
        f"{section.get('label') or ''} {section.get('text') or ''}"
        for section in answer.get("sections") or []
        if isinstance(section, dict)
    )
    answer_text = f"{answer.get('title') or ''} {answer.get('summary') or ''} {sections_text}"
    response_presses = extract_press_ids(answer_text)
    diagnostics = response.get("diagnostics") or {}
    actual_tools = [tool.get("tool") for tool in response.get("toolsUsed") or [] if tool.get("tool")]
    actual_machine_ids = diagnostics.get("finalRenderedMachines") or diagnostics.get("executedMachines") or response_presses
    actual_machine_ids = [int(value) for value in actual_machine_ids]
    expected_machine_count = int(case["expected_machine_count"])

    entity_ok = True
    entity_error = None
    if prompt_presses:
        entity_ok = set(prompt_presses) == set(response_presses)
        if not entity_ok:
            entity_error = "entity drift"

    routing_ok = case["expected_tool"] in actual_tools
    machine_count_ok = len(actual_machine_ids) == expected_machine_count
    machine_ids_ok = set(prompt_presses).issubset(set(actual_machine_ids)) if prompt_presses else True
    metric_ok = metric_present(response) == bool(case["expects_metric"])

    fallback = response.get("context", {}).get("executionMode") != response.get("context", {}).get("requestedMode")

    correctness_components = [
        1.0 if routing_ok else 0.0,
        1.0 if machine_count_ok else 0.0,
        1.0 if machine_ids_ok else 0.0,
        1.0 if metric_ok else 0.0,
        1.0 if entity_ok else 0.0,
        0.0 if fallback and case["mode"] == EXECUTION_MODE_LLM else 1.0,
    ]
    correctness_score = round(sum(correctness_components) / len(correctness_components), 2)
    routing_score = round((1.0 if routing_ok else 0.0) * (0.0 if fallback and case["mode"] == EXECUTION_MODE_LLM else 1.0), 2)
    entity_consistency = 1.0 if entity_ok else 0.0

    passed = routing_ok and machine_count_ok and machine_ids_ok and metric_ok and entity_ok and not (
        fallback and case["mode"] == EXECUTION_MODE_LLM
    )

    validation = {
        "prompt_presses": prompt_presses,
        "response_presses": response_presses,
        "actual_tools": actual_tools,
        "actual_machine_ids": actual_machine_ids,
        "entity_ok": entity_ok,
        "entity_error": entity_error,
        "routing_ok": routing_ok,
        "machine_count_ok": machine_count_ok,
        "machine_ids_ok": machine_ids_ok,
        "metric_ok": metric_ok,
        "fallback": fallback,
        "correctness_score": correctness_score,
        "routing_score": routing_score,
        "entity_consistency": entity_consistency,
        "passed": passed,
    }
    validation["failure_category"] = classify_failure(case, response, validation)
    validation["actual_outcome"] = "passed" if passed else "failed"
    validation["pass_fail_reason"] = validation["failure_category"] or "matched expectations"
    validation["outcome_matches_expectation"] = (
        (case["expected_outcome"] == "should_pass" and passed)
        or (case["expected_outcome"] == "should_fail" and not passed)
        or (case["expected_outcome"] == "may_fallback")
    )
    return validation


def evaluate_case(case: Dict[str, Any]) -> Dict[str, Any]:
    service = StubAssistantService(case)
    response = service.handle_chat(
        case["prompt"],
        filters=build_filters(case["prompt"]),
        mode=case["mode"],
        diagnostic=True,
    )
    assert_contract(response)
    validation = validate_response(case, response)
    answer = response.get("answer") or {}
    diagnostics = response.get("diagnostics") or {}
    if case["suite"] == "phase2a":
        sections = answer.get("sections") or []
        qualification_visible = any((section.get("label") or "") == "Qualification summary" for section in sections if isinstance(section, dict))
        denominator_visible = bool(diagnostics.get("denominatorBasis"))
        metric_key_visible = bool(diagnostics.get("metricKeyUsed"))
        phase2a_ok = qualification_visible and denominator_visible and metric_key_visible
        validation["passed"] = bool(validation["passed"] and phase2a_ok)
        validation["actual_outcome"] = "passed" if validation["passed"] else "failed"
        if not phase2a_ok:
            validation["failure_category"] = validation["failure_category"] or "phase2a contract failure"
            validation["pass_fail_reason"] = "phase2a qualification or denominator diagnostics missing"
    if case["suite"] == "phase2b":
        sections = {str(section.get("label") or "") for section in answer.get("sections") or [] if isinstance(section, dict)}
        metric_analysis = (response.get("context") or {}).get("metricAnalysis") or {}
        phase2b_ok = (
            bool(diagnostics.get("metricKeyUsed"))
            and bool(metric_analysis.get("runPositionPattern"))
            and bool(metric_analysis.get("concentrationPattern"))
            and bool(metric_analysis.get("driverReels"))
            and "Comparison summary" in sections
        )
        validation["passed"] = bool(validation["passed"] and phase2b_ok)
        validation["actual_outcome"] = "passed" if validation["passed"] else "failed"
        if not phase2b_ok:
            validation["failure_category"] = validation["failure_category"] or "phase2b contract failure"
            validation["pass_fail_reason"] = "phase2b comparison or explanation sections missing"
    return {
        "name": case["name"],
        "suite": case["suite"],
        "prompt": case["prompt"],
        "mode": case["mode"],
        "recommended_mode": case["recommended_mode"],
        "expected_tool": case["expected_tool"],
        "expected_machine_count": case["expected_machine_count"],
        "expects_metric": case["expects_metric"],
        "expected_outcome": case["expected_outcome"],
        "actual_tool": primary_tool_name(response),
        "actual_tools": validation["actual_tools"],
        "requested_mode": (response.get("context") or {}).get("requestedMode"),
        "execution_mode": (response.get("context") or {}).get("executionMode"),
        "fallback_reason": (response.get("context") or {}).get("fallbackReason") or diagnostics.get("fallbackReason"),
        "title": answer.get("title"),
        "summary": answer.get("summary"),
        "expected_vs_actual": {
            "expected_tool": case["expected_tool"],
            "actual_tools": validation["actual_tools"],
            "expected_outcome": case["expected_outcome"],
            "actual_outcome": validation["actual_outcome"],
            "pass_fail_reason": validation["pass_fail_reason"],
            "outcome_matches_expectation": validation["outcome_matches_expectation"],
        },
        "validation": validation,
        "diagnostics": {
            "rawExtractedPressIds": diagnostics.get("rawExtractedPressIds"),
            "selectedMachineId": diagnostics.get("selectedMachineId"),
            "machineIdSource": diagnostics.get("machineIdSource"),
            "requestedPressLabel": diagnostics.get("requestedPressLabel"),
            "renderedPressLabel": diagnostics.get("renderedPressLabel"),
            "usedConversationContext": diagnostics.get("usedConversationContext"),
            "contextSourceTurn": diagnostics.get("contextSourceTurn"),
            "inheritedIntent": diagnostics.get("inheritedIntent"),
            "inheritedMachineId": diagnostics.get("inheritedMachineId"),
            "inheritedMetricKey": diagnostics.get("inheritedMetricKey"),
            "inheritedScope": diagnostics.get("inheritedScope"),
            "overriddenFields": diagnostics.get("overriddenFields"),
            "finalResolvedRequest": diagnostics.get("finalResolvedRequest"),
            "plannerAttempted": diagnostics.get("plannerAttempted"),
            "plannerSucceeded": diagnostics.get("plannerSucceeded"),
            "plannerValidationPassed": diagnostics.get("plannerValidationPassed"),
            "rewriteAttempted": diagnostics.get("rewriteAttempted"),
            "rewriteApplied": diagnostics.get("rewriteApplied"),
            "fallbackTriggered": diagnostics.get("fallbackTriggered"),
            "parsedMachines": diagnostics.get("parsedMachines"),
            "plannedMachines": diagnostics.get("plannedMachines"),
            "executedMachines": diagnostics.get("executedMachines"),
            "finalRenderedMachines": diagnostics.get("finalRenderedMachines"),
        },
    }


def evaluate_live_case(case: Dict[str, Any]) -> Dict[str, Any]:
    service = StubAssistantService(case)
    response = service.handle_chat(
        case["prompt"],
        filters=build_live_ui_filters(case["prompt"]),
        mode=case["mode"],
        diagnostic=True,
    )
    assert_contract(response)
    validation = validate_response(case, response)
    answer = response.get("answer") or {}
    diagnostics = response.get("diagnostics") or {}
    return {
        "name": case["name"],
        "suite": case["suite"],
        "prompt": case["prompt"],
        "mode": case["mode"],
        "recommended_mode": case["recommended_mode"],
        "expected_tool": case["expected_tool"],
        "expected_machine_count": case["expected_machine_count"],
        "expects_metric": case["expects_metric"],
        "expected_outcome": case["expected_outcome"],
        "actual_tool": primary_tool_name(response),
        "actual_tools": validation["actual_tools"],
        "requested_mode": (response.get("context") or {}).get("requestedMode"),
        "execution_mode": (response.get("context") or {}).get("executionMode"),
        "fallback_reason": (response.get("context") or {}).get("fallbackReason") or diagnostics.get("fallbackReason"),
        "title": answer.get("title"),
        "summary": answer.get("summary"),
        "expected_vs_actual": {
            "expected_tool": case["expected_tool"],
            "actual_tools": validation["actual_tools"],
            "expected_outcome": case["expected_outcome"],
            "actual_outcome": validation["actual_outcome"],
            "pass_fail_reason": validation["pass_fail_reason"],
            "outcome_matches_expectation": validation["passed"],
        },
        "validation": validation,
        "diagnostics": {
            "finalResolvedRequest": diagnostics.get("finalResolvedRequest"),
            "activeStickyFilters": diagnostics.get("activeStickyFilters"),
            "usedConversationContext": diagnostics.get("usedConversationContext"),
        },
    }


def build_history_from_turns(turns: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    history: List[Dict[str, Any]] = []
    for turn in turns:
        history.append({"role": "user", "content": turn["prompt"], "resolvedRequest": None})
        history.append(
            {
                "role": "assistant",
                "content": ((turn["response"].get("answer") or {}).get("summary") or ""),
                "resolvedRequest": (((turn["response"].get("context") or {}).get("resolvedRequest")) or None),
                "stickyFilters": (((turn["response"].get("context") or {}).get("stickyFilters")) or None),
            }
        )
    return history


def evaluate_follow_up_sequence(sequence: Dict[str, Any]) -> Dict[str, Any]:
    service = StubAssistantService(sequence)
    first_response = service.handle_chat(
        sequence["previous_prompt"],
        filters=build_filters(sequence["previous_prompt"]),
        mode=sequence["mode"],
        diagnostic=True,
    )
    assert_contract(first_response)
    history = build_history_from_turns([{"prompt": sequence["previous_prompt"], "response": first_response}])
    second_response = service.handle_chat(
        sequence["prompt"],
        filters=build_filters(sequence["previous_prompt"]),
        history=history,
        mode=sequence["mode"],
        diagnostic=True,
    )
    assert_contract(second_response)
    validation = validate_response(sequence, second_response)
    diagnostics = second_response.get("diagnostics") or {}
    resolved = diagnostics.get("finalResolvedRequest") or {}
    expected_context_inheritance = sequence.get("expected_context_inheritance")
    if expected_context_inheritance is None:
        expected_context_inheritance = True
    follow_up_ok = (
        diagnostics.get("usedConversationContext") is expected_context_inheritance
        and resolved.get("kind") == sequence.get("expected_kind")
        and int(resolved.get("machine_id") or 0) == int(sequence.get("expected_machine_id") or 0)
    )
    if sequence.get("expected_metric_key"):
        follow_up_ok = follow_up_ok and resolved.get("metric_key") == sequence.get("expected_metric_key")
    if sequence.get("expected_scope_kind"):
        scope = resolved.get("analysisScope") or {}
        follow_up_ok = (
            follow_up_ok
            and scope.get("kind") == sequence.get("expected_scope_kind")
            and int(scope.get("count") or scope.get("value") or 0) == int(sequence.get("expected_scope_value") or 0)
        )
    if sequence.get("expected_scope_source"):
        follow_up_ok = follow_up_ok and diagnostics.get("scopeSource") == sequence.get("expected_scope_source")
    validation["passed"] = bool(validation["passed"] and follow_up_ok)
    validation["actual_outcome"] = "passed" if validation["passed"] else "failed"
    if not follow_up_ok:
        validation["failure_category"] = validation["failure_category"] or "conversation context failure"
        validation["pass_fail_reason"] = "conversation context not inherited as expected"
    answer = second_response.get("answer") or {}
    return {
        "name": sequence["name"],
        "suite": sequence["suite"],
        "prompt": f"{sequence['previous_prompt']} -> {sequence['prompt']}",
        "mode": sequence["mode"],
        "recommended_mode": sequence["mode"],
        "expected_tool": sequence["expected_tool"],
        "expected_machine_count": sequence["expected_machine_count"],
        "expects_metric": sequence["expects_metric"],
        "expected_outcome": sequence["expected_outcome"],
        "actual_tool": primary_tool_name(second_response),
        "actual_tools": validation["actual_tools"],
        "requested_mode": (second_response.get("context") or {}).get("requestedMode"),
        "execution_mode": (second_response.get("context") or {}).get("executionMode"),
        "fallback_reason": (second_response.get("context") or {}).get("fallbackReason") or diagnostics.get("fallbackReason"),
        "title": answer.get("title"),
        "summary": answer.get("summary"),
        "expected_vs_actual": {
            "expected_tool": sequence["expected_tool"],
            "actual_tools": validation["actual_tools"],
            "expected_outcome": sequence["expected_outcome"],
            "actual_outcome": validation["actual_outcome"],
            "pass_fail_reason": validation["pass_fail_reason"],
            "outcome_matches_expectation": validation["passed"],
        },
        "validation": validation,
        "diagnostics": {
            "usedConversationContext": diagnostics.get("usedConversationContext"),
            "contextSourceTurn": diagnostics.get("contextSourceTurn"),
            "inheritedIntent": diagnostics.get("inheritedIntent"),
            "inheritedMachineId": diagnostics.get("inheritedMachineId"),
            "inheritedMetricKey": diagnostics.get("inheritedMetricKey"),
            "inheritedScope": diagnostics.get("inheritedScope"),
            "overriddenFields": diagnostics.get("overriddenFields"),
            "scopeSource": diagnostics.get("scopeSource"),
            "scopeOverrideApplied": diagnostics.get("scopeOverrideApplied"),
            "stickyFiltersBefore": diagnostics.get("stickyFiltersBefore"),
            "stickyFiltersAfter": diagnostics.get("stickyFiltersAfter"),
            "filterUpdatesApplied": diagnostics.get("filterUpdatesApplied"),
            "activeStickyFilters": diagnostics.get("activeStickyFilters"),
            "filterSource": diagnostics.get("filterSource"),
            "effectiveTimeScope": diagnostics.get("effectiveTimeScope"),
            "effectiveReelScope": diagnostics.get("effectiveReelScope"),
            "effectiveFeetFilter": diagnostics.get("effectiveFeetFilter"),
            "effectiveReelCount": diagnostics.get("effectiveReelCount"),
            "effectiveFilterStart": diagnostics.get("effectiveFilterStart"),
            "effectiveFilterEnd": diagnostics.get("effectiveFilterEnd"),
            "finalResolvedRequest": diagnostics.get("finalResolvedRequest"),
        },
    }


def evaluate_sticky_filter_sequence(sequence: Dict[str, Any]) -> Dict[str, Any]:
    service = StubAssistantService(sequence)
    turns: List[Dict[str, Any]] = []
    response = None
    filter_builder = build_live_ui_filters if sequence.get("use_live_ui_filters") else build_filters
    for index, prompt in enumerate(sequence["turns"]):
        history = build_history_from_turns(turns)
        filters_seed = sequence["turns"][max(0, index - 1)] if index else prompt
        response = service.handle_chat(
            prompt,
            filters=filter_builder(filters_seed),
            history=history,
            mode=sequence["mode"],
            diagnostic=True,
        )
        assert_contract(response)
        turns.append({"prompt": prompt, "response": response})
    assert response is not None
    final_prompt = sequence["turns"][-1]
    validation = validate_response({**sequence, "prompt": final_prompt}, response)
    diagnostics = response.get("diagnostics") or {}
    resolved = diagnostics.get("finalResolvedRequest") or {}
    active_filters = diagnostics.get("activeStickyFilters") or {}

    sticky_ok = True
    if sequence.get("expected_kind"):
        sticky_ok = sticky_ok and resolved.get("kind") == sequence.get("expected_kind")
    if sequence.get("expected_machine_id") is not None:
        sticky_ok = sticky_ok and int(resolved.get("machine_id") or 0) == int(sequence.get("expected_machine_id") or 0)
    if sequence.get("expected_filter_source"):
        sticky_ok = sticky_ok and diagnostics.get("filterSource") == sequence.get("expected_filter_source")
    if sequence.get("expected_effective_reel_scope"):
        sticky_ok = sticky_ok and diagnostics.get("effectiveReelScope") == sequence.get("expected_effective_reel_scope")
    if sequence.get("expected_metric_key"):
        sticky_ok = sticky_ok and resolved.get("metric_key") == sequence.get("expected_metric_key")
    if sequence.get("expected_comparison_mode"):
        sticky_ok = sticky_ok and (resolved.get("comparison_mode") or resolved.get("comparisonMode") or "none") == sequence.get("expected_comparison_mode")
    if sequence.get("expected_selected_job"):
        sticky_ok = sticky_ok and str(resolved.get("job") or "") == sequence.get("expected_selected_job")

    if "expected_active_filters" in sequence:
        expected_active = sequence.get("expected_active_filters") or {}
        for key, label in expected_active.items():
            sticky_ok = sticky_ok and isinstance(active_filters.get(key), dict) and active_filters[key].get("label") == label
        for key in sequence.get("expected_absent_active_filters") or []:
            sticky_ok = sticky_ok and key not in active_filters
        if not expected_active:
            sticky_ok = sticky_ok and not active_filters

    validation["passed"] = bool(validation["passed"] and sticky_ok)
    validation["actual_outcome"] = "passed" if validation["passed"] else "failed"
    if not sticky_ok:
        validation["failure_category"] = validation["failure_category"] or "sticky filter failure"
        validation["pass_fail_reason"] = "sticky filters were not persisted or cleared as expected"

    answer = response.get("answer") or {}
    return {
        "name": sequence["name"],
        "suite": sequence["suite"],
        "prompt": " -> ".join(sequence["turns"]),
        "mode": sequence["mode"],
        "recommended_mode": sequence["mode"],
        "expected_tool": sequence["expected_tool"],
        "expected_machine_count": sequence["expected_machine_count"],
        "expects_metric": sequence["expects_metric"],
        "expected_outcome": sequence["expected_outcome"],
        "actual_tool": primary_tool_name(response),
        "actual_tools": validation["actual_tools"],
        "requested_mode": (response.get("context") or {}).get("requestedMode"),
        "execution_mode": (response.get("context") or {}).get("executionMode"),
        "fallback_reason": (response.get("context") or {}).get("fallbackReason") or diagnostics.get("fallbackReason"),
        "title": answer.get("title"),
        "summary": answer.get("summary"),
        "expected_vs_actual": {
            "expected_tool": sequence["expected_tool"],
            "actual_tools": validation["actual_tools"],
            "expected_outcome": sequence["expected_outcome"],
            "actual_outcome": validation["actual_outcome"],
            "pass_fail_reason": validation["pass_fail_reason"],
            "outcome_matches_expectation": validation["passed"],
        },
        "validation": validation,
        "diagnostics": {
            "stickyFiltersBefore": diagnostics.get("stickyFiltersBefore"),
            "stickyFiltersAfter": diagnostics.get("stickyFiltersAfter"),
            "filterUpdatesApplied": diagnostics.get("filterUpdatesApplied"),
            "activeStickyFilters": diagnostics.get("activeStickyFilters"),
            "filterSource": diagnostics.get("filterSource"),
            "effectiveTimeScope": diagnostics.get("effectiveTimeScope"),
            "effectiveReelScope": diagnostics.get("effectiveReelScope"),
            "effectiveFeetFilter": diagnostics.get("effectiveFeetFilter"),
            "finalResolvedRequest": diagnostics.get("finalResolvedRequest"),
        },
    }


def evaluate_reset_sequence(sequence: Dict[str, Any]) -> Dict[str, Any]:
    service = StubAssistantService(sequence)
    first_turns = sequence["turns_before_reset"]
    turns: List[Dict[str, Any]] = []
    filter_builder = build_live_ui_filters if sequence.get("use_live_ui_filters") else build_filters
    for index, prompt in enumerate(first_turns):
        history = build_history_from_turns(turns)
        filters_seed = first_turns[max(0, index - 1)] if index else prompt
        response = service.handle_chat(
            prompt,
            filters=filter_builder(filters_seed),
            history=history,
            mode=sequence["mode"],
            diagnostic=True,
        )
        assert_contract(response)
        turns.append({"prompt": prompt, "response": response})

    response = service.handle_chat(
        sequence["prompt_after_reset"],
        filters=filter_builder(sequence["prompt_after_reset"]),
        history=[],
        mode=sequence["mode"],
        diagnostic=True,
    )
    assert_contract(response)
    validation = validate_response({**sequence, "prompt": sequence["prompt_after_reset"]}, response)
    diagnostics = response.get("diagnostics") or {}
    resolved = diagnostics.get("finalResolvedRequest") or {}
    active_filters = diagnostics.get("activeStickyFilters") or {}
    reset_ok = (
        diagnostics.get("usedConversationContext") is not True
        and not active_filters
        and resolved.get("metric_key") == sequence.get("expected_metric_key")
        and int(resolved.get("machine_id") or 0) == int(sequence.get("expected_machine_id") or 0)
    )
    validation["passed"] = bool(validation["routing_ok"] and reset_ok)
    validation["actual_outcome"] = "passed" if validation["passed"] else "failed"
    if not reset_ok:
        validation["failure_category"] = validation["failure_category"] or "new chat reset failure"
        validation["pass_fail_reason"] = "sticky context carried into a reset chat"

    answer = response.get("answer") or {}
    return {
        "name": sequence["name"],
        "suite": sequence["suite"],
        "prompt": " -> ".join(sequence["turns_before_reset"] + ["New Chat", sequence["prompt_after_reset"]]),
        "mode": sequence["mode"],
        "recommended_mode": sequence["mode"],
        "expected_tool": sequence["expected_tool"],
        "expected_machine_count": sequence["expected_machine_count"],
        "expects_metric": sequence["expects_metric"],
        "expected_outcome": sequence["expected_outcome"],
        "actual_tool": primary_tool_name(response),
        "actual_tools": validation["actual_tools"],
        "requested_mode": (response.get("context") or {}).get("requestedMode"),
        "execution_mode": (response.get("context") or {}).get("executionMode"),
        "fallback_reason": (response.get("context") or {}).get("fallbackReason") or diagnostics.get("fallbackReason"),
        "title": answer.get("title"),
        "summary": answer.get("summary"),
        "expected_vs_actual": {
            "expected_tool": sequence["expected_tool"],
            "actual_tools": validation["actual_tools"],
            "expected_outcome": sequence["expected_outcome"],
            "actual_outcome": validation["actual_outcome"],
            "pass_fail_reason": validation["pass_fail_reason"],
            "outcome_matches_expectation": validation["passed"],
        },
        "validation": validation,
        "diagnostics": {
            "usedConversationContext": diagnostics.get("usedConversationContext"),
            "activeStickyFilters": diagnostics.get("activeStickyFilters"),
            "finalResolvedRequest": diagnostics.get("finalResolvedRequest"),
        },
    }


def evaluate_filter_visibility_sequence(sequence: Dict[str, Any]) -> Dict[str, Any]:
    service = StubAssistantService(sequence)
    turns: List[Dict[str, Any]] = []
    response = None
    for prompt in sequence["turns"]:
        response = service.handle_chat(
            prompt,
            filters=build_live_ui_filters(prompt),
            history=build_history_from_turns(turns),
            mode=sequence["mode"],
            diagnostic=True,
        )
        assert_contract(response)
        turns.append({"prompt": prompt, "response": response})
    assert response is not None
    validation = validate_response({**sequence, "prompt": sequence["turns"][-1]}, response)
    context = response.get("context") or {}
    applied = context.get("appliedFilters") or {}
    changes = context.get("filterChanges") or []
    visibility_ok = True
    for key, expected in (sequence.get("expected_applied_filters") or {}).items():
        visibility_ok = visibility_ok and applied.get(key) == expected
    for key in sequence.get("required_absent_filters") or []:
        visibility_ok = visibility_ok and key not in applied
    for snippet in sequence.get("required_change_substrings") or []:
        visibility_ok = visibility_ok and any(snippet in str(item) for item in changes)
    validation["passed"] = bool(validation["routing_ok"] and visibility_ok)
    validation["actual_outcome"] = "passed" if validation["passed"] else "failed"
    if not visibility_ok:
        validation["failure_category"] = validation["failure_category"] or "filter visibility failure"
        validation["pass_fail_reason"] = "applied filters or changes this turn were not shown as expected"
    answer = response.get("answer") or {}
    diagnostics = response.get("diagnostics") or {}
    return {
        "name": sequence["name"],
        "suite": sequence["suite"],
        "prompt": " -> ".join(sequence["turns"]),
        "mode": sequence["mode"],
        "recommended_mode": sequence["mode"],
        "expected_tool": sequence["expected_tool"],
        "expected_machine_count": sequence["expected_machine_count"],
        "expects_metric": sequence["expects_metric"],
        "expected_outcome": sequence["expected_outcome"],
        "actual_tool": primary_tool_name(response),
        "actual_tools": validation["actual_tools"],
        "requested_mode": (response.get("context") or {}).get("requestedMode"),
        "execution_mode": (response.get("context") or {}).get("executionMode"),
        "fallback_reason": (response.get("context") or {}).get("fallbackReason") or diagnostics.get("fallbackReason"),
        "title": answer.get("title"),
        "summary": answer.get("summary"),
        "expected_vs_actual": {
            "expected_tool": sequence["expected_tool"],
            "actual_tools": validation["actual_tools"],
            "expected_outcome": sequence["expected_outcome"],
            "actual_outcome": validation["actual_outcome"],
            "pass_fail_reason": validation["pass_fail_reason"],
            "outcome_matches_expectation": validation["passed"],
        },
        "validation": validation,
        "diagnostics": {
            "appliedFilters": applied,
            "filterChanges": changes,
        },
    }


def evaluate_phase2a_follow_up_sequence(sequence: Dict[str, Any]) -> Dict[str, Any]:
    service = StubAssistantService(sequence)
    turns: List[Dict[str, Any]] = []
    response = None
    for index, prompt in enumerate(sequence["turns"]):
        history = build_history_from_turns(turns)
        filters_seed = sequence["turns"][max(0, index - 1)] if index else prompt
        response = service.handle_chat(
            prompt,
            filters=build_filters(filters_seed),
            history=history,
            mode=sequence["mode"],
            diagnostic=True,
        )
        assert_contract(response)
        turns.append({"prompt": prompt, "response": response})
    assert response is not None
    final_prompt = sequence["turns"][-1]
    validation = validate_response({**sequence, "prompt": final_prompt}, response)
    diagnostics = response.get("diagnostics") or {}
    resolved = diagnostics.get("finalResolvedRequest") or {}
    scope = resolved.get("analysisScope") or {}

    phase2a_ok = (
        diagnostics.get("usedConversationContext") is True
        and resolved.get("kind") == sequence.get("expected_kind")
        and int(resolved.get("machine_id") or 0) == int(sequence.get("expected_machine_id") or 0)
        and resolved.get("metric_key") == sequence.get("expected_metric_key")
        and (resolved.get("comparisonMode") or resolved.get("comparison_mode") or "none") == sequence.get("expected_comparison_mode")
        and bool(resolved.get("trendRequested")) is bool(sequence.get("expected_trend_requested"))
        and scope.get("kind") == sequence.get("expected_scope_kind")
        and int(scope.get("count") or scope.get("value") or 0) == int(sequence.get("expected_scope_value") or 0)
        and bool(diagnostics.get("denominatorBasis"))
        and int(diagnostics.get("comparisonPeerCount") or 0) > 0
        and bool(diagnostics.get("trendBasis"))
    )
    validation["passed"] = bool(validation["passed"] and phase2a_ok)
    validation["actual_outcome"] = "passed" if validation["passed"] else "failed"
    if not phase2a_ok:
        validation["failure_category"] = validation["failure_category"] or "phase2a follow-up failure"
        validation["pass_fail_reason"] = "phase2a request context was not preserved as expected"

    answer = response.get("answer") or {}
    return {
        "name": sequence["name"],
        "suite": sequence["suite"],
        "prompt": " -> ".join(sequence["turns"]),
        "mode": sequence["mode"],
        "recommended_mode": sequence["mode"],
        "expected_tool": sequence["expected_tool"],
        "expected_machine_count": sequence["expected_machine_count"],
        "expects_metric": sequence["expects_metric"],
        "expected_outcome": sequence["expected_outcome"],
        "actual_tool": primary_tool_name(response),
        "actual_tools": validation["actual_tools"],
        "requested_mode": (response.get("context") or {}).get("requestedMode"),
        "execution_mode": (response.get("context") or {}).get("executionMode"),
        "fallback_reason": (response.get("context") or {}).get("fallbackReason") or diagnostics.get("fallbackReason"),
        "title": answer.get("title"),
        "summary": answer.get("summary"),
        "expected_vs_actual": {
            "expected_tool": sequence["expected_tool"],
            "actual_tools": validation["actual_tools"],
            "expected_outcome": sequence["expected_outcome"],
            "actual_outcome": validation["actual_outcome"],
            "pass_fail_reason": validation["pass_fail_reason"],
            "outcome_matches_expectation": validation["passed"],
        },
        "validation": validation,
        "diagnostics": {
            "usedConversationContext": diagnostics.get("usedConversationContext"),
            "overriddenFields": diagnostics.get("overriddenFields"),
            "finalResolvedRequest": diagnostics.get("finalResolvedRequest"),
            "resolvedIntent": diagnostics.get("resolved_intent"),
            "comparisonMode": diagnostics.get("comparison_mode"),
            "comparisonPeerCount": diagnostics.get("comparisonPeerCount"),
            "metricKeyUsed": diagnostics.get("metricKeyUsed"),
            "denominatorBasis": diagnostics.get("denominatorBasis"),
            "trendBasis": diagnostics.get("trendBasis"),
            "effectiveReelScope": diagnostics.get("effectiveReelScope"),
        },
    }


def evaluate_phase2b_follow_up_sequence(sequence: Dict[str, Any]) -> Dict[str, Any]:
    service = StubAssistantService(sequence)
    turns: List[Dict[str, Any]] = []
    response = None
    for index, prompt in enumerate(sequence["turns"]):
        history = build_history_from_turns(turns)
        filters_seed = sequence["turns"][max(0, index - 1)] if index else prompt
        response = service.handle_chat(
            prompt,
            filters=build_filters(filters_seed),
            history=history,
            mode=sequence["mode"],
            diagnostic=True,
        )
        assert_contract(response)
        turns.append({"prompt": prompt, "response": response})
    assert response is not None
    final_prompt = sequence["turns"][-1]
    validation = validate_response({**sequence, "prompt": final_prompt}, response)
    diagnostics = response.get("diagnostics") or {}
    resolved = diagnostics.get("finalResolvedRequest") or {}
    metric_analysis = (response.get("context") or {}).get("metricAnalysis") or {}
    sections = {str(section.get("label") or "") for section in (response.get("answer") or {}).get("sections") or [] if isinstance(section, dict)}

    phase2b_ok = (
        diagnostics.get("usedConversationContext") is True
        and resolved.get("kind") == sequence.get("expected_kind")
        and int(resolved.get("machine_id") or 0) == int(sequence.get("expected_machine_id") or 0)
        and resolved.get("metric_key") == sequence.get("expected_metric_key")
        and (resolved.get("grouping") or "") == sequence.get("expected_grouping")
    )
    if sequence.get("expected_grouping") == "reels":
        phase2b_ok = phase2b_ok and "Driver reels" in sections and bool(metric_analysis.get("driverReels"))
    if sequence.get("expected_grouping") == "run_position":
        phase2b_ok = phase2b_ok and "Run-position pattern" in sections and bool(metric_analysis.get("runPositionPattern"))
    if sequence.get("expected_grouping") == "concentration":
        phase2b_ok = phase2b_ok and "Concentration pattern" in sections and bool(metric_analysis.get("concentrationPattern"))
    if sequence.get("expected_grouping") == "alignment":
        phase2b_ok = phase2b_ok and "Signal alignment" in sections

    validation["passed"] = bool(validation["passed"] and phase2b_ok)
    validation["actual_outcome"] = "passed" if validation["passed"] else "failed"
    if not phase2b_ok:
        validation["failure_category"] = validation["failure_category"] or "phase2b follow-up failure"
        validation["pass_fail_reason"] = "phase2b explanation focus was not preserved as expected"

    answer = response.get("answer") or {}
    return {
        "name": sequence["name"],
        "suite": sequence["suite"],
        "prompt": " -> ".join(sequence["turns"]),
        "mode": sequence["mode"],
        "recommended_mode": sequence["mode"],
        "expected_tool": sequence["expected_tool"],
        "expected_machine_count": sequence["expected_machine_count"],
        "expects_metric": sequence["expects_metric"],
        "expected_outcome": sequence["expected_outcome"],
        "actual_tool": primary_tool_name(response),
        "actual_tools": validation["actual_tools"],
        "requested_mode": (response.get("context") or {}).get("requestedMode"),
        "execution_mode": (response.get("context") or {}).get("executionMode"),
        "fallback_reason": (response.get("context") or {}).get("fallbackReason") or diagnostics.get("fallbackReason"),
        "title": answer.get("title"),
        "summary": answer.get("summary"),
        "expected_vs_actual": {
            "expected_tool": sequence["expected_tool"],
            "actual_tools": validation["actual_tools"],
            "expected_outcome": sequence["expected_outcome"],
            "actual_outcome": validation["actual_outcome"],
            "pass_fail_reason": validation["pass_fail_reason"],
            "outcome_matches_expectation": validation["passed"],
        },
        "validation": validation,
        "diagnostics": {
            "usedConversationContext": diagnostics.get("usedConversationContext"),
            "overriddenFields": diagnostics.get("overriddenFields"),
            "finalResolvedRequest": diagnostics.get("finalResolvedRequest"),
            "runPositionPattern": diagnostics.get("runPositionPattern"),
            "concentrationPattern": diagnostics.get("concentrationPattern"),
            "driverReels": diagnostics.get("driverReels"),
            "driverJobs": diagnostics.get("driverJobs"),
            "explanationSummary": diagnostics.get("explanationSummary"),
        },
    }


def evaluate_phase2c_follow_up_sequence(sequence: Dict[str, Any]) -> Dict[str, Any]:
    service = StubAssistantService(sequence)
    turns: List[Dict[str, Any]] = []
    response = None
    for index, prompt in enumerate(sequence["turns"]):
        history = build_history_from_turns(turns)
        filters_seed = sequence["turns"][max(0, index - 1)] if index else prompt
        response = service.handle_chat(
            prompt,
            filters=build_filters(filters_seed),
            history=history,
            mode=sequence["mode"],
            diagnostic=True,
        )
        assert_contract(response)
        turns.append({"prompt": prompt, "response": response})
    assert response is not None
    validation = validate_response({**sequence, "prompt": sequence["turns"][-1]}, response)
    diagnostics = response.get("diagnostics") or {}
    resolved = diagnostics.get("finalResolvedRequest") or {}
    metric_analysis = (response.get("context") or {}).get("metricAnalysis") or {}
    sections = {str(section.get("label") or "") for section in (response.get("answer") or {}).get("sections") or [] if isinstance(section, dict)}

    phase2c_ok = (
        int(resolved.get("machine_id") or 0) == int(sequence.get("expected_machine_id") or 0)
        and resolved.get("kind") == sequence.get("expected_kind")
    )
    if sequence.get("expected_metric_key"):
        phase2c_ok = phase2c_ok and resolved.get("metric_key") == sequence.get("expected_metric_key")
    if sequence.get("expected_grouping"):
        phase2c_ok = phase2c_ok and (resolved.get("grouping") or "") == sequence.get("expected_grouping")
    if sequence.get("expected_comparison_mode"):
        phase2c_ok = phase2c_ok and (resolved.get("comparison_mode") or resolved.get("comparisonMode") or "none") == sequence.get("expected_comparison_mode")
    if sequence.get("expected_selected_job"):
        selected_job = metric_analysis.get("selectedJob") or (response.get("context") or {}).get("selectedJob")
        phase2c_ok = phase2c_ok and selected_job == sequence.get("expected_selected_job")

    if sequence.get("expected_grouping") == "fairness":
        phase2c_ok = phase2c_ok and "Comparison confidence" in sections and bool(diagnostics.get("fairnessNotes"))
    if sequence.get("expected_grouping") == "episodes":
        phase2c_ok = phase2c_ok and "Deviation episode summary" in sections and bool(diagnostics.get("deviationEpisodes"))
    if sequence.get("expected_selected_job"):
        phase2c_ok = phase2c_ok and diagnostics.get("selectedJob") == sequence.get("expected_selected_job")

    validation["passed"] = bool(validation["passed"] and phase2c_ok)
    validation["actual_outcome"] = "passed" if validation["passed"] else "failed"
    if not phase2c_ok:
        validation["failure_category"] = validation["failure_category"] or "phase2c follow-up failure"
        validation["pass_fail_reason"] = "phase2c follow-up contract was not satisfied"

    answer = response.get("answer") or {}
    return {
        "name": sequence["name"],
        "suite": sequence["suite"],
        "prompt": " -> ".join(sequence["turns"]),
        "mode": sequence["mode"],
        "recommended_mode": sequence["mode"],
        "expected_tool": sequence["expected_tool"],
        "expected_machine_count": sequence["expected_machine_count"],
        "expects_metric": sequence["expects_metric"],
        "expected_outcome": sequence["expected_outcome"],
        "actual_tool": primary_tool_name(response),
        "actual_tools": validation["actual_tools"],
        "requested_mode": (response.get("context") or {}).get("requestedMode"),
        "execution_mode": (response.get("context") or {}).get("executionMode"),
        "fallback_reason": (response.get("context") or {}).get("fallbackReason") or diagnostics.get("fallbackReason"),
        "title": answer.get("title"),
        "summary": answer.get("summary"),
        "expected_vs_actual": {
            "expected_tool": sequence["expected_tool"],
            "actual_tools": validation["actual_tools"],
            "expected_outcome": sequence["expected_outcome"],
            "actual_outcome": validation["actual_outcome"],
            "pass_fail_reason": validation["pass_fail_reason"],
            "outcome_matches_expectation": validation["passed"],
        },
        "validation": validation,
        "diagnostics": {
            "finalResolvedRequest": diagnostics.get("finalResolvedRequest"),
            "comparisonConfidence": diagnostics.get("comparisonConfidence"),
            "fairnessNotes": diagnostics.get("fairnessNotes"),
            "deviationEpisodes": diagnostics.get("deviationEpisodes"),
            "selectedJob": diagnostics.get("selectedJob"),
            "availableJobs": (response.get("context") or {}).get("availableJobs"),
        },
    }


def evaluate_phase2d_follow_up_sequence(sequence: Dict[str, Any]) -> Dict[str, Any]:
    service = StubAssistantService(sequence)
    turns: List[Dict[str, Any]] = []
    response = None
    for index, prompt in enumerate(sequence["turns"]):
        history = build_history_from_turns(turns)
        filters_seed = sequence["turns"][max(0, index - 1)] if index else prompt
        response = service.handle_chat(
            prompt,
            filters=build_filters(filters_seed),
            history=history,
            mode=sequence["mode"],
            diagnostic=True,
        )
        assert_contract(response)
        turns.append({"prompt": prompt, "response": response})
    assert response is not None
    validation = validate_response({**sequence, "prompt": sequence["turns"][-1]}, response)
    diagnostics = response.get("diagnostics") or {}
    resolved = diagnostics.get("finalResolvedRequest") or {}
    sections = {str(section.get("label") or "") for section in (response.get("answer") or {}).get("sections") or [] if isinstance(section, dict)}

    phase2d_ok = (
        diagnostics.get("usedConversationContext") is True
        and resolved.get("kind") == sequence.get("expected_kind")
        and int(resolved.get("machine_id") or 0) == int(sequence.get("expected_machine_id") or 0)
        and resolved.get("metric_key") == sequence.get("expected_metric_key")
        and (resolved.get("grouping") or "") == sequence.get("expected_grouping")
    )
    if sequence.get("required_section"):
        phase2d_ok = phase2d_ok and sequence["required_section"] in sections

    validation["passed"] = bool(validation["passed"] and phase2d_ok)
    validation["actual_outcome"] = "passed" if validation["passed"] else "failed"
    if not phase2d_ok:
        validation["failure_category"] = validation["failure_category"] or "phase2d follow-up failure"
        validation["pass_fail_reason"] = "phase2d explanation routing did not preserve the expected decision focus"

    answer = response.get("answer") or {}
    return {
        "name": sequence["name"],
        "suite": sequence["suite"],
        "prompt": " -> ".join(sequence["turns"]),
        "mode": sequence["mode"],
        "recommended_mode": sequence["mode"],
        "expected_tool": sequence["expected_tool"],
        "expected_machine_count": sequence["expected_machine_count"],
        "expects_metric": sequence["expects_metric"],
        "expected_outcome": sequence["expected_outcome"],
        "actual_tool": primary_tool_name(response),
        "actual_tools": validation["actual_tools"],
        "requested_mode": (response.get("context") or {}).get("requestedMode"),
        "execution_mode": (response.get("context") or {}).get("executionMode"),
        "fallback_reason": (response.get("context") or {}).get("fallbackReason") or diagnostics.get("fallbackReason"),
        "title": answer.get("title"),
        "summary": answer.get("summary"),
        "expected_vs_actual": {
            "expected_tool": sequence["expected_tool"],
            "actual_tools": validation["actual_tools"],
            "expected_outcome": sequence["expected_outcome"],
            "actual_outcome": validation["actual_outcome"],
            "pass_fail_reason": validation["pass_fail_reason"],
            "outcome_matches_expectation": validation["passed"],
        },
        "validation": validation,
        "diagnostics": {
            "usedConversationContext": diagnostics.get("usedConversationContext"),
            "overriddenFields": diagnostics.get("overriddenFields"),
            "finalResolvedRequest": diagnostics.get("finalResolvedRequest"),
            "explanationSummary": diagnostics.get("explanationSummary"),
        },
    }


def truncate(value: str, width: int) -> str:
    text = str(value or "")
    return text if len(text) <= width else text[: width - 3] + "..."


def print_table(results: List[Dict[str, Any]], *, only_failures: bool) -> None:
    rows = []
    for result in results:
        validation = result["validation"]
        if only_failures and validation["passed"]:
            continue
        rows.append(
            [
                truncate(result["prompt"], 42),
                result["mode"],
                result["actual_tool"],
                result["expected_tool"],
                "yes" if validation["entity_ok"] else "no",
                "yes" if validation["routing_ok"] else "no",
                "PASS" if validation["passed"] else "FAIL",
            ]
        )

    headers = ["Prompt", "Mode", "Tool", "Expected Tool", "Entity OK", "Routing OK", "Status"]
    widths = [42, 13, 24, 24, 10, 11, 6]
    header_line = " | ".join(header.ljust(width) for header, width in zip(headers, widths))
    separator = "-+-".join("-" * width for width in widths)
    print(header_line)
    print(separator)
    for row in rows:
        print(" | ".join(str(cell).ljust(width) for cell, width in zip(row, widths)))


def build_summary(results: List[Dict[str, Any]]) -> Dict[str, Any]:
    total = len(results)
    pass_count = sum(1 for result in results if result["validation"]["passed"])
    entity_ok_count = sum(1 for result in results if result["validation"]["entity_ok"])

    tool_counts: Dict[str, Dict[str, int]] = defaultdict(lambda: {"total": 0, "correct": 0})
    failure_counts = Counter()
    pattern_counts = Counter()

    for result in results:
        expected_tool = result["expected_tool"]
        tool_counts[expected_tool]["total"] += 1
        if result["validation"]["routing_ok"]:
            tool_counts[expected_tool]["correct"] += 1
        failure_category = result["validation"]["failure_category"]
        if failure_category:
            failure_counts[failure_category] += 1
            pattern_counts[f"{expected_tool} -> {failure_category}"] += 1
        if result["validation"]["entity_error"]:
            pattern_counts["entity drift"] += 1

    tool_accuracy = {
        tool: round(stats["correct"] / stats["total"], 2) if stats["total"] else 0.0
        for tool, stats in sorted(tool_counts.items())
    }
    lowest_accuracy_tools = sorted(tool_accuracy.items(), key=lambda item: (item[1], item[0]))[:3]

    suite_summary: Dict[str, Dict[str, Any]] = {}
    for suite in sorted({result["suite"] for result in results}):
        suite_results = [result for result in results if result["suite"] == suite]
        suite_total = len(suite_results)
        suite_passed = sum(1 for result in suite_results if result["validation"]["passed"])
        suite_entity_ok = sum(1 for result in suite_results if result["validation"]["entity_ok"])
        suite_failures = Counter(
            result["validation"]["failure_category"]
            for result in suite_results
            if result["validation"]["failure_category"]
        )
        suite_summary[suite] = {
            "total": suite_total,
            "passed": suite_passed,
            "failed": suite_total - suite_passed,
            "pass_rate": round(suite_passed / suite_total, 2) if suite_total else 0.0,
            "entity_consistency_rate": round(suite_entity_ok / suite_total, 2) if suite_total else 0.0,
            "most_common_failure_type": suite_failures.most_common(1)[0][0] if suite_failures else None,
        }

    return {
        "total_cases": total,
        "passed_cases": pass_count,
        "failed_cases": total - pass_count,
        "overall_pass_rate": round(pass_count / total, 2) if total else 0.0,
        "entity_consistency_rate": round(entity_ok_count / total, 2) if total else 0.0,
        "tool_accuracy": tool_accuracy,
        "failure_categories": dict(failure_counts),
        "most_common_failure_type": failure_counts.most_common(1)[0][0] if failure_counts else None,
        "top_failing_patterns": [
            {"pattern": pattern, "count": count}
            for pattern, count in pattern_counts.most_common(5)
        ],
        "tools_with_lowest_accuracy": [
            {"tool": tool, "accuracy": accuracy}
            for tool, accuracy in lowest_accuracy_tools
        ],
        "average_scores": {
            "correctness_score": round(sum(r["validation"]["correctness_score"] for r in results) / total, 2) if total else 0.0,
            "routing_score": round(sum(r["validation"]["routing_score"] for r in results) / total, 2) if total else 0.0,
            "entity_consistency": round(sum(r["validation"]["entity_consistency"] for r in results) / total, 2) if total else 0.0,
        },
        "suite_summary": suite_summary,
    }


def print_debug_insights(summary: Dict[str, Any]) -> None:
    print("\nDebug insights")
    print(f"- Most common failure type: {summary['most_common_failure_type'] or 'none'}")
    print(f"- Overall pass rate: {summary['overall_pass_rate']:.2f}")
    print(f"- Entity consistency rate: {summary['entity_consistency_rate']:.2f}")
    print("- Top failing patterns:")
    for item in summary["top_failing_patterns"]:
        print(f"  {item['pattern']}: {item['count']}")
    print("- Tools with lowest accuracy:")
    for item in summary["tools_with_lowest_accuracy"]:
        print(f"  {item['tool']}: {item['accuracy']:.2f}")
    print("- Summary by suite:")
    for suite, suite_summary in summary["suite_summary"].items():
        print(
            f"  {suite}: total={suite_summary['total']} passed={suite_summary['passed']} "
            f"failed={suite_summary['failed']} pass_rate={suite_summary['pass_rate']:.2f} "
            f"entity_consistency={suite_summary['entity_consistency_rate']:.2f} "
            f"most_common_failure={suite_summary['most_common_failure_type'] or 'none'}"
        )


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Evaluate routing and entity consistency for the RLM assistant.")
    parser.add_argument("--only-failures", action="store_true", help="Print only failing rows in the output table.")
    parser.add_argument(
        "--suite",
        choices=["safe", "llm", "hard", "summary", "minimal", "category", "category_compare", "scope", "compare_scope", "phase2a", "phase2b", "phase2c", "phase2d", "discovery", "discovery_time", "discovery_wording", "starter", "filter_visibility", "follow_up", "scope_follow_up", "sticky_filters", "sticky_live", "phase2a_follow_up", "phase2b_follow_up", "phase2c_follow_up", "phase2d_follow_up", "all"],
        default="all",
        help="Run only one prompt suite or all suites.",
    )
    parser.add_argument(
        "--json-out",
        default=str(ROOT / "scripts" / "validate_rlm_assistant_llm_report.json"),
        help="Path to write the JSON report.",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    selected_cases = CASES if args.suite == "all" else [case for case in CASES if case["suite"] == args.suite]
    if args.suite == "starter":
        results = [evaluate_live_case(case) for case in selected_cases]
    else:
        results = [evaluate_live_case(case) if case["suite"] == "starter" else evaluate_case(case) for case in selected_cases]
    if args.suite in {"follow_up", "all"}:
        selected_sequences = FOLLOW_UP_SEQUENCES if args.suite == "all" else [sequence for sequence in FOLLOW_UP_SEQUENCES if sequence["suite"] == args.suite]
        results.extend(evaluate_follow_up_sequence(sequence) for sequence in selected_sequences)
    if args.suite in {"scope_follow_up", "all"}:
        selected_sequences = SCOPE_FOLLOW_UP_SEQUENCES if args.suite == "all" else [sequence for sequence in SCOPE_FOLLOW_UP_SEQUENCES if sequence["suite"] == args.suite]
        results.extend(evaluate_follow_up_sequence(sequence) for sequence in selected_sequences)
    if args.suite in {"sticky_filters", "all"}:
        selected_sequences = STICKY_FILTER_SEQUENCES if args.suite == "all" else [sequence for sequence in STICKY_FILTER_SEQUENCES if sequence["suite"] == args.suite]
        results.extend(evaluate_sticky_filter_sequence(sequence) for sequence in selected_sequences)
    if args.suite in {"sticky_live", "all"}:
        selected_sequences = LIVE_STICKY_SEQUENCES if args.suite == "all" else [sequence for sequence in LIVE_STICKY_SEQUENCES if sequence["suite"] == args.suite]
        results.extend(evaluate_sticky_filter_sequence(sequence) for sequence in selected_sequences)
        selected_reset_sequences = RESET_SEQUENCES if args.suite == "all" else [sequence for sequence in RESET_SEQUENCES if sequence["suite"] == args.suite]
        results.extend(evaluate_reset_sequence(sequence) for sequence in selected_reset_sequences)
    if args.suite in {"filter_visibility", "all"}:
        selected_sequences = FILTER_VISIBILITY_SEQUENCES if args.suite == "all" else [sequence for sequence in FILTER_VISIBILITY_SEQUENCES if sequence["suite"] == args.suite]
        results.extend(evaluate_filter_visibility_sequence(sequence) for sequence in selected_sequences)
    if args.suite in {"phase2a_follow_up", "all"}:
        selected_sequences = PHASE2A_FOLLOW_UP_SEQUENCES if args.suite == "all" else [sequence for sequence in PHASE2A_FOLLOW_UP_SEQUENCES if sequence["suite"] == args.suite]
        results.extend(evaluate_phase2a_follow_up_sequence(sequence) for sequence in selected_sequences)
    if args.suite in {"phase2b_follow_up", "all"}:
        selected_sequences = PHASE2B_FOLLOW_UP_SEQUENCES if args.suite == "all" else [sequence for sequence in PHASE2B_FOLLOW_UP_SEQUENCES if sequence["suite"] == args.suite]
        results.extend(evaluate_phase2b_follow_up_sequence(sequence) for sequence in selected_sequences)
    if args.suite in {"phase2c_follow_up", "all"}:
        selected_sequences = PHASE2C_FOLLOW_UP_SEQUENCES if args.suite == "all" else [sequence for sequence in PHASE2C_FOLLOW_UP_SEQUENCES if sequence["suite"] == args.suite]
        results.extend(evaluate_phase2c_follow_up_sequence(sequence) for sequence in selected_sequences)
    if args.suite in {"phase2d_follow_up", "all"}:
        selected_sequences = PHASE2D_FOLLOW_UP_SEQUENCES if args.suite == "all" else [sequence for sequence in PHASE2D_FOLLOW_UP_SEQUENCES if sequence["suite"] == args.suite]
        results.extend(evaluate_phase2d_follow_up_sequence(sequence) for sequence in selected_sequences)
    if args.suite in {"discovery_time", "all"}:
        selected_sequences = DISCOVERY_TIME_SEQUENCES if args.suite == "all" else [sequence for sequence in DISCOVERY_TIME_SEQUENCES if sequence["suite"] == args.suite]
        results.extend(evaluate_discovery_time_sequence(sequence) for sequence in selected_sequences)
    if args.suite in {"discovery_wording", "all"}:
        selected_sequences = DISCOVERY_WORDING_SEQUENCES if args.suite == "all" else [sequence for sequence in DISCOVERY_WORDING_SEQUENCES if sequence["suite"] == args.suite]
        results.extend(evaluate_discovery_time_sequence(sequence) for sequence in selected_sequences)
    summary = build_summary(results)
    report = {
        "generatedAtUtc": datetime.now(UTC).isoformat(),
        "suiteFilter": args.suite,
        "cases": results,
        "summary": summary,
    }

    print_table(results, only_failures=args.only_failures)
    print_debug_insights(summary)

    json_path = Path(args.json_out)
    json_path.write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(f"\nWrote JSON report to {json_path}")

    if summary["failed_cases"]:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
