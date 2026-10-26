# Clipwright: work log and resume guide

Last updated: 2026-10-26. **PAUSED by the user during Phase 3/4.** Phase 2 is complete and verified; see "PAUSED" below.

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
docs/port/ design and maps
(backend/ deleted in the WIP checkpoint; read the original with git show 1dbb178:backend/...)
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

## PAUSED (user stopped work on 2026-10-26, during Phase 3/4)

**State when paused**
- Workflow `wf_5ffbb665-4a6` was paused right after it started. 6 agents had begun (docs-cleanup, e2e, and 4 of the 5 reviewers); **none finished**, so the workflow has no cached results.
- The only work that reached the files came from the docs-cleanup agent, and it is saved in the **WIP checkpoint commit** (see the git log, "WIP (paused)"):
  - **Deleted** (`git rm`): `backend/` (entire old FastAPI backend), `mcp/`, `observability/`, `docker-compose.yml`, `init.sql`, `start.sh`, `install_cron.sh`, the root `.env.example`, `.dockerignore`, `DEPLOY_NOTES.md`, `IMPLEMENTATION_PLAN.md`, `QUICKSTART.md`, `assets/banner.jpg`, and all of the old `docs/*.md`, `docs/images` and `docs/screenshots`. `docs/` now holds only `docs/port/`.
  - **Rewritten:** `Makefile` (targets setup, dev, worker, test, test-web, test-engine, check, build) and `.gitignore` (tidied).
- **Not done yet:**
  - `README.md`, `CLAUDE.md`, `AGENTS.md`, `CONTRIBUTING.md` and `CHANGELOG.md` still describe the **old SupoClip and Docker system**. They are stale until rewritten.
  - None of the new docs exist yet.
  - `NOTICE.md` has not been written.
  - DESIGN.md has not been updated with the Phase 2 contract additions.
  - The E2E suite, the 5-lens review and its fixes have not run.
- `docs/claude.md` was deleted along with the old docs. Its content is still in git: `git show b8131fd:docs/claude.md`. Use it for the new `docs/claude-integration.md`.
- The checks were not re-run after the partial cleanup. Only files outside `web/` and `engine/` changed, so the Phase 2 results still apply.
- One test is now skipped instead of run: the Python↔Node settings-interop test in `web/src/server/settings.test.ts` (`skipIf` when `backend/.venv` or `backend/src` is missing). Either drop it, or turn it into a fixture-based test that uses a value encrypted once by the Python code (from `git show 1dbb178:backend/src/runtime_settings.py`).

**How to resume Phase 3/4**
- **Same session:** `resumeFromRunId` gives no benefit, because no agent finished; just re-run the script. `Workflow({scriptPath: "C:\Users\wefor\.claude\projects\C--other-projects-supoclip\4ac2f41d-0bf2-456a-819d-126608c4e66c\workflows\scripts\clipwright-phase3-4-wf_5ffbb665-4a6.js"})`. The docs agent handles files that are already deleted.
- **New session:** the script file above can be re-run directly. Or ask Claude to "continue Clipwright Phase 3/4 from work.md"; the checklist below is the source of truth.

---

## Left to do

### Phase 3: cleanup and docs
- [x] Deleted `backend/`, `mcp/`, `observability/`, `docker-compose.yml`, `init.sql`, `start.sh`, `install_cron.sh`, Docker files, `assets/banner.jpg`, `DEPLOY_NOTES.md`, `IMPLEMENTATION_PLAN.md`, `QUICKSTART.md`, the root `.env.example`, and the old docs (WIP checkpoint).
- [ ] Delete or rewrite the old e2e specs in `web/e2e/` that target dropped features (`app`, `editor-studio`, `generation-status`, `library-groups`, `local-workflow` specs plus `global-setup.ts`), and reset `CHANGELOG.md`.
- [ ] Rewrite `README.md`, `CONTRIBUTING.md`, `AGENTS.md` and `CLAUDE.md` for Clipwright: prerequisites, setup, commands, architecture. `QUICKSTART.md` is deleted; the README covers it. Add `NOTICE.md` crediting SupoClip under AGPL-3.0.
- [x] `docs/claude.md` deleted (it collided with `CLAUDE.md` on Windows). [ ] Write `docs/claude-integration.md` from `git show b8131fd:docs/claude.md`, updated for Clipwright.
- [ ] New docs:
  - `docs/setup.md`: Windows/macOS/Linux setup with no Docker. Node 22, `npx pnpm@10` or corepack, `uv`, ffmpeg (a gyan.dev **full** build so libass is included), and an Atlas URI.
  - `docs/configuration.md`: env vars.
  - `docs/architecture.md`
  - `docs/testing.md`
  - `docs/troubleshooting.md`: yt-dlp failures, worker offline, key errors, the Windows SWC cache issue, and Store `python` stub on PATH.
  - A Vercel deployment notes section: what is still needed (Blob/R2 storage driver, direct uploads, the worker on an always-on machine).
- [x] Root `Makefile` rewritten: setup, dev, worker, test, test-web, test-engine, check, build (WIP checkpoint; not yet run end to end).
- [ ] Optional: bundle Noto Color Emoji or document the emoji fallback (caption emojis are disabled on Windows when no colour emoji font is found).

### Phase 4: whole-system adversarial review
- [ ] Run a review workflow with several lenses: correctness against the original, security (authz, path traversal, secrets), concurrency/CAS/jobs, Windows process handling, frontend contract parity, and the Vercel-readiness claims. Verify each finding, fix it, re-run all suites.

### Phase 5: real end-to-end run (needs the user's credentials)
- [ ] The user provides a `MONGODB_URI` (Atlas M0) in `web/.env.local` and sets `BETTER_AUTH_SECRET` (32+ characters).
- [ ] `pnpm dev`, then sign up (the first user becomes admin), then Settings → AI: paste the Anthropic and AssemblyAI keys, click Test connection, pick a model, save.
- [ ] Create a generation from a short YouTube video and from an uploaded file. Watch the progress, check the clips and scores, open the editor, make an edit (autosave), export (server and browser), and download.
- [ ] Record the results in `docs/testing.md`. Fix what breaks.

### Known follow-ups / limitations
- The storage driver is local only. Vercel needs a Blob/R2 driver plus direct-to-storage uploads (the client already supports the S3-style multipart flow).
- The worker must run on an always-on machine; it cannot run on Vercel.
- The optional in-app Claude assistant panel is not built.
- The task CAS helpers are fenced by `run.jobId`, not by the claim token. There is at most a 15 s window where a stale handler could push a clip after losing its lease.

---

## How to resume

1. **Check state:**
   `git -c safe.directory=C:/other-projects/supoclip log --oneline` (the branch is `clipwright`).
   - **Why the flag:** the folder is owned by another Windows account ("Tayyab Khan"), so every git command needs `-c safe.directory=...`. The global git config was intentionally left unchanged.
   - **Repo-local identity:** user.name `nakul`, user.email `nakul.volume@gmail.com`.
2. **If Phase 2 was interrupted:** re-run it with
   `Workflow({scriptPath: "C:\Users\wefor\.claude\projects\C--other-projects-supoclip-web-src\4ac2f41d-0bf2-456a-819d-126608c4e66c\workflows\scripts\clipwright-phase2-wf_b73b729a-195.js", resumeFromRunId: "wf_b73b729a-195"})`.
   Completed agents replay from the cache. That only works in the same session; in a new session, inspect the working tree and the remaining checklist instead.
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
