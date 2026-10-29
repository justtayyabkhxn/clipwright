# YouTube auto-post

Clipwright can post every clip of a finished generation to your own YouTube channel as a public
Short, with a title, description, tags and hashtags written by Claude. Nobody reviews the uploads
before they go out, so read this page once before you turn it on.

## 1. Set up the Google Cloud project

Do this once. It creates the OAuth client Clipwright uses to ask for permission to upload to your
channel; Clipwright never sees your Google password.

1. Go to <https://console.cloud.google.com>, open the project picker, choose **New project**, name
   it "Clipwright", and click **Create**.
2. Under **APIs & Services → Library**, search for "YouTube Data API v3" and click **Enable**.
3. Open **Google Auth Platform** (APIs & Services → OAuth consent screen) and click **Get
   started**:
   - App name: Clipwright
   - Support email: yours
   - Audience: **External**
   - Contact email: yours
   - Agree, then **Create**.
4. Under **Data Access → Add or remove scopes**, add
   `https://www.googleapis.com/auth/youtube.upload` and
   `https://www.googleapis.com/auth/youtube.readonly`. Click **Update**, then **Save**.
5. Under **Audience**, click **Publish app** and confirm ("In production"). Do not stay in
   Testing: its tokens die every 7 days. The app stays unverified, which is fine for personal use.
6. Under **Clients → Create client**, choose **Web application** and name it "Clipwright local".
   Add the authorized redirect URI `http://localhost:3000/api/youtube/callback` exactly. It must
   match `BETTER_AUTH_URL`; if you use 127.0.0.1, add that variant too. Click **Create**.
7. **Copy the client secret now.** Google shows it only once. Put the values in
   `web/.env.local` as `GOOGLE_OAUTH_CLIENT_ID=…` and `GOOGLE_OAUTH_CLIENT_SECRET=…`, then restart
   `pnpm dev`.
8. In Clipwright, go to **Settings → YouTube → Connect**. On Google's "hasn't verified this app"
   screen, continue via **Advanced** (the exact labels are not confirmed). Pick the channel, leave
   **both** permissions ticked, and allow.
9. **First test.** Generate one short video. When its clips show "Posted", open YouTube Studio and
   confirm they are **Public**. Also check your email for a "locked as private" notice. If they
   are locked, the only fix is YouTube's API compliance audit
   (<https://support.google.com/youtube/contact/yt_api_form> — see
   [Forced-private uploads and the audit](#2-forced-private-uploads-and-the-audit) below);
   otherwise upload in Studio.
10. Optional: under **APIs & Services → YouTube Data API v3 → Quotas**, confirm the 100
    `videos.insert`/day limit. For a later Vercel deploy, add
    `https://<domain>/api/youtube/callback` to the same client.

## 2. Forced-private uploads and the audit

An unaudited ("unverified") Google Cloud project is sometimes restricted by YouTube so that videos
it uploads can never be made public — Google calls this project-level restriction out in a help
article, even though its public API reference does not always say so. If it applies to your
project, every clip Clipwright uploads comes back `privacyStatus: "private"` no matter what you
asked for, and **no later action can make that specific upload public**; only a fresh upload after
the restriction is lifted can be public.

Clipwright protects you from burning your daily upload quota on locked-private videos: the first
time any upload comes back with a privacy other than the one you picked, it stops there.
- Your account's status becomes `paused` (or stays reconnect-required), with the private-lock
  warning.
- Every clip still waiting to post is held (not uploaded), with the reason `private_lock`.
- Settings shows "YouTube made your uploads private. This happens until your API project passes
  YouTube's audit. Posting is paused until you resume it." and a **Resume posting** button.

The clip or clips that already uploaded locked-private stay as they are — Clipwright does not
retry or re-post them (v1). You can delete them yourself in YouTube Studio.

**To lift the restriction**, request YouTube's API compliance audit:
<https://support.google.com/youtube/contact/yt_api_form>. The audit checks Google's Required
Minimum Functionality rules, which expect a user-editable title before publishing — something this
feature deliberately skips (nobody reviews a clip before it posts), so the audit may take back and
forth to pass. Until it does, you have two options:
- Press **Resume posting** anyway to clear the pause and try again — useful if the lock was a
  one-off (YouTube's behavior here is inconsistent), but expect the same lock to trip again if it
  was not. The held clips go back in the queue at once; if the connection also needs renewing,
  they wait for **Reconnect** instead.
- Keep auto-post off and upload clips yourself in Studio.

## 3. How it behaves

- **Trigger.** When a generation (`process_task`) finishes, Clipwright creates one post per clip
  (skipping the fallback clip shown when Claude picked nothing) and starts uploading them in clip
  order. This also applies to a resumed run that completes. Restyles, combined clips and editor
  exports never post, and a clip not yet uploaded goes out in its latest restyled look.
- **Metadata.** For each clip, Claude (`CLAUDE_METADATA_MODEL`, default `claude-sonnet-5`) writes a
  title, description, 5–15 tags and 3–5 hashtags from the clip's own transcript — no invented
  facts, no links, no `#Shorts`, and the hashtags go at the end of the description rather than in
  the title. A title with a link, a hashtag or a line break goes back to Claude to be rewritten.
  If Claude is unavailable, the clip waits and retries; nothing is ever posted with fallback text.
- **Upload.** Each clip is uploaded as a public (or your chosen visibility) YouTube video,
  category "People & Blogs", with the made-for-kids answer you set in Settings. Uploads use
  YouTube's resumable protocol, so a dropped connection or worker restart resumes instead of
  re-uploading. Automatic retries, restarts and restyles never duplicate a clip; a manual
  **Try again** after the upload cap asks you to check your channel first.
- **Display.** The task page shows each clip's status — waiting, writing the title, uploading, a
  "Posted ↗" link, a warning, an error with "Try again", or why it was not posted — along with
  the title, description, tags and hashtags that were posted.
- **Quota.** `videos.insert` has its own 100-call/day bucket per Google Cloud project, reset at
  midnight Pacific. A generation makes at most `MAX_CLIPS` clips, so this allows about 10
  generations a day. When the quota is used up, every waiting clip is held until the reset; when a
  channel hits YouTube's own (separate, unpublished) daily upload limit, every clip waiting for
  that channel is held for 6 hours. An upload YouTube refuses for either limit does not count
  toward the clip's upload attempts.
- **Failures and retries.** A network error, rate limit or Google 5xx waits 1, then 5, then 15
  minutes before trying again; after that the post fails and shows "Try again". A reconnect-only
  error (an expired or revoked grant, a missing channel) blocks the post with "Reconnect YouTube to
  post" until you reconnect; if you disconnected the channel meanwhile, the post is cancelled
  instead. "Try again" on a failed or blocked post resets the automatic retry count and allows
  exactly one more upload attempt — it never resets the duplicate guard. It first checks the saved
  upload, so a clip that did reach your channel is found rather than posted again; that check can
  only miss if YouTube already expired the upload session, which is why a retry after the upload
  cap asks you to check your channel first.
- **Stopping.** Turning auto-post off, or disconnecting the channel, cancels every clip that has
  not uploaded yet (one already uploading may still finish). Deleting a clip or a task never
  removes a video already on YouTube; it is refused for a moment if that clip is mid-upload. A
  task delete refused that way still cancels the task's other waiting clips (they then show no
  chip). Connecting a different channel cancels clips still waiting for the old one ("Not posted",
  with the reason "A different channel was connected."); they are not redirected to the new channel.
- **What's not included (v1).** No review step before posting. No scheduling. One channel per
  user. No TikTok/Instagram. No thumbnails, playlists or view/like metrics. Tasks completed before
  you connected YouTube are never backfilled.

## 4. Troubleshooting

### Connecting (redirected to `/settings?youtube_error=<code>`)

| Code | Meaning | Fix |
|---|---|---|
| `not_configured` | `GOOGLE_OAUTH_CLIENT_ID` / `GOOGLE_OAUTH_CLIENT_SECRET` are not set. | Finish [step 1](#1-set-up-the-google-cloud-project) and restart the server. |
| `denied` | You declined access on Google's consent screen. | Click Connect again and allow both permissions. |
| `expired` | The connection link expired, or the browser lost the session cookie mid-flow. | Click Connect again; finish the Google screens promptly. |
| `missing_scope` | You unticked one of the two permissions. | Reconnect and leave both ticked — upload and read access are both required. |
| `no_channel` | The Google account you signed in with has no YouTube channel. | Create a channel on that Google account, or sign in with a different one when reconnecting. |
| `exchange_failed` | The code exchange, the channel lookup, or saving the account failed (network error, wrong client secret, or Google was unreachable). | Check the client ID/secret and try again. The server log has the real reason; Google's own error text is never shown. |

### On the task page (per clip)

| What you see | Meaning | Fix |
|---|---|---|
| "Waiting to post" | Queued; the worker hasn't picked it up yet, or it is waiting for its turn. | Nothing to do — check the worker is running (`pnpm dev` / `pnpm worker`). |
| "Writing title…" / "Uploading…" | In progress. | Nothing to do. |
| "Waiting to retry the upload" + reason | A network error, a rate limit, a Google 5xx or Claude being unavailable; it tries again after 1, then 5, then 15 minutes (2 minutes when the worker stopped mid-upload). The line under it names the error. | Nothing to do; if the last try fails too, it shows "Failed" with "Try again". |
| "Waiting for the new style to finish" | A restyle of this task is running; the clip uploads in its new look once it finishes. | Nothing to do. |
| "Waiting for YouTube's daily limit (until …)" | The project's 100/day `videos.insert` quota is used up; every waiting clip is held until just after midnight Pacific. | Wait; it resumes automatically at the time shown. |
| "Waiting for YouTube's channel upload limit" | The channel hit YouTube's own (unpublished) daily upload limit; every clip waiting for that channel is held for about 6 hours. No time is shown. | Wait; it resumes automatically. |
| "Posted ↗" | Uploaded; the link opens the video. | — |
| "Private on YouTube" | YouTube returned a privacy other than the one you chose (at upload or on verification). | See [the audit section](#2-forced-private-uploads-and-the-audit). |
| "Flagged by YouTube ↗" + reason | YouTube rejected or failed the video after processing; the line under it names the reason (for example a duplicate upload), or says "YouTube made this video private" when the video was also forced private. | Open the video in YouTube Studio. Clipwright never re-posts an uploaded clip. |
| "Removed from YouTube" | The video was deleted on YouTube before verification saw it finish processing. Verification reads each video only until its first final status (usually 10–15 minutes after the upload), so a video deleted later is not detected and keeps its "Posted ↗" link. | Nothing to do; Clipwright never re-posts an uploaded clip. |
| "Reconnect YouTube to post" | The refresh token was revoked or expired, or YouTube refused the grant (a missing permission, or the Google account has no channel: the line under it then says "Create a YouTube channel, then reconnect"). | Settings → YouTube → **Reconnect**. The clip posts once you have. |
| "Posting paused" | The forced-private circuit breaker tripped (see [§2](#2-forced-private-uploads-and-the-audit)). | Settings → YouTube → **Resume posting**, after requesting the audit (or to retry once). |
| "Failed" + reason + "Try again" | A permanent error (invalid metadata YouTube rejected twice, the retry budget ran out, or Google refused the server's OAuth client, in which case the reason names the two `GOOGLE_OAUTH_*` variables to check). | Read the reason; "Try again" retries, with one extra upload attempt. If the clip might already be on your channel, check before retrying — posting it twice is possible if it actually succeeded and YouTube has since expired its upload session. |
| "Not posted" + reason | The clip was cancelled before it uploaded. The line under it says why: a different channel was connected, auto-post was turned off, or the YouTube account was disconnected. | Nothing to retry; a cancelled clip never posts. Download it and upload it yourself if you still want it on YouTube. |

No clip is ever shown as fine when it silently failed: a stuck upload either shows "Uploading…", a
specific wait reason, or an error with "Try again" — never nothing.

## 5. Settings reference

**Settings → YouTube** (every user, not only admins):
- Not configured: a hint naming the two env vars and this page.
- Not connected: a **Connect YouTube** button (starts the Google OAuth flow above).
- Connected: your channel's avatar, name and handle; the auto-post switch; visibility (default
  Public) and made-for-kids (default No) selects, which Google requires you to be shown; a warning
  line when something needs attention; **Reconnect** when the connection needs renewing;
  **Disconnect** behind a confirmation; and links to the YouTube Terms of Service, the Google
  Privacy Policy and your Google account's connected-apps page.

See [Configuration](configuration.md) for the four environment variables, and
[`docs/port/DESIGN.md`](port/DESIGN.md) §2/§5/§6/§9 for the full behavioral spec.
