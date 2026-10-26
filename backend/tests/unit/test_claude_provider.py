"""Claude (Anthropic) provider: request shape, validation, and connection checks.

Every test runs the real SDKs against an in-memory HTTP transport, so no paid
API calls are made.
"""

import json

import anthropic
import httpx
import pytest
from pydantic import ValidationError
from pydantic_ai import Agent, NativeOutput
from pydantic_ai.providers.anthropic import AnthropicProvider

from src import ai, llm_connection
from src.api.routes.admin import _setting_status
from src.config import Config

TEST_KEY = "sk-ant-api03-test-secret-value-a1b2"


@pytest.fixture
def claude_config(monkeypatch):
    for key in ("GOOGLE_API_KEY", "OPENAI_API_KEY", "OPENROUTER_API_KEY", "LLM"):
        monkeypatch.delenv(key, raising=False)
    monkeypatch.setenv("ANTHROPIC_API_KEY", TEST_KEY)
    return Config()


def _analysis():
    return ai.TranscriptAnalysis(
        most_relevant_segments=[ai.TranscriptSegment(
            start_time="00:05", end_time="00:40",
            text="Here is the one habit that doubled my output in a month.",
            hook_title="The habit that doubled my output",
        )],
        summary="Productivity advice", key_topics=["productivity"],
    )


def _message(text: str, model: str = "claude-opus-5", stop_reason: str = "end_turn"):
    return {
        "id": "msg_test", "type": "message", "role": "assistant", "model": model,
        "content": [{"type": "text", "text": text}],
        "stop_reason": stop_reason, "stop_sequence": None,
        "usage": {"input_tokens": 100, "output_tokens": 100},
    }


def _patch_provider(monkeypatch, handler):
    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    sdk = anthropic.AsyncAnthropic(api_key=TEST_KEY, http_client=client, max_retries=0)
    real = AnthropicProvider
    monkeypatch.setattr(ai, "AnthropicProvider", type("TestProvider", (), {
        "model_profile": staticmethod(real.model_profile),
        "__new__": lambda cls, **kwargs: real(anthropic_client=sdk),
    }))
    return client


def test_default_model_is_a_valid_claude_id(claude_config):
    assert claude_config.llm == "anthropic:claude-opus-5"
    assert ai._get_missing_llm_key_error(claude_config.llm, claude_config) is None


def test_missing_key_fails_before_request(claude_config):
    claude_config.anthropic_api_key = None
    assert "ANTHROPIC_API_KEY" in ai._get_missing_llm_key_error("anthropic:claude-opus-5", claude_config)


@pytest.mark.parametrize("model", ["claude-opus-5", "claude-sonnet-5", "claude-haiku-4-5"])
def test_every_claude_model_uses_schema_output(model):
    assert ai._uses_native_output(f"anthropic:{model}")


async def test_clip_selection_request_and_response(claude_config, monkeypatch):
    captured = []
    analysis = _analysis()

    def handler(request):
        assert request.url.host == "api.anthropic.com"
        assert request.headers["x-api-key"] == TEST_KEY
        captured.append((json.loads(request.content), request.headers.get("anthropic-beta", "")))
        return httpx.Response(200, json=_message(analysis.model_dump_json()))

    client = _patch_provider(monkeypatch, handler)
    model = ai._build_transcript_model(claude_config)
    agent = Agent(model, output_type=NativeOutput(ai.TranscriptAnalysis, strict=True))
    result = await agent.run("Select clips from the transcript.")
    await client.aclose()

    assert result.output == analysis
    body, betas = captured[0]
    assert body["model"] == "claude-opus-5"
    assert body["max_tokens"] == 16000
    assert body["output_config"]["format"]["type"] == "json_schema"
    assert "tools" not in body and "tool_choice" not in body
    assert body["fallbacks"] == "default"
    assert "server-side-fallback-2026-07-01" in betas


async def test_non_fallback_models_send_no_beta(claude_config, monkeypatch):
    captured = []

    def handler(request):
        captured.append(json.loads(request.content))
        return httpx.Response(200, json=_message(_analysis().model_dump_json(), "claude-sonnet-5"))

    client = _patch_provider(monkeypatch, handler)
    model = ai._build_transcript_model(claude_config, "anthropic:claude-sonnet-5")
    agent = Agent(model, output_type=NativeOutput(ai.TranscriptAnalysis, strict=True))
    await agent.run("Select clips.")
    await client.aclose()
    assert "fallbacks" not in captured[0]


async def test_malformed_output_is_retried_then_rejected(claude_config, monkeypatch):
    calls = []

    def handler(request):
        calls.append(1)
        return httpx.Response(200, json=_message('{"most_relevant_segments": "not a list"}'))

    client = _patch_provider(monkeypatch, handler)
    model = ai._build_transcript_model(claude_config)
    agent = Agent(model, output_type=NativeOutput(ai.TranscriptAnalysis, strict=True), output_retries=1)
    with pytest.raises(Exception):
        await agent.run("Select clips.")
    await client.aclose()
    assert len(calls) == 2  # one retry with the validation error, then fail


@pytest.mark.parametrize("status", [429, 529, 503])
def test_rate_limits_and_overload_are_transient(status):
    from pydantic_ai.exceptions import ModelHTTPError

    assert ai._is_transient_model_error(ModelHTTPError(status, "claude-opus-5"))


def test_auth_errors_are_not_retried():
    from pydantic_ai.exceptions import ModelHTTPError

    assert not ai._is_transient_model_error(ModelHTTPError(401, "claude-opus-5"))


def test_segment_validation_rejects_missing_text():
    with pytest.raises(ValidationError):
        ai.TranscriptAnalysis.model_validate({
            "most_relevant_segments": [{"start_time": "00:00", "end_time": "00:20"}],
            "summary": "x", "key_topics": [],
        })


def test_mask_secret_never_returns_the_key():
    masked = llm_connection.mask_secret(TEST_KEY)
    assert masked == "sk-ant-…a1b2"
    assert llm_connection.mask_secret(None) is None
    assert "secret" not in llm_connection.mask_secret("short-secret")


def test_admin_status_shows_only_masked_hint(claude_config):
    status = _setting_status("ANTHROPIC_API_KEY", {})
    assert status["value_hint"] == "sk-ant-…a1b2"
    assert TEST_KEY not in json.dumps(status, default=str)


def _patch_connection(monkeypatch, handler):
    real = anthropic.AsyncAnthropic

    def factory(**kwargs):
        return real(**kwargs, http_client=httpx.AsyncClient(transport=httpx.MockTransport(handler)))

    monkeypatch.setattr(llm_connection.anthropic, "AsyncAnthropic", factory)


def _models_page():
    return {"data": [{"type": "model", "id": "claude-opus-5", "display_name": "Claude Opus 5",
                      "created_at": "2026-01-01T00:00:00Z"}],
            "has_more": False, "first_id": "claude-opus-5", "last_id": "claude-opus-5"}


async def test_connection_missing_key():
    result = await llm_connection.test_anthropic_connection("  ")
    assert result["status"] == "missing_key" and not result["ok"]


async def test_connection_ok_lists_models(monkeypatch):
    _patch_connection(monkeypatch, lambda request: httpx.Response(200, json=_models_page()))
    result = await llm_connection.test_anthropic_connection(TEST_KEY, "claude-opus-5")
    assert result["ok"] and result["models"][0]["id"] == "claude-opus-5"


@pytest.mark.parametrize(("status", "expected"), [
    (401, "invalid_key"), (403, "permission_denied"), (429, "rate_limited"), (500, "api_error"),
])
async def test_connection_error_statuses(monkeypatch, status, expected):
    body = {"type": "error", "error": {"type": "error", "message": "nope"}}
    _patch_connection(monkeypatch, lambda request: httpx.Response(status, json=body))
    result = await llm_connection.test_anthropic_connection(TEST_KEY)
    assert result["status"] == expected
    assert TEST_KEY not in result["message"]


async def test_connection_unreachable(monkeypatch):
    def handler(request):
        raise httpx.ConnectError("no route")

    _patch_connection(monkeypatch, handler)
    result = await llm_connection.test_anthropic_connection(TEST_KEY)
    assert result["status"] == "connection_failed"


async def test_connection_unknown_model(monkeypatch):
    def handler(request):
        if request.url.path.endswith("/models"):
            return httpx.Response(200, json=_models_page())
        return httpx.Response(404, json={"type": "error", "error": {"type": "not_found_error", "message": "model"}})

    _patch_connection(monkeypatch, handler)
    result = await llm_connection.test_anthropic_connection(TEST_KEY, "claude-nonexistent")
    assert result["status"] == "model_not_found"
