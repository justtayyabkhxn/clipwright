# Clipwright: work log and resume guide

Last updated: 2026-10-27. Phases 1 to 4 are done and verified. Next: Phase 5, a real run with the user's MongoDB Atlas URI and API keys.

**Goal:** rebrand the SupoClip + Claude fork as **Clipwright** and rebuild it on **Next.js + MongoDB**. It must run **locally on Windows without Docker** today and stay **deployable to Vercel** later. The existing Python video renderer is reused as a CLI "engine". Scope: the core clipping flow plus the full clip editor.

The authoritative spec is [`docs/port/DESIGN.md`](docs/port/DESIGN.md). Detailed maps of the original system are in `docs/port/map-*.md` (frontend, task-api, pipeline, ai, editor, data, runtime, critique).

---

## Decisions made (with the user)

| Topic | Decision |
|---|---|
| Name | **Clipwright**. The AGPL-3.0 license stays, with a "Based on SupoClip" credit and a source link |
| Hosting | Local now, Vercel-ready later (user's choice) |
| Database | **MongoDB Atlas free tier** (user's choice). Tests use `mongodb-memory-server` |
| Renderer | **Reuse the Python renderer** as `engine/` (user's choice) |
| Scope | Core flow plus the **clip editor** (user's choice). Billing, social, admin pages, API keys/MCP, B-roll, emails, analytics, i18n (English only), marketing pages, share links, legacy trim/split/merge endpoints and transitions are all dropped |
| LLM | Claude only (`claude-opus-5` default), via `@anthropic-ai/sdk` in TypeScript |
| Transcription | AssemblyAI only, inside the Python engine |
| YouTube | Plain yt-dlp with **Node as its JS runtime**. No proxy, Apify or Twitch/Kick |
| Keys | The first user to sign up becomes admin (also `ADMIN_EMAILS`). The admin saves the Anthropic and AssemblyAI keys and the model in Settings, encrypted in Mongo; env vars also work |
| Password reset | The reset link is logged to the server console (no email provider yet) |
| Progress | Polling every 2 s (SSE removed). Restyle runs as a background job |

---

## Repository layout (target)

```
web/       Next.js app: UI, API routes (src/app/api), server modules (src/server), worker (src/worker), fonts (web/fonts)
engine/    Python render engine (uv project, package clipwright_engine, CLI: python -X utf8 -m clipwright_engine <cmd>)
data/      git-ignored runtime data: storage/ (durable files) and work/ (job temp dirs)
docs/      user docs; docs/port/ holds the design spec and the maps of the original system
(backend/ is deleted; read the original with git show 1dbb178:backend/...)
```

---

## Done

### Before the rewrite (SupoClip + Claude), in baseline commit `1dbb178` on `master`
- Claude provider fixes (valid default model, JSON-schema structured output, connection test, masked keys, server-side refusal fallback for Opus 5).
- UI redesign (warm paper and terracotta tokens, Newsreader serif, sidebar with recent projects and provider indicator, AI provider settings).

### Branch `clipwright`
1. **`abfdf50` Restructure.**
   - `frontend/` → `web/`; `backend/fonts` → `web/fonts`.
   - Dependencies swapped: Prisma, PostHog and Stripe removed; mongodb, @anthropic-ai/sdk, busboy, tsx, concurrently and mongodb-memory-server added.
   - Design doc and maps written.
2. **`42a9502` Phase 1** (4 parallel builders, each reviewed and fixed):
   - **Foundation** `web/src/server/*`: env, db and indexes, Better Auth with `mongodbAdapter` (`MONGODB_TRANSACTIONS` switch), session, http (Range support), storage (LocalStorage, strict keys), settings (AES-GCM compatible with the Python format), jobs (lease, heartbeat, reaper, per-claim fencing), the task and draft repositories with serializers, the engine runner (NDJSON, cancel file, tree kill), fonts and caption templates. 147 tests.
   - **Engine** `engine/`: every CLI command in DESIGN §7, Windows fixes (no fcntl, symlinks or OS temp; filter scripts; cancel sweep), yt-dlp running on Node, and transcript formatting from a sidecar. **358 tests pass**, and a real YouTube fetch test passes. Imports take about 0.2 s (CLI) or 0.8 s (render stack).
   - **Claude AI port** `web/src/server/ai/*`: prompts byte-identical to the Python originals, windowing, grounding, rerank and retries. **236 tests pass**, plus a 20k-case differential fuzz against the Python code.
   - **Frontend**: dropped features removed, English only, Clipwright rebrand (SVG logo and wordmark), polling, AssemblyAI key field in Settings, restyle-safe cancel UI. 100 tests.
3. **Cross-stream fixes, also in `42a9502`:** `zod` and `server-only` added as direct dependencies; `web/.gitignore` now un-ignores `.env.example`; stale config cleaned up; the token-limit error reworded.

4. **`b8131fd` Phase 2.** Four parallel streams (each reviewed and fixed), followed by an integrator:
   - **tasks-api:** explicit route handlers for tasks, clips, uploads (streamed with busboy) and preset exports. YouTube URLs are host-checked and stored as canonical watch URLs; this closed an SSRF and shared-cache poisoning path. A cancelled or failed restyle rolls back its settings.
   - **editor-api:** editor routes, fonts, caption templates, `/api/ai/provider` (`llm_configured`, `transcription_configured`), admin settings and test-connection, preferences (unsaved fonts come back as `null`, plus a `saved` flag), and `/api/health`. The dropped server modules are deleted.
   - **worker:** `web/src/worker` with the main loop, the 6 job handlers, failure hooks, and a cron (export expiry, old job docs, work dirs, unreferenced YouTube sources and uploads).
   - **ui-followups:** per-key "missing" status, saved caption defaults applied on the home page, and a worker-offline notice.
   - **integrator:** fixed the MongoDB client after a failed first connect, removed the orphaned S3 multipart client path, deleted the leftover generated Prisma client, Dockerfile and `auth-origins`.
   - **Verified:** `tsc` 0 errors; lint clean; **640 vitest tests passed on two runs**; `next build` OK with no DB; slow real-engine integration test (`CLIPWRIGHT_SLOW_TESTS=1`) passed; the worker smoke test against an in-memory replica set passed.
   - Afterwards I added `@next/env` as a direct dependency and deleted the stray `web/src/tsconfig.json`.

---

## Phases 3 and 4: done (2026-10-27, commit "Clipwright phases 3-4")

- **Docs:** `README.md`, `CLAUDE.md`, `AGENTS.md`, `CONTRIBUTING.md`, a fresh `CHANGELOG.md`, and a new `NOTICE.md` crediting SupoClip under AGPL-3.0.
  - New `docs/`: setup, configuration, architecture, claude-integration, testing, troubleshooting, deploying-to-vercel.
  - `docs/port/DESIGN.md` updated with every Phase 2 contract addition plus the env vars it was missing.
- **Settings interop test:** now uses a fixed ciphertext produced by the original Python `encrypt_setting_value`, so it no longer skips.
- **Full-stack E2E:** `web/e2e/full-flow.spec.ts` with fakes in `web/e2e/fakes/` (Anthropic Messages and Models, AssemblyAI) and `global-setup.ts`.
  - The setup starts an in-memory MongoDB replica set, the fakes, a synthetic 45 s video, `next dev` and the real worker plus engine.
  - The test covers: sign up → save keys and Test connection → upload → generate → 2 clips → play and download → preset export → editor edit, autosave and reload → server export → library → delete clip → delete task.
  - It passed twice in a row (about 8 minutes each). Old SupoClip specs deleted.
  - New optional env var `ASSEMBLYAI_BASE_URL` (regional endpoint, or a fake in tests), passed to the engine.
- **Whole-system review (read-only):** 3 confirmed defects, all fixed with regression tests:
  1. Concurrent first sign-ups could all become admin. Now a one-time `meta.admin_bootstrap` upsert picks a single winner.
  2. The preset-export route read the body with no size limit. It now uses `readLimitedText` (8 MiB, else 413).
  3. A failed task never showed its reason. The error screen now shows `progress_message`.
  The review judged the core sound. Fencing task writes by `run.jobId` alone is acceptable at `WORKER_CONCURRENCY=1` with a single worker process.
- **Stream bug found by the E2E:** `next dev` logged an uncaught "Controller is already closed" when a browser cancelled a video Range request. Cause: `Readable.toWeb` keeps pushing data after the browser has cancelled the stream. Fix: a pull-based `pullStream` in `server/http.ts`, with tests. In the E2E rerun the error no longer appears.
- **Verified:** `tsc` 0 errors; lint clean; vitest 645 passed and 1 skipped (the slow opt-in test); `next build` OK; engine pytest 360 passed and 1 skipped (network, opt-in).

---

## Left to do

### Phase 5: real end-to-end run (needs the user's credentials)
- [x] `web/.env.local` created (git-ignored): `MONGODB_URI` for the user Atlas cluster `cluster0.u0eg3eq` (DB user `tayyabk2002_db_user`), a generated `BETTER_AUTH_SECRET`; the user added `ANTHROPIC_API_KEY`, `ASSEMBLY_AI_API_KEY` and `CLAUDE_MODEL=claude-opus-5` themselves. 2026-10-27: Atlas connection OK (replica set, MongoDB 8.0, read/write), both keys verified with free checks (Anthropic Models API: connected, claude-opus-5 available; AssemblyAI transcript list: HTTP 200). `pnpm dev` runs: `/api/health` reports ok, db true, worker online; collections and indexes created; sign-in page loads.
- [x] 2026-10-27: the first real generation (a 119-minute YouTube video) failed at the AssemblyAI upload. **Root cause:** the blank `ASSEMBLYAI_BASE_URL=` line from `.env.example` reaches the engine as `""`. The AssemblyAI SDK reads `ASSEMBLYAI_*` env vars, so its default base URL became empty and httpx raised `UnsupportedProtocol`. Fixed in `4bb7d90`: the engine falls back to a fixed `https://api.assemblyai.com`. `e014f22` added 5 upload retries plus logging of the real error, which is what exposed the cause (that commit first blamed a network outage, which was wrong).
- [ ] Sign up at http://localhost:3000 (the first user becomes admin). The keys already come from `.env.local`, so Settings shows them as set by the environment.
- [ ] Generate from a short YouTube video and from an uploaded file. Check progress, clips and scores; then the editor (edit, autosave), exports (server and browser) and downloads.
- [ ] Record the results in `docs/testing.md`. Fix what breaks.

### Known follow-ups and limitations
- **Storage:** the driver is local only. Vercel needs a Blob/R2 driver plus direct-to-storage uploads. The client does NOT support those yet: `lib/video-upload.ts` always POSTs to `/api/upload`. See `docs/deploying-to-vercel.md`.
- **Worker:** it must run on an always-on machine; it cannot run on Vercel.
- **Assistant panel:** the optional in-app Claude assistant panel is not built.
- **Claim fencing:** task writes are fenced by `run.jobId`, not by the claim token. That only matters with more than one worker process.
- **Emoji captions:** need a colour emoji font that libass can use ("Noto Color Emoji"). Otherwise they are off; see troubleshooting.
- **Source link:** `NEXT_PUBLIC_SOURCE_CODE_URL` defaults to the upstream SupoClip repo. Set it to your own repository before deploying (AGPL-3.0 §13).
- **yt-dlp:** 2026.10.26 is available (the lock has 2026.10.21). Update with `cd engine && uv lock --upgrade-package yt-dlp && uv sync` if YouTube downloads fail.

---

## How to resume

1. **Check state:**
   `git -c safe.directory=C:/other-projects/supoclip log --oneline` (the branch is `clipwright`).
   - **Why the flag:** the folder is owned by another Windows account ("Tayyab Khan"), so every git command needs `-c safe.directory=...`. The global git config was intentionally left unchanged.
   - **Repo-local identity:** user.name `nakul`, user.email `nakul.volume@gmail.com`.
2. **Next step:** Phase 5 (above). Everything before it is committed.
3. **Install dependencies:**
   - `cd web && npx -y pnpm@10 install`
   - `cd engine && uv sync`
4. **Verify:**
   - `cd web && npx -y pnpm@10 exec tsc --noEmit -p . && npx -y pnpm@10 run lint && npx -y pnpm@10 exec vitest run`
   - `cd engine && .venv/Scripts/python.exe -X utf8 -m pytest -q`
   - Build: `export SWC_NATIVE_BINDING_CACHE='C:\swc-cache-claude'` first, then `npx -y pnpm@10 run build`.

### Machine quirks (this PC)
- **pnpm** is not on PATH. Use `npx -y pnpm@10 ...` (the project pins pnpm 10.27.0).
- **python on PATH** is the Microsoft Store stub. Use `engine/.venv/Scripts/python.exe` (uv-managed 3.11).
- **SWC native binding:** directory ACLs block SWC's default cache, so `next build` fails with "Failed to load native binding". Fix: set `SWC_NATIVE_BINDING_CACHE=C:\swc-cache-claude`. That folder already exists with the right ACLs.
- **ffmpeg** 8.0.1 essentials is installed at `C:\ffmpeg\bin` (includes libass and libx264).
- **No MongoDB, Redis or Docker** installed locally. Use Atlas for real runs and the memory server for tests.
