# YouTube auto-post: design

Date: 2026-10-27. Status: design. The user's decisions are fixed. Items marked "our call" were
decided by the assistant; the user should check them (all are listed in §7). This feature reverses
the "social dropped" line in `docs/port/DESIGN.md` §0, so DESIGN.md §0, §2, §5, §6 and §9 change with it.

## 1. Intent

Clipwright already turns a long video into scored 9:16 clips. Today the user then downloads each
clip and uploads it to YouTube by hand. That means writing a title, description and tags for every
clip, which is the boring part. The user wants that step gone. When a video finishes processing,
every clip should go to their YouTube channel as a public Short, with a title, description, tags
and hashtags written by Claude. Nobody reviews anything first.

The source videos are the user's own content, so we need no rights checks and no credit lines.
Because nobody reviews the uploads, the system itself has to be careful. It must never post twice,
never post something the user removed, never fail without saying so, and never waste the small
daily upload quota.

## 2. Goals, non-goals, anti-goals

**Goals**
- Every clip from a completed `process_task` run is uploaded to the user's connected channel, public,
  with Claude-written metadata. Uploads start as soon as the task completes, or as soon as the
  worker is running if it was off.
- Each clip produces at most one YouTube video, ever, whatever retries, restarts or restyles happen.
- On the task page, every clip shows one of: waiting, uploading, a "Posted" link, a warning, or an
  error with "Try again". The title, description and tags that were posted are shown there too.
- Uploads survive a worker restart, a dropped connection, a Google 5xx and a used-up daily quota.
  None of these may cause a duplicate or lose a post.
- The split stays Vercel-ready. Route handlers only do short OAuth and database work. All Claude
  calls, uploads and verification run in the worker.

**Non-goals (v1)**
- A review or approval step; scheduling or spacing uploads; editing metadata after upload (that needs
  the broader `youtube.force-ssl` scope).
- More than one channel per user; TikTok, Instagram or other platforms; thumbnails; playlists; view
  and like metrics. The original's metrics cron is not ported.
- Auto-posting combined clips or editor edits; re-posting after a restyle; backfilling tasks that
  completed before the channel was connected.
- Deleting the YouTube video when the clip or task is deleted in Clipwright.

**Anti-goals.** Any of these makes the feature a failure, even if uploads technically work.
- **Duplicate uploads** of one clip. Possible causes: a job re-run after a shutdown or lease loss
  (`releaseJob` requeues without spending an attempt), a retry after the response to a completed
  upload was lost, a double enqueue, or a restyle.
- **Posting a clip the user deleted**, a clip from a cancelled or partial run, or the fallback clip
  (shown when the AI picked nothing).
- **Posting a restyled re-render of a clip that is already on YouTube.**
- **Silent failures.** For example: a post that never goes out, a video Google forced to private, or
  a video YouTube rejected after processing, any of which the task page still shows as fine.
- **Leaking secrets:** OAuth tokens, the client secret, or the resumable session URI. The session URI
  is a capability URL: anyone holding it can upload into the session. None of these may appear in
  API JSON, logs, error messages or git.
- **Burning the daily upload quota.** Examples: retry loops on `quotaExceeded`, sending metadata
  Google will reject (invalid calls still cost quota), or several `videos.insert` initiations for
  one clip.
- **Fallback metadata**, such as a raw transcript dumped into the description, as the original did.
  **Misleading titles or tags.** Google's spam policy penalizes both, and misleading tags can get a
  video locked private.
- **Posting while the user believes auto-post is off.**

## 3. Constraints

- **Runtime.**
  - Clipwright runs locally on Windows today. It uses MongoDB Atlas and a single worker with
    `WORKER_CONCURRENCY=1`.
  - Route handlers must never run long work.
  - Worker-imported modules must not import `next/*` or `server-only`. `session.ts` is off-limits in
    the worker; use `job.userId` there.
  - Writes are single-document atomic updates or compare-and-sets (CAS). There are no transactions.
- **Storage.** The worker reads clips through `getStorage()`: `stat(key)` gives the size and
  `createReadStream(key, {start, end})` streams it. This keeps a future Blob/R2 driver working.
- **Job docs are deleted after 7 days.** Durable post state (YouTube id, URL, status) must live in
  its own collection, never in `job.result`.
- **Google's limits** (from the research; see the sources there):
  - **Upload quota.** `videos.insert` has its own bucket of **100 calls/day per Cloud project**, at
    1 unit each. Other calls share 10,000 units/day; `channels.list` and `videos.list` cost 1 each.
    Quotas reset at **midnight Pacific**. A task makes up to 10 clips, so this allows about 10 tasks
    a day.
  - **Channel limits.** Each channel also has a separate, unpublished 24-hour upload limit; Google
    returns `uploadLimitExceeded` when it is hit.
  - **Testing mode.** In "Testing" mode, refresh tokens expire after **7 days**.
  - **In production, unverified.** The user clicks through a warning screen, and the project has a
    lifetime cap of 100 users.
  - **Forced-private lock (unresolved).** Google contradicts itself about whether uploads from an
    unaudited project are forced private. Since about 8 Oct 2026 the live `videos.insert` reference
    says they are not. The changelog and Help article 7300965 still describe the lock, and a locked
    video can never be made public. Only YouTube's API compliance audit lifts it.
- **Metadata rules.**
  - Title: at most 100 characters and required.
  - Description: at most 5000 **bytes** (UTF-8).
  - Tags: at most 500 characters in total. Commas between tags count, and so do the 2 quote
    characters Google adds around any tag containing a space.
  - Neither `<` nor `>` is allowed anywhere.
  - More than 60 hashtags makes YouTube ignore all of them.
  - Shorts are vertical or square videos of at most 3 minutes. No API flag or `#Shorts` is needed.
- **Policy.**
  - Automated uploads need the user's prior express consent.
  - Google's Required Minimum Functionality rules (RMF) require the app to show a privacy choice.
  - Made-for-kids must be stated explicitly (COPPA).
  - AI-written titles and descriptions do **not** require the synthetic-media disclosure.
- **Scopes.** `youtube.upload` for the insert, plus `youtube.readonly` for `channels.list?mine=true`
  and `videos.list`. Users can untick either scope on Google's consent screen, so check the granted
  scopes.
- **License (AGPL-3.0).** The feature ships as source like the rest of the app. Use plain `fetch`;
  add no `googleapis` dependency. Secrets stay in `.env.local`, and `.env.example` gets placeholders.
- **Tests.** Make no real Google or Anthropic calls. msw already fails on unhandled requests.

## 4. Decided design

### 4.1 Flow

1. **Connect.** In Settings, the user connects one channel (Google OAuth). They see an "Auto-post"
   switch, on after connecting; turning it on is the consent. They also see visibility (Public) and
   made-for-kids (No).
2. **Trigger.** `process_task` completes. If the user has an active account with auto-post on, one
   post doc is created per clip, skipping `hookType: "fallback"`. A `publish_youtube` job is enqueued
   for each post, in clip order.
3. **Publish.** Each job writes the metadata with Claude and stores it on the post. It then uploads
   the clip's current file with the resumable protocol, records the video id, and reads back
   `status.privacyStatus` and `status.uploadStatus`.
4. **Verify.** A cron step re-reads each video's status a few minutes later and flags anything that
   is not public and processed.
5. **Display.** The task page polls the posts while any of them is not finished.

### 4.2 Data

**`ClipDoc.lineageId: string`** (new field).
- Set to the clip's own `id` when `process_task` or `combine_editor` creates the clip.
- `restyle_task` copies `old.lineageId ?? old.id` onto each re-rendered clip, inside the same
  `replaceClips` write, so the link survives atomically.
- Clips without the field use `id`.

A post belongs to a lineage, not to a clip id. So a restyle cannot re-post a clip, and a clip that is
not yet uploaded is posted in its latest look.

**`youtube_accounts`** (`_id` = userId: one channel per user):
```
{ _id, channelId, channelTitle, channelHandle?, thumbnailUrl?,
  refreshToken /*encryptSetting*/, accessToken? /*encrypted*/, accessTokenExpiresAt?, scopes[],
  status: "active" | "reauth_required" | "paused", warning?,
  autoPost: boolean, privacy: "public" | "unlisted" | "private", madeForKids: boolean,
  connectedAt, createdAt, updatedAt }
```
(Amended after the final review: `lastError` was dropped. Nothing wrote or read it.)

**`oauth_states`:**
- Shape: `{_id: state, userId, codeVerifier, expiresAt}`.
- A TTL index on `expiresAt` deletes states after 10 minutes. Consume a state with
  `findOneAndDelete`, and also check `expiresAt > now`, because TTL deletion runs late.

**`youtube_posts`:**
```
{ _id, userId, taskId, lineageId /*unique index*/, channelId,
  state: "queued" | "working" | "uploaded" | "blocked" | "failed" | "cancelled",
  phase?: "writing" | "uploading", progress?, claimedBy? /*job id*/,
  notBefore?, waitReason?: "retry" | "quota" | "channel_limit" | "restyle" | "reconnect" | "private_lock",
  attempts, insertCalls, privacy, madeForKids, notifySubscribers,      // snapshotted at creation
  metadata?: { title, description, tags[], hashtags[], language?, model },
  upload?: { sessionUri, storageKey, size, startedAt },               // never serialized or logged
  videoId?, videoUrl?, privacyStatus?, uploadStatus?, verifiedAt?, uploadedAt?,
  warning?, error?, errorReason?, createdAt, updatedAt }
```
Indexes: `{lineageId:1}` unique, `{taskId:1}`, `{userId:1}`, `{state:1, notBefore:1}`.

**Task flag:** `TaskDoc.autopost?: "pending" | "done"`, with a partial index on `"pending"`.

**States**, where *uploaded* is final and is never left:
- `queued` → `working`, by an atomic claim.
- From `working`:
  - → `uploaded`: the upload succeeded.
  - → `queued` with `notBefore`: retry, quota wait, channel limit, or restyle in progress.
  - → `blocked`: needs a reconnect, the channel is missing, or a scope was refused.
  - → `failed`: a permanent error or the retry budget ran out.
- `queued` | `blocked` | `failed` → `cancelled`: the clip or task was deleted, the account was
  disconnected, or auto-post was turned off. A `working` post is cancelled by its own job for the
  same reasons or a channel change (§4.5 claim checks) (amended after the final review).
- `failed` | `blocked` → `queued`: the user pressed "Try again", or reconnected (blocked posts only).

### 4.3 Connecting (OAuth, our own routes)

- **`POST /api/youtube/connect`** (session required).
  - It is a POST so another site cannot start it.
  - Creates the state: 32 random bytes in base64url, bound to the user, plus a PKCE S256 verifier.
  - Returns `{authorize_url}`, which points at `https://accounts.google.com/o/oauth2/v2/auth` with:
    - `response_type=code`
    - both scopes
    - `access_type=offline`
    - `prompt=consent`
    - `include_granted_scopes=true`
    - `state`
    - `code_challenge`
    - `redirect_uri = {BETTER_AUTH_URL}/api/youtube/callback`
- **`GET /api/youtube/callback`**. The session cookie arrives because this is a top-level Lax
  navigation.
  1. Consume the state and require that the session user owns it.
  2. Exchange the code at `https://oauth2.googleapis.com/token`.
  3. Require both scopes in the response's `scope`.
  4. Call `channels.list?part=snippet&mine=true`. With no channel, return `no_channel`.
  5. Upsert the account, with tokens encrypted. Keep the old refresh token if Google sends none.
  6. Move this user's `blocked` posts back to `queued`. Skip posts blocked by the `private_lock`
     circuit breaker, which only "Resume posting" releases.
     - **If the connected channel differs from the previous one** (our call): cancel the `queued` and
       `blocked` posts whose `channelId` is the old channel. Set their `error` to "Not posted: a
       different channel was connected."
     - Clips are never moved silently to a channel they weren't meant for.
  7. Redirect to `/settings?youtube=connected`, or to `/settings?youtube_error=<code>`. The codes
     are `denied`, `expired`, `missing_scope`, `no_channel` and `exchange_failed`. The UI maps codes
     to copy and never shows Google's error text.
- **`GET` / `PATCH /api/youtube/account`.**
  - GET returns `{configured, connected, channel, status, warning, auto_post, privacy,
    made_for_kids}`, plus a setup hint when the env vars are missing. It never returns tokens.
  - PATCH sets `auto_post`, `privacy` and `made_for_kids`. Turning auto-post off cancels posts that
    are `queued`, `blocked` or `failed` (amended after the final review: `failed` too, so a later
    "Try again" cannot post it).
- **`DELETE /api/youtube/account`** disconnects.
  1. Delete the account doc first.
  2. Cancel `queued`, `blocked` and `failed` posts (amended after the final review).
  3. Then revoke at `https://oauth2.googleapis.com/revoke`, best effort and logged only.
  - `deleteAllUserData` does the same, and also deletes the user's posts and states.
- **Token refresh** (worker):
  - Refresh when the access token has less than 5 minutes left.
  - Only `invalid_grant` (or a 401 on an API call that persists after one refresh) means the account
    needs reconnecting. That sets the account to `reauth_required` and the post to `blocked`.
  - A 5xx, 429 or network error is retryable.

### 4.4 The trigger (crash-safe)

1. Just before the completion CAS in `process-task.ts`, read the user's account.
2. If an account exists with auto-post on, add `autopost: "pending"` to the **same** completion
   `$set`. This applies whether the account is `active`, `reauth_required` or `paused` (§4.6). For
   a `reauth_required` or `paused` account, posts are created as `blocked` rather than `queued`, so
   the clip shows "Reconnect YouTube to post" (or the pause reason) and goes out once the user fixes
   it. A clip is never silently skipped (our call).
3. After the CAS succeeds, call `createPostsForTask(taskId)`, wrapped in try/catch, because the task
   is already complete:
   - Re-read the account, and post nothing if auto-post has been turned off.
   - `insertMany` one post per non-fallback clip, `ordered: false`, ignoring duplicate-key (E11000)
     errors on `lineageId`.
   - Set `notifySubscribers` true only for the first clip. That is the top clip; see §7.
   - Enqueue the jobs.
   - Set `autopost: "done"`.
4. A cron step re-runs `createPostsForTask` for tasks still `pending` more than 2 minutes after
   their last update. This covers a crash between the CAS and the enqueue.
   - The re-run sees the task's current clips, so it skips a clip that starts its own lineage
     after `run.completedAt`: that clip was combined in the editor meanwhile, and combined clips
     never post. A restyled clip keeps its older lineage and still posts (amended after the final
     review).

**Re-running the same source video posts again** (the user's decision). A new task on a video that was already processed posts all of its clips, even ones covering the same moments as Shorts already on the channel. `lineageId` only prevents re-posts within one task. There is no cross-task de-duplication.

Restyle and combine never create posts. **A resumed task posts when it completes**, exactly like a
first run (our call). Resume only applies to `error` or `cancelled` tasks, and those runs never
reached completion, so nothing from them was posted. A resumed run also creates fresh clips. A
cancelled run never reaches completion, so it never posts.

Each post snapshots the account's `channelId` when it is created (field `channelId` on
`youtube_posts`).

### 4.5 The `publish_youtube` job

- **Registration:**
  - New `JobType`, with `MAX_ATTEMPTS` 3. Resuming the session makes a re-run safe.
  - `activeKey: "youtube:{postId}"`, so an E11000 on enqueue means the job already exists.
  - Payload `{postId}`.
  - A failure hook. When the job dies, the post goes back to `queued` with `notBefore` 2 minutes
    later while it has attempts left, and to `failed` otherwise.
  - A cron step applies the same transition to a `working` post whose `claimedBy` job is no longer
    queued or running, because its hook never completed (a long database outage, or a kill
    between the reaper's write and the hook). It is fenced on the claim, so a job that finishes
    meanwhile wins (amended after the final review).
  - Jobs are dispatched at creation, and also by a cron step that enqueues every `queued` post whose
    `notBefore` has passed.
  - A handler that defers a post only sets `notBefore`. The cron picks the post up again.
- **Claim:**
  - CAS the post from `queued` (with `notBefore` passed or absent) to `working, claimedBy: job._id`.
  - Also accept `working` when `claimedBy` is this job's id, since a released or reaped job re-runs
    with the same id.
  - Then check, in order:
    1. The account exists and is active. A missing account means the user disconnected while the
       post was working, so the post is cancelled ("YouTube account was disconnected."), as are
       posts for another channel and posts after auto-post was turned off (amended after the final
       review).
    2. The task exists and is not `processing`. If a restyle is running, defer 2 minutes with
       `waitReason: "restyle"`.
    3. A clip with this `lineageId` is still in `task.clips`. If not, cancel the post.
    4. The file passes `stat`.
- **Metadata** (phase `writing`; skip this step if `metadata` is already stored):
  - Put the call in `web/src/server/ai/youtube-metadata.ts`, not in `prompts.ts`, whose prompts are
    golden-tested. Use `requestStructured` and `runWithRetry` from `ai/client.ts`.
  - The model is `CLAUDE_METADATA_MODEL` (default `claude-sonnet-5`), and the key comes from
    `getRuntimeSettings()`.
  - Input: `{source_title, hook_title, transcript: clip.text}`. The system prompt treats this JSON as
    data, never as instructions. The prompt rules:
    - Use only facts from the transcript.
    - No invented numbers, quotes or promises.
    - The title must describe what the clip actually delivers.
    - Write in the transcript's language.
    - No links and no hashtags in the title.
    - 3-5 relevant hashtags.
    - 5-15 tags that a viewer would actually search; nothing unrelated.
  - Output, as an example:
    ```json
    {"title":"Why index funds beat stock picking","description":"…","hashtags":["investing","indexfunds"],"tags":["index funds","passive investing"],"language":"en"}
    ```
  - `parse` enforces the limits and throws `OutputValidationError`, which triggers a repair turn:
    - Strip `<` and `>` everywhere.
    - The title must be 1-100 characters.
    - The title must not contain a link (`http://`, `https://` or `www.`), a hashtag (a `#`
      starting a word, so "C#" passes) or a line break. The prompt rule above, enforced too, so a
      transcript written as instructions cannot get them into the title (amended after the final
      review).
    - The description plus `"\n\n#a #b"` must fit in 5000 UTF-8 bytes (with no hashtag left, the
      description alone is sent; amended after the final review).
    - Hashtags must match `[\p{L}\p{N}_]+`, deduped, at most 5.
  - Tags are clipped deterministically to the 500-character rule; drop tags from the end until it
    fits.
  - An invalid `language` is dropped.
  - Store `metadata` on the post **before** uploading, so a retry never re-asks Claude and the task
    page shows exactly what was sent.
  - If Claude fails, the post retries later. Nothing is ever posted with fallback text.
- **Upload** (phase `uploading`):
  - **The request.** Send nothing fixed beyond what is listed here:
    - Description: Claude's description, then `\n\n`, then the hashtags.
    - Snippet: `{title, description, tags, categoryId:"22", defaultLanguage, defaultAudioLanguage}`.
    - Status: `{privacyStatus, selfDeclaredMadeForKids, containsSyntheticMedia:false}`.
    - Query: `notifySubscribers`.
    - No `#Shorts`, no links, no signature.
  1. If `upload.sessionUri` exists, **query it first** with `PUT`, `Content-Length: 0` and
     `Content-Range: bytes */{size}`. ~~Only do this when `upload.storageKey` and `size` still match
     the clip.~~ When they no longer match (a restyle changed the file), the saved session is still
     queried once, with its saved size: a 200/201 there means the older render is already the
     lineage's video; a 308 or 404/410 drops the session, which is never resumed or fed the new
     file. An error on that query is handled as for a matching session (in-job retries, then the
     error table), so no new session starts while it cannot be read (amended after the final
     review: the old rule missed a lost response followed by a restyle, a duplicate).
     - 200/201: done. Record the returned resource. This is how a lost response is recovered without
       a duplicate.
     - 308: resume from `Range` + 1, or from 0 when there is no `Range`.
     - 404/410: the session is gone, so start over.
  2. Otherwise start a session: `POST
     https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status`
     with `X-Upload-Content-Length` and `X-Upload-Content-Type: video/mp4`.
     - **Increment `insertCalls` before the call.** If `insertCalls` would exceed 3, fail the post
       instead. A start refused with `quotaExceeded` or `uploadLimitExceeded` gives its call back:
       Google sent no `Location`, so no session and no video can exist. Every other failed start
       still counts (amended after the final review; ruling dup-2b).
     - Save `Location` as `upload.sessionUri` immediately.
  3. Send the file with a single `PUT` streamed from `createReadStream`, passing `ctx.signal`.
     Google discourages chunking, and clips are tens of MB.
  4. On a network error or 5xx, go back to step 1. Back off 1/2/4/8 s, at most 5 tries per job, and
     refresh the token when it is near expiry. Then defer the post as a `retry`, keeping the session.
  5. On 200/201, record:
     - `videoId`
     - `videoUrl`: `https://www.youtube.com/watch?v={id}`, which works for Shorts and for
       `original`-format landscape clips
     - `privacyStatus`, `uploadStatus` and `uploadedAt`
     - state `uploaded`
     - `upload` is unset
     - If `privacyStatus` is not what was requested, set `warning` right away **and trip the
       circuit breaker** (§4.6).
- **Error mapping.** Classify by `error.errors[0].reason` and the HTTP status, never by substring:

  | Reason or status | Result |
  |---|---|
  | `quotaExceeded` | `queued` until the next midnight Pacific + 5 min (`quota`). Apply it with one `updateMany` to every queued post, so no other call is wasted. |
  | `uploadLimitExceeded` | `queued` + 6 h (`channel_limit`). Applied to every queued post of that user's channel, as the quota row does for the project, so no other post spends a refused call (amended after the final review). |
  | `rateLimitExceeded`, `userRateLimitExceeded`, 429, 5xx, network, Anthropic transient errors | `queued` after 1, 5, then 15 min. After 4 attempts, `failed`. |
  | `invalid_grant`, `insufficientPermissions`, `youtubeSignupRequired` | `blocked`, with a "Reconnect" or "Create a channel" message. If the account doc is gone by then (a disconnect mid-run revoked the grant), `cancelled` with "YouTube account was disconnected." instead (amended after the final review). |
  | `invalidTitle`, `invalidDescription`, `invalidTags` | Clear `metadata` and retry once, then `failed`. |
  | Any other 4xx, `forbiddenPrivacySetting` | `failed`. |

  Error text is stored in our own words plus the reason code. No headers, bodies, URLs or tokens.

### 4.6 Verification (cron step)

- Pick posts that were `uploaded` at least 10 minutes ago, within the last 48 h, and have no
  `verifiedAt`.
- Group them per user and call `videos.list?part=status&id=…`: up to 50 ids per call, 1 unit each.
- Store `privacyStatus` and `uploadStatus`.
- Set `verifiedAt` once `uploadStatus` is `processed`, `rejected`, `failed` or `deleted`.
- Set a post `warning` in these cases:
  - Not public: "YouTube made this video private" + a link to the setup doc's audit note. This also
    sets `youtube_accounts.warning`, which Settings shows.
  - `rejected` or `failed`: the reason, for example a duplicate.
- Clear a post `warning` that an earlier pass stored once the video is back to the requested
  privacy with no rejection (amended after the final review).
- Only verify posts whose `channelId` matches the account's current channel. A video on a
  previously connected channel cannot be read with the new token.
- Skip an account that is `reauth_required`: its refresh token would fail again on every pass.
  Its posts are verified after the reconnect, while still inside the 48 h window (amended after
  the final review).

**Circuit breaker for the forced-private lock** (our call). The first time any upload comes back
(from the upload response or from verification) with a `privacyStatus` other than the one
requested:
1. Set the account's `status: "paused"` and `warning: "private_lock"`.
2. Move every `queued` post of that user to `blocked` with `waitReason: "private_lock"`.

Otherwise each later clip would also be uploaded locked-private, spending quota, and could never be
posted publicly from this project. The `uploaded` state stays final; locked videos are not
re-posted (v1).

Settings explains the lock and offers **Resume posting**. Pressing it sets the account back to
`active` and moves those posts to `queued`; the user does this after the project passes YouTube's
audit, or to retry once. Any wait a post had from before the lock (a quota wait, say) is dropped
with it; a limit still in force re-defers the posts on the first upload, at no insert call (§4.5
step 2). A `reauth_required` account stays so, and its held posts wait for the reconnect
instead (amended after the final review). A post uploaded while the lock was in force stays as it
is, and the user can delete it in YouTube Studio.

### 4.7 Interactions with existing features

- **Clip delete** (`DELETE …/clips/[clipId]`) and **task delete:**
  1. First CAS the lineage's post (or the task's posts) from `queued`, `blocked` or `failed` to
     `cancelled`.
  2. If a post is `working`, return 409 "This clip is uploading to YouTube. Try again in a minute."
  - The claim CAS and the cancel CAS act on the same post doc, so exactly one of them wins.
  - If the clip delete is then refused (a restyle started between the route's status check and
    the delete's own CAS), the post gets its state and wait back. A crash between the two still
    leaves it cancelled (amended after the final review).
  - Task delete then deletes its posts.
  - The confirm dialogs say that videos already on YouTube stay there.
- **Restyle route:** return 409 while any of the task's posts is `working`. Otherwise it is allowed:
  - Uploaded lineages are never re-posted.
  - Queued lineages wait for the restyle, then upload the new render.
  - A lineage whose clip failed to re-render is cancelled when its job runs.
  - ~~If the file changed under a half-finished session, step 1 starts a new session. No video
    exists yet, so this cannot duplicate.~~ That reasoning is false when the old session's upload
    finished at Google but the response was lost (§2's lost-response case): the video does exist.
    So step 1 queries the older render's saved session first and records its video when it is
    done; only a session that is gone or incomplete is replaced by a new one (amended after the
    final review).
- **Editor exports** do not change `clip.filename`, so edits made in the editor are not what gets
  posted.

### 4.8 Routes and UI

- **Routes:**
  - `GET /api/tasks/[id]/youtube` returns `{posts:[{id, clip_id, state, phase, progress, title,
    description, tags, hashtags, video_url, privacy_status, upload_status, warning, error,
    not_before, wait_reason, insert_cap_reached}], autopost_pending}` (amended after the final
    review: `id` for the retry URL, `upload_status` for the uploaded chip, `wait_reason` and
    `insert_cap_reached` for the other chips and the retry confirm, and `autopost_pending`, true
    until the task's posts exist, so the page keeps polling).
    `clip_id` is the current clip of the lineage.
  - `POST /api/tasks/[id]/youtube/[postId]/retry` accepts `failed` or `blocked` posts and returns 409
    for `uploaded`. It enqueues the job and returns `worker_online`.
    - It resets the automatic retry budget (`attempts`).
    - It **adds one** to the `videos.insert` allowance (the cap becomes `insertCalls + 1`) instead of
      resetting it (our call). As built, the cap becomes `max(insertCap, insertCalls + 1)`, so an
      unused cap is never lowered (amended after the final review; Task 6 ruling). Before any new
      session, a saved `sessionUri` is still queried first.
    - When the post had already reached its insert cap, the confirm says: "If this clip is already on
      your channel, don't retry; it would post twice."
  - Every route uses `handle()` and `requireUser`, and is owner-only. Serializers never output
    `upload`, tokens, `claimedBy` or storage keys.
- **Settings, "YouTube" section** (every user, not only admins):
  - Not configured: a setup hint naming `GOOGLE_OAUTH_CLIENT_ID` and `GOOGLE_OAUTH_CLIENT_SECRET`
    and linking the setup doc. Never "Coming soon".
  - Not connected: a Connect button.
  - Connected:
    - the channel avatar, name and handle
    - the auto-post switch: "Publish every new clip to this channel as soon as it's ready"
    - visibility (Public) and made-for-kids (No) selects
    - a warning line
    - Reconnect, when `reauth_required`
    - Disconnect, behind a confirm
    - links to the YouTube Terms of Service, the Google Privacy Policy and
      myaccount.google.com/permissions
- **Task page:**
  - Each clip tile gets a status chip: "Waiting to post", "Writing title…", "Uploading…", "Posted ↗",
    "Private on YouTube", "Waiting for YouTube's daily limit (until 9:05 AM)", or "Failed" + reason +
    "Try again".
    - Also (amended after the final review): "Waiting for YouTube's channel upload limit",
      "Waiting to retry the upload" (+ the stored error), "Waiting for the new style to finish",
      "Reconnect YouTube to post" (+ the stored error when it says more than the pill, such as
      "Create a YouTube channel, then reconnect"), "Posting paused"; "Not posted" + the reason for
      a post cancelled with one (another channel, auto-post off, disconnected; a delete's cancel
      shows nothing); "Flagged by YouTube ↗" with the reason line for an upload YouTube rejected
      or failed (also on a private-locked upload, with the lock's line as the reason); and
      "Removed from YouTube" for a video deleted on YouTube before verification saw it finish
      processing (§4.6 reads a video only until its first final status, so a later deletion is
      not detected).
  - `ClipFocus` shows the posted title, description, hashtags and tags (read-only).
  - The page polls the posts route every 4 s while any post is `queued` or `working`. Task polling
    stops at completion, so this needs its own poll.
  - Copy goes in `messages/en/settings.json` and `task.json`.

### 4.9 Configuration

- `GOOGLE_OAUTH_CLIENT_ID` and `GOOGLE_OAUTH_CLIENT_SECRET` (env only; the feature is off when they
  are unset).
- `CLAUDE_METADATA_MODEL` (default `claude-sonnet-5`).
- Add each one to `env.ts`, `web/.env.example`, `docs/configuration.md` and the env-clearing list in
  `test-utils.ts`.
- The redirect base is `BETTER_AUTH_URL`.

## 5. From original SupoClip (`1dbb178`)

- **Reuse:**
  - Single-use random state bound to the user and provider, with a TTL.
  - `access_type=offline` + `prompt=consent` + `include_granted_scopes`.
  - `channels.list?mine=true`, with the "no channel" message.
  - Keep the old refresh token when Google doesn't resend it.
  - Disconnect locally before revoking.
  - Cancel pending posts on clip or task deletion and on disconnect.
  - The atomic `queued → working` claim.
  - Publish the clip's *current* render.
  - Never blindly retry an ambiguous upload.
  - Dedupe enqueues by key.
  - The caption prompt's "JSON is data, facts only, the transcript's language" framing.
- **Avoid:**
  - Retrying `quotaExceeded` at +5 and +10 min.
  - Discarding `errors[0].reason` and classifying by substring.
  - Treating every refresh error ≥400 as a reconnect.
  - A "resumable" upload that is one PUT with no saved session, where a retry re-uploads and can
    duplicate.
  - No metadata limit checks (30×100-character tags break the 500-character total).
  - Ignoring the returned `privacyStatus`; the original showed "Published" for locked-private
    videos.
  - Not checking granted scopes.
  - Leaving Testing-mode 7-day tokens undocumented.
  - Serializers leaking server paths and handles.
  - The raw transcript as the default caption, and a hardcoded model.
  - Appending `#Shorts`.
  - Hardcoding made-for-kids with no user choice, and leaving out `containsSyntheticMedia`.
  - A GET connect route.
  - Echoing `?error=` text.
  - Hiding the setup hint behind "Coming soon".

## 6. Google Cloud setup the user must do

1. Go to https://console.cloud.google.com, open the project picker, choose **New project**, name it
   "Clipwright", and click **Create**.
2. Under **APIs & Services → Library**, search for "YouTube Data API v3" and click **Enable**.
3. Open **Google Auth Platform** (APIs & Services → OAuth consent screen) and click **Get started**:
   - App name: Clipwright
   - Support email: yours
   - Audience: **External**
   - Contact email: yours
   - Agree, then **Create**.
4. Under **Data Access → Add or remove scopes**, add
   `https://www.googleapis.com/auth/youtube.upload` and
   `https://www.googleapis.com/auth/youtube.readonly`. Click **Update**, then **Save**.
5. Under **Audience**, click **Publish app** and confirm ("In production"). Do not stay in Testing:
   its tokens die every 7 days. The app stays unverified, which is fine for personal use.
6. Under **Clients → Create client**, choose **Web application** and name it "Clipwright local". Add
   the authorized redirect URI `http://localhost:3000/api/youtube/callback` exactly. It must match
   `BETTER_AUTH_URL`; if you use 127.0.0.1, add that variant too. Click **Create**.
7. **Copy the client secret now.** Google shows it only once. Put the values in `web/.env.local` as
   `GOOGLE_OAUTH_CLIENT_ID=…` and `GOOGLE_OAUTH_CLIENT_SECRET=…`, then restart `pnpm dev`.
8. In Clipwright, go to **Settings → YouTube → Connect**. On Google's "hasn't verified this app"
   screen, continue via **Advanced** (the exact labels are not confirmed). Pick the channel, leave
   **both** permissions ticked, and allow.
9. **First test.** Generate one short video. When its clips show "Posted", open YouTube Studio and
   confirm they are **Public**. Also check your email for a "locked as private" notice. If they are
   locked, the only fix is YouTube's API compliance audit (https://support.google.com/youtube/contact/yt_api_form);
   otherwise upload in Studio.
10. Optional: under **APIs & Services → YouTube Data API v3 → Quotas**, confirm the 100
    `videos.insert`/day limit. For a later Vercel deploy, add
    `https://<domain>/api/youtube/callback` to the same client.

## 7. Our calls (please check)

1. **One channel per user**, connected once in Settings. Reconnecting a different channel replaces
   it.
2. **Failed uploads retry automatically**, with backoff. The task page shows each clip's YouTube
   link, or its error and "Try again".
3. **Metadata language.** Metadata is written in the video's language. Claude detects it; we also set
   `defaultLanguage` and `defaultAudioLanguage`.
4. **Metadata model** is `claude-sonnet-5` by default ($2/$10 per MTok, against $5/$25 for Opus 5),
   overridable with `CLAUDE_METADATA_MODEL`.
5. **Title, description and tags are visible** on the task page, read-only.
6. **Posting starts when the task completes**, not as each clip renders. That is a minute or two
   later, and it means a cancelled run never posts.
7. **Skipped clips.** The fallback clip (shown when the AI picked nothing) is not posted. Combined
   clips, restyles and editor edits never trigger a post. A clip not yet uploaded goes out in its
   latest restyled look.
8. **Deleting doesn't remove videos.** Deleting a clip or task never removes the YouTube video.
   Delete is refused (409) only while that clip is mid-upload.
9. **Stopping cancels.** Disconnecting, or turning auto-post off, cancels clips that are not yet
   uploaded. Tasks completed before connecting are not backfilled.
10. **Settings fields.** Settings shows visibility (default **Public**) and made-for-kids (default
    **No**), because Google requires the choice to be shown. We always send
    `containsSyntheticMedia: false` and category 22 (People & Blogs).
11. **Notifications.** Only the top clip of each task notifies subscribers, so 10 clips don't send
    10 notifications at once.
12. **Hashtags** (3-5) go at the end of the description, written by Claude. There are none in the
    title, and no `#Shorts`.
13. **No fallback metadata.** If Claude is down, the post waits and retries; nothing is posted with
    fallback text.
14. **Our own OAuth routes**, not Better Auth's Google provider. Its offline-access and scope options
    were not verified for better-auth 1.6.9. Google credentials come from env only, not admin
    Settings.
15. **OAuth app "In production"** (unverified), not Testing.
16. **No metrics.** No view or like metrics are pulled back.
17. **Uploads share the worker's single slot** with renders.
18. **Resumed tasks post on completion**, like a first run. The errored or cancelled run before it never posted.
19. **A disconnected or paused account at completion:** posts are created `blocked` ("Reconnect YouTube to post"). They go out once the user reconnects or resumes posting, never silently skipped.
20. **Circuit breaker:** if YouTube returns a privacy other than the one requested, auto-post pauses and queued clips are held until "Resume posting" in Settings. Locked videos are not re-posted in v1.
21. **"Try again" allows exactly one more `videos.insert` call**, with a warning when the post already hit its cap. It never resets the duplicate guard.
22. **Switching to a different channel** cancels clips still waiting for the old channel (the chip shows "Not posted" with the reason "A different channel was connected."; amended after the final review). They are not redirected to the new one.

## 8. Left to the builder

- File and module layout (suggested: `server/youtube/*.ts`, `worker/handlers/publish-youtube.ts`,
  `components/settings/youtube-settings.tsx`), UI layout and exact copy.
- Whether to show byte-level upload progress (counting bytes from the read stream, throttled to
  1 write/s). The minimum is "Uploading…".
- The exact prompt wording within §4.5's rules. Whether to add an optional `effort` or `maxTokens`
  parameter to `requestStructured` (`low` effort suffices). Mapping `ai/client.ts`'s "AI analysis
  service" error strings to metadata wording.
- How to compute the next midnight Pacific (via `Intl` with `America/Los_Angeles`). The backoff
  constants within the stated shape.
- Fake base-URL env vars for e2e (following `ASSEMBLYAI_BASE_URL`). msw handlers for Google. Tests:
  - the unique lineage, and the status query returning 201 with no second insert
  - the delete/claim race and restyle lineage
  - the quota deferral
  - `invalid_grant` → blocked, and a missing scope
  - byte-limit enforcement
  - serializers never leaking secrets
- Updating DESIGN.md (§0, §2, §5, §6, §9), `web/src/worker/README.md`, `docs/configuration.md`, and
  a new `docs/youtube.md` holding §6.
- Whether to give uploads their own worker slot later (`claimJob` already takes a `types` filter).

## 9. Open risks

1. **Forced-private lock.** If Google still enforces it, every upload becomes private forever and
   nothing can be fixed after the fact. The first test (§6.9) and the verify step expose it, but the
   only cure is the audit. The audit checks RMF, which expects a user-editable title, so it may
   conflict with "no review step".
2. **Spam policy.** Ten AI-titled Shorts from one video, posted at once, every day, is close to what
   YouTube calls mass-produced repetitive content, and the penalties run from a warning to strikes.
   Re-running a video re-posts near-identical Shorts, which adds to this risk (YouTube may also mark
   them `rejected` as duplicates; verification surfaces that). This is the user's decision. `MAX_CLIPS` and the clip-length setting are the levers.
3. **Shared quota.** The 100 uploads/day and the 100-user lifetime cap belong to the one Cloud
   project, so they are shared if Clipwright ever gets more users.
4. **Narrow duplicate window.** A duplicate is still possible if Google completes an upload, the
   response is lost, *and* the session expires before the next status query. Retries happen within
   minutes, but the session lifetime is undocumented.
5. **Google unknowns** to confirm in the first test:
   - whether `categoryId` is required on insert
   - what happens when `selfDeclaredMadeForKids` or `containsSyntheticMedia` is left out (we always
     send both)
   - whether a status query on a completed session returns the resource
   - whether resume PUTs or retried initiations cost upload quota
   - the channel's daily upload limits
6. **The worker runs on the user's PC.** Posts wait while it is off, and a refresh token unused for
   6 months dies.
7. **Shared worker slot.** Uploads sharing the one worker slot can delay the next task's render by
   several minutes.
8. **Long clips.** A clip over 60 s (the "long" preset) with any copyright claim is blocked worldwide.
   This is unlikely for the user's own content, but music in the background can trigger a claim.
