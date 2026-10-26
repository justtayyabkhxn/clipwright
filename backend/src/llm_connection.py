"""Claude (Anthropic) connection checks for the settings UI.

The check uses the Models API, which validates the key and the model ID
without generating tokens, so testing a connection never costs anything.
"""

from __future__ import annotations

import anthropic

DEFAULT_CLAUDE_MODEL = "claude-opus-5"
CONNECTION_TIMEOUT_SECONDS = 15.0


def mask_secret(value: str | None) -> str | None:
    """Return a display hint such as ``sk-ant-…a1b2``; never the full value."""
    if not value:
        return None
    value = value.strip()
    if len(value) <= 12:
        return "…" + value[-2:] if len(value) > 4 else "…"
    prefix = "sk-ant-" if value.startswith("sk-ant-") else value[:3]
    return f"{prefix}…{value[-4:]}"


def _result(status: str, message: str, models: list[dict] | None = None) -> dict:
    return {"ok": status == "ok", "status": status, "message": message, "models": models or []}


async def test_anthropic_connection(api_key: str | None, model: str | None = None) -> dict:
    """Validate an Anthropic API key (and optionally a model ID).

    Returns ``{ok, status, message, models}``. ``status`` is one of
    ``ok, missing_key, invalid_key, permission_denied, model_not_found,
    rate_limited, connection_failed, api_error``. Messages never include the key.
    """
    api_key = (api_key or "").strip()
    if not api_key:
        return _result("missing_key", "No Anthropic API key is configured.")

    client = anthropic.AsyncAnthropic(
        api_key=api_key, max_retries=0, timeout=CONNECTION_TIMEOUT_SECONDS
    )
    try:
        return await _check(client, (model or "").strip())
    except anthropic.AuthenticationError:
        return _result("invalid_key", "Anthropic rejected this API key. Check that it was copied in full and is still active.")
    except anthropic.PermissionDeniedError:
        return _result("permission_denied", "This API key does not have permission to use the Models API.")
    except anthropic.RateLimitError:
        return _result("rate_limited", "Anthropic is rate limiting this key. Wait a moment and try again.")
    except (anthropic.APIConnectionError, anthropic.APITimeoutError):
        return _result("connection_failed", "Could not reach api.anthropic.com from the server. Check its network access.")
    except anthropic.APIStatusError as error:
        return _result("api_error", f"Anthropic returned HTTP {error.status_code}. Try again shortly.")
    finally:
        await client.close()


async def _check(client: anthropic.AsyncAnthropic, model: str) -> dict:
    page = await client.models.list(limit=100)
    models = [
        {"id": item.id, "display_name": getattr(item, "display_name", None) or item.id}
        for item in page.data
    ]
    if model and model not in {item["id"] for item in models}:
        # Aliases are not always listed; ask for the model directly.
        try:
            await client.models.retrieve(model)
        except anthropic.NotFoundError:
            return _result("model_not_found", f"The key works, but model '{model}' is not available to it.", models)
    return _result("ok", "Connected to Anthropic.", models)
