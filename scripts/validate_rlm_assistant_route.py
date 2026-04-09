from __future__ import annotations

from pathlib import Path
import sys

from flask import Flask, jsonify, request

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from services.rlm_assistant_service import (  # noqa: E402
    EXECUTION_MODE_DETERMINISTIC,
    EXECUTION_MODE_LLM,
    RLMAssistantService,
)


class FakeLLMClient:
    def __init__(self, *, plan=None, rewrite=None):
        self.plan = plan
        self.rewrite = rewrite

    def build_plan(self, *, message, filters, tool_registry):
        del message, filters, tool_registry
        return self.plan

    def compose_copy(self, *, message, base_response, tool_results):
        del message, base_response, tool_results
        return self.rewrite or {
            "title": "Press 6 vs Press 8: Press 6 is currently stronger on bad-feet rate.",
            "summary": "Press 6 is at 1.40% estimated bad feet versus 4.80% for Press 8.",
            "sections": [
                {"label": "Press 6", "text": "Rank #2; 1.40% bad feet; 0.31 mm delta std dev; 25.2 pts/1k ft."},
                {"label": "Press 8", "text": "Rank #6; 4.80% bad feet; 0.72 mm delta std dev; 14.8 pts/1k ft."},
            ],
            "suggestedPrompts": ["Why is Press 6 ranked low?", "Why is Press 8 ranked low?"],
        }


class StubRouteAssistantService(RLMAssistantService):
    def __init__(self, llm_client=None):
        super().__init__(live_service=object(), press_service=object(), llm_client=llm_client)

    def get_press_status_tool(self, machine_id, filters):
        del filters
        return {
            "found": True,
            "machineId": machine_id,
            "machineName": f"Press {machine_id}",
            "latest": {
                "machineName": f"Press {machine_id}",
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
        return {
            "machineIds": machine_ids,
            "requestedMachines": machine_ids,
            "requestedMachineLabels": [f"Press {machine_ids[0]}", f"Press {machine_ids[1]}"],
            "rows": [
                {
                    "machineId": machine_ids[0],
                    "machineName": "Wrong Ambient Press 11",
                    "rank": 2,
                    "estimatedBadFeetPct": 1.4,
                    "deltaStd": 0.31,
                    "pointsPer1000Ft": 25.2,
                },
                {
                    "machineId": machine_ids[1],
                    "machineName": "Wrong Ambient Press 13",
                    "rank": 6,
                    "estimatedBadFeetPct": 4.8,
                    "deltaStd": 0.72,
                    "pointsPer1000Ft": 14.8,
                },
            ],
            "dataSemantics": "filtered-window",
        }


def create_test_app(service: RLMAssistantService) -> Flask:
    app = Flask(__name__)

    @app.post("/dashboard/api/rlm-assistant/chat")
    def dashboard_rlm_assistant_chat():
        payload = request.get_json(silent=True) or {}
        if not isinstance(payload, dict):
            return jsonify({"error": "Invalid JSON payload."}), 400
        return jsonify(
            service.handle_chat(
                message=payload.get("message") or "",
                filters=payload.get("filters") or {},
                history=payload.get("history") or [],
                mode=payload.get("mode") or EXECUTION_MODE_DETERMINISTIC,
                diagnostic=bool(payload.get("diagnostic")),
            )
        )

    return app


def assert_contract(payload: dict, *, expect_diagnostics: bool) -> None:
    assert isinstance(payload.get("answer"), dict), "answer missing"
    assert isinstance((payload.get("evidence") or {}).get("metrics"), list), "evidence.metrics missing"
    assert isinstance(payload.get("toolsUsed"), list), "toolsUsed missing"
    assert isinstance(payload.get("suggestedPrompts"), list), "suggestedPrompts missing"
    context = payload.get("context") or {}
    assert isinstance(context.get("filtersApplied"), dict), "context.filtersApplied missing"
    assert context.get("dataSemantics"), "context.dataSemantics missing"
    if expect_diagnostics:
        assert isinstance(payload.get("diagnostics"), dict), "diagnostics missing"
    else:
        assert "diagnostics" not in payload, "diagnostics should be additive only"


def make_request_payload(message: str, *, mode: str, diagnostic: bool) -> dict:
    return {
        "message": message,
        "filters": {
            "machine_id": 6,
            "start": "2026-04-07",
            "end": "2026-04-07",
            "job": "",
            "order": "",
            "reel_ids": [],
        },
        "history": [],
        "mode": mode,
        "diagnostic": diagnostic,
    }


def main() -> None:
    service = StubRouteAssistantService(
        llm_client=FakeLLMClient(
            plan={
                "intent": "compare_presses",
                "toolCalls": [
                    {"tool": "compare_presses_tool", "arguments": {"machine_ids": [6, 8]}},
                ],
            }
        )
    )
    app = create_test_app(service)
    with app.test_client() as client:
        deterministic = client.post(
            "/dashboard/api/rlm-assistant/chat",
            json=make_request_payload("What is the status of Press 6 today?", mode=EXECUTION_MODE_DETERMINISTIC, diagnostic=False),
        )
        assert deterministic.status_code == 200, deterministic.get_data(as_text=True)
        deterministic_payload = deterministic.get_json()
        assert_contract(deterministic_payload, expect_diagnostics=False)

        llm_response = client.post(
            "/dashboard/api/rlm-assistant/chat",
            json=make_request_payload("Compare Press 6 vs Press 8", mode=EXECUTION_MODE_LLM, diagnostic=True),
        )
        assert llm_response.status_code == 200, llm_response.get_data(as_text=True)
        llm_payload = llm_response.get_json()
        assert_contract(llm_payload, expect_diagnostics=True)
        diagnostics = llm_payload.get("diagnostics") or {}
        assert diagnostics.get("parsedMachines") == [6, 8]
        assert diagnostics.get("executedMachines") == [6, 8]
        answer_text = f"{(llm_payload.get('answer') or {}).get('title', '')} {(llm_payload.get('answer') or {}).get('summary', '')}"
        assert "Press 6" in answer_text and "Press 8" in answer_text
        assert "Press 11" not in answer_text and "Press 13" not in answer_text
    print("Validated route-level RLM assistant chat integration in deterministic and llm-assisted modes.")


if __name__ == "__main__":
    main()
