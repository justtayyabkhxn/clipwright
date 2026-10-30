# CLAUDE.md

Guidance for Claude Code (and other coding agents) working in this repository.

## Project overview

Clipwright turns long videos (YouTube URLs or uploads) into short 9:16 clips: AssemblyAI transcribes,
Claude picks and scores segments, a Python engine renders them with face-aware crops and burned
captions, and a clip editor refines them. It is a re-platform of an earlier Python app (AGPL-3.0, see NOTICE.md):
one Next.js app plus a Node worker, MongoDB as the only database, and the original Python renderer
reused as a CLI. It runs locally on Windows, macOS and Linux without Docker and is meant to move to
Vercel later (see `docs/deploying-to-vercel.md`).

**`docs/port/DESIGN.md` is the authoritative spec** (env, storage keys, collections, jobs, engine
CLI, API routes). Keep it in sync when you change a contract. The original
code is in git history at commit `29dc44b` (`git show 29dc44b:backend/src/...`). `work.md` is the progress log.

## Layout

```
web/                 Next.js 15 app, package "clipwright"
  src/app/           pages and API route handlers (src/app/api/**/route.ts)
  src/server/        server modules shared by routes and the worker: env, db, auth, session, http,
                     storage, settings, jobs, tasks, drafts, engine, fonts, caption-templates, ai/,
                     youtube/
  src/server/ai/     Claude clip selection (TypeScript port of the original ai.py), YouTube metadata
  src/server/youtube/  YouTube auto-post: accounts (OAuth, tokens), google (API calls), posts
  src/worker/        worker entry (main.ts), run-job, cron, handlers/ (one per job type)
  src/components, src/hooks, src/lib   client code (shadcn/Radix UI, Tailwind v4)
  messages/en/       UI copy (next-intl, English only)
  fonts/             bundled caption fonts
  e2e/               Playwright tests and fake Claude/AssemblyAI servers
engine/              Python 3.11 render engine (uv), package clipwright_engine, tests/
data/                git-ignored runtime data: storage/ and work/
docs/                user docs; docs/port/ holds the design spec and maps
```

## Commands

pnpm may not be on PATH; `npx -y pnpm@10 <args>` always works (the repo pins pnpm 10.27.0).

```bash
# web/
npx -y pnpm@10 install
npx -y pnpm@10 dev                    # Next on :3000 + worker (tsx watch)
npx -y pnpm@10 run dev:web            # Next only
npx -y pnpm@10 run worker             # worker only
npx -y pnpm@10 exec vitest run        # unit/integration tests (in-memory MongoDB)
npx -y pnpm@10 exec vitest run src/server/settings.test.ts   # one file
CLIPWRIGHT_SLOW_TESTS=1 npx -y pnpm@10 exec vitest run src/worker/integration.slow.test.ts
npx -y pnpm@10 exec tsc --noEmit -p .
npx -y pnpm@10 run lint               # eslint, --max-warnings 0
npx -y pnpm@10 exec playwright test   # e2e (fake AI servers, in-memory MongoDB)
npx -y pnpm@10 run build

# engine/
uv sync
uv run python -X utf8 -m pytest -q
echo '<json request>' | uv run python -X utf8 -m clipwright_engine <command>
```

The root `Makefile` wraps these (`setup dev worker test test-web test-engine check build`).
Before finishing a change, run tsc, lint and the relevant vitest/pytest files.

## Architecture in one paragraph

Route handlers (`runtime = "nodejs"`, `dynamic = "force-dynamic"`) authenticate with Better Auth,
read/write MongoDB and storage, and enqueue jobs; they never run Python or ffmpeg. The worker claims
jobs from the `jobs` collection (60 s lease, 15 s heartbeat, reaper, failure hooks), runs the
handler, and calls the engine as a subprocess per step (`runEngine` in `src/server/engine.ts`: JSON on
stdin, NDJSON events on stdout, cancel file, tree kill). Claude is called from the worker in
TypeScript (`src/server/ai`). The browser polls every 2 s. Files go through the `Storage` interface
(`LocalStorage` under `DATA_DIR/storage`).

## Key contracts (details in DESIGN.md)

- **Jobs:** `process_task`, `restyle_task`, `prepare_editor`, `export_editor`, `combine_editor`,
  `export_clip`, `publish_youtube`. Job ids are 32 lowercase hex. `activeKey` (`task:{id}`,
  `prepare:{clipId}`, `youtube:{postId}`) and `liveKey` are unique partial indexes; E11000 means
  "already queued or running".
- **YouTube auto-post** (`docs/youtube.md`, DESIGN.md §2/§5/§6/§9): `youtube_accounts` (one connected
  channel per user), `oauth_states` (TTL-indexed, single-use) and `youtube_posts` (one post per
  clip lineage, unique on `lineageId`) hold its state. Off unless `GOOGLE_OAUTH_CLIENT_ID` and
  `GOOGLE_OAUTH_CLIENT_SECRET` are set.
- **Task run:** `task.run = {jobId, type}` is set when a run starts; the worker's CAS writes are
  fenced by `run.jobId`. Task JSON exposes `run_type` while the task is active.
- **Restyle cancel/failure** returns the task to `completed` with the old clips and rolls the
  settings back from the job's `payload.previousSettings`.
- **Enqueue responses** include `worker_online` (heartbeat under 30 s old).
- **Progress messages** ("Downloading video...", "Creating clip i/N...", "Complete!" ...) are a UI
  contract; keep them exact.
- **YouTube URLs** are host-checked and stored as `https://www.youtube.com/watch?v={id}`; uploads are
  `upload://{uuid}{ext}` and map to `uploads/{uuid}{ext}`.
- **Settings:** `ANTHROPIC_API_KEY`, `ASSEMBLY_AI_API_KEY`, `CLAUDE_MODEL` from env or `app_settings`
  (AES-256-GCM, `v1:` format, byte-compatible with the original Python). Env wins unless the admin set
  `preferAdminValue`. `/api/ai/provider` returns `llm_configured` and `transcription_configured`.
- **API shapes** match the original app's so the client barely changed; errors are `{detail}`.
- **The engine** never touches MongoDB, never calls an LLM, and gets keys only in its request.

## Conventions

- Server modules the worker imports must **not** import `server-only` or `next/*` (the worker runs
  under `tsx`, outside Next). Keep client code from importing `src/server`.
- No multi-document transactions in app code: every multi-step write is a single-document atomic
  update or compare-and-set (`casStatus`, `pushClip`, `replaceClips`, draft revision CAS).
- Wrap route handlers in `handle()` and throw `ApiError(status, detail)` for expected errors.
- Read configuration only through `env` / `paths` from `src/server/env.ts`; add new variables there,
  to `web/.env.example` and to `docs/configuration.md`.
- Validate storage keys (no `..`, backslashes or leading `/`); never build paths from user input.
- The AI prompts in `src/server/ai/prompts.ts` are byte-identical to the Python originals and covered
  by golden tests; change them deliberately and update the fixtures.
- `web/src/lib/caption-templates.json` is generated from `engine/clipwright_engine/caption_templates.py`;
  an engine test asserts they match.
- Tests: vitest with `mongodb-memory-server`, fake `runEngine`, fake Anthropic `fetch`; no paid calls.
- UI copy goes in `messages/en/*.json`. Product name is **Clipwright**; the upstream project is
  named only in NOTICE.md.
- Deliberate shortcuts are marked with a `ponytail:` comment naming the limit and the upgrade path.
- Never create `docs/claude.md`: on Windows it collides with `CLAUDE.md`.

## Machine quirks (Windows dev box)

- If git reports "dubious ownership", use `git -c safe.directory='*' ...` (the folder may be owned
  by another Windows account). Do not change the global git config.
- `pnpm` is not on PATH: use `npx -y pnpm@10`.
- `python` on PATH is the Microsoft Store stub. Use `engine/.venv/Scripts/python.exe` or `uv run`.
  For one-off scripts that need extra packages: `uv run --no-project --with <pkg> python ...`.
- `next build` fails with "Failed to load native binding" unless
  `SWC_NATIVE_BINDING_CACHE='C:\swc-cache-claude'` is exported (that folder has working ACLs).
- ffmpeg 8 (gyan.dev essentials, with libass and libx264) is in `C:\ffmpeg\bin`.
- No local MongoDB, Redis or Docker. Tests use the in-memory server; real runs use Atlas.
- GNU make is not installed; run the underlying commands.
