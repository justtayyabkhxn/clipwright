# Clipwright — architecture and contracts

Clipwright is the rebrand and re-platform of the SupoClip + Claude fork. **Every
implementation agent builds against this document.** If something here contradicts the
`map-*.md` files, this document wins. For behaviour details it does not restate (prompts,
algorithms, validation rules), the map files and the original code in git history (commit
`1dbb178`) are the spec.

## 0. Product decisions (fixed)

| Topic | Decision |
|---|---|
| Name | **Clipwright**. Every user-visible "SupoClip" string goes. The AGPL-3.0 license and the upstream copyright notice stay, plus a "Based on SupoClip" credit and a source-code link in the footer and README. |
| Stack | One Next.js 15 app (`web/`) holding the UI, all API route handlers, and a Node worker process (`web/src/worker`). MongoDB is the only database. A Python render engine (`engine/`) runs as a CLI subprocess of the worker. |
| Runs | Locally on Windows, macOS and Linux with no Docker. `pnpm dev` starts Next and the worker. It must remain deployable to Vercel later: no code in route handlers may need Python, ffmpeg or a long-running process. |
| Database | MongoDB Atlas (a replica set), configured by `MONGODB_URI`. Transactions are not required; every multi-step write is designed as single-document atomic updates. |
| LLM | Anthropic Claude only, via `@anthropic-ai/sdk`. Default model `claude-opus-5`. |
| Transcription | AssemblyAI only, inside the Python engine (reusing the tested code). Whisper and YouTube captions are dropped. |
| Sources | YouTube URLs (yt-dlp, using **Node** as the yt-dlp JS runtime) and uploaded files. Twitch, Kick, Apify, RapidAPI, residential proxy, section downloads and TimeMaps are dropped. A YouTube source is always a full file. |
| Auth | Better Auth (email/password) with `mongodbAdapter`. The **first user to sign up becomes admin**; `ADMIN_EMAILS` (comma-separated) also grants admin at sign-up. Password reset: if no email transport is configured, the reset URL is logged to the server console (`[auth] Password reset link for <email>: <url>`). Email verification is off. |
| Keys | `ANTHROPIC_API_KEY`, `ASSEMBLY_AI_API_KEY` and `CLAUDE_MODEL` can come from env vars or be saved by an admin in Settings, encrypted in Mongo. The precedence rules are unchanged from SupoClip (section 5). |
| Kept features | Create (YouTube or upload), all generation options, live progress, library, task page (clip wall, scores, focus view, downloads, preset exports, restyle, delete clip and task, cancel and resume), the full editor (prepare, drafts, autosave, undo/redo, browser and server export, combine, apply style to all), settings (Claude and AssemblyAI keys, model, caption defaults, delete account), fonts (bundled plus user upload). |
| Dropped | Billing, social and analytics, admin pages (apart from the settings admin gate), API keys and MCP, affiliate, B-roll, emails/SES, PostHog/DataFast/Axiom, all i18n except English (next-intl stays, English only), marketing/blog/SEO/landing/status pages, iOS integration, announcements, feedback, **share links**, **the legacy trim/split/merge/captions/regenerate/legacy-export endpoints** (the editor covers them), transitions (never applied), SSE (replaced by polling). |
| Restyle | `POST /api/tasks/:id/settings` with `apply_to_existing: true` enqueues a `restyle_task` job instead of rendering inside the request (section 6.2). |
| Processing mode | Fixed at `"fast"`. Neither the UI nor the API exposes it. |

## 1. Repository layout

```
web/                         Next.js app (package name "clipwright")
  fonts/                     bundled TTFs (moved from backend/fonts). Served by /api/fonts/[name]; passed to the engine
  messages/en/*.json         English catalogs only
  src/app/                   pages and route handlers (runtime = "nodejs")
  src/server/                server-only modules (section 3); also imported by the worker
  src/worker/                worker entry point and job handlers
  src/lib/                   client and shared helpers (existing files, pruned)
  src/lib/caption-templates.json   generated from engine/clipwright_engine/caption_templates.py; an engine test asserts they match
engine/                      Python render engine (uv project, Python 3.11)
  pyproject.toml, uv.lock
  clipwright_engine/__main__.py, cli.py, config.py, plus the media modules moved from backend/src
  tests/
data/                        git-ignored. DATA_DIR default: storage/ (durable files) and work/ (job temp dirs)
docs/                        documentation
```

`backend/`, `mcp/`, `observability/`, `docker-compose.yml`, `init.sql`, `start.sh`, `install_cron.sh`, all Dockerfiles, the Prisma schema and migrations, and everything else that belongs to a dropped feature are deleted at the end.

## 2. Environment variables

Read in `web/src/server/env.ts` (server-only, parsed with zod, with the defaults below). Both the Next app and the worker load `web/.env.local` (the worker loads it with `@next/env`'s `loadEnvConfig`).

| Var | Default | Meaning |
|---|---|---|
| `MONGODB_URI` | required | Atlas connection string |
| `MONGODB_DB` | `clipwright` | Database name |
| `BETTER_AUTH_SECRET` | required (at least 32 characters) | Auth secret. Also the fallback encryption secret |
| `BETTER_AUTH_URL` | `http://localhost:3000` | Public base URL |
| `APP_SETTINGS_ENCRYPTION_KEY` | falls back to `BETTER_AUTH_SECRET` | At least 16 characters; AES-256-GCM key = sha256(secret) |
| `ADMIN_EMAILS` | "" | Comma-separated emails that become admin at sign-up |
| `DISABLE_SIGN_UP` | false | |
| `ANTHROPIC_API_KEY`, `ASSEMBLY_AI_API_KEY` | none | May instead be saved in Settings |
| `CLAUDE_MODEL` | `claude-opus-5` | May be saved in Settings |
| `CLAUDE_RERANK_MODEL` | = `CLAUDE_MODEL` | Long-video rerank model |
| `DATA_DIR` | `<repo>/data` (resolved from `web/`'s parent) | Storage root (`storage/`) and job temp (`work/`). Keep it short and ASCII on Windows |
| `STORAGE_DRIVER` | `local` | Only `local` is implemented; the interface keeps Blob/R2 possible |
| `ENGINE_DIR` | `<repo>/engine` | |
| `ENGINE_PYTHON` | `engine/.venv/Scripts/python.exe` on Windows, `engine/.venv/bin/python` elsewhere | Never the bare `python` on PATH (on Windows that is the Microsoft Store stub) |
| `WORKER_CONCURRENCY` | 1 | Jobs run at once |
| `MAX_VIDEO_DURATION` | 5400 | Seconds |
| `MAX_VIDEO_UPLOAD_BYTES` / `NEXT_PUBLIC_MAX_VIDEO_UPLOAD_BYTES` | 4000000000 | |
| `MAX_CLIPS` | 10 | |
| `CLIP_DURATION` | 30 | Fallback clip length for `auto` |
| `TRANSCRIPTION_LANGUAGE` | "" | Empty or `auto` means detect |
| `ASSEMBLY_AI_HTTP_TIMEOUT_SECONDS` | 900 | |
| `SPEAKER_FRAMING` | true | |
| `HOOK_FIRST_TEASER` | false | |
| `YOUTUBE_MAX_HEIGHT` | 1080 | |

`web/.env.example` documents all of them, with placeholders only.

## 3. Server modules (`web/src/server`)

These are shared by the route handlers and the worker. Every module starts with `import "server-only"`, **except the ones the worker imports**. The worker runs under `tsx`, outside Next, so modules it imports must not import `server-only` or `next/*`. Instead, the rule "never import from client code" is enforced by putting these modules under `src/server`, which is never imported by `"use client"` files.

| File | Exports |
|---|---|
| `env.ts` | `env` (typed, with defaults), `paths` `{repoRoot, dataDir, storageRoot, workRoot, engineDir, enginePython, bundledFontsDir}` |
| `db.ts` | `getDb()`, `getClient()` (one cached `MongoClient` on `globalThis`), `collections()` typed accessors, `ensureIndexes()` (idempotent; run by the worker at startup and lazily by route handlers once per process) |
| `types.ts` | Document types: `TaskDoc`, `ClipDoc`, `DraftDoc`, `JobDoc`, `ProcessingCacheDoc`, `AppSettingDoc`, `WorkerStatusDoc`, `EditDocument` (zod schema plus type), `CaptionSettings`, `SourceRange` |
| `auth.ts` | Better Auth instance (`mongodbAdapter(db, {client})`, `nextCookies()`, `additionalFields.is_admin {type:"boolean", input:false, defaultValue:false}`, `databaseHooks.user.create.before` for admin bootstrap, `deleteUser.beforeDelete` → `deleteAllUserData(userId)`, the console password-reset sender) |
| `session.ts` | `getSessionUser(request?)` → `{id, email, name, isAdmin}` or null; `requireUser()` / `requireAdmin()`, which return the user or throw an `ApiError(401/403)` |
| `http.ts` | `ApiError(status, detail)`, `json(data, init)`, `handle(fn)` (wraps a route: ApiError becomes `{detail}`, a ZodError becomes 400 `{detail}`, anything else is logged and becomes 500 `{detail:"An internal server error occurred."}`), `serveStorageFile(request, key, {filename, download, contentType, cacheControl})` with **Range/If-Range support** (206, `Accept-Ranges: bytes`) |
| `storage.ts` | `Storage` interface plus `LocalStorage` (section 4); `getStorage()` |
| `settings.ts` | `encryptSetting` / `decryptSetting` (format `v1:<b64url nonce12>:<b64url tag16>:<b64url ct>`, byte-compatible with the Python version), `getRuntimeSettings()` → `{anthropicApiKey, assemblyAiApiKey, claudeModel, claudeRerankModel}` with precedence applied, `getSettingStatuses()` (the RuntimeSetting array for the UI), `updateSettings({updates, delete_keys, prefer_admin_values}, userId)`, `maskSecret` |
| `jobs.ts` | Queue primitives (section 6): `enqueueJob`, `claimJob`, `heartbeatJob`, `finishJob`, `requestCancel`, `reapExpiredJobs`, `workerHealthy()` |
| `tasks.ts` | Task repository and serializers: `createTask`, `getTaskForUser` (404/403), `listTasks`, `serializeTask`, `serializeClip`, `serializeTaskSummary`, `casStatus(taskId, expected[], set)`, `pushClip`, `clearClips`, `replaceClips`, `removeClip`, `appendClip`, `deleteTaskCompletely(taskId)`, `deleteAllUserData(userId)`, plus the normalisers ported from Python (font options, cleanup, clip length, output format) |
| `drafts.ts` | Editor draft repository: `getDraft`, `startPrepare`, `completePrepare`, `failPrepare`, `saveDraft` (revision CAS), `readEditorState` (with `upgradeDocument` and `captionLooks`) |
| `engine.ts` | `runEngine(command, request, {onEvent, signal, cancelFile, timeoutMs})` → result data. Spawns `ENGINE_PYTHON -X utf8 -m clipwright_engine <command>` with `cwd=engineDir`, `env {PYTHONUTF8:"1", PYTHONIOENCODING:"utf-8"}` and `windowsHide:true`; writes JSON to stdin; parses NDJSON on stdout; collects stderr (last 4 KB goes into error messages). On abort or timeout it writes the cancel file, waits 5 s, then kills the tree (Windows: `taskkill /PID <pid> /T /F`; elsewhere `SIGKILL`). Throws `EngineError {code, message}` / `EngineCancelled`. |
| `ai/*.ts` | The Claude clip-selection port (section 8) |
| `caption-templates.ts` | Reads `src/lib/caption-templates.json`; `templateInfo()` for `/api/caption-templates`; `captionLooks()` (a port of `editor_service.caption_looks`); `upgradeDocument()` |
| `fonts.ts` | `listFonts(userId)`, `resolveFontFile(name, userId)`, `saveUserFont(userId, file)`, `deleteUserFont(userId, name)`, plus a TTF name-table reader for `display_name` |

## 4. Storage

```ts
interface Storage {
  // Absolute local path for a key, for the engine. LocalStorage returns the path under storageRoot
  // (creating parent dirs). A remote driver would download into a cache first.
  localPath(key: string): Promise<string>;
  // Make a local file available at `key` (LocalStorage renames it when it is not already there).
  // DATA_DIR/work and DATA_DIR/storage share a volume, so rename never hits EXDEV.
  putFile(key: string, localFile: string): Promise<void>;
  writeStream(key: string, body: ReadableStream<Uint8Array> | NodeJS.ReadableStream, opts?: {maxBytes?: number}): Promise<{size: number}>;
  stat(key: string): Promise<{size: number; mtimeMs: number} | null>;
  createReadStream(key: string, range?: {start: number; end: number}): NodeJS.ReadableStream;
  delete(key: string): Promise<void>;          // missing is fine
  deletePrefix(prefix: string): Promise<void>;
  list(prefix: string): Promise<{key: string; size: number; mtimeMs: number}[]>;
}
```

Keys never contain `..`, backslashes or a leading `/` (validate them). Layout:

| Key | Content |
|---|---|
| `uploads/{uuid}{ext}` | Uploaded source. `ext` is lowercase, from the allowed set (.mp4 .mov .avi .mkv .webm .m4v) |
| `uploads/{uuid}.transcript_cache.json` | Its word timings (written by the engine next to the file) |
| `sources/youtube/{videoId}/source.mp4` | Downloaded YouTube source (normalized) |
| `sources/youtube/{videoId}/source.transcript_cache.json` | Its word timings. **Durable, never TTL-deleted** |
| `clips/{taskId}/{filename}` | Rendered clips |
| `editor/{clipId}/{basisHash}/clean.mp4`, `.../thumbnails.jpg` | Editor preview media. `basisHash` = the first 16 hex characters of sha256(clip.filename) |
| `editor-exports/{jobId}.mp4` | Editor and combine export outputs |
| `exports/{exportId}.mp4` | Preset exports |
| `fonts/{userId}/usr-{userId8}-{stem}.{ttf,otf}` | User fonts |

Task `source.url` for uploads is `upload://{uuid}{ext}`, as before (the client receives it from `/api/upload`). Storage key = `uploads/` + the part after `upload://`. Reject anything that does not match `^upload://[0-9a-f-]{36}\.(mp4|mov|avi|mkv|webm|m4v)$`.

## 5. MongoDB collections and indexes

Every app document carries `createdAt`/`updatedAt` Dates, and every write `$set`s `updatedAt` itself. Ids are strings (`crypto.randomUUID()`), except Better Auth's own.

### Better Auth (`user`, `session`, `account`, `verification`)
- Created by the adapter (`usePlural: false`, default ObjectId ids; `user.id` reaches the app as a hex string). `user` also holds `is_admin: boolean` and `preferences?: {fontFamily, fontSize, fontColor, clipLength}`, which only the app writes (driver `updateOne` on `{_id: new ObjectId(userId)}`).
- Indexes: `user {email:1}` unique; `session {token:1}` unique, `{userId:1}`, `{expiresAt:1}` TTL 0; `account {userId:1}`, `{providerId:1, accountId:1}`; `verification {identifier:1}`, `{expiresAt:1}` TTL 0.

### `tasks`
```ts
type TaskDoc = {
  _id: string; userId: string;
  status: "queued" | "processing" | "completed" | "error" | "cancelled";
  progress: number; progressMessage: string;
  source: { type: "youtube" | "upload"; url: string; title: string; videoId?: string; durationSeconds?: number };
  settings: {
    fontFamily: string | null; fontSize: number | null; fontColor: string | null;   // null = template default
    captionTemplate: string; outputFormat: "vertical"|"vertical_fit"|"vertical_pan"|"vertical_split"|"original";
    addSubtitles: boolean; clipLength: "auto"|"short"|"medium"|"long";
    cutLongPauses: boolean; pauseThresholdMs: number; removeFillerWords: boolean; filteredWords: string[];
  };
  clips: ClipDoc[];                       // array position + 1 = clip_order
  run?: { jobId: string; startedAt?: Date; completedAt?: Date; cacheHit?: boolean; errorCode?: string };
  editLock?: { jobId: string; until: Date } | null;
  createdAt: Date; updatedAt: Date;
};
type ClipDoc = {
  id: string; filename: string; storageKey: string;
  startTime: string; endTime: string; duration: number; text: string;
  relevanceScore: number; reasoning: string;
  viralityScore: number; hookScore: number; engagementScore: number; valueScore: number; shareabilityScore: number;
  hookType: string | null; hookTitle: string | null;
  sourceRanges: { start: number; end: number }[];      // source seconds, play order
  keepRanges?: [number, number][];                     // ranges the renderer used (restyle keeps cleanup unchanged)
  captionSettings?: { position_y?: number; font_size?: number; position?: string; highlight_words?: string[] };
  createdAt: Date; updatedAt: Date;
};
```
Indexes: `{userId:1, createdAt:-1}`, `{status:1, updatedAt:1}`.

### `clip_drafts` (`_id` = clipId)
`{_id, taskId, userId, basis, status:"preparing"|"ready"|"failed", error?, jobId?, asset?:{width,height,fps,duration,hasAudio,waveform}, media?:{cleanKey, thumbnailsKey}, revision, document?, original?, createdAt, updatedAt}`. Index `{taskId:1}`. A draft whose `basis` ≠ the clip's current filename counts as unprepared; prepare overwrites it.

### `jobs`
```ts
type JobDoc = {
  _id: string;                 // 32 lowercase hex (randomUUID without dashes); editor routes validate /^[a-f0-9]{32}$/
  type: "process_task" | "restyle_task" | "prepare_editor" | "export_editor" | "combine_editor" | "export_clip";
  taskId: string; clipId?: string; userId: string; payload: Record<string, unknown>;
  status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
  activeKey?: string;          // process/restyle: "task:{taskId}"; prepare: "prepare:{clipId}". Unset when finished
  liveKey?: string;            // export_clip: "{clipId}:{optionsHash}". Unset on failure or expiry
  runAt: Date; attempts: number; maxAttempts: number;
  lockedBy?: string; lockedUntil?: Date; cancelRequested?: boolean;
  progress: number; message?: string; error?: string; result?: Record<string, unknown>;
  expiresAt?: Date; startedAt?: Date; finishedAt?: Date; createdAt: Date; updatedAt: Date;
};
```
Indexes: `{status:1, runAt:1}`, `{status:1, lockedUntil:1}`, `{activeKey:1}` unique partial (`activeKey` exists), `{liveKey:1}` unique partial, `{clipId:1, type:1, createdAt:-1}`, `{taskId:1}`, `{status:1, expiresAt:1}`.

### `processing_cache` (`_id` = sha256(`{sourceType}|fast|{CACHE_VERSION}|{url.trim()}`), CACHE_VERSION = `"clipwright-v1"`)
`{_id, sourceUrl, sourceType, transcriptText?, analyses?: {auto?: string, short?: string, medium?: string, long?: string}, createdAt, updatedAt}`. Upserts `$set` only non-null fields.

### `app_settings` (`_id` = key in `ANTHROPIC_API_KEY | ASSEMBLY_AI_API_KEY | CLAUDE_MODEL`)
`{_id, encryptedValue, preferAdminValue, updatedBy, createdAt, updatedAt}`.
- Precedence per key: the admin value wins if `preferAdminValue`, or if no env value exists; otherwise the env value wins.
- `CLAUDE_MODEL` is stored as a plain model id (no `anthropic:` prefix). The settings route and UI accept and return it that way.

### `worker_status` (`_id: "worker"`)
`{_id, workerId, pid, heartbeatAt, startedAt, version}`. Written every 10 s. `workerHealthy()` = heartbeat less than 30 s old.

## 6. Jobs and the worker

### 6.1 Queue primitives (`jobs.ts`)
Implement exactly the pattern in `map-data.md` §7.5: lease 60 s, heartbeat every 15 s (and on every progress update, throttled to 1/s), reaper on every poll (requeue when attempts < maxAttempts, otherwise fail it and run the job type's failure hook), claim with `findOneAndUpdate` sorted by `runAt`, and finish guarded by `lockedBy`. `maxAttempts`: process/restyle 2, prepare 2, exports 1, combine 1. An E11000 on `activeKey` means "already queued or running".

Enqueue routes call `workerHealthy()`. If no heartbeat, the job is still inserted, but the response includes `worker_online: false`, and the UI shows "The Clipwright worker isn't running. Start it with `pnpm dev` (or `pnpm worker`)." Queued jobs then wait until the worker starts.

**Failure hooks** (used by the reaper when a job dies):
- process/restyle: CAS the task from queued/processing to error (`progressMessage` "The worker stopped while processing this video. Resume to try again."). For restyle, restore status `completed` with "Restyle failed. Your existing clips are unchanged."
- prepare: draft status `failed`.
- exports and combine: job status `failed`.

### 6.2 Job handlers (`web/src/worker/handlers/*.ts`)

**`process_task`** (port of `TaskService.process_task` + `VideoService.process_video_complete`; see `map-task-api.md` §4 and `map-pipeline.md` §A1). The progress messages are a UI contract and must be exact:
1. CAS task `queued|processing` → `processing`, progress 0, "Starting...", `run = {jobId, startedAt}`. If the CAS misses: finish the job as cancelled.
2. Load runtime settings. A missing Anthropic or AssemblyAI key → task error "Add your Anthropic API key in Settings → AI before generating clips." or "Add your AssemblyAI API key in Settings → AI before generating clips."
3. Check the cache (section 5).
4. `10 "Downloading video..."`:
   - YouTube: engine `youtube-info`. If the duration exceeds `MAX_VIDEO_DURATION` → error "Video is too long (N min). Maximum allowed duration is M minutes.". If the title is still the placeholder, set `source.title`. Then engine `fetch-youtube` into `localPath(sources/youtube/{id}/source.mp4)`; it reuses the file when it exists.
   - Upload: `localPath(upload key)`. A missing file → "Video file not found".
5. `15 "Preparing video..."`: engine `prepare-source` (normalize in place, ffprobe duration guard). For YouTube, `fetch-youtube` already normalized, so this only probes.
6. `30 "Generating transcript..."`: engine `transcribe` (it uses the existing sidecar when it has words, and returns `transcript_text`). Cache `transcriptText`.
7. `50 "Analyzing content with AI..."`: use the cached analysis for this clipLength, or else engine `signals`, then `selectClips()` (section 8). Store the analysis JSON in the cache.
8. `70 "Creating video clips..."`:
   - Normalise segments (flatten virality, cap `MAX_CLIPS`, fallback segment when empty).
   - `clearClips` (CAS `status: processing`, `run.jobId`).
   - Engine `render-clips`.
   - On each `clip_start` event: progress `70 + floor((i+1)/N*25)` "Creating clip {i+1}/{N}...".
   - On each `clip` event: `putFile` to `clips/{taskId}/{filename}`, then `pushClip` (CAS). A CAS miss means cancelled: kill the engine and delete the file.
9. No clips → error "No clips could be rendered. Please try again." Otherwise CAS → completed, 100, "Complete!", `run.completedAt`.
- **Cancellation:** check before each step and on every progress write. A CAS miss means cancelled: kill the engine, leave the task `cancelled` (the route already set it), and finish the job as cancelled.
- **Errors:** task → `error`, progress 0, message = the error text (engine messages pass through; unknown errors become "Processing failed: <message>"), and `run.errorCode` from the Python rules.

**`restyle_task`** (port of `regenerate_all_clips_for_task`, `clip_service.py:99-286`):
- The route has already validated, saved the new `settings`, and set the task to `processing` with "Applying new style...". The old clips stay visible.
- The handler rebuilds one segment per clip: `keep_ranges` when the cleanup settings are unchanged (`payload.cleanupChanged === false`), otherwise `source_ranges`. It gets the source path (YouTube cached file, or re-fetch; upload file), and runs `render-clips`.
- Every survivor replaces the old clips in one `replaceClips` CAS. Clip ids are new; delete the old clip files and the old clips' drafts.
- The task returns to `completed`, 100, "Complete!".
- If nothing rendered: status `completed`, message "Restyle failed. Your existing clips are unchanged.", and the job fails with that message. The UI shows `progressMessage` as an error toast when it sees that string.

**`prepare_editor`** / **`export_editor`** / **`combine_editor`**: ports of `editor_service.prepare_editor`, `export_editor` and `combine_editor`, per `map-editor.md` §2.1, §5.2, §5.3 and §7.1. Engine commands `editor-prepare`, `editor-render`, `editor-combine`.
- Prepare writes `clean.mp4` and `thumbnails.jpg` to `editor/{clipId}/{basisHash}/`, then `completePrepare` (it never overwrites an existing draft with the same basis; it seeds revision 0 + original).
- Export writes `editor-exports/{jobId}.mp4`; job `result {fileKey}`.
- Combine:
  - appends the new clip (relevance 0, reasoning "Combined in the clip editor", `startTime` "00:00", `endTime` mm:ss(total), text = joined words, `sourceRanges` sliced);
  - seeds the new clip's draft (ready, revision 0, original = document, media from the combine output);
  - `result {clip_id, fileKey}`.

**`export_clip`** (port of `export_clip_preset`): engine `export-preset`. Output goes to `exports/{exportId}.mp4`, with `expiresAt` = now + 7 days. Before succeeding, check that the clip's `filename` is unchanged.

**Cron** (every 5 minutes in the worker):
- Expire `export_clip` and editor-export jobs past `expiresAt`: delete the file, unset `liveKey`, status `failed` with "expired" (keep the doc 7 days, then delete it).
- Delete finished job docs older than 7 days.
- Orphan sweep of `DATA_DIR/work/*` directories older than 24 h.

### 6.3 Status vocabularies at the API
- Tasks: as stored.
- Editor jobs: `queued→queued`, `running→rendering`, `succeeded→completed`, `failed→failed`, `cancelled→cancelled`; DELETE of a running job returns `cancelling`.
- Preset exports: `queued→queued`, `running→running`, `succeeded→succeeded`, `failed|cancelled→failed`.

## 7. Engine CLI contract (`engine/`)

**Invocation:** `python -X utf8 -m clipwright_engine <command>`.
- The JSON request arrives on stdin.
- stdout carries **only** NDJSON events, one JSON object per line. Anything else is logged to stderr.
- Exit codes: 0 success, 1 error, 2 cancelled.

**Events:**
- `{"type":"progress","pct":0-100,"message":"..."}`
- `{"type":"clip_start","index":i,"total":n}`
- `{"type":"clip","index":i,"clip":{...}}`
- `{"type":"clip_failed","index":i,"message":"..."}`
- Last line: `{"type":"result","data":{...}}`, or `{"type":"error","code":"...","message":"..."}`
- Error codes: `invalid_request`, `too_long`, `download_failed`, `not_found`, `metadata_unavailable`, `transcription_failed`, `render_failed`, `cancelled`, `internal`.

**Common request fields:**
- `work_dir`: absolute; created if missing. The engine's temp files go here, never the OS temp.
- `cancel_file?`: absolute path, polled at least every 0.5 s inside render loops and between clips. When it appears, the engine terminates its ffmpeg children and exits 2.
- `config?: {speaker_framing?, hook_first_teaser?, transcription_language?, max_video_duration?, youtube_max_height?, assembly_ai_http_timeout_seconds?}`
- `fonts_dirs: string[]`: absolute; the bundled dir first, then the user's font dir. Font lookup searches them in order.

| Command | Request (extra fields) | Result `data` |
|---|---|---|
| `youtube-info` | `url` | `{video_id, title, duration, thumbnail, uploader}` |
| `fetch-youtube` | `url, video_id, output_path, max_height` | `{video_path, duration, width, height, from_cache}`. Downloads with yt-dlp (`js_runtimes: {"node": {}}`) into `work_dir`, moves to `output_path`, then normalizes (`normalize_source_media`). Progress events report download percent |
| `prepare-source` | `video_path, max_duration_seconds` | `{duration, width, height, normalized}`. Error `too_long` |
| `probe` | `path` | `{duration, width, height, fps, has_audio}` |
| `transcribe` | `video_path, assemblyai_api_key, language?` | `{transcript_text, language_code, word_count}`. Writes `<stem>.transcript_cache.json` (version 2) beside the video. If that sidecar already has words, it **formats `transcript_text` from the sidecar** (same output as `format_transcript_for_analysis`) without calling AssemblyAI |
| `signals` | `video_path, transcript_text` | `{clip_signals: string \| null}` |
| `render-clips` | `video_path, output_dir, segments:[Segment], options:{output_format, add_subtitles, caption_template, font_family, font_size, font_color, cleanup:{cut_long_pauses, pause_threshold_ms, remove_filler_words, filtered_words}, max_clip_seconds}` | One `clip_start` and then either `clip` or `clip_failed` per segment. `clip` = `{index, filename, path, start_time, end_time, duration, text, keep_ranges:[[s,e]], source_ranges:[{start,end}], caption_settings:{position_y, font_size}}`. Final `{clips:[...], failed:[indexes]}` |
| `export-preset` | `input, output, preset` | `{path}` |
| `editor-prepare` | `source_video_path, source_ranges, output_dir, output_format, clip_text, hook_title, add_subtitles, caption_settings, task_style:{caption_template, font_family, font_size, font_color}` | `{asset:{width,height,fps,duration,hasAudio,waveform}, clean_path, thumbnails_path, initial_document}` |
| `editor-render` | `clean_path, document, preset, output` | `{path}` |
| `editor-combine` | `inputs:[{clean_path, document, has_audio, width, height, source_ranges}], output_dir` | `{clean_path, export_path, thumbnails_path, document, asset, source_ranges}` |

**Segment** (input to `render-clips`):
- `start_time`, `end_time`: "MM:SS" strings.
- `text`, `hook_title?`, `hook_start_time?`, `hook_end_time?`.
- `keep_ranges?` or `source_ranges?`: for restyle.

The engine never touches MongoDB, never makes LLM calls, and never reads env vars for keys (keys arrive in the request).

## 8. Claude clip selection (`web/src/server/ai`)

A port of `backend/src/ai.py` minus B-roll, performance context and non-Anthropic providers. Spec: `map-ai.md`.

- **`selectClips({transcript, clipSignals, clipLength, apiKey, model, rerankModel, maxClips, signal}) → {segments: Segment[], summary, keyTopics}`**
  - The algorithm matches §6-§7 of `map-ai.md` exactly: windowing, concurrency 3, per-window 600 s and total 1800 s budgets, validation/snap/repair/grounding, dedupe, rerank (multi-window only, 240 s, never throws), and the final count formula.
- **Prompts** are copied verbatim (minus the performance section).
- **Request shape:**
  - `client.messages.create({ model, max_tokens: 16000, system, messages: [{role:"user", content: prompt}], output_config: {format: {type:"json_schema", schema}} })`, using JSON schemas equivalent to the pydantic models (`additionalProperties: false`; required only where pydantic requires; no numeric min/max in the schema).
  - For `claude-opus-5` / `claude-fable-5-1`, add `betas: ["server-side-fallback-2026-07-01"]` and `fallbacks: "default"` (use `client.beta.messages.create`).
  - Read the JSON from the text blocks; never assume `content[0]`.
  - Parse with zod schemas that apply every default and **clamp** out-of-range scores.
  - On invalid JSON or a schema failure, send the validation error back as a user turn, at most 2 repair attempts (mirroring pydantic-ai `output_retries=2`).
  - Transient errors (408/409/429/5xx/529, connection errors) retry 3 times with 5·2^(n-1)+jitter backoff inside the budget. The SDK runs with `maxRetries: 0`.
  - `stop_reason` `refusal` or `max_tokens` counts as an output failure.
- **`testAnthropicConnection(apiKey, model)`**: a port of `llm_connection.py` (Models API only: `models.list({limit:100})`, then `models.retrieve` when the model is not listed). It returns the same statuses and messages.
- **Tests:** port `backend/tests/unit/test_ai_windowed_selection.py`, `test_ai_grounding.py`, `test_ai_prompt.py`, `test_ai_retry.py`, `test_claude_provider.py` (the AI parts) and `test_clip_duration.py` as vitest golden tests. The SDK is mocked through a fake `fetch`; no paid calls.

## 9. API routes (all in `web/src/app/api`, `runtime = "nodejs"`, `dynamic = "force-dynamic"`)

**Response shapes stay identical to SupoClip's** (`map-frontend.md` §2, `map-task-api.md` §3, `map-editor.md` §8), so the client code barely changes. Errors are `{detail}`. Auth is the Better Auth session; tasks are owner-only.

| Route | Notes |
|---|---|
| `GET /api/tasks` | List of up to 50 `GenerationSummary` (`id, user_id, source_id (= task id), source_title, source_type ("youtube" \| "video_url" for uploads), source_url, status, clips_count, top_virality_score, cover_clip_id, created_at, updated_at`), newest first |
| `POST /api/tasks/create` | Body as SupoClip's. The route validates and normalises (port `tasks.py:186-207,419-470`, `clip_cleanup.py`). It checks the YouTube URL with a regex (no network), and requires an upload url that is in storage (stat). It inserts a task (`queued`, title = the given title or "YouTube Video"/"Uploaded Video") and enqueues `process_task`. Returns `{task_id, job_id, message, worker_online}` |
| `GET /api/tasks/[id]` | Task fields per the critique §3 list, plus the settings fields `output_format, add_subtitles, clip_length, cut_long_pauses, pause_threshold_ms, remove_filler_words, filtered_words`, `clips_count`. No `clips` array |
| `PATCH /api/tasks/[id]` | `{title}` |
| `DELETE /api/tasks/[id]` | 400 "Wait for processing to finish before editing this task" while queued or processing. Otherwise delete the task, its drafts, its jobs and all files (clips, editor media, exports; the upload source and its sidecar for uploads). YouTube sources are shared and are swept by the cron when unreferenced for 24 h |
| `GET /api/tasks/[id]/clips` | `{task_id, clips, total_clips}`. Clip shape per the critique §3 list; `video_url` = `/api/tasks/{id}/clips/{clipId}/file` |
| `DELETE /api/tasks/[id]/clips/[clipId]` | Same lock rule; deletes the file and the draft |
| `GET /api/tasks/[id]/clips/[clipId]/file` | `?download=true` → attachment. Range support |
| `POST /api/tasks/[id]/cancel`, `POST /api/tasks/[id]/resume` | Semantics per `map-task-api.md` §3. Resume re-enqueues `process_task` (409 if the activeKey is taken by a running job) |
| `POST /api/tasks/[id]/settings` | Normalise, save `settings`. With `apply_to_existing`, set processing and enqueue `restyle_task`. Returns `{task, message}` |
| `POST /api/tasks/[id]/clips/[clipId]/exports`, `GET .../exports/[exportId]`, `GET .../exports/[exportId]/file` | `export_clip` jobs. Idempotent per `liveKey = {clipId}:{sha256({preset, filename})}` |
| `GET`/`PATCH /api/tasks/[id]/clips/[clipId]/editor`, `POST .../editor/prepare`, `GET .../editor/media/[asset]` (clean.mp4 \| thumbnails.jpg, Range), `POST .../editor/exports`, `GET`/`DELETE .../editor/exports/[jobId]`, `GET .../editor/exports/[jobId]/file`, `POST /api/tasks/[id]/editor/combine` | Per `map-editor.md` §8 |
| `GET /api/fonts`, `GET`/`DELETE /api/fonts/[fontName]`, `POST /api/fonts/upload` | Bundled fonts plus the user's (`fonts/{userId}/`). Upload: multipart field `file`, .ttf/.otf, ≤10 MB, no paid gate |
| `GET /api/caption-templates` | `{templates:[{id,name,description,animation,font_family,font_size,font_color,highlight_color}]}` |
| `GET /api/ai/provider` | `{provider:"anthropic", model, configured, transcription_configured}`. `configured` = Claude key present AND AssemblyAI key present |
| `GET`/`PATCH /api/admin/runtime-settings`, `POST /api/admin/ai/test-connection` | Same contracts as SupoClip, keys limited to the three in section 5 |
| `GET`/`PATCH /api/preferences` | `{fontFamily, fontSize, fontColor, clipLength}` (no `notifyOnCompletion`) |
| `POST /api/upload` | **Streams** multipart field `video` to `uploads/{uuid}{ext}` (busboy; never buffers). Size cap → 413. Returns `{message, video_path}` |
| `POST /api/upload/authorization` | Returns `{directUpload: false}` (the local driver). Never `{storage:"local"}` |
| `GET /api/health` | `{ok, db: boolean, worker: {online, heartbeatAt}}` |
| `/api/auth/[...all]` | Better Auth |

## 10. Frontend changes
- Follow `map-frontend.md` §3 to cut every dropped dependency.
- Remove the EventSource from `use-task-progress.ts`; poll every 2 s while active.
- `/` for a signed-out user redirects to `/sign-in`.
- Settings:
  - the "AI" section adds an AssemblyAI key field (same mask/test/save pattern; there is no free AssemblyAI test, so just save);
  - non-admins see read-only status;
  - caption defaults and delete account stay.
- Rename the localStorage keys and download filenames to `clipwright-*`.
- Add a "Based on SupoClip (AGPL-3.0) · Source" footer link in the shell's user area and on the auth frame.
- New logo: an SVG mark plus a wordmark (a component), replacing `logo.png`.
- The design tokens from the previous redesign stay.

## 11. Testing
- `web`: vitest. Mongo-backed tests use `mongodb-memory-server` (dev dependency), with one in-memory server per test file. Storage tests use a temp `DATA_DIR`. Engine-dependent worker code is tested with a fake `runEngine`.
- `engine`: pytest; port the media unit tests from `backend/tests/unit` that cover kept modules, and make them pass on Windows. Add CLI tests (stdin/stdout protocol) using a synthetic ffmpeg-generated video.
- End to end: a manual run with real keys, documented in `docs/testing.md`.
