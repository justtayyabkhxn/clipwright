# Backend map: task lifecycle API and worker orchestration (The original app → Clipwright)

All paths are relative to `C:\other-projects\original-app\backend\src\` unless they start with `frontend/`. Line numbers are from the files as they are now.

## 0. Findings that change the port plan

1. **`POST /start-with-progress` no longer exists.** CLAUDE.md is out of date. Tasks are created with `POST /tasks/` (`api/routes/tasks.py:419`). `backend/REFACTORING_GUIDE.md:316` confirms the replacement.
2. **Uploads are stored with `sources.type = "video_url"`, not `"upload"`** (`services/video_service.py:625-626`). The DB check constraint allows `youtube | video_url | twitch | kick` (`init.sql:47`).
3. **Several edit endpoints run ffmpeg and downloads inside the HTTP request, not in the worker.** These are:
   - trim, split, merge, captions, regenerate
   - `POST /tasks/{id}/settings` with `apply_to_existing` (re-renders every clip, may re-download YouTube)
   - `GET .../export`
   
   This cannot run on Vercel, so the port has to turn them into worker jobs.
4. **The frontend never calls trim, split, merge, captions or regenerate.** I grepped `frontend/src` and `mcp/`: the only client of the legacy `GET .../export` is the MCP server (`mcp/src/original-app_mcp/server.py:701`). The editor (`/editor/*` routes) is what the UI actually uses for edits. The task page calls these routes:
   - `GET /tasks/{id}`, `GET /tasks/{id}/clips`, `PATCH /tasks/{id}`, `DELETE /tasks/{id}`
   - `DELETE .../clips/{cid}`, `POST /{id}/settings`
   - `POST/GET .../exports`, `POST/DELETE /share`, `/cancel`, `/resume`
   - `GET /progress` (SSE), `GET .../file`
5. **Stuck tasks are cleaned up only when someone reads the task.** It runs in `get_task_with_clips` (`services/task_service.py:765-809`), which serves only `GET /tasks/{id}` and `GET /tasks/{id}/clips`. There is no cron for it, and the task list never sweeps.
6. **Cancelling publishes nothing on SSE.** The cancel route only writes the DB and Redis (`tasks.py:1240-1273`). The worker's cancelled path re-raises without calling `progress_callback` (`task_service.py:661-670`). The frontend learns about it from its 5-second reconcile poll (`frontend/src/hooks/use-task-progress.ts:62`).
7. **The Python code does not import on native Windows.** `import fcntl` sits at module top level in `media_storage.py:13`, `editor_document.py`, `media/source_limits.py` and `youtube_source.py`. A Windows render-engine CLI must not import these, or must shim them. `font_registry.py:28` also shells out to `fc-query` (fontconfig) and returns `None` when it is missing.
8. **arq only retries on `Retry` or `CancelledError`.** I checked `.venv/.../arq/worker.py:610-633`: ordinary exceptions fail the job straight away. `max_tries = 3` therefore only matters for `TaskRunBusy` → `Retry(defer=2)` and for worker shutdown.
   - A job that hits its 3-hour timeout is cancelled. The `CancelledError` gets past `except Exception` in `process_task`, so the task stays `processing` until the 4-hour stale sweep marks it `error`.
9. **`POST /tasks/{id}/settings` with `apply_to_existing` deletes and re-creates every clip row, so all clip IDs change** (`services/clip_service.py:259-286`). Editor drafts are keyed by `(task_id, clip_id, filename)` (`editor_document.py:113-116`).

---

## 1. Authentication (`auth_headers.py`)

The port replaces this whole layer with a Better Auth session lookup inside each Next route. The current contract is below for reference.

`resolve_authenticated_user_id(request, db, config)` (`auth_headers.py:113-136`) works in this order:

1. **API key** (DROP): `Authorization: Bearer <key>` or `x-api-key`. The SHA-256 of the key is looked up through `ApiKeyRepository.resolve_user_id`. A bad key returns 401 "Invalid or revoked API key".
2. **Signed headers** from the Next proxy (`auth_headers.py:57-84`):
   - `x-original-app-user-id`, `x-original-app-ts` (unix seconds), `x-original-app-signature`
   - The signature is hex `HMAC-SHA256(BACKEND_AUTH_SECRET, "{user_id}:{ts}")`. The frontend signer is `frontend/src/lib/backend-auth.ts:12-27`.
   - The timestamp must be within `AUTH_SIGNATURE_TTL_SECONDS` (default 300, `config.py:160`).
   - 401 errors: "Signed authentication required", "Invalid auth timestamp", "Expired auth signature", "Invalid auth signature".
   - If the secret is missing while signed headers are present: 500 "Server authentication secret is not configured".
3. **Unsigned fallback** (`auth_headers.py:93-110`): used when `ALLOW_UNSIGNED_BACKEND_AUTH=true` (default false). It reads `x-original-app-user-id`, or returns 401 "User authentication required". If neither mode is configured: 503 "Server authentication is not configured".

Ownership helpers in `tasks.py`:

| Helper | Lines | Rule | Errors |
|---|---|---|---|
| `_load_task_for_user` | 319-326 | Loads the task | 404 "Task not found" |
| `_require_task_owner` | 329-338 | `task.user_id == user` | 403 "Not authorized for this task" |
| `_require_task_reader` | 341-354 | Owner, OR an admin when status is `queued`, `processing` or `pending` (`ADMIN_READABLE_TASK_STATUSES`, line 316) | 403 |

The admin branch is DROP, so in the port the reader rule is owner-only.

Error envelope (`main.py:127-175`):
- `HTTPException` → `{"detail": <string or object>, "trace_id": ...}`
- Validation errors → 422 `{"detail": [...], "trace_id"}`
- Unhandled errors → 500 `{"detail": "An internal server error occurred. Contact support with the trace ID.", "trace_id"}`

The frontend reads `detail.code` and `detail.message`, so keep the structured `detail` objects such as `VIDEO_TOO_LONG`.

---

## 2. Task status state machine

Statuses that are actually written: `queued`, `processing`, `completed`, `error`, `cancelled`. The DB default is `pending` (`init.sql:61`), but no code path sets it. Every status write goes through `TaskRepository.update_task_status` (`repositories/task_repository.py:305-355`). That function is a compare-and-set (`AND status = ANY(:expected_statuses)`) and returns `False` when no row matched. On a write to `error` or `cancelled` it also refunds the minute charge (`task_repository.py:341-342`), which is billing and can be dropped.

| From | To | Trigger | progress / message | Where |
|---|---|---|---|---|
| (none) | queued | task created | DB default 0 / NULL | `task_service.py:254-267` |
| queued | error | enqueue failed after create | 0 / "Unable to queue processing. Please retry this generation." | `tasks.py:565-571` |
| queued, processing | processing | worker start | 0 / "Starting..." (DB only, not published) | `task_service.py:400-406` |
| processing | processing | every progress update; a CAS miss raises `TaskCancelled` | see section 4 | `task_service.py:409-420` |
| processing | completed | all clips saved | 100 / "Complete!" | `task_service.py:611-621` |
| queued, processing | error | pipeline exception | 0 / `str(e)` | `task_service.py:671-674` |
| queued, processing | cancelled | user cancel (route) | 0 / "Cancelled by user" | `tasks.py:1264-1271` |
| queued, processing | cancelled | worker sees cancellation | 0 / "Cancelled by user" | `task_service.py:661-670` |
| cancelled, error | queued | resume | 0 / "Re-queued by user" | `tasks.py:1360-1366` |
| queued | cancelled or error (previous status) | resume enqueue failed | message "Could not enqueue resume. Please retry." | `tasks.py:1393-1399` |
| queued | error | lazy sweep: `updated_at` older than `QUEUED_TASK_TIMEOUT_SECONDS` (180) and the arq job is missing | 0 / "The queued job is no longer available. Please resume this generation." | `task_service.py:772-787` |
| processing | error | lazy sweep: `updated_at` older than `PROCESSING_TASK_TIMEOUT_SECONDS` (14400) | 0 / "Task stalled during processing (worker likely stopped or timed out). Check the worker logs (docker-compose logs -f worker) and try again." | `task_service.py:791-809` |

Guards:
- **Edit lock** (`repositories/edit_transaction.py:24-53`): every mutating clip or task operation wrapped in `@serialized_task_edit` takes `SELECT status ... FOR UPDATE`.
  - It raises `ValueError("Wait for processing to finish before editing this task")` when the status is `queued` or `processing`, and `ValueError("Task not found")` when the row is missing.
  - Routes map that `ValueError` to 400.
  - Wrapped operations: `delete_task`, `delete_clip`, `update_task_settings`, `regenerate_all_clips_for_task`, `trim_clip`, `split_clip`, `merge_clips`, `update_clip_captions`.
  - `PATCH /tasks/{id}` (title) is **not** wrapped.
- **Processing transaction**: `task_edit_transaction(..., processing=True)` raises `TaskCancelled` unless the status is `processing` (`edit_transaction.py:42-43`). The worker uses it for each clip insert.
- **Single run per task**: `exclusive_task_run` (`repositories/task_run_guard.py:33-43`) takes a Postgres session advisory lock with `pg_try_advisory_lock(hashtextextended(task_id, 913461))`.
  - If the lock is busy it raises `TaskRunBusy`.
  - If the task is `completed`, `cancelled` or `error`, the job returns `{"task_id", "status", "skipped": True}` without doing anything.
  - In Mongo this becomes an atomic lease or claim on the job or task document.

Stale-queued job check (`task_service.py:101-122`): it reads `source_metadata.processing_job_id`.
- If there is no job ID, the task counts as missing only once its age is at least `max(180 s, 24 h)`, the arq `expires_extra_ms`.
- Otherwise it checks the Redis keys `arq:job:{id}` and `arq:in-progress:{id}`.
- If Redis errors, the task is treated as not missing.
- Task age is measured from `updated_at`, falling back to `created_at` (`task_service.py:140-154`).

---

## 3. Endpoints, `/tasks` router (`api/routes/tasks.py`, prefix `/tasks`)

All routes need auth (section 1) unless marked "no auth".

### KEEP

**`GET /tasks/?limit=50`** (`tasks.py:399-416`)
- Response: `{"tasks": [...], "total": len}`.
- Each item comes from `task_repository.py:371-415`: `id, user_id, source_id, source_title, source_type, status, processing_mode, completion_notification_sent_at, clips_count, source_url, top_virality_score, cover_clip_id, created_at, updated_at`.
- `cover_clip_id` is the clip with the highest virality score, ties broken by `clip_order`. The UI loads it as a thumbnail through `/clips/{id}/file` (`frontend/src/lib/generations.ts:24`).
- Sorted by `created_at DESC`. Error: 500 "Error retrieving tasks: ...". No stale sweep.

**`POST /tasks/`** creates a task (`tasks.py:419-598`). The frontend proxy is `frontend/src/app/api/tasks/create/route.ts`.

Request body (the frontend payload is at `frontend/src/components/home-app.tsx:317-332`):

| Field | Default and normalization | Source |
|---|---|---|
| `source.url` | Required non-empty string, else 400 "Source URL is required" | 441-442 |
| `source.title` | Optional. Fallbacks: YouTube metadata title, then "YouTube Video". Uploads get "Uploaded Video" (`task_service.py:242-246`); the UI sends the file name | 489-495 |
| `font_options` | Object, else 400 "font_options must be an object" | 447-449 |
| `font_options.font_family` | Trimmed string, or `None`. Not checked against available fonts at creation | 204-207 |
| `font_options.font_size` | int clamped to 12-72. Invalid → 24. Empty or None → None | 186-193 |
| `font_options.font_color` | `^#[0-9A-Fa-f]{6}$`, uppercased. Invalid → `#FFFFFF`. Empty → None | 196-201 |
| `caption_template` | `"default"`. **Not validated** | 453 |
| `include_broll` | `true` only if exactly `true` (**DROP**) | 454 |
| `processing_mode` | `fast`, `balanced` or `quality`, else `DEFAULT_PROCESSING_MODE` (`"fast"`, `config.py:251`). The UI always sends `"fast"` | 456-460 |
| `output_format` | `vertical`, `vertical_fit`, `vertical_pan`, `vertical_split` or `original` (`media/common.py:65`), else `vertical` | 461-463 |
| `add_subtitles` | Bool, default `true`. Non-bool → `true` | 464-466 |
| `clip_length` | `auto`, `short`, `medium` or `long`, default `auto`. Invalid → **422** "clip_length must be auto, short, medium, or long" (`clip_duration.py:23-26`) | 467-470 |
| `cut_long_pauses` | Default **true** for new tasks | `clip_cleanup.py:14,108-119` |
| `pause_threshold_ms` | Default 1200, clamped 250-3000 | `clip_cleanup.py:9,54-60` |
| `remove_filler_words` | Default **true** for new tasks | `clip_cleanup.py:15` |
| `filtered_words` | List, or a comma-separated string. Lowercased, whitespace collapsed, de-duplicated | `clip_cleanup.py:63-81` |

Clip length presets (`clip_duration.py:15-21`), as (min, max, ideal_min, ideal_max) seconds:
- auto = (15, 60, 25, 50)
- short = (15, 30, 18, 25)
- medium = (30, 60, 35, 55)
- long = (60, 120, 75, 110)

Flow, in order:
1. `SourceAttempt` logs the sanitized URL and stores rejections in `rejected_source_attempts` (`source_submission.py:186-222, 422-452`). **DROP** (observability).
2. Authenticate.
3. Billing check `assert_can_create_task` (**DROP**). In self-host mode the limits are `max_youtube_duration_seconds = max_upload_duration_seconds = MAX_VIDEO_DURATION`, default 5400 s (`services/billing_service.py:198-203`; `config.py:99`).
4. Detect the source type with `determine_source_type` (`video_service.py:620-630`):
   - A YouTube ID → `youtube`
   - `upload://` → `video_url`
   - Anything else that is not http(s) → `ValueError` → **404** "Only YouTube URLs or upload:// references are supported"
   - Other http(s) URLs go to `detect_stream_source`, which returns twitch/kick (outside KEEP scope) or raises `ValueError` → **422** (`tasks.py:481-488`).
5. Preflight:
   - **YouTube** (`tasks.py:60-116`): `async_get_youtube_video_info` with timeout `YOUTUBE_PREFLIGHT_TIMEOUT_SECONDS` (30, max 180; `config.py:59-63`).
     - Timeout → 503 `{code: "VIDEO_METADATA_TIMEOUT", message}`.
     - Other error, or missing or invalid duration → 503 `{code: "VIDEO_METADATA_UNAVAILABLE"}`.
     - Over the limit → 422 `{code: "VIDEO_TOO_LONG", message, duration_seconds, max_duration_seconds}`.
   - **Upload** (`tasks.py:152-183`): ffprobe through `VideoService.probe_upload_duration` (`video_service.py:191-199`).
     - Failure → 422 `{code: "VIDEO_METADATA_UNAVAILABLE"}`.
     - Over the limit → 422 `VIDEO_TOO_LONG`.
   - Twitch/Kick preflight (`tasks.py:118-149`) is outside KEEP scope.
6. `generation_allowance_guard` (a Postgres advisory lock per user, **DROP**) and the minute re-check (**DROP**).
7. `create_task_with_source` (`task_service.py:207-270`):
   - Checks the user exists, else `ValueError` → 404 "User {id} not found".
   - Inserts the `sources` row and commits (`repositories/source_repository.py:18-62`).
   - Inserts the `tasks` row with `status='queued'`, `source_duration_seconds = ceil(duration)` and the style fields, and records the minute charge when monetized (`task_repository.py:25-83`).
   - For `upload://` URLs, the advisory lock `guard_source_creation` (`repositories/media_repository.py:16-37`) serializes this against media deletion.
8. Sets `processing_job_id = f"{task_id}:{secrets.token_hex(16)}"`. Saves the source metadata (section 6), JSONB-merged into `tasks.source_metadata` and also into the Redis `task_source:{id}` cache (7-day TTL) (`tasks.py:265-286`).
9. Enqueues `process_video_task` with positional args `(task_id, url, source_type, user_id, font_family, font_size, font_color, caption_template, processing_mode, output_format, add_subtitles, cleanup_settings, clip_length)` and `_job_id = processing_job_id` (`tasks.py:546-563`). On failure the task goes to `error`, then a 500 is returned.

Response 200: `{"task_id", "job_id", "message": "Task created and queued for processing"}`.

Other errors:
- 400: invalid JSON or body not an object (`tasks.py:210-217`)
- 402 `SUBSCRIPTION_REQUIRED` (DROP)
- 409 allowance busy, with `Retry-After: 1` (DROP)
- 500 "Error creating task: ..."

**`GET /tasks/{task_id}`** (`tasks.py:669-688`), reader auth. Response from `get_task_with_clips` (`task_service.py:765-826`), after running the stale sweeps. The keys are:
- **Task fields** from `get_task_by_id` (`task_repository.py:139-166`): `id, user_id, source_id, source_title, source_type, status, progress, progress_message, generated_clips_ids, font_family, font_size, font_color, caption_template, include_broll, processing_mode, cache_hit, error_code, stage_timings_json, started_at, completed_at, completion_notification_sent_at, source_url, created_at, updated_at`.
  - Not returned: `source_duration_seconds`, `source_metadata`, `share_token`, `share_enabled`.
- **`clips`**: the clip rows (`repositories/clip_repository.py:174-198`) without `file_path`, plus `caption_settings` read from the clip's sidecar file. Each clip has:
  - `id, filename, start_time, end_time, duration, text, relevance_score, reasoning, clip_order, created_at`
  - `video_url: "/tasks/{task_id}/clips/{id}/file"`
  - `virality_score, hook_score, engagement_score, value_score, shareability_score, hook_type, hook_title`
- **`clips_count`**.
- **Source settings** (`clip_service.py:667-726`): `output_format, add_subtitles, clip_length, cut_long_pauses, pause_threshold_ms, remove_filler_words, filtered_words`. Defaults when absent: vertical / true / auto / false / 1200 / false / [].
- Errors: 404, 403, 500.

**`GET /tasks/{task_id}/clips`** (`tasks.py:691-714`): `{"task_id", "clips", "total_clips"}`. Same clip shape, and it also runs the stale sweeps.

**`GET /tasks/{task_id}/progress`**: SSE, see section 5.

**`PATCH /tasks/{task_id}`** (`tasks.py:812-837`), owner.
- Body `{title: non-empty string}`, else 400 "Title is required".
- Updates `sources.title` (`source_repository.py:86-94`).
- Response `{"message": "Task updated successfully", "task_id"}`.

**`DELETE /tasks/{task_id}`** (`tasks.py:840-870`), owner.
- 404 "Task not found"; 403 "Not authorized to delete this task"; `ValueError` → 400 (including "Wait for processing to finish before editing this task": **active tasks cannot be deleted**).
- Response `{"message": "Task deleted successfully"}`. Semantics are in section 9.

**`DELETE /tasks/{task_id}/clips/{clip_id}`** (`tasks.py:873-906`), owner.
- 404 "Clip not found" when the clip is missing or belongs to another task; 400 on `ValueError`.
- `delete_clip` (`clip_service.py:55-61`) queues the file deletion (section 9), deletes the row, then `reorder_task_clips` renumbers `clip_order` to 1..n by (`clip_order`, `created_at`) and rewrites `tasks.generated_clips_ids` (`clip_repository.py:373-394`).
- Response `{"message": "Clip deleted successfully"}`.

**`GET /tasks/{task_id}/clips/{clip_id}/file?download=false`**: section 8.

**`POST /tasks/{task_id}/cancel`** (`tasks.py:1240-1278`), owner.
- If already `completed`, `error` or `cancelled` → 200 `{"message": "Task already in terminal state: {status}"}`.
- Otherwise it sets Redis `task_cancel:{id}` = "1" with TTL 3600, then CAS-updates queued/processing → `cancelled` (0, "Cancelled by user").
- Response `{"message": "Task cancellation requested"}`.

**`POST /tasks/{task_id}/resume`** (`tasks.py:1297-1419`), owner.
1. Takes the `task_run_guard` advisory lock. If busy → 409 "The previous worker is still stopping. Retry resume in a moment."
2. Re-reads the task:
   - `queued` → 200 `{"message": "Task already queued"}`
   - anything other than `cancelled` or `error` → 400 "Only cancelled/error/queued tasks can be resumed"
3. Rebuilds the job arguments:
   - `source_url` and `source_type` from the source row, falling back to the metadata `url` and `source_type`. Missing → 400 "Task source URL is missing".
   - `output_format`, `add_subtitles` and cleanup settings from the metadata, with defaults vertical / true.
   - `clip_length` = `normalize_clip_length(metadata.clip_length)`.
   - Style fields and `processing_mode` from the task row; `caption_template` defaults to `"default"`.
4. Billing guard and check (DROP).
5. Deletes `task_cancel:{id}`, sets the status to `queued` (0, "Re-queued by user"), stores a new `processing_job_id` in the metadata, and enqueues `process_video_task` with the same positional args as create.
6. Response `{"message": "Task resumed", "job_id"}`. Other errors: 402/409 (DROP), 500.

**Resume semantics:** a resume reprocesses the task from the beginning. Repeated downloads are avoided only by `processing_cache` (section 4, step 4) and the YouTube and transcript file caches. When rendering starts, the worker deletes the task's existing clips (`task_service.py:510-513`).

**`POST /tasks/{task_id}/settings`** (`tasks.py:1112-1186`), owner.
- Body:
  - `font_family`, `font_size`, `font_color`, normalized as at create
  - `caption_template`, default "default"
  - `apply_to_existing`, bool, default false
  - `include_broll` (DROP); omitted means keep the stored value
  - cleanup fields; omitted fields keep the stored values (`clip_cleanup.py:122-136`)
- 400 "Selected font is not available" when `font_family` is not accessible.
- Steps:
  - `update_task_settings` updates the task style columns (`task_repository.py:247-303`).
  - If `apply_to_existing`, `regenerate_all_clips_for_task` runs **synchronously** (`clip_service.py:99-286`):
    - For each clip it rebuilds a segment from the sidecar source ranges: `keep_ranges` when cleanup is unchanged, or `source_ranges` to recompute cleanup when it changed.
    - It gets the source: YouTube re-downloads only those ranges; uploads use the local file (400 "Source video file no longer exists" if missing).
    - Then `prepare_source` and `create_video_clips` (a batch render).
    - If nothing rendered → 400 "Could not regenerate the clips. Your existing clips are unchanged."
    - Otherwise it deletes all clip rows and inserts new ones (**new IDs**).
  - Saves the merged source metadata, minus `processing_job_id` (`tasks.py:1158-1176`).
- Response `{"task": <get_task_with_clips>, "message": "Task settings updated"}`. The UI sends `apply_to_existing: true` (`frontend/src/app/tasks/[id]/page.tsx:488-503`).

**Clip editing: KEEP per your scope, but no frontend caller.** All are owner-only, run synchronously, wrap `ValueError` as 400, and run under the edit lock. They write new files to `{TEMP_DIR}/clips/` and update each clip's `.source_map.json` sidecar (section 7).

| Endpoint | Body | Behavior | Response |
|---|---|---|---|
| `PATCH /tasks/{id}/clips/{cid}` trim (`tasks.py:955-980`) | `start_offset=0`, `end_offset=0`: finite, ≥ 0 (else 400 "Offsets must be non-negative") | `trim_clip_file` (`clip_editor.py:133-155`): ffmpeg `-ss start -t (duration - end_offset - start)`, min length 0.1 s. Source ranges are trimmed the same way (`clip_source_map.py:195-205`). The row is updated in place (same ID); start and end are set to MM:SS of the range bounds and the duration to the sum of the ranges (`clip_service.py:289-334`). Errors: "Clip file not found", "Trimmed clip has no remaining source mapping" | `{"clip"}` |
| `POST /tasks/{id}/clips/{cid}/split` (`tasks.py:983-1006`) | `split_time > 0`, else 400 "split_time must be greater than zero" | Split point clamped to [0.2, duration - 0.2]. The first half updates the row in place. Later clips are shifted (`make_room_for_clip`, `clip_repository.py:358-370`), then the second half is inserted at `clip_order + 1` with the scores, `hook_*` fields and reasoning copied (reasoning defaults to "Split from original clip"). Clips are then reordered (`clip_service.py:337-406`) | `{"message": "Clip split successfully"}` |
| `POST /tasks/{id}/clips/merge` (`tasks.py:1009-1030`) | `clip_ids: string[]`, else 400 "clip_ids must be an array". At least 2 distinct IDs, else 400 "At least two distinct clips are required to merge" | Clips are ordered by `clip_order` and joined with the ffmpeg concat demuxer. The first clip's row is updated (ranges concatenated, texts joined); the others are deleted; then reordered (`clip_service.py:409-473`) | `{"message": "Clips merged successfully", "clip_id": first_id}` |
| `PATCH /tasks/{id}/clips/{cid}/captions` (`tasks.py:1033-1082`) | `caption_text` (string, trimmed, default ""), `position` (`top`, `middle` or `bottom`, default `bottom`), `highlight_words` (array, default []), `font_size` (optional, 12-72), `position_y` (optional, 0.1-0.85) | **Re-renders from the source** (`clip_service.py:476-622`). The source is found via the `processing_cache.video_path` for the task's cache key; else the local upload file; else YouTube ranges are re-downloaded. If none is available → "The source video is no longer available. Upload it again to edit captions." It then runs `create_optimized_clip(add_subtitles=False, hook_title=..., keep_ranges=local ranges)` and `overlay_custom_captions`, and saves the sidecar `caption_settings` `{font_size, position, position_y (default top 0.18 / middle 0.52 / bottom 0.78), highlight_words}`. The row is updated with `text = caption_text` | `{"clip"}` |
| `POST /tasks/{id}/clips/{cid}/regenerate` (`tasks.py:1085-1109`) | `start_offset`, `end_offset` (finite; **no non-negative check**, but values are clamped later) | Same as trim: calls `trim_clip` and does **not** re-render from the source | `{"clip", "message": "Clip regenerated successfully"}` |

**Export presets**

- **Synchronous legacy route** `GET /tasks/{id}/clips/{cid}/export?preset=tiktok` (`tasks.py:1189-1237`), reader auth.
  - 400 "Invalid preset. Use one of: tiktok, reels, shorts".
  - Presets (`clip_editor.py:36-40`): all 1080×1920. Video bitrate: tiktok 10M, reels 12M, shorts 10M. Audio 192k.
  - Encode (`clip_editor.py:457-517`): ffmpeg scale with letterbox pad, `fps` capped, libx264 preset slow, crf 18, `-maxrate`, aac 48 kHz, `+faststart`. Output goes to `{TEMP_DIR}/exports/`.
  - Returns a `FileResponse` attachment named `{stem}_{preset}.mp4`; the file is deleted after the response. Only MCP uses this route.
- **Queued exports, used by the UI** (`api/routes/clip_exports.py`, `services/clip_export_service.py`), reader auth:
  - `POST /tasks/{id}/clips/{cid}/exports?preset=` or JSON `{preset}` → **202** `{id, status, progress, preset, error, download_url}`.
    - Deduplicated per `options_hash = sha256({preset, source_file_path})` among live rows (`queued`, `running`, `succeeded`) (`clip_export_service.py:60-67, 283-345`).
    - A succeeded row whose file is missing or expired is marked failed and a new export is created.
    - Enqueue failure → 503 "The export worker is unavailable."
  - `GET .../exports/{export_id}` → the same shape, after reaping stale exports (`clip_exports.py:90-105`).
  - `GET .../exports/{export_id}/file`:
    - 409 "Export is not ready"; 404 "Export file is no longer available."
    - Returns a local `FileResponse` attachment (the path must be under `TEMP_DIR`), or a 307 redirect for S3 (`clip_exports.py:108-153`).
  - Worker job `export_clip_preset` (`clip_export_service.py:382-471`), described in section 4.
  - Constants (`clip_export_service.py:35-53`):
    - TTL 7 days
    - stale running after 180 s without a heartbeat
    - queued limit 3600 s
    - 60 s grace before a missing job counts as lost
    - job timeout 1800 s
    - local directory `{TEMP_DIR}/clip-exports/{export_id}/{export_id}.mp4`
  - Status strings: queued / running / succeeded / failed.

### DROP from the tasks router

| Route | Lines | Reason |
|---|---|---|
| `GET /tasks/billing/summary` | 601-617 | billing |
| `GET /tasks/metrics/performance` | 1281-1294 | admin |
| `GET /tasks/dead-letter/list` | 1422-1448 | admin; Redis `tasks:dead_letter` set and `dead_letter:{id}` keys |
| `POST /tasks/{id}/share`, `DELETE /tasks/{id}/share`, `GET /tasks/shared/{token}` (no auth), `GET /tasks/shared/{token}/clips/{cid}/file` (no auth) | 620-666, 717-749 | Share links; "drop unless trivial" |

The share feature is small:
- Token: `secrets.token_urlsafe(32)`. It stays stable while sharing is enabled and rotates when sharing is re-enabled after being disabled (`task_repository.py:417-484`).
- Only `completed` tasks can be shared, else 409 "Only completed generations can be shared".
- The public view is a field whitelist (`tasks.py:357-396`).
- Frontend proxy: `frontend/src/app/api/share/[...path]/route.ts`.

---

## 4. Worker orchestration

### Queue setup (`workers/job_queue.py`, `workers/tasks.py:205-252`)

- **Queue:** arq on Redis, queue name `original-app_tasks` (`job_queue.py:14`). `original-app_fast` is defined but has no worker. `enqueue_processing_job` ignores `processing_mode` and always uses the default queue (`job_queue.py:80-89`).
- **Duplicates:** when arq returns `None` for an existing `_job_id`, the code raises `DuplicateJobError` (`job_queue.py:69-72`).
- **WorkerSettings:**
  - `max_jobs = 4`, `job_timeout = 10800` s (3 h), `max_tries = 3`
  - `health_check_interval = 30`; the heartbeat key is read by `GET /health/worker` (`main.py:249-266`)
  - arq defaults: `keep_result` 3600 s, `expires_extra_ms` 86,400,000 (a job not started within 24 h expires)
- **Registered jobs:**

| Job | Settings | Notes |
|---|---|---|
| `process_video_task` | defaults (3 h timeout, 3 tries) | Main pipeline. KEEP |
| `prepare_editor`, `export_editor`, `combine_editor` | defaults | Editor jobs (`services/editor_service.py:354, 522, 568`), enqueued from `api/routes/editor.py:91, 220, 360`. They track state in JSON files in the editor directory (`asset.json`, `job-*.json`), not through pub/sub. At most 3 active exports per clip (429). KEEP |
| `export_clip_preset` | timeout 1800, `max_tries=1` | Queued preset exports. KEEP |
| `publish_social_post` | `keep_result=0` | DROP |

### `process_video_task(ctx, task_id, url, source_type, user_id, font_family=None, font_size=None, font_color=None, caption_template="default", processing_mode="fast", output_format="vertical", add_subtitles=True, cleanup_settings=None, clip_length="auto")` (`workers/tasks.py:20-131`)

1. Sets the trace and user log context (DROP). Creates `ProgressTracker(ctx["redis"], task_id)`.
2. Opens a DB session and runs `load_runtime_settings_cache(db)` (`runtime_settings.py`). This loads settings saved in the admin panel from `app_settings`, AES-GCM encrypted with `APP_SETTINGS_ENCRYPTION_KEY`, falling back to `BACKEND_AUTH_SECRET` or `BETTER_AUTH_SECRET`. Keys: `ASSEMBLY_AI_API_KEY, LLM, OPENAI_API_KEY, OPENROUTER_API_KEY, GOOGLE_API_KEY, ANTHROPIC_API_KEY, OLLAMA_BASE_URL, OLLAMA_API_KEY, YOUTUBE_DATA_API_KEY, APIFY_API_TOKEN, PEXELS_API_KEY` (`runtime_settings.py:15-27`). This is how the configured Claude key reaches the worker. **KEEP the concept.**
3. Defines three callbacks:
   - `update_progress(percent, message, status)` → `ProgressTracker.update`
   - `should_cancel()` → `bool(redis.get("task_cancel:{task_id}"))`
   - `clip_ready_callback(index, total, clip)` → `ProgressTracker.clip_ready`
4. Calls `TaskService.process_task(...)`.
5. Error handling:
   - `except TaskRunBusy` → `raise Retry(defer=2)`.
   - `except Exception`: if `job_try >= max_tries`, writes the dead-letter keys and publishes `progress.error("Task failed permanently after retries")` (DROP the dead-letter part), then re-raises.

### `TaskService.process_task` (`services/task_service.py:311-705`)

It is decorated with `@exclusive_task_run` (lock, or skip if terminal) and `@media_work` (S3 download leases). Every progress message is written to the DB first (CAS on `processing`) and then published, except "Starting...", which is only written to the DB.

1. `check_cancelled()` raises `TaskCancelled` when `should_cancel()` is true.
2. Monetization re-check (DROP). Records `started_at`.
3. Billing summary → `download_quality`, `output_short_side` via `reduced_media_limits`. In self-host this gives `(None, None)`. DROP; use `None`.
4. Cache keys (`task_service.py:61-85`):
   - `cache_key = sha256("{source_type}|{processing_mode}|{TRANSCRIPT_ANALYSIS_CACHE_VERSION}|{url.strip()}")`, with `|q{quality}` appended for reduced-quality YouTube.
   - For non-auto `clip_length`: `analysis_cache_key = sha256("{cache_key}|length:{clip_length}")`.
   - Reads `processing_cache.transcript_text` from the cache_key row and `analysis_json` from the analysis row (`repositories/cache_repository.py`).
5. `performance_context` from social metrics (DROP). When present it bypasses the analysis cache.
6. `cache_hit = transcript and analysis`. Runtime metadata `{started_at, cache_hit}` is written.
7. Status → `processing`, progress 0, "Starting...". If the CAS misses → `TaskCancelled`.
8. `max_video_duration` = `MAX_VIDEO_DURATION` (5400); the plan-based YouTube cap is DROP. Twitch/Kick seeding is DROP.
9. `VideoService.process_video_complete(...)` (`services/video_service.py:632-1009`). It checks for cancellation before each step (raising `Exception("Task cancelled")`). Steps and progress:
   - **10** "Downloading video..." For YouTube:
     - Reads metadata again; too long → `Exception("Video is too long (N min). Maximum allowed duration is M minutes.")`.
     - Downloads through the cached full file or `download_video`, or audio-first when a proxy is configured.
     - Failure → "Failed to download video".
     - For uploads it resolves `{TEMP_DIR}/uploads/{name}`; missing → "Video file not found".
     - Then a post-download ffprobe duration check.
   - **15** "Preparing video..." `prepare_source` caps the source at 1080p and 60 fps.
   - **30** "Generating transcript..." Uses the cached transcript, or `generate_transcript` (AssemblyAI; in fast mode the speech model is `FAST_MODE_TRANSCRIPT_MODEL`, default `universal-3-5-pro`, `config.py:253-255`). Word timings are saved to the `.transcript_cache.json` sidecar.
   - **50** "Analyzing content with AI..." Uses the cached analysis, or `build_clip_signal_summary` followed by `get_most_relevant_parts_by_transcript(transcript, clip_signals, performance_context, clip_length)`.
   - **70** "Creating video clips..." Builds `segments_json` with start/end, text grounded to the transcript, scores, `hook_type`, `hook_title`, and hook start/end.
     - Capped at `MAX_CLIPS` (10), and in fast mode at `min(MAX_CLIPS, FAST_MODE_MAX_CLIPS = 10)`.
     - If there are zero segments, a fallback segment is used: `00:00` up to `CLIP_DURATION` (30 s, or the preset's ideal minimum), with `hook_type: "fallback"`.
   - **65** "Downloading selected segments..." Only on the audio-first proxy or stream path. Note this is emitted **after** 70, so the bar moves backwards.
   - Returns `{segments, segments_to_render, video_path, transcript, analysis_json, summary, key_topics}`.
10. If `segments_to_render` is empty: upserts the cache with the transcript only, then raises `ValueError("No usable clip segments were selected for this video.")`.
11. Upserts `processing_cache`:
    - `video_path` (the local path; the S3 source reference for `upload://s3/`), `transcript_text`, and `analysis_json`. Analysis is stored only when not personalized; for a non-auto length it goes into a separate analysis row.
    - The upsert keeps existing values via COALESCE (`cache_repository.py:37-75`).
12. `time_map = load_time_map(video_path)`, for partial (section) downloads.
13. Under the processing transaction: deletes all existing clips of the task and sets `generated_clips_ids = []`.
14. Reads `include_broll` from the task row (DROP).
15. For each segment `i` (`task_service.py:522-601`):
    1. `check_cancelled()`.
    2. `update_progress(70 + int((i+1)/total * 25), "Creating clip {i+1}/{total}...")`. This is emitted *before* the clip is rendered.
    3. `render_segment = localize_segment(segment, time_map)`.
    4. `create_single_clip(video_path, render_segment, i, {TEMP_DIR}/clips, fonts..., caption_template, output_format, add_subtitles, normalized_cleanup, max_short_side, max_clip_seconds = clip_duration(clip_length).maximum)` (`video_service.py:455-600`):
       - Builds keep ranges: sentence snap, pause/filler cleanup, sentence-end extension, optional hook teaser, clamp to max length.
       - Calls `create_optimized_clip` (face crop, captions, hook title).
       - Saves the `.source_map.json` sidecar.
       - Filename: `clip_{i+1}_{start}-{end}_{12hex}.mp4`, with the colons stripped from the times.
       - Returns `None` on failure; that clip is skipped.
    5. Restores the clip's timeline to source time.
    6. Under the processing transaction: `create_clip(..., clip_order=i+1)`, an upsert on `(task_id, clip_order)`. If earlier clips failed, the order numbers have gaps. Then `update_task_clips`.
    7. `clip_ready_callback(i, total, get_clip_by_id(clip_id))`.
16. If no clips were rendered → `ValueError("No clips could be rendered. Please try again.")`.
17. `check_cancelled()`, then status → `completed` (100, "Complete!"); a CAS miss → `TaskCancelled`. Publishes `(100, "Complete!", "completed")`. Writes `completed_at`, `stage_timings_json` (`{pipeline_seconds, render_seconds}`) and `error_code = ""`.
18. Completion email (`task_service.py:707-763`): DROP (SES).
19. Returns `{task_id, clips_count, segments, summary, key_topics}`.

**Exception path** (`task_service.py:650-699`):
- `db.rollback()`. Deletes the unfinished clip file and its `.source_map.json` if it is inside the clips directory.
- If `str(e) == "Task cancelled"` (covers both `TaskCancelled` and the pipeline's `Exception("Task cancelled")`): status → `cancelled` (0, "Cancelled by user"), re-raise, **nothing published**.
- Otherwise: status → `error` (0, `str(e)`); if the CAS missed, re-raise.
- `error_code` is derived from the lowercased message:
  - contains "download" or "youtube" → `download_error`
  - "analysis" → `analysis_error`
  - "transcript" → `transcription_error`
  - "cancelled" → `cancelled`
  - otherwise `task_error`
- Writes `completed_at`, publishes `(0, str(e), "error")`, re-raises.

**`finally`** runs `_cleanup_source_video` (`task_service.py:156-205`):
- **YouTube:** backs up the word timings to S3 when enabled, then `cleanup_downloaded_files(video_id)`. Downloaded media is removed; the transcript cache JSON is kept.
- **Uploads:** removes `<stem>.transcription.mp3` only. The original upload file is kept.
- Stream cleanup is DROP.

**Cancellation is checked in three ways:** (a) the Redis flag before each pipeline step and before and after each clip; (b) the DB CAS on every progress write; (c) the status check inside each clip-insert transaction. The cancel route writes the DB status itself, so (b) catches it even if the Redis flag has expired.

### `export_clip_preset(ctx, export_id)` (`clip_export_service.py:382-471`)

1. Skips if the row is missing, succeeded or failed. Marks it running (`clip_export_repository.py:187-202`).
2. If the clip has changed (`file_path` differs from `source_file_path`), fails with "The clip changed before the export finished."
3. Runs `export_with_preset` in a thread. A progress pump writes progress or a heartbeat to the row every 2 s and stops if the row is no longer `running`.
4. Stores the file locally, or uploads it to S3 `exports/{id}.mp4`, then `mark_succeeded`. If that misses, the file is discarded.
5. Failure messages: "Export timed out before it finished." (cancelled or stopped), or "Export failed. Try again."

---

## 5. Progress pub/sub and SSE

**Publisher** (`workers/progress.py`):
- `update(progress, message, status)`:
  - `SETEX progress:{task_id} 3600 <json>`. The API never reads this snapshot; `ProgressTracker.get` is unused.
  - `PUBLISH progress:{task_id}` with `{"task_id", "progress", "message", "status"}` (`progress.py:20-46`).
- `clip_ready(index, total, clip)`: `PUBLISH progress:{task_id}` with `{"task_id", "event_type": "clip_ready", "clip_index", "total_clips", "clip": <get_clip_by_id row>}`, serialized with `default=str` (`progress.py:57-69`).
  - The clip record **includes `file_path`** and does not include `caption_settings` (`clip_repository.py:288-309`).

**SSE endpoint** `GET /tasks/{task_id}/progress` (`tasks.py:752-809`):
- Uses its own DB session and reader auth, and loads the task once.
- Emits `event: status`, `data: {"task_id", "status", "progress", "message": progress_message or ""}`.
- If the task is already `completed`, `error` or `cancelled`: emits `event: close`, `data: {"status"}`, and ends.
- Otherwise it subscribes to `progress:{task_id}` (`progress.py:79-96`). For each message:
  - `event = data.event_type or "progress"`, `data` = JSON of the payload.
  - If `data.status` is terminal: emits `close` and breaks.
- Events published between the initial DB read and the subscribe are lost.
- `sse_starlette` 3.4.1 defaults: a ping comment every 15 s, `Cache-Control: no-store`, `X-Accel-Buffering: no`.

**Consumer** (`frontend/src/hooks/use-task-progress.ts`):
- Listens for `status`, `progress`, `clip_ready` (uses `data.clip`) and `close`.
- On `onerror` it keeps the stream open and reconciles.
- Reconcile means re-fetching the task: on terminal status, every **5 s**, on visibility change and on `online`.
- Because of this the UI keeps working without SSE. A Mongo port can use DB polling plus optional SSE, which suits Vercel's function time limits.

Redis keys to replace:

| Key | Meaning | TTL |
|---|---|---|
| `progress:{id}` | channel, plus a latest-snapshot string | 3600 s |
| `task_cancel:{id}` | cancel flag | 3600 s |
| `task_source:{id}` | legacy copy of the source metadata | 7 days (`tasks.py:278-281`) |
| `arq:job:*`, `arq:in-progress:*`, queue zset `original-app_tasks`, health key | arq internals | |
| `dead_letter:{id}`, `tasks:dead_letter` | dead letters | DROP |

---

## 6. `tasks.source_metadata` (JSONB, merged with `||`)

Written by `_save_task_source_metadata` at create, resume and settings (`tasks.py:265-311`; `task_repository.py:85-104`). Keys:

- `processing_job_id`, `clip_length`
- `url`, `source_type`, `output_format`, `add_subtitles`
- `cut_long_pauses`, `pause_threshold_ms`, `remove_filler_words`, `filtered_words`
- `stream_resolution` (twitch/kick only, DROP)

Readers fall back to the Redis `task_source:{id}` copy when the column is empty (`tasks.py:236-262`; `clip_service.py:667-706`).

---

## 7. Clip storage model

- **Files:** `{TEMP_DIR}/clips/*.mp4`. `TEMP_DIR` defaults to `temp` (`config.py:119`).
- **Sidecar** `<clip>.source_map.json` (`clip_source_map.py`) contains:
  - `{"version": 1, "source_ranges": [{start, end}, ...]}`, in seconds of the source, in play order. Ranges may run out of order (a hook teaser comes first).
  - optional `caption_settings`
  - optional `broll` (DROP)
- Trim, split, merge, captions, settings-regenerate and the editor all depend on `source_ranges`. When the sidecar is missing, the code falls back to `[(start_time, end_time)]` parsed from MM:SS (`clip_service.py:654-664`).
- `generated_clips` has a unique index on `(task_id, clip_order)` (`backend/src/migrations/sql/20260319_0002_generated_clips_task_order_unique.sql:27`). `create_clip` upserts on it and queues deletion of the replaced file (`clip_repository.py:47-54`).
- `start_time` and `end_time` are stored as `MM:SS` strings, rounded to whole seconds (`clip_service.py:625-630`). `duration` is a float of cleaned seconds.
- With S3 enabled, `persist_clip` uploads the clip and its sidecars to `clips/{task_id}/{hex}/{name}`, and `file_path` becomes `s3://...` (`media_storage.py:191-208`). This is the "storage behind an interface" seam.

---

## 8. Clip file serving

`GET /tasks/{task_id}/clips/{clip_id}/file?download=false` (`tasks.py:909-952`), reader auth.
- 404 "Clip not found" (missing or wrong task); 404 "Clip file not found" (file missing).
- S3: 307 redirect to a presigned GET with `Content-Disposition` inline or attachment, TTL `MEDIA_URL_TTL_SECONDS` (default 900, clamped to 60-3600; `config.py:130`; `media_storage.py:335-341`).
- Local: closes the DB session before streaming, then `FileResponse` `video/mp4` with `Content-Disposition` inline or attachment and filename = `clip.filename`, `Cache-Control: private, no-store`.
- Starlette 1.3.1 `FileResponse` supports `Range` and `If-Range` (206, `Accept-Ranges: bytes`). The Next proxy forwards `Range` and `If-Range` (`frontend/src/app/api/tasks/[...path]/route.ts:27-40`). **The port must support Range requests** so the video player can seek.

---

## 9. Delete semantics

**`delete_task`** (`task_service.py:834-855`) runs under the edit lock, so it is refused while queued or processing.
1. If the source URL is `upload://...`: queues deletion of the upload file (`{TEMP_DIR}/uploads/{name}` or the S3 source).
2. Else, if S3 is enabled and it is YouTube: queues deletion of the S3 transcript metadata.
3. `delete_clips_by_task` (`clip_repository.py:213-230`):
   - For each clip: `queue_clip_delete`, which covers the clip file plus its editor directory `{TEMP_DIR}/editor/{sha256(task:clip:filename)}` as a prefix, and the S3 editor prefix.
   - Queues deletion of export files.
   - Cancels unpublished social posts (DROP).
   - Deletes the rows.
4. Deletes the `tasks` row. FK cascades clear `clip_exports`. **The `sources` row is not deleted**: `tasks.source_id` is `ON DELETE SET NULL`. **`processing_cache` rows are kept.**

**`queue_delete`** (`media_repository.py:40-54`) inserts into the `media_deletions` outbox `(file_path PK, is_prefix, attempts, next_attempt_at, hold_token)`.
- Local paths outside `TEMP_DIR` are skipped with a warning.
- The actual deletion happens later in `drain_deletions` (section 10). It deletes only if the path is not `referenced()` by any `generated_clips.file_path`, by a `sources.url` that still has a task, or by a publishing social post. Local deletes also remove the `.source_map.json` and `.transcript_cache.json` sidecars and `<stem>.transcription.mp3` (`media_storage.py:549-559`).

**`delete_clip`**: queues the clip's media, export files and editor directory, then reorders (`clip_repository.py:232-248`).

---

## 10. Cron jobs (`workers/tasks.py:245-252`, `workers/media_cleanup.py`)

KEEP (adapt to local disk plus Mongo):

**`cleanup_media`** runs every 5 minutes (minute ∈ {0, 5, …, 55}) and once at startup (`media_cleanup.py:185-197`):
1. `drain_deletions(limit=100)` (`media_cleanup.py:81-109`): picks the outbox row with the earliest due `next_attempt_at` (`FOR UPDATE SKIP LOCKED`), re-checks `referenced`, deletes, then removes the row. On failure, `attempts + 1` and `next_attempt_at = now + min(21600, 60·2^min(attempts, 9))` seconds.
2. `cleanup_upload_sessions`: S3 only. Aborts expired multipart sessions in state `reserved` or `uploading`, and deletes completed or aborted session rows older than 2 days (`media_cleanup.py:200-227`).
3. `expire_clip_exports` (`clip_export_service.py:357-371`):
   - reaps stale running exports (180 s) and queued ones (lost after 60 s, overdue at 1 h)
   - deletes succeeded exports past `expires_at` (7 days) and their files
   - purges failed rows older than 7 days
   - removes `{TEMP_DIR}/clip-exports/*` directories that are not live and are older than 1 h
4. `drain_deletions` again.
5. S3 cache housekeeping: `sweep_cache` (media-cache older than `MEDIA_CACHE_TTL_SECONDS`, min 14400), `sync_source_metadata`, `sync_editor_drafts`, `sweep_editor_cache` (`media_storage.py:655-699`). These do nothing in local mode except `sweep_cache`.

**`sweep_orphaned_media`** runs at 00:15, 06:15, 12:15 and 18:15 (`media_cleanup.py:230-241, 112-168`). Candidates older than `MEDIA_ORPHAN_GRACE_SECONDS` (minimum 86400):
- video files in `{TEMP_DIR}/uploads`, `/clips`, `/exports`
- YouTube leftovers in the `TEMP_DIR` root matching `[A-Za-z0-9_-]{11}.(mp4|webm|mkv|m4a|transcription.mp3|assemblyai.mp3|part)`
- legacy provider temp directories (`apify-`, `rapidapi-`, `oxy-`, `videoscale-`, `ytdl-`)
- `{TEMP_DIR}/editor/*` directories whose newest file is past the grace period
- the S3 equivalents

Anything not referenced is queued for deletion, then the outbox is drained.

DROP: `dispatch_scheduled_social_posts` (every minute) and `refresh_social_metrics` (hourly, minute 7).

There is no stuck-task cron (finding 5).

---

## 11. Endpoints, media router (`api/routes/media.py`, no prefix)

| Method and path | Auth | Request | Response | Errors |
|---|---|---|---|---|
| `GET /fonts` (138-157) | yes | none | `{"fonts": [{name, display_name, filename, format, file_path, scope: "system" or "user", supported_languages: string[] or null}]}`, sorted by `display_name`. Built from `backend/fonts/*.ttf\|otf` plus `backend/fonts/users/{sanitized_user}/` (`font_registry.py:89-117`). If the directory is missing: `{"fonts": [], "message": "Fonts directory not found"}` | 500 |
| `GET /fonts/{font_name}` (160-188) | yes | name: exact filename, or stem + .ttf/.otf, or a normalized alphanumeric match. The user's directory is searched first, then system fonts (`font_registry.py:120-156`) | font file, `font/ttf` or `font/otf`, `Cache-Control: private, no-cache`, `Access-Control-Allow-Origin: *` | 404 "Font not found" |
| `POST /fonts/upload` (191-256) | yes, plus a paid-plan gate (DROP the gate) | multipart field **`file`**; `.ttf` or `.otf`; max **10 MB** (`MAX_FONT_UPLOAD_BYTES`, line 43) | stored as `fonts/users/{u}/usr-{u}-{stem}.{ext}` (lowercase), with `-2`, `-3`… on collision (`font_registry.py:338-354`). Returns `{"font": {name, display_name, filename, format, scope: "user"}, "message": "Font uploaded successfully"}` | 400 "Missing file name" / "Only .ttf and .otf fonts are supported" / "Invalid font file name"; 413; 403 (gate) |
| `DELETE /fonts/{font_name}` (259-283) | yes | user fonts only | `{"font_name", "message": "Font deleted successfully"}` | 403 "Bundled system fonts cannot be deleted"; 404 "Custom font not found" |
| `GET /transitions` (286-314) | no | none | `{"transitions": [{name, display_name, file_path}]}` from `backend/transitions/*.mp4` (`video_utils.py:609-621`). `file_path` exposes the absolute server path | 500 |
| `GET /caption-templates` (317-341) | no | none | `{"templates": [{id, name, description, animation, font_family, font_size, font_color, highlight_color}]}` (`caption_templates.py:226-240`); falls back to a single default template | none |
| `GET /ai/provider` (354-365) | no | none | `{"provider", "model", "configured": bool}`. Never includes secrets. KEEP (settings) | none |
| `GET /broll/status` (344-351) | no | none | **DROP** | |
| `POST /upload` (368-428) | yes | multipart field **`video`** | local: `{"message": "Video uploaded successfully", "video_path": "upload://{uuid4}{original_ext}"}`. S3: `video_path: "upload://s3/{sha256(user)}/{hex}/video{ext}"` | see the upload flow below |
| `POST /upload/authorize` (431-474) | yes | `{size: int, filename: string, contentType?: string (≤128)}` | local: `{"storage": "local"}`. S3: `{storage: "s3", video_path, uploadId, partSize: 67108864, parts: [{partNumber, url}]}` (presigned PUTs, 1 h; `media_storage.py:352-375, 416-421`) | 400; 429 (upload limit) |
| `POST /upload/parts` (477-485) | yes | `{video_path, uploadId, partNumbers: 1-3 ints}` | `{"parts": [...]}` | 400 "Upload expired or is unavailable; restart the upload" / "Invalid multipart part numbers" |
| `POST /upload/complete` (488-498) | yes | `{video_path, uploadId, parts: [{partNumber, etag}]}`, part numbers contiguous from 1 | `{"video_path"}`. Checks every part's size against the signed size; too large → abort plus "Uploaded file is too large. The upload limit is X." Validates owner, size and expected-size metadata (`media_storage.py:450-522`) | 400 |
| `POST /upload/abort` (501-521) | yes | `{video_path, uploadId}` | `{"message": "Upload cancelled"}` | 400 |

**Upload flow details:**
- **Limit:** `MAX_VIDEO_UPLOAD_BYTES`, default 4,000,000,000 (`config.py:111-113`). The frontend mirror is `NEXT_PUBLIC_MAX_VIDEO_UPLOAD_BYTES`.
- **Checks before reading** (`media/upload_limits.py:39-59`; `media.py:51-106`):
  - `Content-Length` and `Transfer-Encoding: chunked` both present → 400 "Conflicting upload length"
  - several or non-digit `Content-Length` → 400 "A single Content-Length is required"
  - `Content-Length` > max + 1 MiB of multipart framing → 413
- **While streaming:** bytes are counted; past the ceiling → 413. Multipart parser limits: `max_files=1`, `max_fields=8`, `max_part_size=1 MiB` for non-file parts. Bad multipart → 400 "A multipart upload is required". No file → 400 "No video file provided".
- **Local storage:** written in 1 MiB chunks to `{TEMP_DIR}/uploads/{uuid4}{ext}`. The file is deleted on failure, and over the cap → 413 "Uploaded file is too large. The upload limit is 4 GB." **The extension is not validated in local mode.** No `media_upload_sessions` row is created in local mode.
- **S3 mode:** `reserve_upload` (`repositories/upload_repository.py:14-32`) allows at most 3 active sessions (`MEDIA_UPLOAD_CONCURRENCY`) and 20 per day (`MEDIA_UPLOAD_DAILY_LIMIT`) per user, else 429 "Upload limit reached. Finish existing uploads or try again later." States: `reserved → uploading → completed | aborted`.
- **Frontend** (`frontend/src/lib/video-upload.ts:136-176`): POST `/api/upload/authorization` (`frontend/src/app/api/upload/authorization/route.ts`). Then one of three paths:
  - S3: 3 parallel part PUTs, each retried 3 times; on 403 the URL is refreshed via `/api/upload/parts`; then `/api/upload/complete`; on any failure `/api/upload/abort`.
  - No `BACKEND_AUTH_SECRET`: proxy through `/api/upload`. That route returns 411 without `Content-Length` and 413 when over the limit plus 1 MiB, then re-posts the form data (`frontend/src/app/api/upload/route.ts`).
  - Otherwise: the browser POSTs multipart directly to `${NEXT_PUBLIC_API_URL}/upload` with signed headers.
  
  For Vercel, the S3-style direct-to-storage path is the one to keep, because function request bodies are capped. A local-disk dev mode can keep the plain multipart route.

---

## 12. Health endpoints (`main.py:226-266`)

`GET /` (info), `GET /health`, `GET /health/db`, `GET /health/redis`, `GET /health/worker` (checks the arq heartbeat key; 503 when stale). In the port, `/health/worker` becomes a check on a heartbeat document written by the Node worker.

---

## 13. DROP inventory inside this area

| Item | Location |
|---|---|
| Billing checks and refunds | `BillingService` calls at `tasks.py:476-477, 509, 587-595, 1342-1345, 1404-1412`; `generation_allowance_guard` (`repositories/generation_allowance_guard.py`); `minute_usage_repository.py` (charge in `task_repository.py:75-76`, refund in `task_repository.py:341-342`); `reduced_media_limits` / `_media_limits` (`task_service.py:87-92, 359-366`; `clip_service.py:149, 506`); plan YouTube cap (`task_service.py:423-429`); font upload gate (`media.py:200-211`); `GET /tasks/billing/summary` |
| Social | `_load_performance_context` (`task_service.py:272-289`); `SocialRepository.cancel_unpublished_for_clips` (`clip_repository.py:222, 242`); social reference in `media_cleanup.py:39-42, 76`; social crons and job |
| Admin | admin reader branch (`tasks.py:349-352`); `/tasks/metrics/performance`; `/tasks/dead-letter/list`; dead-letter writes (`workers/tasks.py:114-129`) |
| B-roll | `include_broll` everywhere; `BRollSession`; `_carry_broll`, `broll_overlays_for`, `save_clip_broll`; `/broll/status` |
| Emails | `_send_completion_notification_if_needed` (`task_service.py:707-763`); `get_task_notification_context`, `mark_completion_notification_sent` (`task_repository.py:503-560`) |
| Observability | `SourceAttempt` and `rejected_source_attempts` (`source_submission.py`); `set_trace_id`, `set_user_id`, `bind_request_user`; trace middleware (`main.py:94-125`) |
| API keys | `extract_api_key`, `hash_api_key`, ApiKeyRepository branch (`auth_headers.py:27-49, 125-134`) |
| Twitch/Kick | stream preflight, `_seed_stream_source`, stream cleanup, `download_stream_*` branches |
| Share links | unless kept as trivial (section 3) |