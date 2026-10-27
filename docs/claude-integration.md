# Claude integration

Clipwright uses Anthropic's Claude for every LLM step. Claude reads the word-timestamped
transcript, picks self-contained 15 to 60 second moments, scores each one (hook, engagement, value
and shareability, 0 to 25 each, summed into a 0 to 100 virality score), explains the pick, and
writes the hook title burned into the top of the clip. On long videos it also reranks the
candidates from every window together.

Claude only receives transcript text plus a few timing signals. Video frames are never sent, so it
does no visual analysis; face tracking and cropping happen in the Python engine with OpenCV.
Transcription is AssemblyAI's job, not Claude's.

## What you need

- An Anthropic API key from the [Anthropic Console](https://console.anthropic.com/settings/keys). The
  account needs API access and billing or credits. **API usage is billed by Anthropic to your
  account.** You do not need Claude Code, a CLI login or a Claude.ai subscription.
- An AssemblyAI API key for transcription.
- A running Clipwright (see [setup](setup.md)).

## Configure Claude

### In the app (recommended)

1. Start Clipwright (`pnpm dev` in `web/`) and sign in as an admin. The first account created is the
   admin; `ADMIN_EMAILS` adds more.
2. Open **Settings → AI and transcription**.
3. Paste the API key and click **Test connection**. The test calls Anthropic's Models API, which costs
   nothing and generates no tokens. It reports one of: `Connected`, `No key`, `Invalid key`,
   `Permission denied`, `Model unavailable`, `Rate limited`, `Connection failed` or `Anthropic error`.
4. Pick a model. After a successful test the list shows every Claude model the key can use.
5. Click **Save**. The worker reads the settings at the start of each job, so the next generation uses
   them without a restart.

The key is encrypted with AES-256-GCM (key = sha256 of `APP_SETTINGS_ENCRYPTION_KEY`, falling back to
`BETTER_AUTH_SECRET`) and stored in the `app_settings` collection. It never reaches the browser
bundle, local storage, logs or API responses; the UI shows only a masked hint such as
`sk-ant-…a1b2`. **Remove saved key** deletes the stored value.

If `web/.env.local` also sets `ANTHROPIC_API_KEY`, `ASSEMBLY_AI_API_KEY` or `CLAUDE_MODEL`, the
environment wins unless you tick **Use these saved values instead of the server environment**.
Saving in the app never silently overrides a working environment configuration.

Only admins can change these settings; other users see the active model and key status read-only.
The keys apply to the whole instance; there are no per-user keys.

### With environment variables

In `web/.env.local`:

```env
ANTHROPIC_API_KEY=sk-ant-...
ASSEMBLY_AI_API_KEY=...
CLAUDE_MODEL=claude-opus-5
# Optional: a different model for the long-video rerank pass (env only)
CLAUDE_RERANK_MODEL=claude-sonnet-5
```

Model IDs are plain Anthropic IDs, with no `anthropic:` prefix. `.env.local` is git-ignored;
`web/.env.example` has placeholders only.

## Choosing a model

Any Claude model ID the key can use works, so newer models need no code change.

| Model | `CLAUDE_MODEL` | Notes |
|---|---|---|
| Claude Opus 5 | `claude-opus-5` | Default. Best clip judgement. Uses the server-side refusal fallback. |
| Claude Sonnet 5 | `claude-sonnet-5` | Faster and cheaper; good for high volume. |
| Claude Haiku 4.5 | `claude-haiku-4-5` | Cheapest; weaker on long, subtle transcripts. |

There is no other LLM provider and no automatic fallback to another provider.

## How the integration works

The code is a TypeScript port of SupoClip's Python `ai.py`, in
[`web/src/server/ai`](../web/src/server/ai). It runs inside the worker during the
"Analyzing content with AI..." step of a generation.

| File | Role |
|---|---|
| `index.ts` | `selectClips()`: windows, concurrency, budgets, final selection. |
| `prompts.ts` | System and user prompts (byte-identical to the Python originals, minus SupoClip's performance section). |
| `client.ts` | One structured Claude call, output repair, transient retries. |
| `schemas.ts` | JSON schemas sent to Claude and the zod parsers for the replies. |
| `validate.ts`, `transcript.ts` | Timestamp validation, snapping, repair and grounding against the transcript. |
| `windows.ts`, `rerank.ts` | Long-video windowing, dedupe, rerank, clip count. |
| `connection.ts` | The free connection test and key masking. |

- **Structured output.** Every request uses `messages.create` with
  `output_config: {format: {type: "json_schema", schema}}` instead of a forced tool call. The reply's
  text blocks are joined and parsed with zod, which applies defaults and clamps out-of-range scores.
- **`max_tokens` is 16000**, so adaptive thinking cannot truncate a full segment list.
- **Output repair.** Invalid JSON or a schema failure is sent back to Claude as a user turn listing the
  errors, at most 2 times. A refusal or token-limit stop with no text fails at once.
- **Server-side refusal fallback.** For `claude-opus-5` and `claude-fable-5-1` requests go through
  `client.beta.messages.create` with `betas: ["server-side-fallback-2026-07-01"]` and
  `fallbacks: "default"`. If a safety classifier declines the request, Anthropic retries it on a
  fallback model so the task does not fail.
- **Retries.** The SDK runs with `maxRetries: 0`; Clipwright retries itself so retries stay inside a
  time budget. HTTP 408, 409, 429 and 5xx (including 529 overloaded) and connection errors are
  retried up to 3 attempts in total, waiting 5 s then 10 s plus up to 1 s of jitter. 400, 401 and 403
  fail immediately.
- **Budgets.** Each analysis call has 600 s, all windows together 1800 s, and the rerank 240 s.
- **Long videos.** Transcripts up to 15 minutes are analysed in one call. Longer ones are split into
  12-minute windows with 2 minutes of overlap, analysed 3 at a time. A failed window is skipped as
  long as another one succeeds. Candidates are deduplicated (more than 50% overlap), then reranked
  in one comparative call with `CLAUDE_RERANK_MODEL`. The rerank never fails the task; on error the
  per-window ranking is kept.
- **Clip count.** About one clip per 5 minutes of source, at least 5 (or `MAX_CLIPS` if lower), at most
  `MAX_CLIPS` (default 10) and never more than 20.
- **Validation.** Segments are checked against transcript timestamps and the duration bounds for the
  chosen clip length before the engine renders them. If nothing usable comes back, Clipwright
  renders a fallback segment of `CLIP_DURATION` seconds.

## Costs

Clipwright adds no fees; you pay Anthropic and AssemblyAI directly at their current prices
([Anthropic pricing](https://www.anthropic.com/pricing)). What drives the Claude bill:

- **One analysis call per transcript window:** one call for videos up to 15 minutes, then roughly one
  more per additional 10 minutes, plus one rerank call for multi-window videos. Each call sends the
  window's transcript as input and can use up to 16000 output tokens (thinking included). Repairs
  and retries add calls.
- **Caching.** The transcript and the analysis for each clip length are cached in
  `processing_cache`, keyed by the source URL. Resuming a task, or generating again from the same
  YouTube video with the same clip length, makes no Claude call. YouTube word timings are kept on
  disk, so re-runs do not pay AssemblyAI again either.
- **No Claude calls** for restyle, the editor, preset exports or the connection test.
- The model matters most: Sonnet and Haiku cost less per token than Opus.

## Tests

```bash
cd web
npx -y pnpm@10 exec vitest run src/server/ai          # selection, prompts, grounding, retries, provider
npx -y pnpm@10 exec vitest run src/components/settings  # the settings UI
```

The AI tests drive the real `@anthropic-ai/sdk` request path against a fake `fetch`
(`src/server/ai/__fixtures__`), with golden outputs from the original Python code. They make no
paid calls.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `Invalid key` | Copy the whole key (it starts with `sk-ant-`). Check that it was not revoked in the Console. |
| `Permission denied` | The key's workspace cannot use the Models API; use a key from a workspace with API access. |
| `Model unavailable` | The key cannot use that model ID. Pick one from the list shown after a successful test. |
| `Rate limited`, or tasks fail with "The AI analysis service is temporarily unavailable after several attempts" | Your Anthropic rate limits were exceeded or the API is overloaded. Wait, or raise limits in the Console, then **Resume** the task. |
| "The AI analysis service took too long to respond" | The time budget ran out. Resume the task; consider a faster model for very long videos. |
| `Connection failed` | The server cannot reach `api.anthropic.com` (proxy, firewall, DNS). |
| "Add your Anthropic API key in Settings → AI before generating clips." | Save a key in Settings or set `ANTHROPIC_API_KEY`, then resume the task. |
| Task error "Processing failed: Transcript analysis failed: 400 ..." mentioning credit or billing | Add credits or billing in the Anthropic Console, then resume. |
| "Claude reached its output limit (16000 tokens) before returning any clips." | Try again, or choose a shorter clip length. |
| "Content filter triggered. Finish reason: 'refusal'" | Claude declined the transcript. With Opus 5 the server-side fallback normally prevents this; try again or another model. |
| Saved settings do not take effect | `web/.env.local` sets the same variable. Tick "Use these saved values instead of the server environment", or edit the file and restart. |
| The settings show the key but generations still say it is missing | `APP_SETTINGS_ENCRYPTION_KEY` or `BETTER_AUTH_SECRET` changed since the key was saved, so it cannot be decrypted. Save the key again. |

## Not included yet

- An in-app Claude assistant panel for suggesting titles or rewriting captions. A future version
  should run it server-side against task and transcript data and ask for explicit confirmation
  before changing a clip.
- Per-user API keys. The keys are instance-wide.
