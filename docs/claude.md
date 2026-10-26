# SupoClip + Claude

SupoClip + Claude uses Anthropic's Claude models for every LLM step in the clipping
pipeline. Claude reads the word-timestamped transcript, picks self-contained 15–60 s
moments, scores each one (hook, engagement, value, shareability, 0–25 each), explains
the pick, and writes the hook title burned into the clip. On long videos it also
reranks the candidates from every window together, and it plans B-roll cutaways when
B-roll is on.

Claude only receives transcript text and metadata. Video frames are never sent to it,
so it does not do visual analysis. Face tracking and cropping stay on MediaPipe/OpenCV.

## What you need

- An Anthropic API key from the [Anthropic Console](https://console.anthropic.com/settings/keys).
  The account needs API access and billing or credits. **API usage is billed by Anthropic.**
  You do not need Claude Code, a CLI login, or a Claude.ai subscription.
- The usual SupoClip services: AssemblyAI (or Whisper) for transcription, PostgreSQL,
  Redis, the ARQ worker, and ffmpeg. See [setup](setup.md).

## Configure Claude

### In the app (recommended)

1. Start the stack (`docker-compose up -d`) and sign in as an admin user
   (`users.is_admin = true`; see [app guide](app-guide.md)).
2. Open **Settings → AI provider**.
3. Paste the API key and click **Test connection**. The test calls Anthropic's Models API,
   which costs nothing and generates no tokens. It reports one of:
   `Connected`, `No key`, `Invalid key`, `Permission denied`, `Model unavailable`,
   `Rate limited`, `Connection failed` or `Anthropic error`.
4. Pick a model. After a successful test the list shows every Claude model the key can use.
5. Click **Save**. New generations use Claude right away. The worker reloads settings
   at the start of each job.

The key is encrypted with AES-GCM (`APP_SETTINGS_ENCRYPTION_KEY`, falling back to
`BACKEND_AUTH_SECRET`) in the `app_settings` table. It never reaches the browser bundle,
local storage, logs or API responses. The UI only shows a masked hint such as
`sk-ant-…a1b2`. **Remove saved key** deletes the stored value.

If the server environment also sets `ANTHROPIC_API_KEY` or `LLM`, the environment wins
unless you tick **Use these saved values instead of the server environment**. Saving here
never silently overrides a working environment configuration.

Only admins can change the provider. Other users see the active model read-only. The key
applies to the whole instance; there are no per-user keys.

### With environment variables (single-user / headless)

In the root `.env`:

```env
ANTHROPIC_API_KEY=sk-ant-...
LLM=anthropic:claude-opus-5
# Optional: a separate model for the long-video rerank pass
RERANK_LLM=anthropic:claude-sonnet-5
```

`.env` files are git-ignored; `.env.example` contains placeholders only.

## Choosing a model

`LLM` uses `provider:model`. Any Claude model ID works, so newer models need no code change.

| Model | `LLM` value | Notes |
|---|---|---|
| Claude Opus 5 | `anthropic:claude-opus-5` | Default. Best clip judgement. |
| Claude Sonnet 5 | `anthropic:claude-sonnet-5` | Faster and cheaper; good for high volume. |
| Claude Haiku 4.5 | `anthropic:claude-haiku-4-5` | Cheapest; weaker on long, subtle transcripts. |

If only `ANTHROPIC_API_KEY` is set and `LLM` is empty, SupoClip picks `anthropic:claude-opus-5`.
The other providers (Google, OpenAI, OpenRouter, Ollama) still work; switch back by
changing `LLM`. SupoClip never falls back to another provider on its own.

## How the integration works

- `backend/src/ai.py` builds a Pydantic AI `AnthropicModel` for `anthropic:*` models. Every
  Claude request uses JSON-schema structured output (`output_config.format`) instead of a
  forced tool call, because current Claude models think by default. The output is
  validated against `TranscriptAnalysis`, `CandidateRanking` or `BRollPlan`. Invalid output
  is sent back for repair (2 retries), and segments are then checked against transcript
  timestamps and duration bounds before the worker renders them.
- `max_tokens` is 16000 so adaptive thinking cannot truncate a full segment list.
- Claude Opus 5 and Fable 5.1 requests enable Anthropic's server-side refusal fallback
  (`fallbacks: "default"`, beta `server-side-fallback-2026-07-01`). If a safety
  classifier declines a request, Anthropic retries it on a fallback model so the task
  doesn't fail.
- 408/429/5xx/529 responses and network errors retry with backoff inside one time budget.
  401/403/400 fail immediately with a clear task error.
- `backend/src/llm_connection.py` holds the connection test and key masking.
  `POST /admin/ai/test-connection` (admin) and `GET /ai/provider` (public, no secrets)
  expose them.

## Tests

```bash
cd backend && uv run pytest tests/unit/test_claude_provider.py
cd frontend && pnpm exec vitest run src/components/settings
```

These run the real Anthropic SDK and Pydantic AI request path against an in-memory HTTP
transport, so they make no paid calls.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `Invalid key` | Copy the whole key (it starts with `sk-ant-`). Check that it wasn't revoked in the Console. |
| `Permission denied` | The key's workspace can't use the Models API; use a key from a workspace with API access. |
| `Model unavailable` | The key can't use that model ID. Pick one from the list shown after a successful test. |
| `Rate limited` / tasks fail with "temporarily unavailable" | Your Anthropic rate limits were exceeded. Wait, or raise limits in the Console. |
| `Connection failed` | The backend can't reach `api.anthropic.com` (proxy, firewall, DNS). |
| Saved settings don't take effect | The environment sets the same variable; tick "Use these saved values…" or edit `.env`. |
| "Selected LLM provider is Anthropic, but ANTHROPIC_API_KEY is not set" | Save a key in Settings or set `ANTHROPIC_API_KEY`, then retry the task. |
| Credit or billing errors (HTTP 400 from Anthropic) | Add credits or billing in the Anthropic Console. |

## Not included yet

- An in-app Claude assistant panel for suggesting titles or rewriting captions. The core
  pipeline, settings and redesign came first. A future version should run it server-side
  against task and transcript data and require explicit confirmation before changing a clip.
- Per-user API keys. The key is instance-wide, which matches how the other provider keys work.
