from __future__ import annotations

import argparse
import csv
from dataclasses import dataclass
from datetime import datetime
import json
from pathlib import Path
import re
import sys
from typing import Any, Dict, Iterable, List, Optional

import requests


DEFAULT_BASE_URL = "http://127.0.0.1:5000"
DEFAULT_ASSISTANT_PATH = "/assistant/"
DEFAULT_ENDPOINT_PATH = "/assistant/api/chat"
DEFAULT_OUTPUT_ROOT = Path("tmp/assistant_smoke_runs")
REQUEST_TIMEOUT_SECONDS = 60


STARTER_PROMPTS = [
    "How is Press 5 performing today?",
    "Which press is performing the worst right now?",
    "What changed on Press 8 today?",
    "Compare Press 6 and Press 8",
    "Compare Press 5 to average",
    "Which press has the weakest monitoring coverage today?",
    "What jobs ran on Press 5 in the last 24 hours?",
    "Show me the recent jobs for Press 8",
    "Show delta behavior for Press 7",
    "Show speed instability for Press 14",
]

DECISION_PROMPTS = [
    "Why was Press 5 worse in the last 10 reels?",
    "Is Press 5 worse than average because of delta or something else?",
    "Was this just a few reels or the whole job?",
    "Was it broadly unstable or just spikes?",
    "Did it recover?",
    "Was the issue at the beginning, middle, or end?",
]

SCOPED_CHAINS = [
    {
        "name": "chain_a_delta_follow_up",
        "turns": [
            "Show delta behavior for Press 5 in the last 10 reels",
            "What about speed instability?",
            "Compare it to average",
            "Was this just a few reels or the whole job?",
            "Which reels drove this?",
        ],
    },
    {
        "name": "chain_b_scope_replacement",
        "turns": [
            "Show speed instability for Press 14 in the last 24 hours",
            "Now use last 10 reels instead",
            "Is Press 14 getting worse reel to reel?",
        ],
    },
    {
        "name": "chain_c_job_selection",
        "turns": [
            "What jobs ran on Press 5 in the last 24 hours?",
            "Use Job JOB-1-A",
            "Analyze only that job",
            "Compare that job to average",
        ],
    },
    {
        "name": "chain_d_fairness_follow_up",
        "turns": [
            "Compare Press 5 to average",
            "Was this comparison fair?",
            "What really changed?",
        ],
    },
]


@dataclass
class PromptCase:
    suite: str
    chain: str
    turn: int
    prompt: str


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run smoke tests against the real /assistant endpoint.")
    parser.add_argument("--base-url", default=DEFAULT_BASE_URL, help="Base application URL, e.g. http://127.0.0.1:5000")
    parser.add_argument("--assistant-path", default=DEFAULT_ASSISTANT_PATH, help="Assistant page path used to initialize cookies and defaults.")
    parser.add_argument("--endpoint-path", default=DEFAULT_ENDPOINT_PATH, help="Assistant API endpoint path.")
    parser.add_argument("--output-root", default=str(DEFAULT_OUTPUT_ROOT), help="Root directory for timestamped output folders.")
    parser.add_argument("--mode", default="deterministic", choices=["deterministic", "llm-assisted"], help="Execution mode to send.")
    parser.add_argument("--data-mode", default="rlm-only", help="Assistant data mode to send.")
    parser.add_argument("--diagnostic", action="store_true", help="Enable assistant diagnostics in responses.")
    parser.add_argument("--cookie", action="append", default=[], help="Cookie string to add to the session, e.g. name=value")
    parser.add_argument("--header", action="append", default=[], help="Extra header to send, format: Name: Value")
    parser.add_argument("--skip-home-get", action="store_true", help="Skip GET /assistant/ before API calls.")
    return parser.parse_args()


def build_cases() -> List[PromptCase]:
    cases: List[PromptCase] = []
    for idx, prompt in enumerate(STARTER_PROMPTS, start=1):
        cases.append(PromptCase(suite="starter", chain=f"starter_{idx:02d}", turn=1, prompt=prompt))
    for idx, prompt in enumerate(DECISION_PROMPTS, start=1):
        cases.append(PromptCase(suite="decision", chain=f"decision_{idx:02d}", turn=1, prompt=prompt))
    for chain in SCOPED_CHAINS:
        for turn_index, prompt in enumerate(chain["turns"], start=1):
            cases.append(PromptCase(suite="scoped_chain", chain=chain["name"], turn=turn_index, prompt=prompt))
    return cases


def normalize_url(base_url: str, path: str) -> str:
    return base_url.rstrip("/") + "/" + path.lstrip("/")


def parse_header_args(values: Iterable[str]) -> Dict[str, str]:
    headers: Dict[str, str] = {}
    for raw in values:
        if ":" not in raw:
            continue
        name, value = raw.split(":", 1)
        headers[name.strip()] = value.strip()
    return headers


def apply_cookie_args(session: requests.Session, cookie_args: Iterable[str], base_url: str) -> None:
    host = requests.utils.urlparse(base_url).hostname or ""
    for raw in cookie_args:
        if "=" not in raw:
            continue
        name, value = raw.split("=", 1)
        session.cookies.set(name.strip(), value.strip(), domain=host or None)


def fetch_default_filters(session: requests.Session, assistant_url: str, skip_home_get: bool) -> Dict[str, Any]:
    fallback = {
        "machine_id": None,
        "start": "",
        "end": "",
        "job": "",
        "order": "",
        "reel_ids": [],
    }
    if skip_home_get:
        return fallback
    response = session.get(assistant_url, timeout=REQUEST_TIMEOUT_SECONDS)
    response.raise_for_status()
    html = response.text
    start_match = re.search(r'data-default-start="([^"]+)"', html)
    end_match = re.search(r'data-default-end="([^"]+)"', html)
    fallback["start"] = start_match.group(1) if start_match else ""
    fallback["end"] = end_match.group(1) if end_match else ""
    return fallback


def assistant_history_entry(entry: Dict[str, Any]) -> Dict[str, Any]:
    if entry["role"] == "assistant":
        payload = entry.get("payload") or {}
        context = payload.get("context") or {}
        answer = payload.get("answer") or {}
        return {
            "role": "assistant",
            "content": answer.get("summary") or "",
            "resolvedRequest": context.get("resolvedRequest"),
            "stickyFilters": context.get("stickyFilters"),
        }
    return {"role": "user", "content": entry.get("content") or "", "resolvedRequest": None, "stickyFilters": None}


def build_payload(
    *,
    prompt: str,
    filters: Dict[str, Any],
    history: List[Dict[str, Any]],
    mode: str,
    diagnostic: bool,
    data_mode: str,
) -> Dict[str, Any]:
    return {
        "message": prompt,
        "filters": filters,
        "history": [assistant_history_entry(entry) for entry in history[-8:] if entry["role"] in {"user", "assistant"}],
        "mode": mode,
        "diagnostic": diagnostic,
        "data_mode": data_mode,
    }


def extract_response_kind(response_json: Dict[str, Any]) -> str:
    context = response_json.get("context") or {}
    diagnostics = response_json.get("diagnostics") or {}
    resolved = context.get("resolvedRequest") or {}
    metric_analysis = context.get("metricAnalysis") or {}
    return (
        str(resolved.get("kind") or diagnostics.get("parsedIntentKind") or metric_analysis.get("metricKey") or context.get("dataSemantics") or "")
        or "-"
    )


def extract_applied_filter(response_json: Dict[str, Any], label: str) -> str:
    applied = (response_json.get("context") or {}).get("appliedFilters") or {}
    value = applied.get(label)
    return str(value) if value not in (None, "") else ""


def unsupported_flag(response_json: Dict[str, Any]) -> bool:
    answer = response_json.get("answer") or {}
    title = str(answer.get("title") or "").lower()
    summary = str(answer.get("summary") or "").lower()
    semantics = str(((response_json.get("context") or {}).get("dataSemantics") or "")).lower()
    return "question type not supported" in title or "question type not supported" in summary or semantics == "request-validation"


def error_flag(status_code: Optional[int], response_json: Optional[Dict[str, Any]], request_error: Optional[str]) -> bool:
    if request_error:
        return True
    if status_code is None or status_code >= 400:
        return True
    if response_json is None:
        return True
    title = str(((response_json.get("answer") or {}).get("title") or "")).lower()
    return title in {"the assistant request failed.", "no matching rlm data was found."}


def save_json(path: Path, payload: Any) -> None:
    path.write_text(json.dumps(payload, indent=2, ensure_ascii=True), encoding="utf-8")


def save_text(path: Path, text: str) -> None:
    path.write_text(text, encoding="utf-8")


def prompt_markdown(
    *,
    case: PromptCase,
    request_payload: Dict[str, Any],
    status_code: Optional[int],
    response_json: Optional[Dict[str, Any]],
    request_error: Optional[str],
) -> str:
    response_json = response_json or {}
    answer = response_json.get("answer") or {}
    context = response_json.get("context") or {}
    diagnostics = response_json.get("diagnostics") or {}
    lines = [
        f"# {case.suite} / {case.chain} / turn {case.turn}",
        "",
        f"**Prompt**: `{case.prompt}`",
        f"**HTTP status**: `{status_code if status_code is not None else 'request-failed'}`",
        f"**Response kind**: `{extract_response_kind(response_json)}`",
    ]
    if request_error:
        lines.extend(["", f"**Request error**: `{request_error}`"])
    lines.extend(
        [
            "",
            "## Answer",
            f"- Title: {answer.get('title') or '--'}",
            f"- Summary: {answer.get('summary') or '--'}",
            "",
            "## Applied Filters",
        ]
    )
    applied_filters = context.get("appliedFilters") or {}
    if applied_filters:
        lines.extend([f"- {key}: {value}" for key, value in applied_filters.items()])
    else:
        lines.append("- --")
    lines.extend(["", "## Changes This Turn"])
    changes = context.get("filterChanges") or []
    if changes:
        lines.extend([f"- {item}" for item in changes])
    else:
        lines.append("- --")
    lines.extend(["", "## Suggested Follow-ups"])
    prompts = response_json.get("suggestedPrompts") or []
    if prompts:
        lines.extend([f"- {prompt}" for prompt in prompts])
    else:
        lines.append("- --")
    lines.extend(
        [
            "",
            "## Request Payload",
            "```json",
            json.dumps(request_payload, indent=2, ensure_ascii=True),
            "```",
            "",
            "## Diagnostics",
            "```json",
            json.dumps(diagnostics, indent=2, ensure_ascii=True),
            "```",
        ]
    )
    return "\n".join(lines) + "\n"


def ensure_dir(path: Path) -> None:
    path.mkdir(parents=True, exist_ok=True)


def aggregate_markdown(rows: List[Dict[str, Any]], metadata: Dict[str, Any]) -> str:
    lines = [
        "# Assistant Smoke Test Summary",
        "",
        f"- Run timestamp: `{metadata['timestamp']}`",
        f"- Base URL: `{metadata['base_url']}`",
        f"- Endpoint: `{metadata['endpoint_url']}`",
        f"- Assistant page: `{metadata['assistant_url']}`",
        f"- Mode: `{metadata['mode']}`",
        f"- Data mode: `{metadata['data_mode']}`",
        f"- Diagnostics: `{metadata['diagnostic']}`",
        "",
        "| Suite | Chain | Turn | Prompt | Title | Kind | Error | Unsupported | Applied Filters |",
        "|---|---|---:|---|---|---|---|---|---|",
    ]
    for row in rows:
        applied = []
        for key in ("applied_press", "applied_job", "applied_time_scope", "applied_reel_scope"):
            if row.get(key):
                applied.append(row[key])
        lines.append(
            f"| {row['suite']} | {row['chain']} | {row['turn']} | "
            f"{row['prompt'].replace('|', '\\|')} | {row['response_title'].replace('|', '\\|')} | "
            f"{row['response_kind']} | {row['error_flag']} | {row['unsupported_flag']} | "
            f"{', '.join(applied).replace('|', '\\|') or '--'} |"
        )
    return "\n".join(lines) + "\n"


def run_single_request(
    *,
    session: requests.Session,
    endpoint_url: str,
    payload: Dict[str, Any],
) -> tuple[Optional[int], Optional[Dict[str, Any]], Optional[str], Optional[str]]:
    try:
        response = session.post(endpoint_url, json=payload, timeout=REQUEST_TIMEOUT_SECONDS)
        status_code = response.status_code
        raw_text = response.text
        try:
            response_json = response.json()
        except ValueError:
            return status_code, None, None, raw_text
        return status_code, response_json, None, raw_text
    except requests.RequestException as exc:
        return None, None, str(exc), None


def main() -> int:
    args = parse_args()
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    output_root = Path(args.output_root)
    run_dir = output_root / f"assistant_smoke_{timestamp}"
    ensure_dir(run_dir)

    base_url = args.base_url.rstrip("/")
    assistant_url = normalize_url(base_url, args.assistant_path)
    endpoint_url = normalize_url(base_url, args.endpoint_path)

    session = requests.Session()
    session.headers.update({"Content-Type": "application/json"})
    session.headers.update(parse_header_args(args.header))
    apply_cookie_args(session, args.cookie, base_url)

    default_filters = fetch_default_filters(session, assistant_url, args.skip_home_get)

    metadata = {
        "timestamp": timestamp,
        "base_url": base_url,
        "assistant_url": assistant_url,
        "endpoint_url": endpoint_url,
        "mode": args.mode,
        "data_mode": args.data_mode,
        "diagnostic": args.diagnostic,
        "default_filters": default_filters,
    }
    save_json(run_dir / "run_metadata.json", metadata)

    rows: List[Dict[str, Any]] = []
    all_cases = build_cases()
    chains = sorted({case.chain for case in all_cases})

    for chain_name in chains:
        chain_cases = [case for case in all_cases if case.chain == chain_name]
        chain_dir = run_dir / chain_name
        ensure_dir(chain_dir)
        chain_session = requests.Session()
        chain_session.headers.update(session.headers)
        apply_cookie_args(chain_session, args.cookie, base_url)
        if not args.skip_home_get:
            try:
                chain_session.get(assistant_url, timeout=REQUEST_TIMEOUT_SECONDS)
            except requests.RequestException:
                pass
        conversation: List[Dict[str, Any]] = []
        for case in sorted(chain_cases, key=lambda item: item.turn):
            turn_slug = f"{case.turn:02d}"
            turn_dir = chain_dir / turn_slug
            ensure_dir(turn_dir)
            filters = dict(default_filters)
            payload = build_payload(
                prompt=case.prompt,
                filters=filters,
                history=conversation,
                mode=args.mode,
                diagnostic=args.diagnostic,
                data_mode=args.data_mode,
            )
            status_code, response_json, request_error, raw_text = run_single_request(
                session=chain_session,
                endpoint_url=endpoint_url,
                payload=payload,
            )

            save_json(turn_dir / "request.json", payload)
            if response_json is not None:
                save_json(turn_dir / "response.json", response_json)
            elif raw_text is not None:
                save_text(turn_dir / "response_raw.txt", raw_text)
            if request_error:
                save_text(turn_dir / "request_error.txt", request_error)

            md = prompt_markdown(
                case=case,
                request_payload=payload,
                status_code=status_code,
                response_json=response_json,
                request_error=request_error,
            )
            save_text(turn_dir / "summary.md", md)

            if response_json is not None:
                conversation.append({"role": "user", "content": case.prompt})
                conversation.append({"role": "assistant", "payload": response_json})

            response_json_for_extract = response_json or {}
            row = {
                "suite": case.suite,
                "chain": case.chain,
                "turn": case.turn,
                "prompt": case.prompt,
                "response_title": str(((response_json_for_extract.get("answer") or {}).get("title") or "")).replace("\n", " ").strip(),
                "response_summary": str(((response_json_for_extract.get("answer") or {}).get("summary") or "")).replace("\n", " ").strip(),
                "response_kind": extract_response_kind(response_json_for_extract),
                "http_status": status_code if status_code is not None else "",
                "error_flag": "yes" if error_flag(status_code, response_json, request_error) else "no",
                "unsupported_flag": "yes" if unsupported_flag(response_json_for_extract) else "no",
                "applied_press": extract_applied_filter(response_json_for_extract, "Press") or extract_applied_filter(response_json_for_extract, "Presses"),
                "applied_job": extract_applied_filter(response_json_for_extract, "Job"),
                "applied_time_scope": extract_applied_filter(response_json_for_extract, "Time scope"),
                "applied_reel_scope": extract_applied_filter(response_json_for_extract, "Reel scope"),
                "request_error": request_error or "",
            }
            rows.append(row)

    csv_path = run_dir / "summary.csv"
    with csv_path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(
            handle,
            fieldnames=[
                "suite",
                "chain",
                "turn",
                "prompt",
                "response_title",
                "response_summary",
                "response_kind",
                "http_status",
                "error_flag",
                "unsupported_flag",
                "applied_press",
                "applied_job",
                "applied_time_scope",
                "applied_reel_scope",
                "request_error",
            ],
        )
        writer.writeheader()
        writer.writerows(rows)

    save_text(run_dir / "SUMMARY.md", aggregate_markdown(rows, metadata))

    print(f"Saved assistant smoke test results to {run_dir}")
    print(f"- Aggregate markdown: {run_dir / 'SUMMARY.md'}")
    print(f"- Aggregate CSV: {csv_path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
