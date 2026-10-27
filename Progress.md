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
  `GOOGLE_BASE_URL_OVERRIDE` to `env.ts` (the first three also to `.env.example` and the worker
  test-utils env-clearing list; the test-only override is in `env.ts` only);
  `MAX_ATTEMPTS.publish_youtube = 3` in `jobs.ts`.
- Added a `publish_youtube` placeholder (throws "not implemented") to `run-job.ts`'s `HANDLERS` and
  `FAILURE_HOOKS` so `Record<JobType, ...>` still type-checks; Task 8 replaces it.
- Tests: `npx vitest run` 641/648 passing (6 pre-existing timeouts/flakes in `fonts`, `cron` and
  `editor` tests under full-suite load on this box, unrelated to this change — all 4 files pass
  cleanly in isolation); `tsc --noEmit` 0 errors; `pnpm lint` clean.

### 2026-10-27 18:01 — Task 2: clip lineage
- Added `lineageOf(clip)` (`server/youtube/posts.ts`, its first export): `clip.lineageId ?? clip.id`.
- `clipDocFrom` now sets `lineageId: id` on every clip it builds, so `process_task`'s rendered and
  fallback clips, and `combine_editor`'s new clip (set directly, since it builds its `ClipDoc` by
  hand), all start with `lineageId === id`.
- `restyle_task` now maps each re-rendered clip's `lineageId` to `lineageOf(old)` before the
  `replaceClips` swap, so a restyled clip keeps posting under its original lineage instead of
  starting a new one.
- Tests (TDD): added failing assertions first in `process-task.test.ts`, `editor.test.ts` and a new
  `restyle-task.test.ts` case (seeded clips `{id:"a"}` and `{id:"b", lineageId:"L"}`; after restyle,
  `lineageId` is `["a","L"]` and the ids changed), confirmed RED, then implemented. `npx vitest run`
  648/649 passing (1 pre-existing slow-test skip); `tsc --noEmit` 0 errors; `pnpm lint` clean.

### 2026-10-27 18:14 — Task 3: Claude-written metadata
- Added `server/ai/youtube-metadata.ts`: `writeYoutubeMetadata` calls Claude via the existing
  `createClaudeClient`/`requestStructured`/`runWithRetry` (120s budget), with its own system/user
  prompt (kept out of the golden-tested `prompts.ts`) that treats the `{source_title, hook_title,
  transcript}` JSON as data, never instructions.
- `parseYoutubeMetadata` throws `OutputValidationError` (triggering a repair turn) for an empty or
  over-100-character title, or a description whose UTF-8 byte count (with its hashtags appended)
  exceeds 5000 — stripping `<`/`>` from every field first. `fitTags` clips tags to the 500-character
  total (commas plus 2 quote chars per multi-word tag), dropping from the end; hashtags are
  deduped case-insensitively, filtered to `[\p{L}\p{N}_]+`, and capped at 5. An unrecognizable
  `language` is dropped. `youtubeDescription` joins the description and `#hashtags` exactly as
  specified.
- Tests (TDD): wrote `youtube-metadata.test.ts` first (fake Anthropic fetch, same pattern as
  `claude-provider.test.ts`), confirmed RED (module did not exist), then implemented; all 12 passed
  on the first run. Covers the request shape, a repaired-then-successful retry, exhausting the
  retry budget, the angle-bracket/length title rule, a multibyte description that is under the
  5000-byte budget only when measured in bytes (not JS `.length`), `fitTags`, and hashtag dedup.
  `npx vitest run` 661/662 passing (1 pre-existing slow-test skip); `tsc --noEmit` 0 errors;
  `pnpm lint` clean.
