# Configuration

Clipwright reads its configuration from `web/.env.local`. Both processes load it: Next.js does so
itself, and the worker uses `@next/env` (`loadEnvConfig`) before any server module reads
`process.env`. Start from the template:

```bash
cp web/.env.example web/.env.local
```

The server variables are parsed by [`web/src/server/env.ts`](../web/src/server/env.ts) with zod
on first use. Rules that apply to all of them:

- Values are trimmed, and a **blank value counts as unset** (so `CLAUDE_MODEL=` means "use the
  default").
- Boolean flags accept `1/true/yes/on` and `0/false/no/off` (any case). Anything else falls back to
  the default.
- Integer limits are coerced from strings and must be at least the stated minimum, otherwise the
  first request (or the worker) fails with `Invalid environment configuration: ...`.

## Required

| Variable | Default | Meaning |
|---|---|---|
| `MONGODB_URI` | none, required | MongoDB connection string. Atlas (a replica set) is recommended; see [setup](setup.md#3-mongodb-atlas-m0). |
| `BETTER_AUTH_SECRET` | none, required (at least 32 characters) | Signs sessions. Also the encryption secret for keys saved in Settings when `APP_SETTINGS_ENCRYPTION_KEY` is unset. Generate one with `openssl rand -base64 48` or `node -e "console.log(require('crypto').randomBytes(48).toString('base64'))"`. |

## Database and auth

| Variable | Default | Meaning |
|---|---|---|
| `MONGODB_DB` | `clipwright` | Database name. |
| `MONGODB_TRANSACTIONS` | `true` | Better Auth wraps sign-up and similar multi-step writes in transactions, which need a replica set (Atlas is one). Set `false` for a standalone local `mongod`. Clipwright's own writes never need transactions. |
| `BETTER_AUTH_URL` | `http://localhost:3000` | Public base URL of the app. Always trusted as an auth origin. |
| `BETTER_AUTH_TRUSTED_ORIGINS` | empty | Extra comma-separated origins allowed to call the auth API. `http://localhost:3000` and `http://127.0.0.1:3000` are always trusted. |
| `ADMIN_EMAILS` | empty | Comma-separated emails (case-insensitive) that become admins at sign-up. The **first account ever created** is an admin regardless. |
| `DISABLE_SIGN_UP` | `false` | `true` stops new sign-ups. |
| `APP_SETTINGS_ENCRYPTION_KEY` | falls back to `BETTER_AUTH_SECRET` | Secret for keys saved in Settings (at least 16 characters). AES-256-GCM with key = sha256(secret), stored as `v1:<nonce>:<tag>:<ciphertext>` (base64url). Changing it makes saved keys unreadable; save them again in Settings. |

## AI and transcription

These can be set here, or saved by an admin under **Settings → AI and transcription**. A value set
here wins, unless the admin ticks **Use these saved values instead of the server environment**. The
worker reads them at the start of every job, so a change applies to the next job without a restart.

| Variable | Default | Meaning |
|---|---|---|
| `ANTHROPIC_API_KEY` | none | Anthropic API key for clip selection. A generation fails with "Add your Anthropic API key in Settings → AI before generating clips." when neither this nor a saved key exists. |
| `ASSEMBLY_AI_API_KEY` | none | AssemblyAI key for transcription. Same rule as above. |
| `CLAUDE_MODEL` | `claude-opus-5` | Claude model ID, without any `anthropic:` prefix. See [Claude integration](claude-integration.md#choosing-a-model). |
| `CLAUDE_RERANK_MODEL` | the value of `CLAUDE_MODEL` | Model for the long-video rerank pass. Env only (not in Settings). |
| `TRANSCRIPTION_LANGUAGE` | empty (auto-detect) | Spoken language code passed to AssemblyAI, such as `es`, `de` or `en_us`. Lowercased, `-` becomes `_`; `auto` means detect. |
| `ASSEMBLY_AI_HTTP_TIMEOUT_SECONDS` | `900` (min 1) | How long the engine waits for an AssemblyAI transcript. |
| `ASSEMBLYAI_BASE_URL` | unset (the AssemblyAI SDK default) | AssemblyAI API host, for example `https://api.eu.assemblyai.com` for the EU region. Must be a URL. The end-to-end tests point it at a fake server. |
| `ANTHROPIC_BASE_URL` | unset (`https://api.anthropic.com`) | Not parsed by `env.ts`; the Anthropic SDK reads it from the environment itself. Useful for a proxy or, in the end-to-end tests, a fake server. |

## Storage and the render engine

| Variable | Default | Meaning |
|---|---|---|
| `DATA_DIR` | `<repo>/data` | Root for `storage/` (durable files) and `work/` (per-job temp dirs). A relative path is resolved against the repo root. Keep it short and ASCII on Windows. `storage/` and `work/` must be on the same volume (files are moved with `rename`). |
| `STORAGE_DRIVER` | `local` | Only `local` is implemented. Any other value is rejected. See [deploying to Vercel](deploying-to-vercel.md). |
| `ENGINE_DIR` | `<repo>/engine` | The Python render engine. Relative paths resolve against the repo root. |
| `ENGINE_PYTHON` | `engine/.venv/Scripts/python.exe` on Windows, `engine/.venv/bin/python` elsewhere | Interpreter that runs the engine. A value containing a slash is a path (relative to the repo root); a bare name is looked up on `PATH`. Never point it at the Microsoft Store `python` stub. |
| `WORKER_CONCURRENCY` | `1` (min 1) | Jobs the worker runs at once. Each job runs ffmpeg, so raise it only on a machine with spare cores. |

## Limits and processing

| Variable | Default | Meaning |
|---|---|---|
| `MAX_VIDEO_DURATION` | `5400` (min 1) | Longest source video, in seconds. Longer videos fail with "Video is too long (N min)...". |
| `MAX_VIDEO_UPLOAD_BYTES` | `4000000000` (min 1) | Largest upload. Bigger uploads get HTTP 413. |
| `MAX_CLIPS` | `10` (min 1) | Most clips per video. The final count also scales with length, about one clip per 5 minutes. |
| `CLIP_DURATION` | `30` (positive number) | Fallback clip length in seconds when the AI returns no usable segment. |
| `SPEAKER_FRAMING` | `true` | Cut between speakers on multi-person wide shots, using diarization. |
| `HOOK_FIRST_TEASER` | `false` | Replay a later punchline as a teaser at the start of each clip. |
| `YOUTUBE_MAX_HEIGHT` | `1080` (min 144) | Highest YouTube download resolution. |

## YouTube auto-post

Unset `GOOGLE_OAUTH_CLIENT_ID` / `GOOGLE_OAUTH_CLIENT_SECRET` turns the whole feature off (no
Connect button in Settings). See [docs/youtube.md](youtube.md) for the one-time Google Cloud setup
and how auto-post behaves.

| Variable | Default | Meaning |
|---|---|---|
| `GOOGLE_OAUTH_CLIENT_ID` | none | OAuth client id from the Google Cloud project, env only (not settable in Settings). |
| `GOOGLE_OAUTH_CLIENT_SECRET` | none | Its client secret. Never logged or returned by any API response. |
| `CLAUDE_METADATA_MODEL` | `claude-haiku-4-5` | Claude model that writes each clip's title, description, tags and hashtags before upload. |
| `GOOGLE_BASE_URL_OVERRIDE` | unset (Google's real hosts) | **Test-only.** Replaces the origin of every Google endpoint (OAuth, Data API, resumable upload) with this base URL. Used by the vitest and Playwright fakes; never set it in a real `.env.local`. |

## Browser-side variables

`NEXT_PUBLIC_*` variables are inlined into the client bundle at build time (`next build`, or the
dev server start), so restart or rebuild after changing them. They are not parsed by `env.ts`.

| Variable | Default | Meaning |
|---|---|---|
| `NEXT_PUBLIC_MAX_VIDEO_UPLOAD_BYTES` | 4 GB | Upload limit the browser checks before sending a file. Keep it equal to `MAX_VIDEO_UPLOAD_BYTES`. |
| `NEXT_PUBLIC_SOURCE_CODE_URL` | `https://github.com/justtayyabkhxn/clipwright` | Target of the "Source" link in the sidebar and on the sign-in pages. **If you deploy a modified Clipwright, AGPL-3.0 requires you to offer its source to your users: set this to your fork.** |
| `NEXT_PUBLIC_APP_URL` | `http://localhost:3000` | Public origin used for page metadata (`metadataBase`). |

## Test-only variables

| Variable | Meaning |
|---|---|
| `CLIPWRIGHT_SLOW_TESTS=1` | Enables the vitest test that runs the real Python engine (`src/worker/integration.slow.test.ts`). |
| `CLIPWRIGHT_NETWORK_TESTS=1` | Enables the engine test that fetches a real YouTube video (`engine/tests/test_network.py`). |

See [testing](testing.md) for the commands.
