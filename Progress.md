# Progress: YouTube Shorts auto-post

Feature: Claude writes each clip's YouTube title, description, tags and hashtags, and Clipwright
uploads every clip of a finished video to the user's channel as a public Short.

- Design: [docs/superpowers/specs/2026-10-27-youtube-autopost-design.md](docs/superpowers/specs/2026-10-27-youtube-autopost-design.md), approved 2026-10-27.
- Plan: [docs/superpowers/plans/2026-10-27-youtube-autopost.md](docs/superpowers/plans/2026-10-27-youtube-autopost.md).
- Times are IST (UTC+05:30), taken from the clock or from git commit times. Earlier steps without a recorded time show a range.

## Log

### 2026-10-27 (between 14:40 and 17:04) — Brainstorming
- User decisions: fully automatic, every clip right away, public, the user's own videos, metadata
  only from Claude (nothing fixed added).
- One question back from the builder check, answered by the user: re-running the same video posts
  its clips again.

### 2026-10-27 17:04 — Design written and committed (`d5e2be6`)
- Research: SupoClip's original YouTube code, the Clipwright integration points, and Google's
  current API rules (100 uploads a day per project; the forced-private lock is unresolved).
- 22 "our calls" are listed in §7 of the design.

### 2026-10-27 17:12 — Started the implementation plan
- Mapped the interfaces the plan builds on: the job queue (`server/jobs.ts`), the handler registry
  and failure hooks (`worker/run-job.ts`), `requestStructured` / `runWithRetry`
  (`server/ai/client.ts`), the task repository (`replaceClips`, `appendClip`, `removeClip`,
  `deleteTaskCompletely`), indexes (`server/db.ts`), the cron steps (`worker/cron.ts`) and the
  completion CAS in `worker/handlers/process-task.ts`.

### 2026-10-27 17:17 — Implementation plan written
- [docs/superpowers/plans/2026-10-27-youtube-autopost.md](docs/superpowers/plans/2026-10-27-youtube-autopost.md): 14 tasks, from the data model to the docs, each with failing tests first.
- Review Focus (inputs no task would otherwise exercise):
  - a lost upload response
  - multibyte metadata limits
  - bad tags
  - midnight Pacific at DST changes
  - a refused scope or an account with no channel
- Execution: subagent-driven. Each task gets an implementer and an independent reviewer, then the whole branch is reviewed.

### 2026-10-27 17:41 — Task 1: data model, config and job type
- Added `YoutubeAccountDoc`, `OAuthStateDoc`, `YoutubePostDoc`/`YoutubePostState`/`YoutubeWaitReason`
  (§4.2), `ClipDoc.lineageId`, `TaskDoc.autopost` and the `publish_youtube` `JobType` to
  `server/types.ts`; the three new `collections()` entries and their indexes (unique `lineageId`,
  `taskId`/`userId`/`{state,notBefore}` on `youtube_posts`, a TTL on `oauth_states.expiresAt`, a
  partial index on `tasks.autopost`) to `server/db.ts`.
- Added `GOOGLE_OAUTH_CLIENT_ID`/`SECRET`, `CLAUDE_METADATA_MODEL` (default `claude-sonnet-5`) and
  `GOOGLE_BASE_URL_OVERRIDE` to `env.ts`, `.env.example` and the worker test-utils env-clearing list;
  `MAX_ATTEMPTS.publish_youtube = 3` in `jobs.ts`.
- Added a `publish_youtube` placeholder (throws "not implemented") to `run-job.ts`'s `HANDLERS` and
  `FAILURE_HOOKS` so `Record<JobType, ...>` still type-checks; Task 8 replaces it.
- Tests: `npx vitest run` 641/648 passing (6 pre-existing timeouts/flakes in `fonts`, `cron` and
  `editor` tests under full-suite load on this box, unrelated to this change — all 4 files pass
  cleanly in isolation); `tsc --noEmit` 0 errors; `pnpm lint` clean.
