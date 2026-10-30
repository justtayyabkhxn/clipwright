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
- Research: the original app's YouTube code, the Clipwright integration points, and Google's
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

### 2026-10-28 13:05 — Task 7: Connection routes
- Added the four route handlers: `POST /api/youtube/connect` (session + config required, returns
  `authorize_url` with both scopes, `access_type=offline`, `prompt=consent`,
  `include_granted_scopes=true`, PKCE `code_challenge`/`S256`, and the state from
  `createOAuthState`; 409 `{code: "not_configured"}` when the OAuth env vars are unset);
  `GET /api/youtube/callback` (`getSessionUser`, not `requireUser`: consumes the state, exchanges
  the code, checks both scopes, looks up the channel, upserts the account, then either
  `cancelPostsForUser` on a channel change or `unblockAfterReconnect`, and redirects to
  `/settings?youtube=connected` or `?youtube_error=<denied|expired|missing_scope|no_channel|
  exchange_failed>` — Google's own error text is never echoed); `GET/PATCH/DELETE
  /api/youtube/account` (GET hides tokens; PATCH validates `auto_post`/`privacy`/`made_for_kids`
  and cancels queued/blocked posts when auto-post turns off; DELETE disconnects then cancels);
  `POST /api/youtube/account/resume`. Added `google.ts#callbackRedirectUri()` so the literal
  redirect URI has one source for both routes.
- Judgment calls: a Google `?error=` of any value maps to `youtube_error=denied` (the fixed code
  set has no generic/unknown bucket); a channel change cancels *all* the user's not-yet-uploaded
  posts via `cancelPostsForUser` (not filtered to the old `channelId`, per the task brief's ledger
  ruling, since that function cancels by `userId` only and a failed post must not be retried onto
  the new channel); PATCH/DELETE 404 when no account is connected only matters for PATCH (DELETE's
  `disconnectAccount` and `cancelPostsForUser` are both no-ops on an absent account).
- Tests (TDD): `youtube-routes.test.ts` written first (real Better Auth sessions, msw for Google),
  RED confirmed (`Cannot find module './connect/route'`), then GREEN on the first implementation
  pass, 17/17. Covers the exact authorize-URL params, the 409 config error, a successful connect,
  missing-scope and no-channel rejections (no account stored), a reused state and a foreign
  (other-user) state both redirecting `expired`, never echoing `error_description`, a channel
  change cancelling an old post with the exact message, a same-channel reconnect unblocking a
  `reconnect`-waiting post but not a `private_lock` one, GET hiding tokens, PATCH cancelling queued
  posts on auto-post-off and rejecting an invalid `privacy`, DELETE cancelling queued+blocked posts,
  and resume requeuing a `private_lock` post and enqueueing its job (plus 404 with no account).
- Full `npx vitest run --maxWorkers=2`: 741 passed / 1 skipped, output pristine; `tsc --noEmit` 0
  errors; `pnpm lint` clean.
- 2026-10-28 13:16 review fix round 1: DELETE now cancels posts before the best-effort revoke
  (`disconnectAccount` returns a revoke thunk instead of awaiting it internally), and the callback
  logs the sanitized Google error on exchange/channel-lookup failure instead of swallowing it.
- 2026-10-28 13:35 review fix round 2: channel-change cancel now spares the new channel's own posts
  (`cancelPostsForUser`'s new `exceptChannelId`), the callback redirects `not_configured` up front
  and catches any other unexpected error as `exchange_failed` (logged, never thrown to a 500),
  `BETTER_AUTH_URL`'s trailing slash is stripped in both the redirect URI and the callback's
  redirect, PATCH 404s off `updateAccountPrefs`'s own null return, resume's response includes
  `worker_online`, and the test gaps (no session, `MissingRefreshTokenError`, auto-post-off on a
  blocked post, GET unconfigured, trailing slash) are covered.

### 2026-10-28 14:06 — Task 8: publish_youtube handler and the trigger
- `worker/handlers/publish-youtube.ts`: claim, then the §4.5 checks (account missing or needing a
  reconnect → blocked `reconnect`; private lock or paused → blocked `private_lock`; another channel
  or auto-post off → cancelled; restyle running → +2 min; lineage gone → cancelled; file missing →
  failed), Claude metadata stored before any upload, then query a saved session → spend one insert
  call → start → one streamed PUT, with 5 tries per job 1/2/4/8 s apart and one token refresh on a
  401. Errors follow the §4.5 table (quota holds every queued post to midnight Pacific + 5 min,
  channel limit 6 h, transient 1/5/15 min then failed, invalid metadata re-asks Claude once), stored
  as our words plus the reason code. The failure hook re-queues the post in 2 min or fails it.
- `process-task.ts` sets `autopost: "pending"` in the completion CAS for any account with auto-post
  on, then runs `createPostsForTask` in a try/catch. `posts.ts` gained `takeInsertCall` (CAS on the
  claim and `insertCalls < insertCap`), `setPhase` and `cancelClaimedPost`; `accounts.ts` gained the
  fenced `markReauthRequired`. The two cancel messages now live in `posts.ts`.
- Tests (TDD): 27 handler tests (the brief's 14 plus account states, both 401 paths, a stale
  session, the failure hook, and no secret in any log line), 3 trigger tests, 3 repository tests;
  RED first, then GREEN. Full `npx vitest run --maxWorkers=2`: 785 passed / 1 skipped; `tsc --noEmit`
  and `pnpm lint` clean.
- 2026-10-28 14:27 review fix round 1: the in-job 1/2/4/8 s loop now covers only a live session (query
  and PUT: network, 5xx, 308), so a failed session start (rate limit, 429, 5xx, network) spends one
  insert call and goes to the 1/5/15 min table; the 401 refresh applies only to the start and its
  token is reused for the job; a session-URI 401 fails the post (no reconnect); non-Google errors
  (e.g. MongoDB in `markUploaded`) fail the job so the hook re-queues it and the kept session
  recovers the video. 13 new tests; full `npx vitest run`: 798 passed / 1 skipped.

### 2026-10-28 14:47 — Task 9: Cron steps
- `worker/cron.ts` gained three steps, wired into `runCron`: `dispatchDuePosts(now)` enqueues every
  `queued` post whose `notBefore` has passed or is absent (via `posts.ts`'s now-exported
  `enqueueQueued`, so the activeKey dedup stays in one place); `resumePendingAutopost(now)` re-runs
  `createPostsForTask` for a task still `autopost:"pending"` more than 2 min after its last update,
  one task's error logged and skipped rather than stopping the rest; `verifyUploads(now, fetchImpl?)`
  re-reads each `uploaded` post 10 min–48 h old with no `verifiedAt`, grouped per user (one user's
  network/5xx/reauth failure never stops another's), skips posts whose `channelId` no longer matches
  the account, sets `verifiedAt` once `uploadStatus` is processed/rejected/failed/deleted (deleted =
  absent from `videos.list`), warns "YouTube made this video private" and trips `tripPrivateLock` on
  a privacy other than the post's own, or stores the rejection reason.
- Tests (TDD): 4 new cases in `cron.test.ts` — dispatch skips not-yet-due and already-working posts,
  resume leaves a freshly-pending task alone, verification records a forced-private video and blocks
  the user's other queued post, verification never calls out for a previous channel's post. RED
  first (missing exports / duplicate lineageId), then GREEN.
- Full `npx vitest run --maxWorkers=2`: 802 passed / 1 skipped, output pristine; `tsc --noEmit` and
  `pnpm lint` clean.
- 2026-10-28 14:59 review fix round 1: `verifyUploads` now trips the private lock only when the newly
  fetched `privacyStatus` differs from the post's own previously stored value, and trips before the
  post's `updateOne` so a failed trip leaves the post unwritten for a retry; a video already known to
  be locked no longer re-blocks the posts "Resume posting" just released. 1 new test; full
  `npx vitest run --maxWorkers=2`: 803 passed / 1 skipped.
- 2026-10-28 15:14 review fix round 2: `post.warning` now stores the `private_lock` code (imported
  from `posts.ts`, the sentence constant deleted) instead of an English sentence; `enqueueQueued`
  counts only jobs it actually created, not posts whose job already existed; `byUser` in
  `verifyUploads` now pushes onto its existing array instead of copying it per post; added 6 tests
  for the untested §4.6 branches (deleted/non-final/rejection-reason/window bounds/one user's fetch
  failure). Full `npx vitest run --maxWorkers=2`: 809 passed / 1 skipped.

### 2026-10-28 15:39 — Task 10: Task routes and interactions
- New `GET /api/tasks/[id]/youtube` (serialized posts, owner-only) and
  `POST /api/tasks/[id]/youtube/[postId]/retry` ("Try again", `worker_online`, 409 for an uploaded
  post), both built on the already-committed `serializePosts`/`retryPost`.
- Clip delete and task delete now cancel the clip's (or task's) YouTube post(s) first and 409 with
  "This clip is uploading to YouTube. Try again in a minute." while one is `working` (§4.7); the
  edit-lock check still runs first, so a delete that was going to be refused anyway never cancels a
  post as a side effect. Task delete then deletes its posts. Restyle 409s with "A clip from this
  task is uploading to YouTube. Try again in a minute." while any of the task's posts is `working`
  (our call on the wording — §4.7 didn't fix it).
- Added `posts.ts`'s `hasWorkingPost` and the two message constants; no change to the already-tested
  `cancelPostForLineage`/`cancelPostsForTask`/`retryPost`.
- Tests (TDD): 6 cases in new `src/app/api/tasks/youtube.test.ts` (GET owner-only, retry + 409,
  clip-delete cancel + 409, task-delete cancel/delete + 409, restyle 409); RED first (missing route
  modules), then GREEN. Full `npx vitest run --maxWorkers=2`: 815 passed / 1 skipped, output
  pristine; `tsc --noEmit` and `pnpm lint` clean.
- 2026-10-28 15:55 controller follow-up: retry is scoped to the URL's task (`retryPost` takes an optional `taskId`; a post of another task gets 404, test added, RED then GREEN); `ponytail:` notes on the delete routes' check-then-cancel window. `src/app/api/tasks` + `src/server/youtube` 124/124; tsc and lint clean.

### 2026-10-28 16:14 — Task 11: Settings UI
- New `YoutubeSettings` (`web/src/components/settings/youtube-settings.tsx`), added as a
  `<Section id="youtube">` on the settings page after the AI section, shown to every user. Not
  configured: a setup hint naming `GOOGLE_OAUTH_CLIENT_ID`/`GOOGLE_OAUTH_CLIENT_SECRET` and linking
  `docs/youtube.md`. Not connected: a Connect button that posts to `/api/youtube/connect` and
  navigates to `authorize_url`. Connected: channel avatar/title/handle, the auto-post switch,
  visibility and made-for-kids selects (autosaving via `PATCH /api/youtube/account`), a
  reauth-required banner with Reconnect, a private-lock banner with "Resume posting"
  (`POST /api/youtube/account/resume`), Disconnect behind an `AlertDialog` confirm, and links to the
  YouTube ToS, Google's Privacy Policy and `myaccount.google.com/permissions`. `?youtube_error=...`
  codes map to our own copy with a generic fallback for an unrecognized code; the raw query value is
  never rendered. Copy added to `messages/en/settings.json`.
- The doc link uses `${NEXT_PUBLIC_SOURCE_CODE_URL}/blob/main/docs/youtube.md` — the only existing
  convention for linking into the repo, assuming a GitHub-style `/blob/main/` path (noted as a
  concern: a fork on another host or branch would need a different link).
- Updated `settings/page.test.tsx`'s `next/navigation` mock to add `useSearchParams` (the new
  section now calls it), since the existing mock didn't provide one.
- Tests (TDD): 12 cases in new `youtube-settings.test.tsx` (setup hint, Connect + navigate, connected
  view, reconnect + private-lock banners together, 6 known `youtube_error` codes, the unknown-code
  fallback never echoing the raw value, Disconnect's confirm). RED first (missing module), then
  GREEN. Full `npx vitest run --maxWorkers=2`: 828 passed / 1 skipped, output pristine; `tsc --noEmit`
  and `pnpm lint` clean.

### 2026-10-28 16:41 — Task 12: Task page UI
- `ClipTile` now shows a per-clip status chip (design §4.8): "Waiting to post", "Writing title…",
  "Uploading…", a "Posted" link (`target="_blank"`, to `video_url`), "Private on YouTube" (+ "YouTube
  made this video private" and a link to the setup doc, reusing Task 11's exported `SETUP_DOC_URL`),
  "Waiting for YouTube's daily limit (until <local time>)" for `wait_reason: "quota"`, and "Failed" +
  the post's own `error` text + a "Try again" button. Also mapped `channel_limit`/`retry`/`restyle`
  (queued) and `reconnect`/`private_lock` (blocked, linking to `/settings#youtube`) wait reasons, and
  an uploaded post's non-`private_lock` `warning` code (a known-code map plus a generic fallback
  naming the code). `ClipFocus` shows the written title, description, hashtags and tags read-only.
  "Try again" calls `POST …/youtube/[postId]/retry` directly, or — when `insert_cap_reached` —
  confirms first with "If this clip is already on your channel, don't retry; it would post twice."
  The clip-delete and task-delete confirm dialogs now say the delete never removes videos already on
  YouTube (§4.7).
- The task page polls `GET /api/tasks/[id]/youtube` once on mount, again when the task completes, and
  every 4 s on its own `setInterval` while any post is `queued` or `working`, stopping once none are
  (and on unmount) — independent of the task's own poll, which stops at completion.
- Tests (TDD): 4 new cases in `src/app/tasks/[id]/page.test.tsx` — the 7-state chip matrix, the
  insert-cap-reached retry confirm, the focus view's metadata, and the 4 s poll starting/stopping
  (via `vi.useFakeTimers()` + `advanceTimersByTimeAsync`, following `use-task-progress.test.tsx`'s
  pattern). RED first (no `post` prop / no chip rendered), then GREEN.
- Full `npx vitest run --maxWorkers=2`: 832 passed / 1 skipped, output pristine (one pre-existing
  expected stderr log from an unrelated restyle test); `tsc --noEmit` and `pnpm lint` clean.
- Concerns: wait-reason/warning-code copy beyond the brief's literal examples (`channel_limit`,
  `retry`, `restyle`, the generic warning-code line) is my own wording, not spec text. The "Private on
  YouTube" chip links to the setup doc itself (no `#audit` anchor) since `docs/youtube.md` doesn't
  exist in the repo yet; once it's written, point the link at its audit section.
- 2026-10-28 17:01 review fix round 1: dropped the `SETUP_DOC_URL` link (it 404'd against upstream's
  repo) for inline `docs/youtube.md` text in Settings and a `/settings#youtube` link on the task
  page's private-lock chip; added tests for the `blocked` chip (reconnect/private_lock) and the
  generic unknown-warning-code line.
- 2026-10-28 17:56 review fix round 2: `GET /api/tasks/[id]/youtube` now also returns
  `autopost_pending` (from `task.autopost === "pending"`); the task page's 4 s poll runs while that
  flag is true or any post is queued/working, so a fetch that lands before `createPostsForTask`'s
  insert (seeing an empty `posts` array) keeps polling instead of going silent until a reload.

### 2026-10-28 17:30 — Task 13: End-to-end with a fake Google
- New `web/e2e/fakes/google.ts` behind `GOOGLE_BASE_URL_OVERRIDE`: consent screen (instant 302 back
  with a code), PKCE-checked token exchange and refresh, revoke, `channels.list`, the resumable
  `videos.insert` session (initiate, PUT, status query) and `videos.list`. It records each
  initiation's query and JSON body, served at `GET /__fake/initiations` for the spec.
- The fake Anthropic also answers the metadata request (on `claude-sonnet-5` only) with
  `fakeYoutubeMetadata(hook_title)`; `fakes/http.ts` handlers can now set response headers.
- `full-flow.spec.ts`: Settings → Connect YouTube → connected with the fake channel; after the 2
  clips render, both tiles show "Posted" (in about 1 s; budget 3 min), the posts API leaks no session
  URI or token, and exactly 2 initiations carry public / not-for-kids / category 22 / Claude's
  metadata, with `notifySubscribers` true for the first clip only. No cron knob needed: posts are
  dispatched when the task completes.
- Playwright passed twice in a row (6.4 min, 6.1 min). Full `npx vitest run`: 835 passed / 1
  skipped; `tsc --noEmit`, `pnpm lint` and eslint on `e2e/` clean.

### 2026-10-28 18:33 — Task 14: Documentation and final verification
- New `docs/youtube.md`: §6's Google Cloud setup steps verbatim, how auto-post behaves (trigger,
  metadata, upload, quota, failures/retries, stopping, what's not included), a dedicated section on
  the forced-private lock and how to request YouTube's API compliance audit, troubleshooting tables
  for both the `youtube_error` codes and the task-page chips, and the Settings reference.
- Documented the 4 env vars (`GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`,
  `CLAUDE_METADATA_MODEL`, `GOOGLE_BASE_URL_OVERRIDE` as test-only) in `docs/configuration.md` and
  `web/.env.example`; added `GOOGLE_BASE_URL_OVERRIDE` next to the other `GOOGLE_*` vars in
  `web/src/worker/test-utils.ts`'s env-clearing list (it was missing).
- Added the `publish_youtube` job and the three collections (`youtube_accounts`, `oauth_states`,
  `youtube_posts`) to every place the repo already lists jobs/collections: `CLAUDE.md`'s "Key
  contracts", `docs/port/DESIGN.md` (§0 product-decisions table — reverses the "social dropped"
  row; §2 env vars; §5 new collections subsection plus `TaskDoc.autopost` and `ClipDoc.lineageId`;
  §6 `publish_youtube` handler, failure hook, cron steps; §9 the 6 new routes), and
  `docs/architecture.md` (job types table, data model table, a short flow paragraph).
  `AGENTS.md` has no "Key contracts" list of its own (it only points at CLAUDE.md), so nothing to
  add there.
- `web/src/worker/README.md` (job table row, cron bullets), `README.md` (feature line, doc table
  row), `docs/testing.md` (manual-checklist step 8: connect YouTube, watch a clip post, confirm
  Public in Studio).
- Verification (all from `web/`, after this task's doc-only changes): `tsc --noEmit` 0 errors;
  `pnpm lint` clean; full `npx vitest run` hit mongod-memory-server startup timeouts under load in
  3 files (pre-existing machine-load flakiness, not these changes) — rerun with `--maxWorkers=2`:
  837 passed / 1 skipped, 67/68 files, output pristine; `next build` (with
  `SWC_NATIVE_BINDING_CACHE`) succeeded; `playwright test` (with the same env var, needed for its
  own `next` subprocess) passed 1/1 in 9.0 min, including "youtube: both clips posted with Claude's
  metadata"; engine `pytest`: 362 passed, 1 skipped, unchanged.
- Left to the user: the Google Cloud project setup (docs/youtube.md §1) and the first live-upload
  check against a real channel (docs/youtube.md step 9 / docs/testing.md step 8) — both need a real
  Google account and are not something this environment can do.
- 2026-10-28 18:52 review fix round 1: fixed 3 of the 4 "DESIGN.md §4" YouTube cross-references
  (CLAUDE.md, docs/architecture.md, docs/youtube.md) to §2/§5/§6/§9; the 4th cited location
  (DESIGN.md:363) has no such self-reference, so it was left unchanged (see fix report).

### 2026-10-28 18:56 — Paused before the final whole-branch review (stopped by the user)
- Done and reviewed: Tasks 1–14. Last full verification (Task 14): tsc 0 errors, lint clean,
  vitest 837 passed / 1 skipped, `next build` OK, Playwright passed, engine pytest 362 passed / 1 skipped.
- The final review was launched and then stopped before any reviewer finished; nothing was changed.
- Next: re-run the final review over `review-8300730..04cb93d.diff`, one fix wave plus a re-review,
  then finish the branch. Details and the decisions taken are in `work.md`.

### 2026-10-29 11:30 — Final review fix wave (backend B1–B13, UI, docs D1–D9)
- Final whole-branch review: 33 findings, 27 confirmed (1 Critical, 2 Important, 24 Minor), 6
  refuted. One fix wave from base `6fe272f`.
- Backend (`fad4609..a1120a6`, 8 commits): a session saved for an older render is queried before
  any new `videos.insert` (closes a lost-response-then-restyle duplicate); `uploadLimitExceeded`
  holds every queued post of the channel, and a start refused for quota or the channel limit gives
  its insert call back (ruling dup-2b); a cron step releases `working` posts whose job is gone; a
  post whose account was disconnected mid-run is cancelled, not blocked; a refused clip delete puts
  its post back; a clip combined after the run completed never gets a post; Resume posting drops
  stale waits; verification skips reconnect-required accounts and clears a warning that no longer
  holds; a refused OAuth client is worded as server setup; the title may not contain links,
  hashtags or line breaks; no empty hashtag line; `YoutubeAccountDoc.lastError` deleted.
- UI (`6db3afb`): task-page chips "Not posted" (+ reason), "Flagged by YouTube", "Removed from
  YouTube"; the stored reason under retry waits and blocked posts; the posts route serializes
  `upload_status`; Resume posting warns when the worker is offline; the Settings description no
  longer promises a public Short.
- Docs: `docs/port/DESIGN.md` (account doc, failure hook, `publish_youtube` steps 2–4, the cron's
  YouTube steps in order, the delete/PATCH/resume/posts/retry route rows), `docs/youtube.md` (§2
  private-lock copy and status, §3 duplicate wording, channel-limit hold, disconnect cancel, title
  rule; troubleshooting rows for every chip), `CLAUDE.md` layout (`src/server/youtube/`),
  `web/src/worker/README.md` cron bullets, and the design spec, each change marked "(amended after
  the final review)".
- Verification: see the backend report (`final-fix-backend.md`: full vitest 857 passed / 1
  skipped); the docs commit ran tsc and lint.
- 2026-10-29 12:07 re-review fix round (F1–F7, all Minor): a cancel without a reason (clip or task
  delete) drops the old error, so a refused task delete no longer shows a stale retry/failure as
  the "Not posted" reason, and a refused clip delete puts the error back; the channel-change reason
  is "A different channel was connected." (no doubled "Not posted"); Resume posting on a
  reconnect-required account drops pre-lock errors and waits; a rejected or failed upload on a
  private-locked project shows "Flagged by YouTube" with the private-lock line; the worker and the
  chip share the RECONNECT/PAUSED sentences (`web/src/lib/youtube-blocked.ts`); the guide and spec
  say "Removed from YouTube" only catches deletions before verification finished; three stale
  cancel comments fixed.

### 2026-10-29 14:25 — YouTube overview page (branch `youtube-posts-page`, from `b1ab65d`)
- Asked for by the user: one page showing every clip's posting status, instead of only the chip on
  each task page.
- API (`36d1538`): `GET /api/youtube/posts` returns the user's newest 200 posts, newest first, with
  `truncated` when older ones exist. Each item is the task route's post plus `task_id`,
  `task_title`, `clip_title`, `created_at` and `uploaded_at`. It runs one projected query for the
  tasks (`listPostsForUser` in `server/youtube/posts.ts`). The `youtube_posts {userId:1}` index is
  now `{userId:1, createdAt:-1}`.
- Refactor (`3761082`): `YoutubeStatusChip` and the task page's Try again logic (cap confirm,
  retry route, worker-offline toast) moved to `components/app/youtube-status-chip.tsx`
  (`useYoutubeRetry`). The task page behaves as before.
- Page (`9d56225`): `/youtube` shows:
  - the channel (link, status, auto-post, private-lock warning, Settings link);
  - Posted/Waiting/Uploading/Failed counts, plus Not posted when any exist;
  - the posts grouped by task, each with its chip, "Next try …" for a queued post that has a wait,
    and "Uploaded …" for a posted one.
  It polls every 4 s while a post is working, every 30 s while one is queued, and stops
  otherwise. Its copy is in the new `youtube` message namespace. Nav (`223d2fd`): sidebar, tab bar
  and palette, between Library and Settings.
- Docs: `docs/port/DESIGN.md` (route row, index, §10 bullet) and `docs/youtube.md` §3 ("Seeing
  every post").
- Verification (from `web/`): `tsc --noEmit` 0 errors; `pnpm lint` clean; focused vitest (11
  files: the new page, the task page, shell, YouTube and task YouTube routes, posts, db, i18n,
  settings) 130 passed; full `vitest run --maxWorkers=2` 877 passed / 1 skipped (68 files + 1
  skipped).

### 2026-10-29 14:45 — YouTube overview page review fixes (branch `youtube-posts-page`)
- Startup drops the old `youtube_posts {userId:1}` index (`createIndex` never removes it), so a
  database from the `youtube-autopost` branch ends up with only `{userId:1, createdAt:-1}`. Codes
  26/27 (fresh database, already dropped) are ignored.
- `GET /api/youtube/posts` leaves out posts cancelled without a reason (a clip delete), so they no
  longer take slots in the 200 cap; the page's own filter is gone.
- `/youtube` polls every 4 s while a post is working or queued and due (a Try again, the next clip
  of a batch), every 30 s while a post waits or auto-post is on (so a finishing generation's posts
  appear without a reload), and stops otherwise.
- With no channel connected the page keeps the Settings card and still lists the history
  (uploaded links, cancellation reasons). Signed out, it shows a sign-in prompt instead of a 401
  error page.
- A quota-held post no longer repeats its time as "Next try …" under the chip.
- The chip's Try again button is named "Retrying…" while its spinner shows (task page too).
- Tests first (RED then GREEN): db (old index dropped, restart without it), posts route (hidden
  posts take no cap slot), page (sign-in, disconnected history, quota line, Retrying name, poll
  cadence).
