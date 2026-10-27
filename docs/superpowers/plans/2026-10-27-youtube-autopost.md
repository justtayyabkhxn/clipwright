# YouTube Shorts Auto-Post Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every clip from a completed generation is uploaded to the user's connected YouTube channel as a public Short. Claude writes the title, description, tags and hashtags.

**Architecture:** Short route handlers do the Google OAuth connection and read state. A new `publish_youtube` worker job, one per clip, writes metadata with Claude and uploads with YouTube's resumable protocol. Durable post state lives in a `youtube_posts` collection keyed by a per-clip `lineageId`, so a clip can never become two videos. The worker cron dispatches due posts, catches missed triggers and verifies uploaded videos.

**Tech Stack:**
- Next.js 15 route handlers and the existing Node worker (tsx).
- MongoDB driver 7.
- `@anthropic-ai/sdk` through `server/ai/client.ts`.
- Plain `fetch` for Google (no `googleapis` dependency).
- zod 4, vitest + mongodb-memory-server + msw, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-27-youtube-autopost-design.md`. Read it before any task. Section numbers below (§x.y) refer to it.

## Global Constraints

- Every git command: `git -c safe.directory=C:/other-projects/supoclip ...`.
- pnpm: `npx -y pnpm@10 ...` in `web/`.
- After each task, add a timestamped entry to `Progress.md` at the repo root, in the existing format (`### YYYY-MM-DD HH:MM — <what>`, time from `date '+%Y-%m-%d %H:%M'`).
- Route handlers only do short OAuth and DB work. Claude calls, uploads and verification run in the worker.
- Worker-imported modules never import `next/*`, `server-only` or `server/session.ts`. In the worker, use `job.userId`.
- Writes are single-document atomic updates or CAS. No transactions.
- Use plain `fetch`. Add no new dependency.
- Google quota: `videos.insert` allows **100 calls/day per project**, reset at **midnight Pacific** (`America/Los_Angeles`).
- Metadata limits (§3):
  - Title: 1–100 characters. No `<` or `>` anywhere.
  - Description plus `"\n\n#a #b"`: ≤ 5000 **UTF-8 bytes**.
  - Tags: ≤ 500 characters total, counting the commas between tags and 2 quote characters for any tag containing a space.
  - Hashtags: match `[\p{L}\p{N}_]+`, deduped, at most 5. Claude is asked for 3–5 hashtags and 5–15 tags.
- Upload body (§4.5):
  - `snippet {title, description, tags, categoryId:"22", defaultLanguage, defaultAudioLanguage}`
  - `status {privacyStatus, selfDeclaredMadeForKids, containsSyntheticMedia:false}`
  - query `notifySubscribers`
  - Never send `#Shorts`, links, a signature or fallback text.
- Duplicate guards: `lineageId` is unique on `youtube_posts`. `insertCalls` is incremented **before** each session initiation, and the cap is 3 (raised by 1 per manual retry). A saved `sessionUri` is queried before any new initiation.
- Secrets: tokens and `sessionUri` are never in API JSON, logs or error text. Tokens are stored with `encryptSetting` (`server/settings.ts`).
- The metadata model is `env.CLAUDE_METADATA_MODEL` (default `claude-sonnet-5`). The Anthropic key comes from `getRuntimeSettings().anthropicApiKey`.
- UI copy goes in `web/messages/en/*.json`. The product name is Clipwright.

## Review Focus

1. **Lost upload response.** Google finished the upload but the response never arrived; a worker restart re-runs the job. Expected: the session status query returns 200/201, the video is recorded, and nothing is inserted again. *(Task 8 test `recovers a completed upload from the saved session without a second insert`.)*
2. **Non-Latin transcripts** (Hindi, Japanese, emoji-heavy). Expected: the description is trimmed by UTF-8 **bytes**, not characters, and hashtags keep Unicode letters. *(Task 3 test `enforces the description byte limit with multibyte text`.)*
3. **Tags containing commas or `< >`, or one huge tag.** Expected: `<` and `>` are stripped, commas inside a tag split it or the tag is dropped, and the 500-character rule holds. *(Task 3 test `cleans tags that YouTube would reject`.)*
4. **The daily quota running out near a DST change.** Expected: the wait ends at the next real midnight in Los Angeles + 5 min. *(Task 4 test `nextMidnightPacific handles both DST transitions`.)*
5. **The user unticks a scope on Google's consent screen**, or picks an account with no channel. Expected: no account is saved, and Settings shows a clear reason. *(Task 7 tests `rejects a callback that is missing a scope` and `reports an account without a channel`.)*

---

## File Structure

| File | Responsibility |
|---|---|
| `web/src/server/types.ts` (modify) | `YoutubeAccountDoc`, `OAuthStateDoc`, `YoutubePostDoc`, `ClipDoc.lineageId`, `TaskDoc.autopost`, the `publish_youtube` JobType |
| `web/src/server/db.ts` (modify) | Collections `youtubeAccounts`, `oauthStates`, `youtubePosts` and their indexes |
| `web/src/server/env.ts` (modify) | `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`, `CLAUDE_METADATA_MODEL`, `GOOGLE_BASE_URL_OVERRIDE` |
| `web/src/server/jobs.ts` (modify) | `MAX_ATTEMPTS.publish_youtube = 3` |
| `web/src/server/ai/youtube-metadata.ts` (new) | The Claude call, schema, parse and limit enforcement |
| `web/src/server/youtube/google.ts` (new) | Google HTTP: OAuth endpoints, channels/videos list, resumable upload, error classification, `nextMidnightPacific` |
| `web/src/server/youtube/accounts.ts` (new) | Account repository, token access/refresh, OAuth state, account serializer |
| `web/src/server/youtube/posts.ts` (new) | Post repository: creation, claim, cancel, retry, circuit breaker, serializer |
| `web/src/worker/handlers/publish-youtube.ts` (new) | The job handler |
| `web/src/worker/run-job.ts`, `cron.ts`, `handlers/process-task.ts`, `handlers/restyle-task.ts`, `context.ts` (modify) | Registration, trigger, lineage, cron steps |
| `web/src/app/api/youtube/{connect,callback,account,account/resume}/route.ts` (new) | Connection routes (Task 7) |
| `web/src/app/api/tasks/[id]/youtube/route.ts`, `.../youtube/[postId]/retry/route.ts` (new) | Post status and retry |
| `web/src/app/api/tasks/[id]/route.ts`, `.../clips/[clipId]/route.ts`, `.../settings/route.ts` (modify) | Delete and restyle interactions |
| `web/src/components/settings/youtube-settings.tsx` (new), `app/settings/page.tsx`, `components/app/clip-wall.tsx`, `app/tasks/[id]/page.tsx` (modify) | UI |
| `web/e2e/fakes/google.ts` (new), `e2e/global-setup.ts`, `e2e/full-flow.spec.ts` (modify) | End-to-end test |
| `docs/youtube.md` (new), `docs/configuration.md`, `docs/port/DESIGN.md`, `web/src/worker/README.md`, `web/.env.example` (modify) | Documentation |

---

### Task 1: Data model, config and job type

**Files:**
- Modify: `web/src/server/types.ts`, `web/src/server/db.ts`, `web/src/server/env.ts`, `web/src/server/jobs.ts`, `web/.env.example`, `web/src/worker/test-utils.ts` (the env-clearing list)
- Test: `web/src/server/db.test.ts`, `web/src/server/env.test.ts`

**Interfaces:**
- Produces:
  - `YoutubeAccountDoc`, `OAuthStateDoc`, `YoutubePostDoc` and `YoutubePostState`, with fields exactly as in §4.2 plus `channelId` and `insertCap: number` (default 3; a manual retry raises it by 1) on posts and `"paused"` on account status. `waitReason` has type `YoutubeWaitReason = "retry" | "quota" | "channel_limit" | "restyle" | "reconnect" | "private_lock"`.
  - `ClipDoc.lineageId?: string`.
  - `TaskDoc.autopost?: "pending" | "done"`.
  - `JobType` adds `"publish_youtube"`.
  - `collections().youtubeAccounts | oauthStates | youtubePosts`.
  - `env.GOOGLE_OAUTH_CLIENT_ID?`, `env.GOOGLE_OAUTH_CLIENT_SECRET?`, `env.CLAUDE_METADATA_MODEL` (default `"claude-sonnet-5"`), `env.GOOGLE_BASE_URL_OVERRIDE?` (a URL, for tests and e2e only).

- [ ] **Step 1: Write failing tests**
  - In `db.test.ts`, `creates the YouTube indexes`. After `ensureIndexes()`:
    - `youtube_posts` has a unique index on `lineageId` and indexes on `taskId`, `userId` and `{state:1, notBefore:1}`.
    - `oauth_states` has a TTL index on `expiresAt` with `expireAfterSeconds: 0`.
    - `tasks` has a partial index on `autopost` with filter `{autopost:"pending"}`.
  - In `env.test.ts`, `reads the YouTube settings`:
    - The `CLAUDE_METADATA_MODEL` default is `claude-sonnet-5`.
    - A blank `GOOGLE_OAUTH_CLIENT_ID` is `undefined`.
    - An invalid `GOOGLE_BASE_URL_OVERRIDE` throws.
- [ ] **Step 2: Run them.** `npx -y pnpm@10 exec vitest run src/server/db.test.ts src/server/env.test.ts` — expected FAIL.
- [ ] **Step 3: Implement** the types, collections, indexes, env fields, `MAX_ATTEMPTS.publish_youtube = 3`, the `.env.example` entries (placeholders and a comment linking `docs/youtube.md`), and the test-utils env clearing.
- [ ] **Step 4: Run them.** Same command — expected PASS. Then `npx -y pnpm@10 exec tsc --noEmit -p .` — expected 0 errors. Add every new `JobType` to `HANDLERS` / `FAILURE_HOOKS` as a placeholder that throws `new Error("not implemented")` *only* if tsc requires it; Task 8 replaces it.
- [ ] **Step 5: Commit** — `feat(youtube): data model, config and job type`. Log in Progress.md.

### Task 2: Clip lineage

**Files:**
- Modify: `web/src/worker/context.ts` (`clipDocFrom`), `web/src/worker/handlers/combine-editor.ts`, `web/src/worker/handlers/restyle-task.ts`
- Test: `web/src/worker/handlers/process-task.test.ts`, `restyle-task.test.ts`, `editor.test.ts`

**Interfaces:**
- Produces: `lineageOf(clip: Pick<ClipDoc,"id"|"lineageId">): string` in `server/youtube/posts.ts`, which returns `clip.lineageId ?? clip.id`. It is created here as the file's first export. Every clip written by process_task and combine has `lineageId === id`.

- [ ] **Step 1: Write failing tests:**
  - `process_task stores lineageId equal to each clip id`
  - `combine stores lineageId on the new clip`
  - `restyle keeps each clip's lineage`: seed clips `{id:"a"}` (no lineageId) and `{id:"b", lineageId:"L"}`, restyle, then assert the new clips' `lineageId` are `["a","L"]` and their ids changed.
- [ ] **Step 2: Run them.** `npx -y pnpm@10 exec vitest run src/worker/handlers` — expected FAIL.
- [ ] **Step 3: Implement.**
  - `clipDocFrom` sets `lineageId: id`.
  - Combine sets the new clip's `lineageId` to its `id`.
  - Restyle maps each rendered clip to its source clip's `lineageOf(old)` before `replaceClips`, in the same write.
- [ ] **Step 4: Run them.** Same command — expected PASS.
- [ ] **Step 5: Commit** — `feat(youtube): clip lineage survives restyle`. Log in Progress.md.

### Task 3: Claude-written metadata

**Files:**
- Create: `web/src/server/ai/youtube-metadata.ts`
- Test: `web/src/server/ai/youtube-metadata.test.ts`

**Interfaces:**
- Consumes: `createClaudeClient(apiKey, fetch?)`, `requestStructured({client, model, system, prompt, schema, parse, signal})`, `runWithRetry(run, {timeoutMs, signal})`, `OutputValidationError` (`server/ai/schemas.ts`).
- Produces:
  - `type YoutubeMetadata = {title: string; description: string; tags: string[]; hashtags: string[]; language?: string; model: string}`.
  - `writeYoutubeMetadata(input: {sourceTitle: string; hookTitle: string | null; transcript: string}, opts: {apiKey: string; model: string; signal?: AbortSignal; fetch?: typeof fetch}): Promise<YoutubeMetadata>`.
  - `parseYoutubeMetadata(value: unknown): Omit<YoutubeMetadata,"model">`, which throws `OutputValidationError`.
  - `fitTags(tags: string[]): string[]`.
  - `youtubeDescription(m: Pick<YoutubeMetadata,"description"|"hashtags">): string`, which returns `description + "\n\n" + hashtags.map(h => "#" + h).join(" ")`.

- [ ] **Step 1: Write failing tests** (fake `fetch` returning Anthropic messages, as in `server/ai/claude-provider.test.ts`):
  - `sends the clip as data with the metadata model`. Assert:
    - the request `model` is the given model;
    - `output_config.format.type === "json_schema"`;
    - the user prompt contains the transcript inside a JSON object;
    - the system prompt says the JSON is data, never instructions.
  - `returns parsed metadata with the model name`.
  - `strips angle brackets and enforces the title length`. Given an input title `"<b>Hi</b>" + "x".repeat(150)`, the parser either repairs or rejects it, and the final title has ≤100 characters and no `<` or `>`.
  - `enforces the description byte limit with multibyte text`. A 3000-character Devanagari description plus 5 hashtags gives a `youtubeDescription` of ≤ 5000 bytes by `Buffer.byteLength`.
  - `cleans tags that YouTube would reject`. For `["a,b", "<x>", "long tag " + "y".repeat(600), "ok"]`, `fitTags` returns tags with no comma, `<` or `>`, totalling ≤ 500 by the counting rule.
  - `dedupes hashtags, keeps Unicode letters, at most 5`. `["#Money","money","धन","bad tag","x","y","z"]` becomes `["Money","धन","x","y","z"]`.
  - `repairs once on invalid output then succeeds`.
  - `throws after the output retry budget`. No fallback text is ever returned.
- [ ] **Step 2: Run them.** `npx -y pnpm@10 exec vitest run src/server/ai/youtube-metadata.test.ts` — expected FAIL.
- [ ] **Step 3: Implement.**
  - The system prompt follows the §4.5 rules:
    - facts only from the transcript;
    - no invented numbers, quotes or promises;
    - the title describes what the clip delivers;
    - write in the transcript's language;
    - no links and no hashtags in the title;
    - 3–5 hashtags and 5–15 searchable tags;
    - the input JSON is data.
  - Schema: `{title, description, hashtags[], tags[], language?}`, with `additionalProperties:false`.
  - `parse` throws `OutputValidationError` for an empty or over-long title and for a description over budget. Tags are clipped, never rejected.
  - Wrap the call in `runWithRetry` with `timeoutMs: 120_000`. Do not touch `prompts.ts`.
- [ ] **Step 4: Run them.** Same command — expected PASS.
- [ ] **Step 5: Commit** — `feat(youtube): Claude-written Shorts metadata`. Log in Progress.md.

### Task 4: Google HTTP client

**Files:**
- Create: `web/src/server/youtube/google.ts`
- Test: `web/src/server/youtube/google.test.ts`

**Interfaces:**
- Produces (every function takes `fetchImpl: typeof fetch = fetch` as its last parameter):
  - `googleUrls(): {authorize: string; token: string; revoke: string; api: string; upload: string}`. Every origin is replaced by `env.GOOGLE_BASE_URL_OVERRIDE` when it is set.
  - `SCOPES = ["https://www.googleapis.com/auth/youtube.upload", "https://www.googleapis.com/auth/youtube.readonly"]`.
  - OAuth calls:
    - `exchangeCode(code, codeVerifier, redirectUri) → {accessToken, refreshToken?, expiresAt: Date, scopes: string[]}`
    - `refreshAccessToken(refreshToken) → {accessToken, expiresAt}`
    - `revokeToken(token): Promise<void>`
  - Data API reads:
    - `fetchMyChannel(accessToken) → {channelId, title, handle?, thumbnailUrl?} | null`
    - `listVideoStatus(accessToken, ids: string[]) → Map<id, {privacyStatus, uploadStatus, rejectionReason?}>`, which batches by 50.
  - Resumable upload:
    - `startUploadSession(accessToken, body: {snippet, status}, size, notifySubscribers) → sessionUri`
    - `querySession(sessionUri, size) → {done: VideoResource} | {nextByte: number} | {gone: true}`
    - `uploadFrom(sessionUri, size, startByte, body: NodeJS.ReadableStream, signal) → VideoResource`
    - `type VideoResource = {id: string; status: {privacyStatus: string; uploadStatus: string}}`
  - `class GoogleApiError extends Error {status: number; reason?: string}`. `reason` is `error.errors[0].reason`, or `"invalid_grant"` from the token endpoint. The message never contains a body, header, URL or token.
  - `classify(error: unknown): "quota" | "channel_limit" | "transient" | "reauth" | "invalid_metadata" | "permanent"`, per the §4.5 table.
  - `nextMidnightPacific(now: Date): Date`.

- [ ] **Step 1: Write failing tests** (fake `fetch` recording requests):
  - `starts a resumable session with the exact body`. Assert:
    - `POST .../upload/youtube/v3/videos?uploadType=resumable&part=snippet,status&notifySubscribers=false`
    - headers `X-Upload-Content-Length` and `X-Upload-Content-Type: video/mp4`
    - the JSON body equals the given snippet and status
    - the result is the `Location` header.
  - `querySession maps 200/201, 308 with and without Range, and 404/410`:
    - 308 with `Range: bytes=0-999` gives `{nextByte:1000}`;
    - 308 without Range gives `{nextByte:0}`;
    - 404 gives `{gone:true}`.
  - `uploadFrom sends Content-Range for a resumed upload`: `bytes 1000-1999/2000`.
  - `classify maps reasons` across `quotaExceeded`, `uploadLimitExceeded`, `rateLimitExceeded`, 503, `invalid_grant`, `insufficientPermissions`, `youtubeSignupRequired`, `invalidTitle`, `forbiddenPrivacySetting` and an `AbortError`.
  - `GoogleApiError messages never include tokens or bodies`. A 400 body containing `"secret-token"` must not appear in `error.message`.
  - `nextMidnightPacific handles both DST transitions`:
    - `2026-03-08T09:30:00Z` → `2026-03-09T07:00:00Z`
    - `2026-11-01T06:30:00Z` → `2026-11-01T07:00:00Z`
    - `2026-11-01T08:30:00Z` → `2026-11-02T08:00:00Z`
  - `GOOGLE_BASE_URL_OVERRIDE replaces every Google origin`.
- [ ] **Step 2: Run them.** `npx -y pnpm@10 exec vitest run src/server/youtube/google.test.ts` — expected FAIL.
- [ ] **Step 3: Implement** with plain `fetch`. `nextMidnightPacific` uses `Intl.DateTimeFormat("en-US",{timeZone:"America/Los_Angeles"})` to find the next local midnight. `uploadFrom` streams the body in one `PUT`: `duplex:"half"`, `Content-Length: size - startByte`, and `Content-Range` when `startByte > 0`.
- [ ] **Step 4: Run them.** Same command — expected PASS.
- [ ] **Step 5: Commit** — `feat(youtube): Google OAuth and resumable upload client`. Log in Progress.md.

### Task 5: Accounts, tokens and OAuth state

**Files:**
- Create: `web/src/server/youtube/accounts.ts`
- Modify: `web/src/server/tasks.ts` (`deleteAllUserData` also deletes the user's account, posts and states)
- Test: `web/src/server/youtube/accounts.test.ts`

**Interfaces:**
- Consumes: Task 4's `exchangeCode`, `refreshAccessToken`, `fetchMyChannel`, `revokeToken`, `SCOPES`, `GoogleApiError`; `encryptSetting` / `decryptSetting`.
- Produces:
  - OAuth state:
    - `createOAuthState(userId) → {state, codeChallenge}`. The verifier is 32 random bytes in base64url, the challenge is S256, and the TTL is 10 min.
    - `consumeOAuthState(state, userId) → {codeVerifier} | null`. Uses `findOneAndDelete`, plus a `userId` and `expiresAt > now` check.
  - Account repository:
    - `getAccount(userId)`
    - `saveConnectedAccount(userId, tokens, channel) → {channelChanged: boolean}`. It upserts the account (status `active`, tokens encrypted), keeps the old refresh token when none is sent, and defaults to `autoPost:true`, `privacy:"public"`, `madeForKids:false`.
    - `updateAccountPrefs(userId, {autoPost?, privacy?, madeForKids?})`
    - `disconnectAccount(userId)`. Deletes the doc first, then makes a best-effort revoke.
    - `setAccountStatus(userId, status, warning?)`
  - `getAccessToken(account, fetchImpl?) → string`. Refreshes when less than 5 min remain. On `invalid_grant` it sets `reauth_required` and throws `GoogleApiError` with reason `invalid_grant`.
  - `serializeAccount(account | null) → {configured, connected, channel, status, warning, auto_post, privacy, made_for_kids, setup_hint?}`. Never includes tokens.

- [ ] **Step 1: Write failing tests:**
  - `state is single-use, user-bound and expires`. The second consume returns null, another user gets null, and so does a consume 11 min later.
  - `stores tokens encrypted and never serializes them`. The raw doc's `refreshToken` starts with `"v1:"`, and `JSON.stringify(serializeAccount(...))` contains no token text.
  - `keeps the previous refresh token when Google sends none`.
  - `reports channelChanged when a different channel connects`.
  - `refreshes an access token that expires within 5 minutes`.
  - `marks the account reauth_required on invalid_grant`.
  - `deleteAllUserData removes YouTube data`.
- [ ] **Step 2: Run them.** `npx -y pnpm@10 exec vitest run src/server/youtube/accounts.test.ts src/server/tasks.test.ts` — expected FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them.** Same command — expected PASS.
- [ ] **Step 5: Commit** — `feat(youtube): accounts, encrypted tokens, OAuth state`. Log in Progress.md.

### Task 6: Post repository

**Files:**
- Modify: `web/src/server/youtube/posts.ts` (created in Task 2)
- Test: `web/src/server/youtube/posts.test.ts`

**Interfaces:**
- Consumes: `getAccount`, `lineageOf`, `enqueueJob({type:"publish_youtube", activeKey:"youtube:{postId}", payload:{postId}})`.
- Produces:
  - Creation:
    - `createPostsForTask(taskId): Promise<number>`. Re-reads the account and creates nothing when it is missing or auto-post is off.
      - It creates one post per clip whose `hookType !== "fallback"`, with `insertMany({ordered:false})`, ignoring E11000.
      - It snapshots `privacy`, `madeForKids` and `channelId`.
      - `notifySubscribers` is true only for the first clip in order.
      - The state is `queued` for an `active` account, otherwise `blocked` with `waitReason` `reconnect` or `private_lock`.
      - It enqueues the queued posts and sets the task's `autopost: "done"`.
  - Claim:
    - `claimPost(postId, jobId): Promise<YoutubePostDoc | null>`.
    - CAS `queued` (with `notBefore` absent or ≤ now) → `working` with `claimedBy: jobId`; also accept `working` with the same `claimedBy`.
  - Transitions:
    - `deferPost(post, reason: YoutubeWaitReason, until: Date, error?)`
    - `blockPost(post, reason, message)`
    - `failPost(post, message, errorReason?)`
    - `markUploaded(post, video: VideoResource)`
    - `saveSession(postId, upload)`, `saveMetadata(postId, metadata)`, `clearMetadata(postId)`
  - Cancelling:
    - `cancelPostsForUser(userId, reason)` and `cancelPostsForTask(taskId)` act on `queued | blocked | failed`.
    - `cancelPostForLineage(taskId, lineageId): Promise<"cancelled" | "working" | "none">`.
  - `unblockAfterReconnect(userId)`. Every `blocked` post except `private_lock` → `queued`.
  - `tripPrivateLock(userId)`. The account becomes `paused` with warning `private_lock`, and every queued post → `blocked` with `private_lock`.
  - `resumePosting(userId)`. Undoes `tripPrivateLock`.
  - `retryPost(postId, userId) → {post, job}`. Accepts `failed | blocked`, 409s for `uploaded`, resets `attempts`, adds 1 to the insert allowance via `insertCap = insertCalls + 1`, and enqueues.
  - `deferAllQueuedForQuota(until)`.
  - `serializePosts(task, posts) → {posts: SerializedPost[]}`. `SerializedPost` has the §4.8 fields: `clip_id` (the current clip of the lineage), `state`, `phase`, `progress`, `title`, `description`, `tags`, `hashtags`, `video_url`, `privacy_status`, `warning`, `error`, `not_before`, `insert_cap_reached`.

- [ ] **Step 1: Write failing tests:**
  - `creates one post per non-fallback clip in order, notifying only the first`.
  - `is idempotent across repeated calls`. Calling it twice gives the same count of docs.
  - `creates blocked posts for a reauth_required account`.
  - `creates nothing when auto-post is off`.
  - `claim and cancel race: exactly one wins` (`Promise.all` of `claimPost` and `cancelPostForLineage`).
  - `re-claim by the same job id succeeds after a restart`.
  - `tripPrivateLock pauses the account and blocks queued posts; resumePosting undoes it`.
  - `retry raises the insert cap by one and refuses uploaded posts`.
  - `serializer never outputs upload, tokens, claimedBy or storage keys`.
- [ ] **Step 2: Run them.** `npx -y pnpm@10 exec vitest run src/server/youtube/posts.test.ts` — expected FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them.** Same command — expected PASS.
- [ ] **Step 5: Commit** — `feat(youtube): post repository with lineage guard`. Log in Progress.md.

### Task 7: Connection routes

**Files:**
- Create:
  - `web/src/app/api/youtube/connect/route.ts` (POST)
  - `web/src/app/api/youtube/callback/route.ts` (GET)
  - `web/src/app/api/youtube/account/route.ts` (GET/PATCH/DELETE)
  - `web/src/app/api/youtube/account/resume/route.ts` (POST, for "Resume posting")
- Test: `web/src/app/api/youtube/youtube-routes.test.ts`, using real Better Auth sessions as in `web/src/app/api/tasks/route.test.ts`, and msw for Google.

**Interfaces:**
- Consumes: Task 5, plus Task 6's `unblockAfterReconnect(userId)`, `cancelPostsForUser(userId, reason)` and `resumePosting(userId)`.
- Produces: the redirect codes `connected`, and the `youtube_error` codes `denied | expired | missing_scope | no_channel | exchange_failed | not_configured`.

- [ ] **Step 1: Write failing tests:**
  - `connect requires a session and returns an authorize URL`. The URL has:
    - `response_type=code`
    - both scopes
    - `access_type=offline`
    - `prompt=consent`
    - `include_granted_scopes=true`
    - `state`
    - `code_challenge_method=S256`
    - `redirect_uri={BETTER_AUTH_URL}/api/youtube/callback`
  - `connect returns 409 not_configured when client env vars are missing`.
  - `callback stores the channel and redirects to /settings?youtube=connected`.
  - `rejects a callback that is missing a scope`. Redirects with `youtube_error=missing_scope` and stores no account.
  - `reports an account without a channel`. Redirects with `youtube_error=no_channel`.
  - `callback with a foreign or reused state redirects expired`.
  - `callback never echoes Google error text`.
  - `account GET hides tokens; PATCH updates prefs; turning auto_post off cancels queued posts`.
  - `DELETE disconnects and cancels queued and blocked posts`.
  - `resume sets the account active and requeues private_lock posts`.
- [ ] **Step 2: Run them.** `npx -y pnpm@10 exec vitest run src/app/api/youtube` — expected FAIL.
- [ ] **Step 3: Implement.** Use `handle()` and `requireUser` everywhere; the callback uses `getSessionUser`.
  - When the channel changed, the callback cancels old-channel posts with the error `"Not posted: a different channel was connected."`
  - Otherwise it calls `unblockAfterReconnect`.
- [ ] **Step 4: Run them.** Same command — expected PASS.
- [ ] **Step 5: Commit** — `feat(youtube): connect, callback and account routes`. Log in Progress.md.

### Task 8: `publish_youtube` handler and the trigger

**Files:**
- Create: `web/src/worker/handlers/publish-youtube.ts`
- Modify:
  - `web/src/worker/run-job.ts`: register the handler. The failure hook defers the post 2 min while it has attempts left, else `failPost`.
  - `web/src/worker/handlers/process-task.ts`: §4.4 steps 1–3, with `autopost:"pending"` in the completion `$set`, then `createPostsForTask` in a try/catch.
- Test: `web/src/worker/handlers/publish-youtube.test.ts`, `process-task.test.ts`

**Interfaces:**
- Consumes: Tasks 3, 4, 5 and 6; `ctx.deps.fetch` (fake in tests); `getStorage().stat/createReadStream`.
- Produces: `publishYoutube(ctx: JobContext): Promise<JobOutcome>`.

- [ ] **Step 1: Write failing tests** (fake fetch for Anthropic and Google, a memory server, and seeded task, clip file, account and post):
  - `writes metadata, uploads and records the video`. Assert:
    - the post is `uploaded`, with `videoUrl = https://www.youtube.com/watch?v=VID`;
    - metadata is stored before the upload request;
    - the request body matches the Global Constraints upload body;
    - the description is Claude's plus the hashtags.
  - `recovers a completed upload from the saved session without a second insert`. Seed `upload.sessionUri` and `insertCalls:1`; the session query returns 200. Assert there are zero initiation requests.
  - `resumes from the Range offset after a dropped connection`.
  - `never initiates more than the insert cap`. With `insertCalls:3`, the post fails and nothing is requested.
  - `quotaExceeded defers every queued post to the next midnight Pacific + 5 min`.
  - `uploadLimitExceeded defers 6 h`.
  - `transient errors back off 1, 5, 15 min, then fail`.
  - `invalid_grant blocks the post and marks the account reauth_required`.
  - `invalidTitle clears metadata and retries once, then fails`.
  - `a returned private status trips the circuit breaker`.
  - `cancels when the clip's lineage is gone`.
  - `defers 2 min while a restyle is processing`.
  - `does not re-ask Claude when metadata is stored`.
  - `Claude failure defers without uploading anything`.
  - In `process-task.test.ts`:
    - `completion creates posts for an auto-post account`;
    - `completion creates none when not connected`;
    - `a resumed task posts on completion`.
- [ ] **Step 2: Run them.** `npx -y pnpm@10 exec vitest run src/worker/handlers/publish-youtube.test.ts src/worker/handlers/process-task.test.ts` — expected FAIL.
- [ ] **Step 3: Implement.**
  - Claim, then run the §4.5 checks in order: the account exists and is active; the task exists and is not processing; a clip with the lineage exists; the file `stat`s.
  - Then `writing` (skipped when metadata is stored), then `uploading` (query → initiate → upload, with 1/2/4/8 s backoff and at most 5 tries per job).
  - Map errors with `classify`. Store error text in our own words plus the reason code.
- [ ] **Step 4: Run them.** Same command — expected PASS. Then the whole worker suite: `npx -y pnpm@10 exec vitest run src/worker`.
- [ ] **Step 5: Commit** — `feat(youtube): publish job and completion trigger`. Log in Progress.md.

### Task 9: Cron steps

**Files:**
- Modify: `web/src/worker/cron.ts`, to add three steps to `runCron`.
- Test: `web/src/worker/cron.test.ts`

**Interfaces:**
- Produces:
  - `dispatchDuePosts(now)`. Enqueues `queued` posts whose `notBefore` has passed or is absent. E11000 means the job already exists.
  - `resumePendingAutopost(now)`. `createPostsForTask` for tasks with `autopost:"pending"` and `updatedAt` older than 2 min.
  - `verifyUploads(now, fetchImpl?)`.
    - Selects posts that are `uploaded`, uploaded ≥ 10 min and ≤ 48 h ago, with no `verifiedAt` and a `channelId` matching the account.
    - Groups them per user and calls `listVideoStatus`.
    - Sets `verifiedAt` once `uploadStatus ∈ {processed, rejected, failed, deleted}`.
    - Warns on private status (and calls `tripPrivateLock`) or on a rejection.
- [ ] **Step 1: Write failing tests:**
  - `dispatches only due queued posts`.
  - `re-creates posts for a task stuck in autopost pending`.
  - `verification records processed videos and trips the breaker on private`.
  - `verification skips posts from a previous channel`.
- [ ] **Step 2: Run them.** `npx -y pnpm@10 exec vitest run src/worker/cron.test.ts` — expected FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them.** Same command — expected PASS.
- [ ] **Step 5: Commit** — `feat(youtube): cron dispatch, trigger recovery and verification`. Log in Progress.md.

### Task 10: Task routes and interactions

**Files:**
- Create:
  - `web/src/app/api/tasks/[id]/youtube/route.ts` (GET)
  - `web/src/app/api/tasks/[id]/youtube/[postId]/retry/route.ts` (POST)
- Modify:
  - `web/src/app/api/tasks/[id]/clips/[clipId]/route.ts` (DELETE)
  - `web/src/app/api/tasks/[id]/route.ts` (DELETE)
  - `web/src/app/api/tasks/[id]/settings/route.ts` (restyle)
- Test: `web/src/app/api/tasks/youtube.test.ts`

- [ ] **Step 1: Write failing tests:**
  - `GET returns serialized posts for the owner only`. Another user gets 404 or 403, as for the other task routes.
  - `retry requeues a failed post with worker_online and 409s for uploaded`.
  - `clip delete cancels the lineage's waiting post, and 409s "This clip is uploading to YouTube. Try again in a minute." while working`.
  - `task delete cancels and deletes its posts`.
  - `restyle 409s while a post is working`.
- [ ] **Step 2: Run them.** `npx -y pnpm@10 exec vitest run src/app/api/tasks/youtube.test.ts` — expected FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them.** Same command — expected PASS. Then `npx -y pnpm@10 exec vitest run src/app/api`.
- [ ] **Step 5: Commit** — `feat(youtube): task post routes and delete/restyle guards`. Log in Progress.md.

### Task 11: Settings UI

**Files:**
- Create: `web/src/components/settings/youtube-settings.tsx` and its test
- Modify: `web/src/app/settings/page.tsx` (a new `<Section id="youtube">` after the AI section), `web/messages/en/settings.json`

- [ ] **Step 1: Write failing tests** (fake fetch, following `ai-provider-settings.test.tsx`):
  - `shows the setup hint when not configured`. It names `GOOGLE_OAUTH_CLIENT_ID` and `GOOGLE_OAUTH_CLIENT_SECRET` and links `docs/youtube.md`.
  - `Connect posts to /api/youtube/connect and navigates to the authorize URL`.
  - `connected view shows the channel, the auto-post switch, visibility and made-for-kids selects`.
  - `shows the reconnect prompt and the private-lock warning with Resume posting`.
  - `maps youtube_error codes to copy and never shows raw text`.
  - `Disconnect asks for confirmation`.
- [ ] **Step 2: Run them.** `npx -y pnpm@10 exec vitest run src/components/settings` — expected FAIL.
- [ ] **Step 3: Implement.**
  - Switch label: "Publish every new clip to this channel as soon as it's ready".
  - Show links to the YouTube Terms of Service, the Google Privacy Policy and `https://myaccount.google.com/permissions`.
- [ ] **Step 4: Run them.** Same command — expected PASS.
- [ ] **Step 5: Commit** — `feat(youtube): Settings section`. Log in Progress.md.

### Task 12: Task page UI

**Files:**
- Modify: `web/src/components/app/clip-wall.tsx` (`ClipTile` chip, `ClipFocus` metadata), `web/src/app/tasks/[id]/page.tsx` (posts poll), `web/messages/en/task.json`
- Test: `web/src/app/tasks/[id]/page.test.tsx`

- [ ] **Step 1: Write failing tests:**
  - `shows a status chip per clip`. Waiting to post, Writing title…, Uploading…, Posted (a link with `target="_blank"`), Private on YouTube, Waiting for YouTube's daily limit (until <local time>), Failed + reason + Try again.
  - `Try again posts to the retry route`. When `insert_cap_reached`, it confirms first with "If this clip is already on your channel, don't retry; it would post twice."
  - `focus view shows the posted title, description, hashtags and tags`.
  - `polls posts every 4 s while any is queued or working, and stops after`.
- [ ] **Step 2: Run them.** `npx -y pnpm@10 exec vitest run "src/app/tasks/[id]/page.test.tsx"` — expected FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them.** Same command — expected PASS. Then `npx -y pnpm@10 run lint`.
- [ ] **Step 5: Commit** — `feat(youtube): task page post status`. Log in Progress.md.

### Task 13: End-to-end with a fake Google

**Files:**
- Create: `web/e2e/fakes/google.ts`. It fakes the authorize page (an instant redirect back with a code), token, revoke, `channels.list`, the resumable upload session (initiate, PUT, status query) and `videos.list`.
- Modify: `web/e2e/global-setup.ts` (start the fake; set `GOOGLE_BASE_URL_OVERRIDE`, `GOOGLE_OAUTH_CLIENT_ID` and `GOOGLE_OAUTH_CLIENT_SECRET`), `web/e2e/full-flow.spec.ts`

- [ ] **Step 1: Extend the spec.**
  - After saving the AI keys: Settings → YouTube → Connect → returns connected, showing the fake channel name.
  - After the 2 clips render: both clip tiles reach "Posted" within 3 min.
  - The fake recorded exactly 2 session initiations, each with `privacyStatus:"public"`, `selfDeclaredMadeForKids:false`, `categoryId:"22"` and the fake Claude metadata.
- [ ] **Step 2: Run it.** `export SWC_NATIVE_BINDING_CACHE='C:\swc-cache-claude' && npx -y pnpm@10 exec playwright test` — expected to FAIL until the fake exists, then PASS twice in a row.
- [ ] **Step 3: Commit** — `test(youtube): end-to-end auto-post with fake Google`. Log in Progress.md.

### Task 14: Documentation and final verification

**Files:**
- Create: `docs/youtube.md` (§6 setup steps verbatim, how auto-post behaves, the forced-private note with the audit link, and troubleshooting by error code)
- Modify:
  - `docs/configuration.md` (the 4 env vars)
  - `docs/port/DESIGN.md` (§0, §2, §5, §6 and §9 for the new feature, collections and job)
  - `web/src/worker/README.md`
  - `README.md` (a feature line)
  - `docs/testing.md` (the manual YouTube check)

- [ ] **Step 1: Write the docs.**
- [ ] **Step 2: Run the full verification** from `web/`:
  - `npx -y pnpm@10 exec tsc --noEmit -p .` — 0 errors
  - `npx -y pnpm@10 run lint` — clean
  - `npx -y pnpm@10 exec vitest run` — all pass
  - `export SWC_NATIVE_BINDING_CACHE='C:\swc-cache-claude' && npx -y pnpm@10 run build` — succeeds
  - `npx -y pnpm@10 exec playwright test` — passes
  - Engine: `cd ../engine && .venv/Scripts/python.exe -X utf8 -m pytest -q` — all pass (unchanged)
- [ ] **Step 3: Commit** — `docs(youtube): setup guide and configuration`. Add a Progress.md entry with the verification results and the manual steps left to the user (Google Cloud setup, the first live upload check).
