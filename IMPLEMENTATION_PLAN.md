# SupoClip + Claude — Implementation Plan

## Audit findings (what already exists)

- **LLM layer:** `backend/src/ai.py` runs every LLM task (clip selection, long-video
  rerank, B-roll planning) through Pydantic AI agents chosen by `LLM=provider:model`.
  `anthropic:*` is already a supported provider (`AnthropicModel` + `AnthropicProvider`),
  with retries, timeouts, transient-error handling and schema validation shared by all
  providers. **No new provider or second client is needed.**
- **Secret storage:** `backend/src/runtime_settings.py` stores admin-entered keys
  (incl. `ANTHROPIC_API_KEY`, `LLM`) AES-GCM-encrypted in `app_settings`; the API and the
  worker load them at startup / job start. Exposed at `/admin/runtime-settings`
  (admin only); values are never returned.
- **Gaps found:** the inferred default `anthropic:claude-4-sonnet` is not a valid model ID;
  only one hard-coded Claude model used native structured output (others relied on forced
  tool calls, which conflict with thinking-on-by-default models such as Claude Opus 5); there
  was no way to test a key, pick a Claude model, or see the active provider in the UI.
- **Frontend:** Next.js 15 + Tailwind v4 + ShadCN tokens in `globals.css`, `AppShell`
  sidebar, next-intl messages in 6 locales. Existing brand token is already terracotta.

## Checklist

### Phase 2 — Claude integration (backend)
- [x] All `anthropic:*` models use native structured output (`NativeOutput`, JSON schema),
      larger `max_tokens` so adaptive thinking cannot truncate output.
- [x] Default inferred model → `anthropic:claude-opus-5`.
- [x] `src/llm_connection.py`: key masking + free connection test (Models API, no tokens
      billed) with distinct `missing_key / invalid_key / permission_denied / model_not_found /
      rate_limited / connection_failed / api_error / ok` results.
- [x] `POST /admin/ai/test-connection` (admin only; tests a pasted key or the saved one).
- [x] `GET /ai/provider` (public, no secrets): active provider + model + configured flag.
- [x] Admin runtime settings return a masked hint (`sk-ant-…abcd`) for secrets.
- [x] Unit tests for the above.

### Phase 3–4 — Design system, shell, screens
- [x] Warm off-white / terracotta token palette (light primary), serif display face.
- [x] Shell: "SupoClip + Claude" branding, recent projects, active AI provider indicator.
- [x] Settings → **AI provider** card (key paste, Test connection, model select, save,
      remove; masked key; admin-only edit, read-only status for others).
- [x] Home: active-provider indicator next to the create action.
- Existing processing, results, library and editor screens inherit the new tokens; their
  behavior is untouched.

### Phase 6 — Assistant panel
- Deferred (documented in README "Future work"); core flows take priority.

### Phase 7 — Verify & document
- [x] Backend unit tests, frontend lint/typecheck/unit tests/build.
- [x] README / `.env.example` / `docs/configuration.md` Claude setup + troubleshooting.
