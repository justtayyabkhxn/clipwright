# Data model map: SupoClip (Postgres + Redis + files) → Clipwright (MongoDB)

All facts below were checked in the code. Paths are relative to `C:\other-projects\supoclip`.

## 0. Where the schema is defined

Three separate migration runners create overlapping tables. All three are dropped in the port.

- `init.sql` is the full bootstrap used by Docker (lines 1-322).
- `backend/src/database.py:104-142` (`init_db`) runs `Base.metadata.create_all` from `backend/src/models.py`. It then creates `schema_migrations(version PK, applied_at)` (line 110) and applies `backend/src/migrations/sql/*.sql` in sorted order, splitting each file on `;`.
- `backend/migrations/001-003*.sql` are old one-off scripts for progress fields, completion notifications and RevenueCat.
- `frontend/prisma/schema.prisma` plus 26 folders under `frontend/prisma/migrations/` form a second copy that Prisma migrates.
  - Prisma does **not** model `generated_clips`, `processing_cache`, `clip_exports`, `media_deletions`, `media_upload_sessions` or `rejected_source_attempts`. The backend owns those through raw SQL.
  - Prisma's `Task` model leaves out `processing_mode`, `started_at`, `completed_at`, `cache_hit`, `error_code` and `stage_timings_json`. Those columns are owned by the backend.
- `models.py` has drifted from the real schema. For example, `GeneratedClip` has no `hook_title`, which only migration `20260704_0001` adds.

Triggers (`init.sql:291-322`):
- `update_updated_at_column()` sets `updated_at` on `tasks`, `sources`, `generated_clips` and `app_settings`.
- `update_updatedAt_column()` sets `"updatedAt"` on `users`, `session`, `account` and `verification`.
- **Mongo has no triggers, so every write must `$set: {updatedAt: new Date()}` itself.** Better Auth already does this for its own collections.

---

## 1. Tables to KEEP, transformed

### 1.1 `users` (`init.sql:8-43`, Prisma `User` `schema.prisma:58-110`)

Better Auth core columns, which the Mongo adapter maps directly:

| column | type / default |
|---|---|
| id | VARCHAR(36) PK, default `uuid_generate_v4()` |
| name | VARCHAR(255) NOT NULL |
| email | VARCHAR(255) UNIQUE NOT NULL, plus `idx_users_email` (`init.sql:268`) |
| "emailVerified" | BOOLEAN NOT NULL default false |
| image | VARCHAR(500) |
| "createdAt", "updatedAt" | TIMESTAMPTZ default now; `updatedAt` is set by trigger |

App columns:

| column | type / default | port |
|---|---|---|
| is_admin | BOOLEAN NOT NULL default false | KEEP. It is a Better Auth `additionalField` and gates the Claude-key settings. |
| default_font_family | VARCHAR(100) default 'TikTokSans-Regular' | KEEP (caption defaults) |
| default_font_size | INT default 24 | KEEP. Validated as an integer from 12 to 48 (`frontend/src/app/api/preferences/route.ts:83`). |
| default_font_color | VARCHAR(7) default '#FFFFFF' | KEEP. Validated against `^#[0-9A-Fa-f]{6}$` (route.ts:90). |
| default_clip_length | VARCHAR(10) NOT NULL default 'auto', CHECK IN ('auto','short','medium','long') (`init.sql:24-25`, migration `20261025_0004_default_clip_length.sql`) | KEEP |
| notify_on_completion | BOOLEAN NOT NULL default true | DROP (only drives the SES completion email) |
| product_updates_unsubscribed_at | TIMESTAMPTZ | DROP (email) |
| first_name, last_name | VARCHAR(100) | DROP. Only read by email code (`task_repository.py:517`, `email_preference_repository.py:20`). |
| password_hash | VARCHAR(255) | DROP. Never read; Better Auth keeps the password in `account.password`. |
| plan, subscription_status, subscription_provider, stripe_customer_id (UNIQUE), stripe_subscription_id (UNIQUE), billing_period_start/end, trial_ends_at, subscription_cancel_at, legacy_hd, pending_plan, pending_plan_invoice_id | billing | DROP |

How the KEEP scope reads and writes users:
- Preferences GET selects the 5 `default_*` and notify fields (`preferences/route.ts:19-28`). It applies fallbacks in code (`:38-42`), so the port must apply defaults in code too: Mongo has none.
- Preferences PATCH writes only the fields present (`:108-126`).
- `SELECT is_admin FROM users WHERE id=?` (`backend/src/admin_auth.py:11-34`).
- The frontend admin check reads `session.user.is_admin` (`frontend/src/app/api/admin/users/[id]/admin/route.ts:12`).
- `PATCH /api/admin/users/{id}/admin` sets `is_admin` (`:39-47`).
- `SELECT 1 FROM users WHERE id=?` (`task_repository.py:487-492`).

**No code bootstraps the first admin.** `is_admin` is only set by the admin route, which already requires an admin, or by hand in SQL.

### 1.2 Better Auth tables (`init.sql:131-165`, Prisma `:353-395`)

- **session**: id PK, "expiresAt" NOT NULL, token UNIQUE NOT NULL, "createdAt", "updatedAt" NOT NULL, "ipAddress", "userAgent", "userId" FK→users ON DELETE CASCADE. Indexes `idx_session_token` and `idx_session_userId` (`init.sql:283-284`).
- **account**: id PK, "accountId", "providerId", "userId" FK CASCADE, "accessToken", "refreshToken", "idToken", "accessTokenExpiresAt", "refreshTokenExpiresAt", scope, password, "createdAt", "updatedAt". Index `idx_account_userId` (`:285`).
- **verification**: id PK, identifier, value, "expiresAt" NOT NULL, "createdAt", "updatedAt". Index `idx_verification_identifier` (`:286`).

### 1.3 `sources` (`init.sql:46-53`): embed into the task

- Columns: id PK uuid, type VARCHAR(20) NOT NULL, title VARCHAR(500) NOT NULL, url VARCHAR(1000), created_at, updated_at.
- `type` has CHECK IN ('youtube','video_url','twitch','kick') (`init.sql:48`, migration `20261021_0001`). Uploads are type `video_url` with url `upload://{uuid}{ext}` (`video_service.py:620-630`, `api/routes/media.py:387-419`). The KEEP scope only needs `youtube` and `video_url`.
- Indexes: `idx_sources_created_at` (`init.sql:278`) and `sources_url_idx` (migration `20261014_0001:6`, used by cleanup).
- **Every task creates its own source row** (`task_service.py:249-251`), so the relation is 1:1 in practice.
- Queries:
  - `INSERT` (`source_repository.py:19-62`)
  - `SELECT * WHERE id`
  - `UPDATE title` when a task is renamed (`source_repository.py:87-94`, route `tasks.py:812-831`)
  - joined into every task read (`task_repository.py:115-118`, `378-387`)
  - `prisma.source.deleteMany` on account deletion, because `sources` has no `user_id` (`frontend/src/server/account-deletion.ts:61-69`).

### 1.4 `tasks` (`init.sql:56-90` plus migrations)

| column | type / default | port |
|---|---|---|
| id | VARCHAR(36) PK; app generates `uuid4` (`task_repository.py:42`) | KEEP |
| user_id | NOT NULL FK→users CASCADE; `idx_tasks_user_id` | KEEP |
| source_id | FK→sources SET NULL; `idx_tasks_source_id` | replaced by embedded `source` |
| generated_clips_ids | VARCHAR(36)[]; a denormalised copy of clip ids in order (`task_repository.py:358-369`, `clip_repository.py:390-393`) | DROP (embedded array) |
| status | VARCHAR(20) NOT NULL default 'pending'; `idx_tasks_status` | KEEP. Values used: pending, queued, processing, completed, error, cancelled. Legacy 'failed' and 'canceled' appear only in billing refund SQL. |
| progress | INT default 0, CHECK 0..100 | KEEP |
| progress_message | TEXT | KEEP |
| source_metadata | JSONB NOT NULL default '{}' (migration `20261011_0001`); merged with `||` (`task_repository.py:86-95`) | KEEP as `settings` (see the key list below) |
| source_duration_seconds | INT (billing, `20261018_0001`) | optional info only |
| font_family / font_size / font_color | VARCHAR(100) 'TikTokSans-Regular' / INT 24 / VARCHAR(7) '#FFFFFF' | KEEP |
| caption_template | VARCHAR(50) default 'default' | KEEP |
| include_broll | BOOL default false | DROP |
| processing_mode | VARCHAR(20) NOT NULL default 'fast', values fast/balanced/quality (`tasks.py:456-460`); `idx_tasks_processing_mode` | KEEP |
| started_at, completed_at, cache_hit (BOOL NOT NULL false), error_code (VARCHAR 80), stage_timings_json (TEXT) | `20260302_0001` | KEEP as `run` |
| completion_notification_sent_at | TIMESTAMPTZ | DROP |
| share_token VARCHAR(64), share_enabled BOOL NOT NULL false | unique partial index `WHERE share_token IS NOT NULL` (`init.sql:277`, `20260722_0001`) | optional (small) |
| created_at, updated_at | `idx_tasks_created_at`, `idx_tasks_completed_at` | KEEP |

`source_metadata` keys written by task creation (`tasks.py:526-540`) and `_merge_task_source_metadata` (`tasks.py:289-311`):
- `processing_job_id` (`"{task_id}:{hex32}"`)
- `clip_length` ('auto'|'short'|'medium'|'long'; ranges in `clip_duration.py:18-20`)
- `url`
- `source_type`
- `output_format`, one of {vertical, vertical_fit, vertical_pan, vertical_split, original} (`media/common.py:65`)
- `add_subtitles` (bool)
- cleanup keys from `clip_cleanup.py:84-109`:
  - `cut_long_pauses`, default true for new tasks (`:15`)
  - `pause_threshold_ms`, default 1200 (`:12`)
  - `remove_filler_words`, default true for new tasks (`:16`)
  - `filtered_words[]`
- `stream_resolution` (twitch/kick; DROP)

Readers fall back to defaults when keys are missing (`clip_service.py:667-726`). The same payload is also mirrored to Redis `task_source:{id}` for 7 days (`tasks.py:265-286`), which is legacy and can go.

### 1.5 `generated_clips` (`init.sql:93-117`): embed into the task

| column | type |
|---|---|
| id | VARCHAR(36) PK uuid4 (`clip_repository.py:56`) |
| task_id | NOT NULL FK→tasks CASCADE; `idx_generated_clips_task_id` |
| filename | VARCHAR(255) NOT NULL; also the editor "basis" |
| file_path | VARCHAR(500) NOT NULL: an absolute local path or `s3://`; `generated_clips_file_path_idx` (`20261014_0001:5`) |
| start_time, end_time | VARCHAR(20) NOT NULL, "MM:SS" |
| duration | FLOAT NOT NULL, seconds |
| text | TEXT (clip transcript) |
| relevance_score | FLOAT NOT NULL |
| reasoning | TEXT |
| clip_order | INT NOT NULL; `idx_generated_clips_clip_order`; **UNIQUE(task_id, clip_order)** `uq_generated_clips_task_order` (`20260319_0002:26-27`) |
| virality_score, hook_score, engagement_score, value_score, shareability_score | INT default 0 |
| hook_type | VARCHAR(50) |
| hook_title | VARCHAR(200) (`20260704_0001`) |
| created_at, updated_at | `idx_generated_clips_created_at` |

Sidecar data stored outside the DB, as `{clip}.source_map.json` beside each clip file (`clip_source_map.py:19-20`):
- `source_ranges[{start,end}]` (`:57-77`)
- `caption_settings{font_size, position, position_y, highlight_words}` (`:123-138`; written at `clip_service.py:604-609` and `video_utils.py:572-575`)
- `broll` (DROP)

`GET /tasks/{id}` returns `caption_settings` per clip (`task_service.py:813-822`), but **the frontend never reads it** (grep finds no hit). The backend uses it for editor init and caption edits.

### 1.6 `processing_cache` (`init.sql:119-128`, `20260302_0001`)

- Columns: cache_key VARCHAR(255) PK, source_url TEXT NOT NULL, source_type VARCHAR(20) NOT NULL, video_path TEXT, transcript_text TEXT, analysis_json TEXT, created_at, updated_at.
- `idx_processing_cache_source_url` exists but **no query uses it**.
- Key: `sha256("{source_type}|{processing_mode}|{TRANSCRIPT_ANALYSIS_CACHE_VERSION}|{url.strip()}")`, with `|q{quality}` appended for reduced-quality YouTube (`task_service.py:61-73`). The version constant is `"windowed-rerank-v6"` (`ai.py:37`).
- When `clip_length != auto`, the analysis is stored under the derived key `sha256("{key}|length:{clip_length}")` (`task_service.py:75-85`).
- Queries:
  - `get_cache` by key
  - upsert `ON CONFLICT DO UPDATE` with **COALESCE semantics**: a NULL in the new row keeps the old value (`cache_repository.py:37-75`). Used at `task_service.py:372-383` and `467-500`.
- A personalized analysis skips the cache (social: DROP).

### 1.7 `app_settings` (`init.sql:181-188`, `20260503_0001/0002`)

- Columns: setting_key VARCHAR(100) PK, encrypted_value TEXT NOT NULL, prefer_admin_value BOOL NOT NULL false, updated_by FK→users SET NULL (`idx_app_settings_updated_by`), created_at, updated_at.
- Keys (`runtime_settings.py:15-27`): ASSEMBLY_AI_API_KEY, LLM, OPENAI_API_KEY, OPENROUTER_API_KEY, GOOGLE_API_KEY, ANTHROPIC_API_KEY, OLLAMA_BASE_URL, OLLAMA_API_KEY, YOUTUBE_DATA_API_KEY, APIFY_API_TOKEN, PEXELS_API_KEY. **Only ASSEMBLY_AI_API_KEY, LLM and ANTHROPIC_API_KEY matter for Clipwright.**
- Encryption is AES-256-GCM with key = sha256(secret), where secret = `APP_SETTINGS_ENCRYPTION_KEY` ‖ `BACKEND_AUTH_SECRET` ‖ `BETTER_AUTH_SECRET` and must be at least 16 characters. Format is `v1:{b64url nonce12}:{b64url tag16}:{b64url ciphertext}` (`runtime_settings.py:55-91`). Node `crypto` can reproduce it byte for byte.
- Queries:
  - `SELECT ... WHERE setting_key = ANY(keys)` (`runtime_settings.py:94-169`)
  - upsert (`admin.py:197-218`)
  - `UPDATE prefer_admin_value` (`:220-236`)
  - `DELETE WHERE key = ANY` (`:238-247`)
- Precedence: the admin value wins if `prefer_admin_value` is set or no env var exists; otherwise the env var wins (`admin.py:106-111`).
- The UI is admin-only: `components/settings/ai-provider-settings.tsx:45,82` calls `/api/admin/runtime-settings`, and `/api/admin/ai/test-connection` (`admin.py:144-153`) checks a key through the Models API.

### 1.8 `clip_exports` (`20261025_0001_clip_exports.sql`): fold into `jobs`

- Columns:
  - id VARCHAR(36) PK (uuid4, `clip_export_service.py:314`)
  - task_id, clip_id, user_id: all FK CASCADE
  - preset VARCHAR(32): tiktok | reels | shorts (`clip_editor.py:36-40`)
  - options_hash VARCHAR(64) = sha256 of `{"preset", "source_file_path"}` (`clip_export_service.py:60-67`)
  - source_file_path, status CHECK IN (queued, running, succeeded, failed), progress INT 0..100, error_message, file_path, download_filename
  - created_at, updated_at (used as the heartbeat), expires_at NOT NULL (TTL 7 days, `clip_export_service.py:36`)
- Indexes:
  - unique `(clip_id, options_hash) WHERE status IN (queued, running, succeeded)`
  - `ix_clip_exports_clip_id`, `ix_clip_exports_task_id`
  - `(expires_at) WHERE succeeded`
  - `(updated_at) WHERE queued/running`
- Used by the task page (`frontend/src/app/tasks/[id]/page.tsx:548-554`, `lib/clip-export.ts:25`).
- Queries (`clip_export_repository.py`):
  - `lock_options` advisory xact lock (`:23-27`)
  - get / get_for_task_clip (`:30-50`)
  - get_live with optional `FOR UPDATE` (`:53-69`)
  - insert (`:72-114`)
  - list_queued (`:117-144`)
  - fail_stale_running when `updated_at < now - 180s` (`:147-185`; stale threshold `clip_export_service.py:41`)
  - mark_running / update_progress (monotonic, < 100) / touch / mark_succeeded / mark_failed (`:188-268`)
  - lock_expired `FOR UPDATE SKIP LOCKED` (`:278-291`)
  - purge_failures older than 7 days (`:294-305`)
  - live_ids, queue_file_deletes (`:308-347`)

### 1.9 Editor drafts: JSON files on disk with a file lock, no table today (KEEP, move to Mongo)

- Directory: `{TEMP_DIR}/editor/{sha256(task_id:clip_id:filename)}` (`editor_document.py:113-116`). Because the key includes the filename, a changed clip file starts a fresh editor state.
- Files:
  - `asset.json`: `{status: unprepared|preparing|ready|failed, error?, width, height, fps, duration, hasAudio, waveform[160 floats]}` (`editor_service.py:51-59`, `132-140`, `editor.py:85-103`)
  - `draft.json`: `{revision:int, document: EditDocument}`
  - `original.json`: the initial `EditDocument` (`editor_service.py:466-501`)
  - `request-{job}.json`: the payload `{document, preset}` or `{inputs:[...]}` for combine
  - `job-{job}.json`: `{status: queued|rendering|completed|failed|cancelled, progress, error?, clip_id?}`
  - `cancel-{job}`: a marker file
  - `clean.mp4`, `thumbnails.jpg`: preview media
- `EditDocument` schema (`editor_document.py:27-110`):
  - `version: 1`
  - `segments[1..100]{id, start, end}`, each at least 0.04 s
  - `words[0..5000]{id, start, end, text ≤120, highlight}`
  - `captions{enabled, font ∈ 4 fonts, size 20-132, color, accent, y 0.1-0.9, background, wordsPerLine 1-8, karaoke, uppercase, template}`
  - `framing{aspect: vertical|square|original, fit: contain|cover, zoom 1-3, x, y}`
  - `effects{brightness 40-180, contrast 40-180, saturation 0-220, blur 0-8, hue ±180}`
  - `volume 0-2`, `muted`, `hookTitle ≤200`
  - Rule: unique ids, and nothing past the clip's duration + 0.05 s.
- Save rule (`editor_document.py:144-157`, `editor.py:106-152`):
  - under `flock`, `revision` must equal the stored revision, else 409
  - the payload `basis` must equal `clip.filename`, else 409
  - status must be ready, else 409
- Export rule: at most 3 queued or rendering exports per clip, checked under the lock, else 429 (`editor.py:203-210`, `345-354`). The job list returns the latest 20 (`editor.py:71-76`). Combine accepts 2-20 distinct clips (`editor.py:311-317`).
- Undo/redo history lives only in browser `localStorage` (`components/editor/use-editor.ts:49-60`, `191-197`) and stays client-side.

---

## 2. Tables to DROP

Each is listed with its columns so nothing is lost silently.

- `stripe_webhook_events(id, type, created_at)` and `revenuecat_webhook_events(...)` (`init.sql:168-179`): billing.
- `minute_usage_events(id, user_id, task_id UNIQUE, minutes, source_duration_seconds, created_at, refunded_at)` (`20261025_0002`), written inside `create_task` and `update_task_status` (`task_repository.py:75-76`, `341-342`): billing. **Remove these calls during the port.**
- `api_keys(id, user_id, name, key_hash UNIQUE, key_prefix, created_at, last_used_at, revoked_at)` (`init.sql:191-200`): API keys and MCP.
- `user_acquisition(user_id PK, utm_*, ref, referrer_host, landing_path, first_seen_at, first_clip_exported_at, created_at)` (`:203-216`): attribution.
- `affiliates(... slug UNIQUE, status, platform, profile_url ...)` (`:219-237`): creator program.
- `announcements` (`:239-265`) and `service_statuses` (`20261013_0002`): marketing and status page.
- `email_deliveries(message_id PK, recipient, subject, region, sent_at)` (`20261016_0001`): SES.
- `social_accounts`, `social_oauth_states`, `social_posts`, `social_post_metrics` (`20260901_0001`): social.
- `rejected_source_attempts(id, user_id, domain, sanitized_url, reason, client, created_at)` (`20261023_0001`; insert at `source_submission.py:428-445`): analytics.
- `media_upload_sessions(id, user_id, upload_id UNIQUE, video_path UNIQUE, size, state CHECK, created_at, expires_at)` (`20261014_0001:8-18`): **used only for S3 multipart**, when `storage.enabled` (`media.py:399-412`, `431-518`). Local uploads never touch it.
- `media_deletions(file_path PK, is_prefix, created_at, attempts, next_attempt_at, hold_token)` (`20261013_0001`, `20261014_0001`): a deletion outbox written in the same transaction as row changes (`media_repository.py:40-75`) and drained with `FOR UPDATE SKIP LOCKED` plus exponential backoff capped at 6 h (`workers/media_cleanup.py:81-109`).
  - `hold_token` is only ever read from `db.info` and never set anywhere, so it is dead code.
  - Section 7.7 suggests replacing the whole outbox.
- `schema_migrations` (`database.py:110`).
- KEEP-adjacent queries that go away: the admin dashboard Prisma counts (`frontend/src/app/admin/page.tsx:125-234`), `get_performance_metrics` (`task_repository.py:209-245`, admin), `get_task_notification_context` and `mark_completion_notification_sent` (`:503-560`, email), the dead-letter list (`tasks.py:1422-1448`), and all billing queries in `services/billing_service.py`.

---

## 3. State outside Postgres that the port must replace

| Today | Where | Clipwright |
|---|---|---|
| ARQ queue `supoclip_tasks`; `max_tries=3`, `job_timeout=10800`, `max_jobs=4`; `export_clip_preset` `max_tries=1` | `workers/tasks.py:206-244`, `job_queue.py:110-185` | `jobs` collection (§7.5) |
| Redis `progress:{task_id}`: SETEX 3600 + PUBLISH; events `{task_id, progress, message, status}` and `{event_type: clip_ready, clip_index, total_clips, clip}` | `workers/progress.py:15-77`; SSE `tasks.py:752-809` | progress fields on the task doc, plus SSE that polls Mongo or plain client polling |
| Redis `task_cancel:{task_id}`: SETEX 3600 by cancel, DEL by resume, read by `should_cancel` | `tasks.py:1260`, `1356`; `workers/tasks.py:76-78` | `task.status === 'cancelled'` or `job.cancelRequested` |
| Redis `task_source:{task_id}`, 7 days | `tasks.py:265-286` | drop; `task.settings` already holds it |
| Redis `dead_letter:{id}` and set `tasks:dead_letter` | `workers/tasks.py:115-127` | drop; a failed job doc is enough |
| Editor JSON files and `fcntl.flock` | §1.9 | `clip_drafts` plus `jobs` |
| `.source_map.json` sidecars | §1.5 | engine output saved on the clip subdocument (keep the file for the engine if convenient) |
| `.transcript_cache.json` (word timings) beside the source | `youtube_source.py:310-325`, CLAUDE.md | remains a storage artifact |
| Crons: `cleanup_media` every 5 min, `sweep_orphaned_media` at 00/06/12/18:15 | `workers/tasks.py:245-247` | worker interval timers |

**Windows blocker:** `import fcntl` sits at module top level in `backend/src/editor_document.py:12`, `backend/src/media_storage.py:13` and `backend/src/media/source_limits.py:15`. `fcntl` does not exist on Windows, so those modules cannot be imported by the Python render-engine CLI there. Moving drafts and locks to Mongo removes the editor lock. The other two need a Windows-safe lock or removal.

---

## 4. Queries the KEEP scope runs, and the Mongo index each one needs

Tasks:
1. **Get a task with its source.** Runs on every route for ownership checks (`task_repository.py:107-166`, `tasks.py:319-354`).
   - The owner check is `task.user_id == user`.
   - **Admins may also read tasks in queued, processing or pending** (`tasks.py:316`, `341-354`).
   - Mongo: `_id` lookup.
2. **List a user's tasks.** `WHERE user_id ORDER BY created_at DESC LIMIT 50`, plus per-task `COUNT(clips)`, `MAX(virality_score)`, and `cover_clip_id` = the clip with the highest virality, ties broken by lowest `clip_order` (`task_repository.py:372-415`).
   - The response shape the client expects is in `frontend/src/lib/generations.ts:1-14`.
   - Mongo index: `{userId:1, createdAt:-1}`.
3. **Compare-and-set status.** `UPDATE ... WHERE id AND status = ANY(expected)` returning whether a row changed (`task_repository.py:306-355`). Every status change uses it:
   - start (expect queued/processing) `task_service.py:400-406`
   - progress (expect processing; a miss raises TaskCancelled) `:413-418`
   - complete (expect processing) `:612-621`
   - cancelled / error (expect queued/processing) `:662-674`
   - cancel route `tasks.py:1264-1271`
   - resume to queued `tasks.py:1360-1366`
   - enqueue failure (expect queued) `:566-570`
   - Mongo: `updateOne({_id, status:{$in}})`, then check `matchedCount`.
4. **Runtime metadata.** `cache_hit`, `error_code`, `stage_timings_json`, `started_at`, `completed_at` (`task_repository.py:169-207`).
5. **Settings merge.** `source_metadata ||` (`:86-95`) maps to `$set` on `settings.<key>` dot paths. Read at `:98-104`.
6. **Styling update** (`:248-303`).
7. **Rename source title** (`source_repository.py:87-94`).
8. **Sharing.** Enable: keep the token if sharing is already on, rotate it when re-enabling (`task_repository.py:417-445`). Disable (`:447-463`). Resolve a token only when enabled and completed (`:466-484`). Mongo index: unique partial `{"share.token":1}`.
9. **Delete a task** (`:494-501`), together with clip, file and export cleanup (`task_service.py:834-855`).
10. **Stale sweeps on read** (`task_service.py:94-138`, `772-809`):
    - queued for at least 180 s with its ARQ job missing → error
    - processing with `updated_at` older than 14400 s → error
    - thresholds at `config.py:144-152`
    - Replaced by job leases (§7.5).

Clips:
- **Upsert** `ON CONFLICT (task_id, clip_order)`, replacing the clip at that position on retries; the old file is queued for deletion (`clip_repository.py:25-141`).
- **List by task** `ORDER BY clip_order` (`:144-200`).
- **Get by id** (`:251-309`).
- **Count** (`:203-211`).
- **Delete** by task or by id, each queuing deletes for the clip file, the editor dir and export files (`:213-248`).
- **Update** filename, path, times, duration, text (`:312-356`).
- **make_room_for_clip**: `FOR UPDATE`, then shift following orders +1 in descending order (`:359-370`).
- **reorder_task_clips**: renumber 1..n by (order, created_at) and rewrite `generated_clips_ids` (`:373-394`).
- Edit services, all `@serialized_task_edit`:
  - delete (`clip_service.py:55-61`)
  - update settings with optional regenerate-all (`:63-97`, `99-287`)
  - trim and regenerate (`:289-334`)
  - split (`:337-406`)
  - merge (`:409-473`)
  - captions (`:476-622`)
  - combine (`editor_service.py:686-716`): new clip at `max(order)+1`, then reorder
- **These run ffmpeg inside the HTTP request today.** On Vercel they must become worker jobs.

Cache: `get` by `_id`, and upsert that sets only non-null fields (§1.6).

Exports: see §1.8. Editor drafts: see §1.9.

---

## 5. Concurrency primitives today, and their replacements

| Primitive | Where | Purpose | Mongo replacement |
|---|---|---|---|
| `SELECT status FROM tasks WHERE id FOR UPDATE` held through the edit; rejects queued/processing for edits; processing mode requires status `processing` | `repositories/edit_transaction.py:25-53` | serialise clip edits and keep them away from processing | single-doc atomic updates on the embedded clips array, plus an `editLock` lease on the task (§7.6) |
| `pg_try_advisory_lock(hashtextextended(task_id, 913461))` on a dedicated connection; `exclusive_task_run` skips when completed/cancelled/error | `repositories/task_run_guard.py:20-43` | one worker run or resume per task | unique `activeKey: "task:{id}"` on `jobs` plus a CAS on task status |
| `pg_advisory_lock(user_id, 913462)` | `generation_allowance_guard.py:16-41` | billing admission | DROP |
| `pg_advisory_lock(upload_url, 113462)` | `media_repository.py:17-37` | upload creation vs. deletion race | covered by the 24 h orphan grace (`config.py:132`), with no lock |
| `pg_advisory_xact_lock(user_id, 113463)` plus counts | `upload_repository.py:14-32` | S3 upload admission (3 concurrent, 20 a day) | DROP |
| `pg_advisory_xact_lock(clip:options_hash, 902110)` plus `FOR UPDATE` | `clip_export_repository.py:23-69` | one live export per clip and options | unique `liveKey` |
| `FOR UPDATE SKIP LOCKED` | `clip_export_repository.py:278-291`, `media_cleanup.py:83-87`, `204-208` | crons claiming rows | `findOneAndDelete` / `findOneAndUpdate` claims, or nothing (single worker) |
| `fcntl.flock` plus a revision CAS on `draft.json` | `editor_document.py:129-157` | autosave across tabs | `updateOne({_id, revision})` |
| UNIQUE(task_id, clip_order) | `20260319_0002` | no duplicate positions | array position is the order |

**MongoDB transactions are not needed if clips are embedded.** This matters because a standalone local `mongod` has no transactions; they need a replica set, which Atlas always is.

---

## 6. Better Auth: current setup and what the Mongo adapter needs

Current setup (`frontend/src/lib/auth.ts`, better-auth `1.6.9` per `frontend/package.json:34`):
- `prismaAdapter(prisma, {provider: "postgresql"})` (`:38-40`).
- `user.deleteUser.enabled` with a `beforeDelete` hook that calls `prepareAccountDeletion` (`:42-47`). That hook does a Stripe check, frees the affiliate code, revokes social grants and deletes the user's sources (`server/account-deletion.ts:22-70`).
- `user.additionalFields.is_admin {type: "boolean", input: false}` (`:48-53`). No `defaultValue`; the Postgres default supplied false.
- `trustedOrigins` (`:30-35`, `lib/auth-origins.ts:19-35`): NEXT_PUBLIC_APP_URL, BETTER_AUTH_URL, hard-coded localhost:3107 variants, comma-separated BETTER_AUTH_TRUSTED_ORIGINS, plus localhost/127.0.0.1:3001/3107 when NEXT_PUBLIC_SELF_HOST is true.
- `emailVerification` (`:56-73`): `sendOnSignUp false`, `sendOnSignIn false`, `expiresIn 3600`. It sends through the backend SES endpoint `/account/verification-email`. There is no `requireEmailVerification`, and it is only triggered from the API-keys page, which is dropped.
- `emailAndPassword` (`:74-84`): enabled; `disableSignUp` from env `DISABLE_SIGN_UP` (`:9-11`); `revokeSessionsOnPasswordReset: true`. `sendResetPassword` fires and forgets a call to backend SES `/account/password-reset-email` (`:13-28`, `78-83`).
- No `session` block, so Better Auth defaults apply: 7-day expiry, refreshed daily.
- Plugins: `nextCookies()` only.
- The client is a plain `createAuthClient()` (`lib/auth-client.ts`).
- APIs used: `signUp.email`, `signIn.email`, `signOut`, `requestPasswordReset`, `resetPassword`, `deleteUser`, `sendVerificationEmail` (API keys only), and `auth.api.getSession` on the server (`server/session.ts`).
- Handler: `app/api/auth/[...all]/route.ts`.

What the MongoDB adapter needs. I checked `node_modules/.pnpm/@better-auth+mongo-adapter@.../dist/index.mjs`, 492 lines.
- Import: `import { mongodbAdapter } from "better-auth/adapters/mongodb"`, which re-exports `@better-auth/mongo-adapter` 1.6.9. Peer dependency `mongodb ^6 || ^7`. **`mongodb` is not installed in `frontend/` yet.**
- Signature: `mongodbAdapter(db, { client?, usePlural?, debugLogs?, transaction? })`.
  - Transactions are on by default when `client` is passed.
  - The typings say a standalone server needs `transaction: false`.
- Collection names default to `user`, `session`, `account`, `verification`, because `usePlural` defaults to false (`:416`).
- IDs: `_id` is an ObjectId by default, and so are reference fields (`session.userId`, `account.userId`). `generateId: "uuid"` stores a BSON UUID instead; a custom `generateId` function stores the raw value (`:89-130`, `436-480`). The API returns ids as hex strings.
- **The adapter creates no indexes** (no `createIndex` calls in its source), so create them in an init script (§7.1).
- `deleteUser` removes sessions, then accounts, then the user (`better-auth/dist/db/internal-adapter.mjs:127-139`). **App data must be removed in `beforeDelete`; nothing cascades.**
- Add `defaultValue: false` to `is_admin`. Frontend reads (`Boolean(session.user.is_admin)`) already tolerate a missing value.

---

## 7. Proposed MongoDB design

### 7.1 Better Auth collections

- `user`: `{_id: ObjectId, name, email, emailVerified, image, createdAt, updatedAt, is_admin: false, preferences?: {fontFamily, fontSize, fontColor, clipLength}}`. Preferences are written by our own route with the driver; Better Auth never touches them. Defaults are applied on read.
- `session`, `account`, `verification`: the Better Auth shapes from §1.2, with ObjectId `userId`.
- Indexes:
  - `user {email:1} unique`
  - `session {token:1} unique`, `{userId:1}`, `{expiresAt:1}` with TTL `expireAfterSeconds: 0`
  - `account {userId:1}`, `{providerId:1, accountId:1}`
  - `verification {identifier:1}`, `{expiresAt:1}` with TTL 0
- App collections store `userId` as the **hex string** from `session.user.id`. Only direct `user` lookups need `new ObjectId(id)`.

### 7.2 `tasks`: source and clips embedded

```ts
{
  _id: string,                 // crypto.randomUUID(), keeps URL shape
  userId: string,
  status: "queued"|"processing"|"completed"|"error"|"cancelled",
  progress: number, progressMessage: string,
  source: { type: "youtube"|"video_url", title: string, url: string, durationSeconds?: number },
  settings: {
    fontFamily, fontSize, fontColor, captionTemplate, processingMode, outputFormat,
    addSubtitles, clipLength, cutLongPauses, pauseThresholdMs, removeFillerWords, filteredWords: string[]
  },
  clips: [{                    // array position + 1 === clip_order
    id: string, filename, filePath /* storage key, not absolute path */, startTime, endTime, duration,
    text, relevanceScore, reasoning, viralityScore, hookScore, engagementScore, valueScore,
    shareabilityScore, hookType, hookTitle,
    sourceRanges?: {start,end}[], captionSettings?: {...},   // from engine output
    createdAt, updatedAt
  }],
  run?: { jobId, startedAt, completedAt, cacheHit, errorCode, stageTimings: object },
  editLock?: { jobId: string, until: Date } | null,
  rev: number,
  share?: { token: string, enabled: boolean },   // only if share links kept
  createdAt, updatedAt
}
```

- Indexes: `{userId:1, createdAt:-1}`; `{"share.token":1}` unique with `partialFilterExpression: {"share.token": {$exists: true}}`.
- Size: about 3 KB per clip and MAX_CLIPS defaults to 10 (`config.py:116`), with split, merge and combine adding a few more. That is nowhere near 16 MB.
- **Why embed:**
  - Reorder, split, merge, append and clear each become one atomic update.
  - The UNIQUE(task, order) index, the `generated_clips_ids` duplicate, the source join and every transaction all disappear.
  - The list query projects `clips.id` and `clips.viralityScore`, then computes count, max and cover in code.
- **Store storage keys** such as `clips/{taskId}/{file}`, not absolute paths. Today `file_path` and `video_path` hold absolute local or `s3://` values, which would break once storage moves off the worker machine (Vercel).

### 7.3 `clip_drafts`: separate collection

Drafts are large and autosaved often, and they must not bump `task.updatedAt`. The original code makes the same point at `editor.py:116-117`.

```ts
{ _id: clipId, taskId, userId, basis: string /* clip filename */,
  status: "preparing"|"ready"|"failed", error?: string,
  asset?: { width, height, fps, duration, hasAudio, waveform: number[] },
  revision: number, document: EditDocument, original: EditDocument, updatedAt }
```

- Index: `{taskId:1}`, used for cascade delete.
- Size: at most 5000 words × 2 documents, about 1.2 MB.
- A stale `basis` counts as unprepared; prepare overwrites it.
- Autosave:
  ```ts
  updateOne({_id: clipId, basis, status: "ready", revision},
            {$set: {document, updatedAt}, $inc: {revision: 1}})
  ```
  `matchedCount === 0` returns 409.
- Preview media goes to storage at `editor/{clipId}/{sha(basis)}/clean.mp4` and `thumbnails.jpg`.

### 7.4 `processing_cache`, `app_settings`

- `processing_cache`: `{_id: cacheKey, sourceUrl, sourceType, videoPath?, transcriptText?, analysisJson?, createdAt, updatedAt}`.
  - Upsert with `$set` built only from non-null fields, plus `$setOnInsert: {createdAt}`. That reproduces the COALESCE behaviour.
  - Add a TTL on `updatedAt` only if wanted; the original never expires entries.
- `app_settings`: `{_id: settingKey, encryptedValue, preferAdminValue, updatedBy, createdAt, updatedAt}`. The `_id` index is enough.

### 7.5 `jobs`: the queue

One collection covers process_task, prepare_editor, export_editor, combine_editor, export_clip, and the clip_edit operations (trim, split, merge, captions, regenerate, apply-settings).

```ts
{ _id: string, type: string, taskId: string, clipId?: string, userId: string, payload: object,
  status: "queued"|"running"|"succeeded"|"failed"|"cancelled",
  activeKey?: string,          // "task:{id}" for process_task; unset when finished
  liveKey?: string,            // "{clipId}:{optionsHash}" for export_clip; unset on failure
  runAt: Date, attempts: number, maxAttempts: number,
  lockedBy?: string, lockedUntil?: Date, cancelRequested?: boolean,
  progress: number, message?: string, error?: string, result?: object /* e.g. {filePath, clipId} */,
  expiresAt?: Date,            // finished exports, 7 days
  createdAt, updatedAt, startedAt?, finishedAt? }
```

Indexes:
- `{status:1, runAt:1}` for the claim
- `{status:1, lockedUntil:1}` for the reaper
- `{activeKey:1} unique, partialFilterExpression {activeKey:{$exists:true}}`
- `{liveKey:1} unique, partial exists`
- `{clipId:1, type:1, createdAt:-1}`: editor job list, limit 20
- `{taskId:1}`
- `{status:1, expiresAt:1}` for the sweep

Do not put a TTL index on `expiresAt`: it would delete docs and orphan their files.

```ts
const LEASE_MS = 60_000;
// 1) reaper, each poll
await jobs.updateMany(
  { status: "running", lockedUntil: { $lt: now }, $expr: { $lt: ["$attempts", "$maxAttempts"] } },
  { $set: { status: "queued", runAt: now }, $unset: { lockedBy: "" } });
// remaining expired running jobs -> failJob(): status "failed", $unset activeKey/liveKey,
// and CAS the task: updateOne({_id: taskId, status: {$in: ["queued","processing"]}}, {$set: {status: "error", ...}})

// 2) claim (driver v6 returns the doc directly)
const job = await jobs.findOneAndUpdate(
  { status: "queued", runAt: { $lte: now } },
  { $set: { status: "running", lockedBy: workerId, lockedUntil: new Date(+now + LEASE_MS), startedAt: now, updatedAt: now },
    $inc: { attempts: 1 } },
  { sort: { runAt: 1 }, returnDocument: "after" });

// 3) heartbeat every ~LEASE_MS/3 (also carries progress); kill the Python child on null/cancel
const live = await jobs.findOneAndUpdate(
  { _id: job._id, lockedBy: workerId, status: "running" },
  { $set: { lockedUntil: new Date(Date.now() + LEASE_MS), progress, message, updatedAt: new Date() } },
  { returnDocument: "after", projection: { cancelRequested: 1 } });
if (!live || live.cancelRequested) throw new Cancelled();

// 4) finish: only the lease holder can write
await jobs.updateOne({ _id: job._id, lockedBy: workerId },
  { $set: { status, result, error, finishedAt: new Date() }, $unset: { activeKey: "", lockedUntil: "" } });
```

- Enqueue process_task with `insertOne({... activeKey: "task:"+taskId})`. An E11000 duplicate-key error means the task is already queued or running.
- Retries: today a re-run after an error is skipped (`task_run_guard.py:40-41`), so `maxAttempts: 2` with lease-based reclaim after a crash matches the current behaviour. `process_task` already accepts expected statuses queued or processing (`task_service.py:400-404`).
- Exports keep `maxAttempts: 1`, matching `workers/tasks.py:222-226`.
- Clip export idempotency: insert with `liveKey`. On E11000, read the existing job by `liveKey`. Failure unsets `liveKey`, which mirrors the partial unique index excluding failed rows. A cron deletes the file, then the doc, after `expiresAt`. Failed exports are purged after 7 days.
- Editor exports: `countDocuments({clipId, type: {$in: [export_editor, combine_editor]}, status: {$in: [queued, running]}}) >= 3` returns 429. Mark it `// ponytail: soft limit, races can admit a 4th; add a counter doc if it matters`.
- Cancel: CAS the task status (as today), set `cancelRequested: true` on running jobs, and set queued jobs straight to `cancelled`. Workers already treat a failed `expected: processing` write as cancellation (`task_service.py:413-418`), so the Redis key is no longer needed.
- Progress and SSE: keep progress on the task doc. The SSE route polls the task every 1-2 s, or the client polls `GET /api/tasks/:id`. `clip_ready` becomes "the clips array grew". Change streams only work on a replica set (Atlas), and Vercel caps how long a function can stream.
- Stale detection: the reaper replaces the 180 s and 14400 s heuristics.

### 7.6 Task writes without transactions

- **Worker clears clips at render start** (today `task_service.py:510-513`):
  ```ts
  updateOne({_id, status: "processing", "run.jobId": jobId}, {$set: {clips: []}})
  ```
  Delete the old files afterwards.
- **Worker appends a clip** (today `:564-589`):
  ```ts
  updateOne({_id, status: "processing", "run.jobId": jobId}, {$push: {clips: clip}, $set: {updatedAt}})
  ```
  `matchedCount 0` raises TaskCancelled, then delete the just-rendered file.
- **Edit jobs take a lease:**
  ```ts
  findOneAndUpdate({_id, status: {$nin: ["queued","processing"]}, $or: [{editLock: null}, {"editLock.until": {$lt: now}}]},
                   {$set: {editLock: {jobId, until}}})
  ```
  If that returns null while the task exists and is not processing, requeue the job with `runAt = now + 2s`. This mirrors the arq `Retry(defer=2)` at `workers/tasks.py:108-111`. Renew `until` with the job heartbeat.
- **Edit commit:**
  ```ts
  updateOne({_id, "editLock.jobId": jobId}, {$set: {clips: newClips, updatedAt}, $unset: {editLock: ""}, $inc: {rev: 1}})
  ```
  Split and merge become in-memory array splices; the order is the array index. Delete replaced files only after this write succeeds.
- **Resume:**
  ```ts
  findOneAndUpdate({_id, userId, status: {$in: ["cancelled","error"]}, $or: [{editLock: null}, {"editLock.until": {$lt: now}}]},
                   {$set: {status: "queued", progress: 0, progressMessage: "Re-queued by user"}})
  ```
  Then insert a job with `activeKey`. If the insert fails with anything other than E11000, revert the status (as `tasks.py:1393-1399` does).

### 7.7 Deletion and cleanup, replacing the `media_deletions` outbox

- **Task delete:** delete the task doc (which removes its clips), `clip_drafts {taskId}`, jobs `{taskId}` (cancel running ones first), then the storage files:
  - clip files
  - editor directories
  - export files
  - an `upload://` source (`task_service.py:839-848`)
- **Account delete:** in `beforeDelete`, run the task delete for every `tasks {userId}`.
- File deletes are best-effort, after the Mongo write. Add an orphan sweep: any file older than the 24 h grace (`config.py:132`) that no `tasks.clips.filePath`, `clip_drafts`, live `jobs.result.filePath` or `tasks.source.url` references gets deleted. Mark it `// ponytail: no outbox; a crash between DB write and unlink leaves an orphan for the sweep`.

---

## 8. Open questions

These need your call (you asked to be told about issues):

1. **MongoDB for local development.** Option one: an Atlas free cluster, which is a replica set and so supports transactions and change streams, with identical behaviour on Vercel later. Option two: a standalone `mongod` on Windows, which requires `transaction: false` in the Better Auth adapter, or running it as a single-node replica set. I recommend Atlas.
2. **Password reset email.** It depends on the dropped SES backend. Options: log the reset link to the server console, or use a provider such as Resend or SMTP. Email verification is not used outside the dropped API-keys page and can be removed.
3. **The Claude key.** Today it is global, set only by an admin, and stored encrypted in `app_settings`. Should it stay global (then we need a way to make the first admin, e.g. an `ADMIN_EMAILS` env var checked in a Better Auth `databaseHooks.user.create.before` hook, since no code does this today), be per user, or come from env vars only (then no admin role is needed)?
4. **Existing Postgres data.** Does it need migrating? User ids would change from UUIDs to ObjectIds, and Better Auth password hashes live in `account.password`. If this is a fresh start, no migration code is needed.
5. **Share links.** Keep them? It costs two fields, one index and two routes (`task_repository.py:417-484`, `tasks.py:620-667`, `717-749`).
6. **Before Vercel.** The worker (Python and ffmpeg) cannot run on Vercel, and local-disk files are invisible to Vercel functions. So the storage interface, storage-key `filePath` values, and uploads that go straight to Blob (Vercel caps request bodies at 4.5 MB) must exist before that deploy. All in-request ffmpeg edits (§4) must also move to jobs.