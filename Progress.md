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

### 2026-10-27 18:48 — Task 4: Google HTTP client
- Added `server/youtube/google.ts` (plain `fetch`, every call takes an injectable `fetchImpl`):
  OAuth code exchange/refresh/revoke, `channels.list?mine=true`, `videos.list?part=status` in
  batches of 50, and the resumable upload (session start, `bytes */size` status query, one streamed
  `PUT` with `duplex:"half"` and `Content-Range` on resume). `GOOGLE_BASE_URL_OVERRIDE` replaces
  every Google origin.
- `GoogleApiError` carries only the operation, status and reason code (`error.errors[0].reason`, or
  the token endpoint's `error`); JSON parse errors are wrapped so V8 never quotes a body.
  `classify` implements the §4.5 table (401 maps to `reauth`; callers refresh once first).
  `nextMidnightPacific` uses `Intl` with `America/Los_Angeles`.
- Tests (TDD): `google.test.ts` written first, RED (module missing), then 10/10 passing; full suite 670/671 (1 slow-test skip). Also checked
  against a local HTTP server with real Node `fetch` (308 without `Location`, explicit
  `Content-Length` on a streamed body). `tsc --noEmit` 0 errors; `pnpm lint` clean.
- 2026-10-28 11:25 review fix round 1: `classify` now treats a 308 on the upload PUT as `transient`
  (resume instead of fail) and a token-endpoint 401 (e.g. `invalid_client`) as `permanent` rather
  than `reauth`, via a new `GoogleApiError.tokenEndpoint` flag set only by `tokenRequest`/`revokeToken`;
  `listVideoStatus` drops the unsupported `maxResults` alongside `id`; added tests for all of these
  plus `fetchMyChannel` (both branches), `refreshAccessToken`, `revokeToken` and the `invalidJson`
  secret-wrapping path (18/18 passing).

### 2026-10-27 19:01 — Paused (stopped by the user; resume tomorrow)
- Done and reviewed: Tasks 1–4 (data model, clip lineage, Claude-written metadata, Google client).
- In progress: four fixes to the Google client that review turned up (a 308 "resume incomplete" response must
  retry rather than fail; a bad client secret must not force reconnects; drop an unsupported
  `maxResults`; tests for the secret-free error and the no-channel case). The partial edit is stashed,
  nothing half-done is committed.
- Next: redo those fixes, then Task 5 (accounts, tokens and OAuth state), then Tasks 6–14.

### 2026-10-28 11:49 — Task 5: Accounts, tokens and OAuth state
- Added `server/youtube/accounts.ts`: single-use, user-bound PKCE OAuth state (`createOAuthState`/
  `consumeOAuthState`, 10 min TTL, `findOneAndDelete`); the account repository
  (`getAccount`/`saveConnectedAccount`/`updateAccountPrefs`/`disconnectAccount`/`setAccountStatus`),
  tokens always stored via `encryptSetting`; `getAccessToken` (refreshes within 5 min of expiry,
  persists the new token, sets `reauth_required` on `invalid_grant`); `serializeAccount` (never
  tokens; a `setup_hint` when the OAuth env vars are unset).
- `deleteAllUserData` (`tasks.ts`) now also disconnects the YouTube account (delete-then-
  best-effort-revoke, same as `disconnectAccount`) and deletes the user's posts and OAuth states.
- Tests (TDD): `accounts.test.ts` written first; RED confirmed by moving `accounts.ts` aside
  (`Cannot find module ./youtube/accounts`), then restored and GREEN, 15/15 passing. Covers
  single-use/user-bound/expiring state, encrypted-at-rest tokens never present in
  `JSON.stringify(serializeAccount(...))`, keeping the old refresh token when Google omits it,
  `channelChanged` on a different channel, the 5-minute refresh window (and not refreshing early),
  `invalid_grant` -> `reauth_required`, and `deleteAllUserData` removing the account/posts/states
  (an msw handler on the revoke endpoint keeps the best-effort revoke from logging a warning).
- `npx vitest run --maxWorkers=2` 641/694 in one pass (3 suites hit the documented
  MongoMemoryServer-under-load hook timeout, unrelated to this change); re-run alone,
  `drafts.test.ts` + `accounts.test.ts` + `restyle-task.test.ts` all pass, 52/52. `tsc --noEmit` 0
  errors; `pnpm lint` clean.
- Concern: `setAccountStatus`'s `warning` parameter is a tri-state (omitted keeps it, `null` clears
  it, a string replaces it) so the private-lock circuit breaker's warning survives an unrelated
  status change (e.g. a later `reauth_required`); the brief's signature did not say which, so this is
  a judgment call for the route tasks (6+) to follow.
- 2026-10-28 12:09 review fix round 1: `saveConnectedAccount` now unsets a missing handle/thumbnail
  and keeps the §4.6 private-lock pause through a reconnect (one aggregation-pipeline update, still
  no read-then-write); `getAccessToken`'s two writes are fenced on the caller's own refresh-token
  snapshot so a stale snapshot can never clobber a reconnected account; a refresh-token-less
  first connect now throws `MissingRefreshTokenError` instead of inserting a broken doc; plus the
  test-coverage gaps the review found (refresh token assertion, revoke call/order/failure cases,
  refresh request body, another user's data surviving `deleteAllUserData`). 29 tests now (was 15).

### 2026-10-28 12:32 — Task 6: Post repository
- Extended `server/youtube/posts.ts` with the post repository: `createPostsForTask` (only for a task
  still `autopost: "pending"`; one post per non-fallback clip, `insertMany` unordered ignoring
  E11000 on `lineageId`, snapshots privacy/made-for-kids/channel, notifies only the first clip,
  `blocked` with `private_lock` whenever the account carries that warning, else `reconnect` unless
  active; enqueues the queued posts in clip order, then sets `autopost: "done"`), the claim CAS
  (`queued`+due → `working`, or re-claim by the same job id), claim-fenced defer/block/fail,
  `markUploaded` (trips the breaker on a privacy other than requested), session/metadata writes,
  the three cancels, `unblockAfterReconnect`, `tripPrivateLock`/`resumePosting` (the lock survives
  reconnects; a `reauth_required` account keeps its status), `deferAllQueuedForQuota` (never
  shortens a longer wait), `retryPost` and `serializePosts`.
- Judgment calls: retry sets `insertCap = max(insertCap, insertCalls + 1)` (never lowers the cap);
  a `retry` deferral spends one automatic attempt; the serializer adds `id` and `wait_reason` to the
  §4.8 fields (the retry route and the quota chip need them).
- Tests (TDD): `posts.test.ts` written first, RED 17/17 (`… is not a function`), then GREEN 17/17,
  including a 20-round claim/cancel race (both outcomes observed) and the reauth_required +
  private_lock combination. Full `npx vitest run` 715 passed / 1 skipped; `tsc --noEmit` clean;
  `pnpm lint` clean.
- 2026-10-28 12:44 review fix round 1: `createPostsForTask` now rethrows a bulk error with no write
  errors (network/write-concern) instead of marking the task done; `unblockAfterReconnect` keeps
  posts blocked (re-labelled `private_lock`) while the account still has the lock; defer/block/cancel
  drop a stale `errorReason`; `markUploaded` trips the breaker only when its write matched; retry
  docstring matches `max(insertCap, insertCalls + 1)`; tests for block/fail/session/metadata and
  both markUploaded no-trip cases. posts tests 26/26 (6 RED before the fix); full suite 724 passed /
  1 skipped; tsc and lint clean.
