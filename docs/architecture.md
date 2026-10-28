# Architecture

This is the overview. The authoritative contracts (every route, collection, job and engine
command) are in [`docs/port/DESIGN.md`](port/DESIGN.md).

## Components

```
Browser ──HTTP──▶ Next.js app (web/)  ──────────────┐
  polls every 2 s   UI pages + API route handlers    │  MongoDB
                    (src/app, src/server)            ├─ users, sessions (Better Auth)
                          │ enqueue jobs             ├─ tasks, clip_drafts, jobs
                          ▼                          ├─ processing_cache, app_settings
                    Node worker (web/src/worker) ────┤  worker_status
                          │ spawn per step           │
                          ▼                          │
                    Python engine (engine/)          │  DATA_DIR/storage  (durable files)
                    ffmpeg, OpenCV, yt-dlp,          │  DATA_DIR/work     (job temp dirs)
                    AssemblyAI                       │
                          ▲                          │
                    Claude (Anthropic API) ◀─────────┘ called by the worker, in TypeScript
```

| Component | Where | What it does |
|---|---|---|
| Web app | `web/` (Next.js 15, React 19, Tailwind v4) | Pages (`src/app`), API route handlers (`src/app/api`, `runtime = "nodejs"`), server modules (`src/server`). Route handlers only read and write MongoDB and storage, and enqueue jobs. They never run Python or ffmpeg. |
| Auth | `src/server/auth.ts` | Better Auth with email/password and the MongoDB adapter. The first sign-up (and any `ADMIN_EMAILS` address) becomes admin. |
| Worker | `web/src/worker` (run with `tsx`) | Claims jobs from the `jobs` collection with a lease, runs the handler, writes progress back to the task or job. Also runs a cleanup cron every 5 minutes. See [`web/src/worker/README.md`](../web/src/worker/README.md). |
| Clip selection | `web/src/server/ai` | Claude calls with JSON-schema structured output: windowing, validation, grounding, dedupe and rerank. See [Claude integration](claude-integration.md). |
| Render engine | `engine/` (Python 3.11, uv) | A CLI: JSON request on stdin, NDJSON events on stdout. Downloads YouTube with yt-dlp (Node as its JS runtime), normalizes sources, transcribes with AssemblyAI, extracts signals, renders 9:16 clips with face-aware cropping and burned captions, and does the editor renders. It never touches MongoDB, never calls an LLM and never reads key env vars. See [`engine/README.md`](../engine/README.md). |
| Database | MongoDB (Atlas recommended) | All state except media files. No multi-document transactions in app code; every multi-step write is a single-document atomic update (compare-and-set). |
| Storage | `src/server/storage.ts` | A `Storage` interface with one driver, `LocalStorage`, rooted at `DATA_DIR/storage`. |

## A generation, step by step

1. **Upload (optional).** The browser calls `POST /api/upload/authorization` (local storage answers
   `{directUpload: false}`), then streams the file to `POST /api/upload`. The route streams the
   multipart field `video` to `uploads/{uuid}{ext}` with busboy, never buffering it, and returns
   `video_path: "upload://{uuid}{ext}"`.
2. **Create.** `POST /api/tasks/create` validates and normalises the options. A YouTube URL is
   host-checked (youtube.com, m.youtube.com, music.youtube.com, youtu.be) and stored as
   `https://www.youtube.com/watch?v={id}`; an `upload://` reference must exist in storage. The route
   inserts a `queued` task and a `process_task` job, and returns
   `{task_id, job_id, message, worker_online}`. When `worker_online` is false the UI says the worker
   isn't running; the job waits in the queue.
3. **Claim.** A worker slot claims the job (`findOneAndUpdate`, 60 s lease, heartbeat every 15 s).
4. **Process.** The `process_task` handler moves the task to `processing` and calls the engine one
   command at a time, each with its own work dir and cancel file. The progress messages are fixed:
   - 10 "Downloading video..." — `youtube-info` (duration guard, title) and `fetch-youtube` into
     `sources/youtube/{id}/source.mp4` (reused when present), or the upload's file.
   - 15 "Preparing video..." — `prepare-source` (normalize, duration guard).
   - 30 "Generating transcript..." — `transcribe` with AssemblyAI; word timings are saved in a
     `.transcript_cache.json` sidecar next to the video and reused on later runs.
   - 50 "Analyzing content with AI..." — `signals`, then Claude `selectClips()` in the worker.
     Transcript and analysis are cached in `processing_cache`, keyed by the source URL.
   - 70 "Creating video clips..." / "Creating clip i/N..." — `render-clips`. Each clip is moved to
     `clips/{taskId}/{filename}` and pushed onto the task as soon as it renders.
   - 100 "Complete!"
5. **Poll.** The task page polls `GET /api/tasks/{id}` and `GET /api/tasks/{id}/clips` every 2 s while
   the task is active, and plays clips from `GET /api/tasks/{id}/clips/{clipId}/file` (Range support).

**Cancel** sets the task `cancelled` and flags the job; the worker's next heartbeat sees the flag,
writes the engine's cancel file, and kills the process tree after 5 s. **Resume** re-enqueues
`process_task`; cached downloads, transcripts and analyses make it cheap.

**Restyle** (`POST /api/tasks/{id}/settings` with `apply_to_existing: true`) saves the new settings,
sets the task `processing` ("Applying new style...") and enqueues `restyle_task` with
`{cleanupChanged, previousSettings}`. The old clips stay visible until all re-rendered clips are
swapped in with one write. A cancelled or failed restyle puts the task back to `completed` with
the old clips and the old settings.

## An editor export, step by step

1. **Prepare.** Opening a clip in the editor calls `POST .../clips/{clipId}/editor/prepare`. The
   `prepare_editor` job runs `editor-prepare`, writes `editor/{clipId}/{basisHash}/clean.mp4` (the
   clip without burned captions) and `thumbnails.jpg`, and seeds the draft (revision 0) in
   `clip_drafts`. The editor polls `GET .../editor` until the draft is `ready`.
2. **Edit.** The editor works on an edit document (timeline, captions, style). Autosave sends
   `PATCH .../editor` with the revision it started from; the server accepts it only if the revision
   still matches, so two tabs cannot overwrite each other silently. Undo/redo is client-side.
3. **Export**, two ways:
   - **In the browser:** `mediabunny` encodes the document client-side (WebCodecs). If the browser
     cannot encode it, the UI suggests the server export.
   - **On the server:** `POST .../editor/exports` with `{basis, preset?, document}` returns 202 and
     `worker_online`. The `export_editor` job runs `editor-render` into `editor-exports/{jobId}.mp4`.
     The editor polls `GET .../editor/exports/{jobId}` and downloads `.../file`. `DELETE` cancels.
4. **Combine.** `POST /api/tasks/{id}/editor/combine` with 2 to 20 prepared clip ids runs
   `editor-combine`, appends a new clip with a ready draft, and writes the combined export.

Preset exports from the task page (`POST .../clips/{clipId}/exports`, presets `tiktok`, `reels`,
`shorts`) run `export_clip` into `exports/{jobId}.mp4`. They are idempotent per clip file and preset
and expire after 7 days.

## Job types

| Type | Payload | Engine commands | Max attempts |
|---|---|---|---|
| `process_task` | none (the task holds everything; `task.run.jobId` = job id) | `youtube-info`, `fetch-youtube` or upload lookup, `prepare-source`, `transcribe`, `signals`, `render-clips` | 2 |
| `restyle_task` | `{cleanupChanged, previousSettings}` | `render-clips` (plus `fetch-youtube` if the cached source was swept) | 2 |
| `prepare_editor` | `{filename}` | `editor-prepare` | 2 |
| `export_editor` | `{document, preset, basis}` | `editor-render` | 1 |
| `combine_editor` | `{inputs}` | `editor-combine` | 1 |
| `export_clip` | `{preset, filename}` | `export-preset` | 1 |
| `publish_youtube` | `{postId}` | none (plain `fetch` to Claude and Google) | 3 |

Only one `process_task`/`restyle_task` can be active per task (unique `activeKey` `task:{taskId}`),
one `prepare_editor` per clip, and one `publish_youtube` per post (`activeKey` `youtube:{postId}`).
If a worker dies, the reaper requeues its jobs when the lease expires; when attempts run out it
runs the job type's failure hook (for example the task goes to `error` with "The worker stopped
while processing this video. Resume to try again."; a `publish_youtube` post goes back to `queued`
with a 2-minute wait, or `failed` once its retries are used up).

**YouTube auto-post** (optional, off unless `GOOGLE_OAUTH_CLIENT_ID`/`GOOGLE_OAUTH_CLIENT_SECRET`
are set): when a generation completes, Clipwright uploads every non-fallback clip to the user's own
connected channel as a public Short, with a title, description, tags and hashtags written by
Claude. See [`docs/youtube.md`](youtube.md) for setup and behavior, and DESIGN.md §2/§5/§6/§9 for
the full contract.

## Data model summary

| Collection | Key fields |
|---|---|
| `user`, `session`, `account`, `verification` | Better Auth's own. `user` also has `is_admin` and `preferences {fontFamily, fontSize, fontColor, clipLength}`. |
| `tasks` | `userId`, `status` (`queued → processing → completed / error / cancelled`), `progress`, `progressMessage`, `source {type, url, title, videoId?}`, `settings` (caption template, font, output format, subtitles, clip length, cleanup), `clips[]` (embedded; scores, hook title, `sourceRanges`, `keepRanges`), `run {jobId, type, startedAt, completedAt, ...}`. |
| `clip_drafts` | `_id` = clip id. Editor draft: `basis` (the clip filename it was prepared from), `status`, `revision`, `document`, `original`, `media` keys. |
| `jobs` | Queue: `type`, `taskId`, `clipId?`, `payload`, `status`, lease fields (`lockedBy`, `lockedUntil`), `attempts`, `cancelRequested`, `progress`, `result`, `expiresAt`. |
| `processing_cache` | `_id` = sha256 of source type and URL. `transcriptText` and one Claude analysis per clip length. |
| `app_settings` | `_id` = `ANTHROPIC_API_KEY`, `ASSEMBLY_AI_API_KEY` or `CLAUDE_MODEL`. AES-256-GCM encrypted value plus `preferAdminValue`. |
| `worker_status` | One document, heartbeat every 10 s. The worker counts as online when it is under 30 s old. |
| `youtube_accounts` | `_id` = userId (one connected channel per user). Encrypted tokens, `status`, `autoPost`, `privacy`, `madeForKids`, a `warning` (e.g. the forced-private lock). |
| `oauth_states` | `_id` = the OAuth state. Single-use, TTL-deleted after 10 minutes. |
| `youtube_posts` | One post per clip *lineage* (unique on `lineageId`), so a restyle can never re-post a clip. `state` (`queued → working → uploaded`, or `blocked`/`failed`/`cancelled`), the stored metadata, `videoId`/`videoUrl` once uploaded. |

## Storage layout

Everything lives under `DATA_DIR` (default `<repo>/data`, git-ignored).

| Path under `DATA_DIR/storage` | Content | Lifetime |
|---|---|---|
| `uploads/{uuid}{ext}` and `uploads/{uuid}.transcript_cache.json` | Uploaded source and its word timings | Deleted with the task; swept once over 24 h old if no task uses it |
| `sources/youtube/{videoId}/source.mp4` | Downloaded YouTube source, shared across tasks | Swept once it is over 24 h old and no task references the video |
| `sources/youtube/{videoId}/source.transcript_cache.json` | Its word timings | Kept (makes re-runs free of AssemblyAI cost) |
| `clips/{taskId}/{filename}` | Rendered clips | Deleted with the clip or task |
| `editor/{clipId}/{basisHash}/clean.mp4`, `thumbnails.jpg` | Editor preview media | Deleted with the clip or task |
| `editor-exports/{jobId}.mp4` | Editor and combine exports | 7 days |
| `exports/{jobId}.mp4` | Preset exports | 7 days |
| `fonts/{userId}/...` | User-uploaded fonts | Deleted with the account |

`DATA_DIR/work/{jobId}/{claim token}` holds each job attempt's temp files and the engine's cancel
file. The cron removes work dirs older than 24 h.
