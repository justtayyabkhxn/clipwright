# Clipwright port map: configuration, runtime and local-run concerns

Read-only survey. I modified no files. To check claims on this Windows machine I ran `python -B` imports (writes no bytecode) and binary lookups only. Every path below is relative to `C:\other-projects\supoclip`.

---

## 0. Findings that change the plan

1. **The Python code cannot be imported on Windows.**
   - `import fcntl` sits at module top in `backend/src/editor_document.py:12`, `backend/src/media/source_limits.py:15`, `backend/src/media_storage.py:13` and `backend/src/youtube_source.py:11`.
   - Tested with `backend/.venv` (Py 3.11): `src.video_utils`, `src.clip_editor`, `src.editor_document`, `src.media.reframing` and `src.media_storage` all fail with `ModuleNotFoundError: No module named 'fcntl'`.
   - `src.media.captions`, `src.youtube_utils` and `src.ai` import fine.
   - The engine CLI needs a lock helper that works on both platforms (`msvcrt.locking`, the `portalocker`/`filelock` libraries, or no locking at all with a single worker). Call sites:
     - editor_document.py: 133, 137
     - source_limits.py: 484, 488
     - media_storage.py: 69, 74, 92, 242, 247, 285, 301, 316, 570, 601, 616, 638, 689
     - youtube_source.py: 424, 427
2. **CLAUDE.md is out of date about the media stack.**
   - There is no MoviePy and no MediaPipe anywhere in `backend/src`. Rendering is ffmpeg run as a subprocess (`src/media/ffmpeg.py`, `reframing.py`, `clip_editor.py`, `editor_document.py`).
   - Face detection uses OpenCV YuNet (`FaceDetectorYN`) with a bundled ONNX model, falling back to the Haar cascade (`src/media/face_detection.py:1-17,112-127`).
   - OpenCV DNN is optional: it looks for `opencv_face_detector.pbtxt`/`_uint8.pb` under `cv2.data` and is normally absent (`src/media/reframing.py:192-208`).
3. **Inter-clip transitions are effectively turned off.**
   - `create_clips_with_transitions` logs "Inter-clip transitions are disabled for standalone SupoClip exports" (`video_utils.py:713-734`).
   - `VideoService.apply_single_transition` is a no-op (`services/video_service.py:603-616`).
   - `GET /transitions` only lists files, and no frontend code calls it (grep for `transitions` found nothing).
4. **The frontend `middleware.ts` is at `frontend/middleware.ts`, not `frontend/src/`.** The app uses `src/app`, and Next.js expects middleware inside `src/` in that layout, so this file is probably not active. It only implements the dropped landing-only mode; delete it.
5. **Two Python packages both install a top-level `whisper` module.** `openai-whisper` and `whisper==1.1.10` (Graphite's time-series library, `pyproject.toml:20`) are both in `backend/.venv/Lib/site-packages` (`whisper/` and `whisper.py`). Drop both, along with `torch`.
6. **Email-based password reset depends on dropped SES.** `frontend/src/lib/auth.ts:13-28,60-83` calls backend `/account/password-reset-email` and `/account/verification-email`. Verification is off (`sendOnSignUp: false`), but forgot/reset password has no transport once emails go.

---

## 1. Environment variables needed for the KEEP scope

Backend values are read in `backend/src/config.py` unless noted.

### AI / Claude

| Var | Default | Meaning | Where |
|---|---|---|---|
| `ANTHROPIC_API_KEY` | none | Claude key. A runtime setting: an admin-entered value can override it (see section 4). | config.py:19, runtime_settings.py:21 |
| `LLM` | inferred: google key → `google-gla:gemini-3-flash-preview`, openai → `openai:gpt-5.2`, anthropic → `anthropic:claude-opus-5`, openrouter → `openrouter:anthropic/claude-sonnet-5.5`, else gemini | `provider:model` string. `.env.example:140` sets `anthropic:claude-opus-5`. Also a runtime setting. | config.py:34, 412-425 |
| `RERANK_LLM` | = `LLM` | Model for the cross-window rerank on long videos | config.py:36 (used in ai.py) |
| `MAX_CLIPS` | 10 | Hard cap on clips per task | config.py:116 (ai.py, video_service) |
| `CLIP_DURATION` | 30 | Seconds; used when `clip_length=="auto"` | config.py:117, video_service.py:929 |

`llm_connection.py:11` uses `DEFAULT_CLAUDE_MODEL="claude-opus-5"` and a 15 s timeout for the connection test.

### Transcription (AssemblyAI)

| Var | Default | Meaning | Where |
|---|---|---|---|
| `ASSEMBLY_AI_API_KEY` | none | Required; also a runtime setting | config.py:37 |
| `ASSEMBLY_AI_HTTP_TIMEOUT_SECONDS` | 900 | Total polling budget after submit | config.py:38-40 |
| `ASSEMBLY_AI_REQUEST_TIMEOUT_SECONDS` | 60, clamped 5–300 | Per upload/submit HTTP request | config.py:41-43 |
| `TRANSCRIPTION_LANGUAGE` | "" (`auto` also means "") | Forces an AssemblyAI language code; also selects the audio track | config.py:31-33, 382-384 (ffmpeg.py, transcription.py) |
| `FAST_MODE_TRANSCRIPT_MODEL` | `universal-3-5-pro` | AssemblyAI `speech_models` value | config.py:253-255, transcription.py:165-175 |
| `TRANSCRIPTION_PROVIDER` | `assemblyai` | Keep fixed at assemblyai. `whisper` and `youtube_captions` are dropped. | config.py:26-28 |

### Processing

| Var | Default | Meaning | Where |
|---|---|---|---|
| `DEFAULT_PROCESSING_MODE` | `fast` | | config.py:251 |
| `FAST_MODE_MAX_CLIPS` | 10 (`backend/.env.example:34` says 4) | | config.py:252 |
| `HOOK_FIRST_TEASER` | false | Replays a later punchline as a cold open | config.py:259, timeline.py |
| `SPEAKER_FRAMING` | true | Diarization-driven speaker cuts | config.py:261, video_utils.py:389, reframing.py, editor_service.py |
| `MAX_VIDEO_DURATION` | 5400 s | Source length cap | config.py:99 |
| `MAX_VIDEO_UPLOAD_BYTES` | 4,000,000,000 | Upload cap | config.py:111-113 |
| `NEXT_PUBLIC_MAX_VIDEO_UPLOAD_BYTES` | 4e9 | Client-side pre-check | frontend/src/lib/video-upload.ts:4-11 |
| `QUEUED_TASK_TIMEOUT_SECONDS` | 180 | Fail-safe for tasks stuck in queued | config.py:144-146 |
| `PROCESSING_TASK_TIMEOUT_SECONDS` | 14400 | Fail-safe for dead "processing" tasks; must exceed the job timeout | config.py:150-152 |

### YouTube via yt-dlp

| Var | Default | Meaning |
|---|---|---|
| `YOUTUBE_DOWNLOAD_PROVIDER` | `yt_dlp` (also `apify`/`rapidapi`) | config.py:50-52. Keep fixed at `yt_dlp`. |
| `YOUTUBE_METADATA_PROVIDER` | `yt_dlp` (or `youtube_data_api`) | config.py:53-55 |
| `YOUTUBE_DATA_API_KEY` | none, falls back to `GOOGLE_API_KEY` | config.py:21, 400-401. Optional. |
| `YOUTUBE_PREFLIGHT_TIMEOUT_SECONDS` | 30, cap 180 | Wait for length metadata at task creation (config.py:59-63) |
| `YOUTUBE_DOWNLOAD_MAX_BYTES` | 2e9 | Per-job byte cap (config.py:70) |
| `YOUTUBE_SECTION_PADDING_SECONDS` | 10 | Padding around clip ranges for section downloads (config.py:71) |
| `YOUTUBE_MAX_HEIGHT` | 1080 | Hard cap (config.py:72) |
| `YOUTUBE_SOURCE_CACHE` / `_TTL_SECONDS` | true / 604800 | Reuse audio and sections for edits (config.py:73-76, youtube_source.py:574, 661, 988) |
| `YOUTUBE_PROXY_URL`, `YOUTUBE_PROXY_TIMEOUT_SECONDS` (300), `YOUTUBE_PROXY_COUNTRY`, `YOUTUBE_POT_PROVIDER_URL` | empty = off | Optional residential proxy and bgutil PO token (config.py:66-69, youtube_proxy.py:285-293) |

### Storage, temp, logging

| Var | Default | Meaning |
|---|---|---|
| `TEMP_DIR` | `temp`, relative to the working directory; Docker uses `/app/uploads` (compose:126) | Root of every media directory (section 3). config.py:119 |
| `MEDIA_STORAGE` | `local` (or `s3`) | config.py:120-122. Replaced by the storage interface. |
| `MEDIA_URL_TTL_SECONDS` | 900 (60–3600) | Signed URL lifetime (config.py:130) |
| `MEDIA_CACHE_TTL_SECONDS` | 86400 (min 14400) | config.py:131 |
| `MEDIA_ORPHAN_GRACE_SECONDS` | 86400 (min) | Orphan sweep grace (config.py:132, media_cleanup.py:114) |
| `MEDIA_UPLOAD_CONCURRENCY` / `MEDIA_UPLOAD_DAILY_LIMIT` | 3 / 20 | Per-user upload sessions (config.py:133-134, upload_repository.py) |
| `LOG_LEVEL` | INFO | observability.py:164 |

### Auth and frontend

| Var | Default | Where |
|---|---|---|
| `BETTER_AUTH_SECRET` | compose default `supoclip_dev_secret_change_in_production` | compose:51, .env.example:176 (read by better-auth itself) |
| `BETTER_AUTH_URL` | `http://localhost:3107` | lib/auth.ts:32 |
| `NEXT_PUBLIC_APP_URL` | `http://localhost:3107`; site.ts falls back to `https://www.supoclip.com` | lib/auth.ts:31, lib/site.ts:18-24 |
| `BETTER_AUTH_TRUSTED_ORIGINS` | "" (comma-separated) | lib/auth.ts:33, lib/auth-origins.ts:19-35 (also hardcodes localhost:3107, sp./supoclip.localhost:3107, 3001 variants) |
| `DISABLE_SIGN_UP` | false | lib/auth.ts:9-11 |
| `APP_SETTINGS_ENCRYPTION_KEY` | falls back to `BACKEND_AUTH_SECRET`, then `BETTER_AUTH_SECRET`; at least 16 chars | runtime_settings.py:55-66 |
| `NEXT_BUILD_DIR` | `.next` | next.config.ts:22 |
| Port | 3107 | package.json:7,9 (`--port 3107`) |

### Obsolete after the port (infrastructure is replaced)

- Postgres and Redis: `DATABASE_URL` (database.py:17-19, default `postgresql+asyncpg://localhost:5432/supoclip`; Prisma `schema.prisma:13-16`), `POSTGRES_DB/USER/PASSWORD`, `REDIS_HOST/PORT/PASSWORD` (config.py:139-141).
- Python API auth and routing: `BACKEND_AUTH_SECRET`, `ALLOW_UNSIGNED_BACKEND_AUTH`, `AUTH_SIGNATURE_TTL_SECONDS` (config.py:156-162; HMAC headers in lib/backend-auth.ts), `CORS_ORIGINS` (config.py:166-172), `BACKEND_INTERNAL_URL` and `NEXT_PUBLIC_API_URL` (12 proxy sites, e.g. server/backend-api.ts:18-25).
- Docker and process plumbing: `SUPOCLIP_SERVICE` (observability.py:17), `BACKEND_CPU_ONLY`, `BACKEND_PLATFORM`, `FRONTEND_PORT`, `FRONTEND_BUILD_TARGET`, `COMPOSE_*`, `DOCKER_BUILDKIT`, `PYTHONPATH`, `PYTHONUNBUFFERED`.
- Removed modes: `SELF_HOST` / `NEXT_PUBLIC_SELF_HOST` (monetization switch, config.py:154-155, lib/monetization.ts:7), `NEXT_PUBLIC_LANDING_ONLY_MODE`, and `OUTPUT_DIR` (config.py:114, never read).

## 2. Environment variables used only by dropped features

- **Other LLM providers** (Claude-only target): `OPENAI_API_KEY`, `GOOGLE_API_KEY`, `OPENROUTER_API_KEY`, `OPENROUTER_FALLBACK_MODEL` (default `openai/gpt-6-luna`), `OLLAMA_BASE_URL`, `OLLAMA_API_KEY`.
- **Whisper**: `WHISPER_MODEL`, `WHISPER_MODEL_SIZE`.
- **Paid YouTube fallbacks and Twitch/Kick sources** (not in KEEP): `APIFY_API_TOKEN`, `APIFY_YOUTUBE_*` (DOWNLOADER_ACTOR, PROVIDERS, FALLBACK_ACTOR(S), INPUT_ADAPTER, DEFAULT_QUALITY), `APIFY_RUN_TIMEOUT_SECONDS`, `APIFY_LONG_VIDEO_SECONDS`, `APIFY_DOWNLOAD_MAX_CHARGE_USD`, `APIFY_FALLBACK_MAX_CHARGE_USD`, `APIFY_EXPENSIVE_FALLBACKS`, `APIFY_STORAGE_*` (7), `APIFY_STREAM_PROVIDERS`, `APIFY_STREAM_TIMEOUT_SECONDS`, `APIFY_TWITCH_ACTOR`, `APIFY_KICK_*`, `TWITCH_DOWNLOAD_PROVIDERS`, `KICK_DOWNLOAD_PROVIDERS`, `RAPIDAPI_YOUTUBE_API_KEY`, `RAPIDAPI_YOUTUBE_TIMEOUT_SECONDS`, `RAPIDAPI_YOUTUBE_HOST`, `RAPIDAPI_YOUTUBE_RELAY_HOST`.
- **Billing**: `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_ID`, `STRIPE_PRO_PRICE_ID`, `STRIPE_SCALE_PRICE_ID`, `STRIPE_PRO_ANNUAL_PRICE_ID`, `STRIPE_SCALE_ANNUAL_PRICE_ID`, `STRIPE_PRO_LEGACY_PRICE_IDS`, `STRIPE_SCALE_LEGACY_PRICE_IDS`, `STRIPE_CREATOR_COUPON_ID`, `STRIPE_CHECKOUT_URL`, `STRIPE_CUSTOMER_PORTAL_URL`, `NEXT_PUBLIC_{PRO,SCALE}_PRICE_{MONTHLY,ANNUAL}`, `NEXT_PUBLIC_{PRO,SCALE}_PLAN_MINUTE_LIMIT`, `NEXT_PUBLIC_{PRO,SCALE}_YOUTUBE_MAX_MINUTES`, `PRO_/SCALE_PLAN_MINUTE_LIMIT`, `PRO_/SCALE_YOUTUBE_MAX_VIDEO_DURATION`, `REVENUECAT_WEBHOOK_AUTH_HEADER`, `REVENUECAT_PRO_PRODUCT_IDS`, `REVENUECAT_SCALE_PRODUCT_IDS`.
- **Social publishing**: `YOUTUBE_OAUTH_CLIENT_ID/SECRET` (plus `GOOGLE_OAUTH_*`), `TIKTOK_CLIENT_KEY/SECRET`, `INSTAGRAM_APP_ID/SECRET` (plus `META_APP_*`), `SOCIAL_OAUTH_REDIRECT_BASE_URL`, `SOCIAL_PUBLIC_MEDIA_BASE_URL`, `SOCIAL_METRICS_REFRESH_HOURS`, `SOCIAL_METRICS_MAX_POST_AGE_DAYS`, `SOCIAL_PERFORMANCE_MIN_POSTS`, `SOCIAL_PUBLISH_MAX_ATTEMPTS`, `SOCIAL_PUBLISHING_ACCESS`, `SOCIAL_PUBLISHING_PROVIDERS`, `SOCIAL_PUBLISHING_ALLOWED_EMAILS`, `NEXT_PUBLIC_SOCIAL_PUBLISHING`.
- **Email / SES**: `AWS_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `SES_FROM_EMAIL`.
- **Feedback**: `DISCORD_FEEDBACK_WEBHOOK_URL`, `DISCORD_SALES_WEBHOOK_URL`.
- **Observability**: `POSTHOG_PROJECT_TOKEN`, `POSTHOG_HOST`, `NEXT_PUBLIC_POSTHOG_KEY/HOST`, `POSTHOG_PERSONAL_API_KEY`, `POSTHOG_PROJECT_ID`, `POSTHOG_RELEASE_VERSION`, `AXIOM_TOKEN`, `AXIOM_DATASET`, `NEXT_PUBLIC_DATAFAST_WEBSITE_ID/DOMAIN/ALLOW_LOCALHOST`.
- **B-roll**: `PEXELS_API_KEY`.
- **MCP**: `SUPOCLIP_API_URL`, `SUPOCLIP_DOWNLOAD_DIR`, `SUPOCLIP_TIMEOUT`, `SUPOCLIP_MCP_TRANSPORT/HOST/PORT/PUBLIC_URL/REQUIRE_BEARER_AUTH` (compose:257-265).

## 3. Fonts, transitions and storage directories

### Fonts

- **Discovery** (`backend/src/font_registry.py`):
  - `FONTS_DIR = Path(__file__).parent.parent / "fonts"`, which resolves to `backend/fonts` regardless of the working directory (line 9).
  - Supported formats: `.ttf` and `.otf` (line 8).
  - `get_available_fonts` (111-117) globs `FONTS_DIR` (scope `system`) plus the user's directory (scope `user`) and returns `{name, display_name, filename, format, file_path, scope, supported_languages}`, sorted by display name.
  - `supported_languages` comes from running `fc-query --format=%{lang}\n` (lines 20-52, LRU-cached by mtime and size). If `fc-query` is missing, the value is `None`.
- **User uploads**:
  - Stored at `backend/fonts/users/<sanitized user id>/usr-<user>-<stem>.<ext>` (font_registry.py:10, 55-61, 194-205).
  - Max 10 MB (media.py:43).
  - Gated to paid plans when monetization is on (media.py:191-256).
  - These files must move into the storage interface for Vercel.
- **Name resolution**: `find_font_path` (120-157) tries the exact file, then stem plus extension, then a normalized-name match, then optionally every user's directory (`allow_all_user_fonts`, used by the renderer, captions.py:180-186).
- **Family name for libass `\fn`**: read by `get_font_family_name`, which parses the TTF name table and avoids `(){}\` (font_registry.py:172-252).
- **Glyph coverage**: `get_font_codepoints` parses the cmap. `GLYPH_FALLBACK_FONT="TikTokSans-Bold"` and `CAPS_ONLY_FONTS={"THEBOLDFONT"}` (captions.py:189-200).
- **Serving**:
  - `GET /fonts` (media.py:138-157, run in a thread because of fc-query), `GET /fonts/{name}` as a FileResponse with `font/ttf|otf` (160-188), `POST /fonts/upload` (191-256), `DELETE /fonts/{name}` (259-283; bundled fonts return 403).
  - Next proxies: `frontend/src/app/api/fonts/route.ts`, `[fontName]/route.ts`, `upload/route.ts`. Each tries `/fonts` and then `/api/fonts`.
  - The browser loads fonts with `@font-face url('/api/fonts/<name>')` in `components/home-app.tsx:169-180`, `app/settings/page.tsx:103-113`, `app/tasks/[id]/page.tsx:342,523` and `lib/editor/render.ts:29`.
- **ffmpeg** gets `fontsdir=` set to the font's directory (ffmpeg.py:373-375, clip_editor.py:297-299). `editor_document.py:362` falls back to `Path('fonts')`, which depends on the working directory.
- **Bundled fonts** (23, in `backend/fonts/`): Anton-Regular, ArchivoBlack-Regular, Bangers-Regular, BarlowCondensed-Bold, BebasNeue-Regular, DMSans, Inter, LeagueSpartan, Montserrat-Variable-wght, NunitoSans, OpenSans, Oswald-Variable-wght, Poppins-ExtraBold, Raleway-Variable-wght, Roboto, Rubik, Sora, THEBOLDFONT, TikTokSans-Bold, TikTokSans-Regular, Urbanist, WorkSans. `README.md` and `SOURCES.md` hold licensing notes.
- **Defaults**: caption templates reference THEBOLDFONT (4), TikTokSans-Regular (2) and TikTokSans-Bold (1) (`caption_templates.py`). The DB default font is `TikTokSans-Regular`, size 24, `#FFFFFF` (init.sql:20-22, 71-73; schema.prisma:73, 206). The emoji font is the system font `"Noto Color Emoji"` (media/common.py:67) and is not bundled.

### Transitions

`video_utils.py:609-621` globs `backend/transitions/*.mp4` (`Path(__file__).parent.parent / "transitions"`). The directory holds `circle_transition.mp4` and `flat_transition_1.mp4`. Only `GET /transitions` lists them (media.py:286-314), and they are never applied (finding 0.3).

### Directories under `TEMP_DIR`

| Path | Purpose | Code |
|---|---|---|
| `uploads/<uuid><ext>` | Uploaded sources, referenced as `upload://<file>` | media.py:387-418, video_service.py:78, 180-189 |
| `clips/` | Rendered clips plus trim/split/merge/caption outputs. The DB stores the **absolute path** in `generated_clips.file_path`; served by `GET /tasks/{id}/clips/{clip}/file` (tasks.py:908-950). | task_service.py:341, 505; clip_service.py:306, 350, 426, 558; editor_service.py:667 |
| `editor/<key>/` | Editor drafts, render jobs, `.lock` | editor_document.py:113-137 |
| `exports/` | Preset exports | tasks.py:1224 |
| `clip-exports/<export_id>/` | Export jobs | clip_export_service.py:53, 205-223 |
| `youtube-cache/`, `youtube-work/` | Cached audio and sections, work directories | youtube_source.py:40-41, 378, 640, 880 |
| `<video_id>.*` (root) | yt-dlp full downloads | youtube_utils.py:48-61, 215-218 |
| `<media>.transcript_cache.json` | Word-level transcript cache beside the source file | transcription.py:449-512, youtube_source.py:397 |
| `media-cache/` | Local cache of S3 objects (S3 mode only) | media_storage.py:228-307, 667 |
| `broll_cache/`, `<id>.en.vtt` | Dropped features | broll.py:66, transcription.py:271 |

- System temp directories (OS temp) use the prefixes `supoclip_render_` (video_utils.py:347), `supoclip_motion_` (reframing.py:617), `supoclip_emojiprobe_` (captions.py:86) and `supoclip_concat_` (clip_editor.py:206).
- Logs go to `./logs/backend.log` and `./logs/backend-error.log`, relative to the working directory (observability.py:160-191).
- In Docker, the `clips:/app/clips` volume is mounted but nothing references it; clips live in `TEMP_DIR/clips`.
- Cleanup crons: `cleanup_media` runs every 5 minutes and at startup, and `sweep_orphaned_media` runs at 00/06/12/18:15 (workers/tasks.py:245-247, media_cleanup.py).

## 4. Runtime settings (admin-stored Claude key)

- Keys: `ASSEMBLY_AI_API_KEY`, `LLM`, `OPENAI_API_KEY`, `OPENROUTER_API_KEY`, `GOOGLE_API_KEY`, `ANTHROPIC_API_KEY`, `OLLAMA_BASE_URL`, `OLLAMA_API_KEY`, `YOUTUBE_DATA_API_KEY`, `APIFY_API_TOKEN`, `PEXELS_API_KEY` (runtime_settings.py:15-27). For KEEP, only `ANTHROPIC_API_KEY`, `LLM` and `ASSEMBLY_AI_API_KEY` matter.
- **Encryption**: AES-256-GCM with key = SHA-256(secret). Stored format is `v1:<b64url nonce>:<b64url tag>:<b64url ciphertext>` (runtime_settings.py:69-91). A TS port must match this exactly only if existing rows are migrated.
- **Table**: `app_settings(setting_key PK, encrypted_value, prefer_admin_value bool, updated_by, created_at, updated_at)` (init.sql:181-188; Prisma `AppSetting` schema.prisma:162-174).
- **Precedence**: the env value wins unless an admin value exists with `prefer_admin_value`; with no env value, the admin value is used (config.py:294-300).
- **Loading**: at API startup (main.py:67-68), per worker job (workers/tasks.py:53-65, 135-138) and after each PATCH. Provider keys are pushed into `os.environ` for pydantic-ai (runtime_settings.py:138-148, ai.py:581, 660, 734).
- **Endpoints** (admin only via `users.is_admin`, admin_auth.py:20-34):
  - `GET/PATCH /admin/runtime-settings` returns a masked hint (`sk-ant-…abcd`), a source (`admin|environment|unset`) and `overridden_by_env` (admin.py:25-257).
  - `POST /admin/ai/test-connection` runs an Anthropic Models API check that spends no tokens, with statuses `ok|missing_key|invalid_key|permission_denied|model_not_found|rate_limited|connection_failed|api_error` (llm_connection.py:30-72).
  - Public `GET /ai/provider` returns `{provider, model, configured}` (media.py:354-365).

## 5. Worker and queue semantics to reproduce in the MongoDB queue

From ARQ `WorkerSettings` (workers/tasks.py:206-252) and job_queue.py:

- **Queue names**: `supoclip_tasks` (job_queue.py:14, tasks.py:231). `supoclip_fast` exists but has no worker (job_queue.py:15; clip_export_service.py:329-331 says so).
- **Limits**: `job_timeout=10800` s, `max_tries=3`, `max_jobs=4` concurrent, `health_check_interval=30` (heartbeat key checked by `/health/worker`, main.py:249-265).
- **Job functions**: `process_video_task`, `prepare_editor`, `export_editor`, `combine_editor`, and `export_clip_preset` (timeout 30×60 s, `max_tries=1`; clip_export_service.py:47). `publish_social_post` is dropped.
- **Crons**: `cleanup_media` every 5 minutes (`run_at_startup`), `sweep_orphaned_media` four times a day at :15. The social crons are dropped.
- **Progress**: Redis pub/sub feeds SSE today (workers/progress.py, tasks.py via sse_starlette). Replace with Mongo-polled progress.

## 6. System dependencies from the Docker image, and their Windows equivalents

Two different things are checked below: what the Docker image installs, and what is installed on this machine.

| Docker (backend/Dockerfile) | Purpose | Status on this Windows machine |
|---|---|---|
| `python:3.11.17-slim-trixie` (line 2); `requires-python>=3.11`; `.python-version` 3.11 | Runtime | `backend/.venv` exists (Py 3.11, includes torch 2.11, openai-whisper, cv2, yt_dlp, yt_dlp_ejs, assemblyai) |
| apt `ffmpeg` (line 8) | All rendering; libass `subtitles=`/`ass=` filters with `fontsdir`; `libx264` (ffmpeg.py:315, 460, 517, 579, 609); ffprobe | Present: ffmpeg 8.0.1 essentials build (gyan.dev) at `C:\ffmpeg\bin`, built with `--enable-libass --enable-fontconfig --enable-libx264`; `ass`/`subtitles` filters and the libx264/aac encoders are listed. Windows drive-colon escaping is already handled (ffmpeg.py:285-300). |
| `fontconfig` plus `fc-cache -f` (lines 14-15) | `fc-query` for font language coverage (font_registry.py:29); libass fallback selection | `fc-query` and `fc-list` are **not on PATH**, so `supported_languages` will be `null`. The code tolerates this. |
| `fonts-noto-core`, `fonts-noto-cjk`, `fonts-noto-color-emoji` (lines 11-13) | Fallback glyphs (Hindi, CJK) and the colour emoji font `"Noto Color Emoji"` | Not verified. Install Noto Color Emoji and Noto Sans or CJK system-wide, or the emoji probe (captions.py:72-127) turns caption emojis off. |
| deno via `curl https://deno.land/install.sh` (lines 18-21, `DENO_DIR=/root/.deno`) | JS runtime yt-dlp needs for YouTube player challenges (`yt-dlp[default]` brings `yt-dlp-ejs 0.8.0`). Only the proxy path sets `js_runtimes={"deno":{}}` explicitly, if `shutil.which("deno")` finds it (youtube_proxy.py:290-293); the default path relies on yt-dlp picking deno up from PATH. | **deno is not on PATH.** Install it (e.g. `winget install DenoLand.Deno`), or configure yt-dlp to use Node, which is v22.17.0 here. I did not check whether this yt-dlp version accepts Node, so verify. |
| `unzip`, `curl` | deno install and healthcheck | not needed |
| `pip install uv` then `uv sync --frozen --extra cpu`/`cuda` (lines 24-39) | Dependencies, including the torch wheel | uv 0.13.5 is present |
| bgutil sidecar `brainicism/bgutil-ytdlp-pot-provider:2.0.2` on :4416 (compose:427-434, profile `youtube-proxy`) plus pip plugin `bgutil-ytdlp-pot-provider==2.0.2` (pyproject:19) | Optional PO tokens, used only when `YOUTUBE_POT_PROVIDER_URL` is set | Skip for local use (optional) |
| Models | YuNet ONNX is bundled at `backend/src/media/models/face_detection_yunet_2023mar.onnx` (232,589 B, SHA-256 `8f2383e4…52fa4`, MIT, `LICENSE-yunet`). Haar XMLs (`haarcascade_frontalface_default.xml`, `haarcascade_profileface.xml`) ship inside the opencv-python wheel's `cv2.data` (face_detection.py:124-127, speaker_framing.py:229). There are no MediaPipe or DNN downloads; whisper weights would download at runtime and are dropped. | Nothing extra to fetch |
| `mkdir /app/uploads /app/clips /app/logs` | Directories | `backend/temp/clips` and `backend/logs` already exist from earlier local runs |
| Frontend: `node:22.23.4-bookworm-slim`, pnpm 10.27.0, openssl for Prisma (frontend/Dockerfile) | | Node v22.17.0 present. pnpm is not on PATH, but corepack 0.33.0 is (package.json:5 sets `packageManager pnpm@10.27.0`). |

Other Windows hazards in the engine:
- Paths that depend on the working directory: `Path("logs")` (observability.py:161), `TEMP_DIR` default `temp`, and the `Path('fonts')` fallback (editor_document.py:362).
- JSON written without `encoding=` is safe because of `ensure_ascii` (transcription.py:458, 498, 512; editor_document.py:123, 150).
- Backend root holds stray files: `a-init.mp4`, `v-init.mp4`, `temp_tiktok_font_urls.css`.

## 7. Python dependencies: media engine vs. API (pyproject.toml:7-36)

What the engine modules import (video_utils, media/*, clip_editor, editor_document, youtube_utils, youtube_source, youtube_proxy, caption_templates, clip_cleanup, clip_source_map, emoji_captions, font_registry, clip_duration):

- **Engine needs**:
  - `numpy`
  - `opencv-python`; `opencv-python-headless` would suffice, since the code uses no `imshow`/GUI and needs `FaceDetectorYN`, `dnn` and `cv2.data`
  - `yt-dlp[default]` (with `yt-dlp-ejs`)
  - `pydantic` (editor_document models, line 20)
  - `python-dotenv` (config)
  - `requests` (youtube_utils, Data API)
  - `httpx` and `assemblyai`, only if transcription stays in Python: `media/common.py:31-35` and `transcription.py:8-10` import them at module top
  - optionally `bgutil-ytdlp-pot-provider`
- **The engine currently pulls in server-only libraries through imports, and needs refactoring before it can be slim**:
  - `config.py:5` imports `runtime_settings`, whose top imports are `sqlalchemy` and `cryptography` (runtime_settings.py:9-11).
  - `media/source_limits.py` imports `media_storage`, whose top imports are `boto3`/`botocore` plus `fcntl` (media_storage.py:13, 25-28).
  - `media/common.py:33` imports `srt`, which nothing uses.
  - `media/common.py:37-43` tries `whisper` (already optional).
- **API-only, or droppable entirely**: `fastapi`, `uvicorn`, `sse-starlette`, `aiofiles`, `asyncpg`, `sqlalchemy`, `greenlet`, `alembic` (never imported), `arq`, `redis`, `boto3` (S3 and SES), `cryptography`, `posthog`, `anthropic` (llm_connection test only), `pydantic-ai` (ai.py only; the full extra pulls many providers, uv.lock:3307-3311), `apify-client`, `openai-whisper`, `torch` (cpu/cuda extras), `whisper` (wrong package), `setuptools-rust`, `srt-equalizer` (never imported), `srt` (dead import).
- **Dev**: httpx, pytest, pytest-asyncio, pytest-cov. The pytest addopts gate coverage on auth_headers and billing (pyproject:91-97).

## 8. next-intl wiring to collapse to English

- `frontend/next.config.ts:2,5,44` wraps the config in `createNextIntlPlugin("./src/i18n/request.ts")`. Routing has no `[locale]` segment and no intl middleware; the locale is chosen per request.
- `src/i18n/request.ts:7-18`: cookie `NEXT_LOCALE`, else Accept-Language negotiation, then `loadMessages(locale)`.
- `src/i18n/config.ts`: `locales=["en","es","pt","de","zh","id"]` (1), `defaultLocale` (5), `LOCALE_COOKIE` (7), `NAMESPACES` (22 entries, 10-33), `isLocale`, `intlLocale` (zh → zh-Hans, pt → pt-BR), `catalogKey` (marketing only), `negotiateLocale`.
- `src/i18n/load-messages.ts:5-14` dynamically imports `messages/<locale>/<ns>.json` for every namespace.
- `src/i18n/actions.ts` holds the `setUserLocale` server action. Its only consumer is `components/language-switcher.tsx`, used at `app/settings/page.tsx:29,317`.
- `app/layout.tsx:2-3,95-99,122-131` uses `getLocale`/`getMessages`, `<html lang={intlLocale(locale)}>` and `NextIntlClientProvider`.
- `intlLocale` callers in KEEP scope: `app/tasks/[id]/page.tsx:62,702` and `app/admin/page.tsx:17,68` (if admin is kept). `lib/generations.ts:48` duplicates the mapping. All other callers are dropped pages.
- Scale: 84 files import next-intl, 83 use `useTranslations`/`getTranslations`/`useLocale`. `src/test/setup.ts:7-30` wraps test renders with the `messages/en` catalog.
- **Catalogs**: `messages/{de,es,id,pt,zh}/` can be deleted. `messages/en/` has 22 files, 164,884 bytes.
  - Keep: `common`, `metadata`, `shell`, `auth`, `settings`, `home`, `library`, `task`, `editor`. KEEP pages also call `social` (2×, settings) and `language` (1×), and both go with their features.
  - Drop: `language`, `billing`, `social`, `analytics`, `marketing`, `seo`, `blog`, `changelog`, `affiliate`, `status`, `share`, `legal`, plus `admin` unless the AI-key UI uses it.
- **Simplest path**: keep next-intl, make `request.ts` return `{locale:"en", messages}` without cookies or headers, prune `NAMESPACES`, and delete `actions.ts`, `language-switcher.tsx`, `negotiateLocale` and the other locales.

## 9. Frontend runtime pieces to remove or simplify

- **`next.config.ts`**: keep `output:'standalone'` (23). Remove the DataFast rewrites (`/js/script.js`, `/api/events`), the PostHog `/ingest` rewrites, `skipTrailingSlashRedirect` (12-19, 25, 29-41) and `withPostHogConfig` with `releaseName "supoclip-web"` (46-62).
- **Observability**: `src/instrumentation-client.ts` (posthog-js plus `installTraceFetch`), `src/instrumentation.ts` (posthog-node `onRequestError`), `src/server/posthog.ts`, `lib/posthog-config.ts`, `lib/datafast.ts`; and in `layout.tsx`, DataFast scripts (39-42, 101-119), `DataFastIdentity`, `PostHogIdentity`, `AttributionTracker` and `FeedbackButton` (7-12, 125-128).
- **`src/server/*.ts`**:
  - `backend-api.ts` is the Python proxy plus trace headers; it goes away.
  - `session.ts` is `getServerSession` over Better Auth; keep it.
  - `prisma.ts` becomes the Mongo client.
  - `account-deletion.ts` (Stripe check, affiliate promo code, social revoke, `source.deleteMany`) shrinks to source cleanup.
  - `affiliates.ts`, `announcements.ts`, `billing-plans.ts`, `stripe.ts`, `stripe-subscription-sync.ts`, `user-acquisition.ts` and `posthog.ts` are dropped.
- **`lib/auth.ts`**: switch `prismaAdapter(prisma,{provider:"postgresql"})` (38-40) to the MongoDB adapter. Keep `additionalFields.is_admin` (48-53), `deleteUser.beforeDelete`, `emailAndPassword` and `nextCookies()`. Resolve the email hooks (finding 0.6).
- **`package.json` dependencies to drop**: `@posthog/nextjs-config`, `posthog-js`, `posthog-node`, `stripe`, `@prisma/client`, `prisma`; dev `@electric-sql/pglite`. Also drop the `postinstall`/`build`/`typecheck` `prisma generate` steps (8, 16-17).
- **`package.json` dependencies to keep**: `mediabunny` (editor `export-panel.tsx`, `lib/editor/export-draft.ts`), `motion` (auth `clip-cut-animation`), `tw-shimmer` (globals.css), `next-themes`/`sonner`, Radix.

## 10. SupoClip brand references a Clipwright rebrand must change

There are 268 files in total. Lists below are file:line.

### KEEP-scope code (must edit)

- **`frontend/src/lib/site.ts:1-24`**: `SITE_NAME="SupoClip"`, `DEFAULT_SITE_URL="https://www.supoclip.com"`, `GITHUB_URL` (FujiwaraChoki/supoclip), `APP_STORE_ID="6784760040"`, `APP_STORE_URL`, `PRODUCT_HUNT_URL`/`BADGE_URL`, `appStoreRedeemUrl`. Drop everything except the name and URL.
- **`frontend/src/app/layout.tsx`**: 32 (comment), 54-57 (`applicationName`/`authors`/`creator`/`publisher`), 68 (`siteName`), 14 and 62-64 (`itunes.appId`).
- **`frontend/src/components/app/app-shell.tsx`**: 102 and 160 (aria "SupoClip + Claude"), 103 and 161 (`/logo.png`), 190 (`"supoclip.sidebar.collapsed"`), 192-197 (`BrandWordmark` "SupoClip + Claude").
- `frontend/src/components/auth/auth-frame.tsx:13` (logo plus "SupoClip"); `components/auth/clip-cut-animation.tsx:8` (comment).
- **Editor storage keys and filenames**: `components/editor/editor-workspace.tsx:379` (`supoclip-draft-${id}.json`), `components/editor/inspector.tsx:303,321` (`supoclip-caption-style`), `components/editor/use-editor.ts:46` (`supoclip-editor:`), `lib/editor/export-draft.ts:172` (`supoclip-${preset}.mp4`), `lib/copy-text.ts:16` (`supoclip-manual-copy`).
- **Auth plumbing**: `lib/backend-auth.ts:15,23-25` (`x-supoclip-*` headers, removed with the API) and `lib/auth-origins.ts:25-26` (`sp.localhost`, `supoclip.localhost`).
- **Error and icon files**: `app/global-error.tsx:20`, `app/not-found.tsx:8`, `app/globals.css:54` (comment, "SupoClip + Claude"), `app/icon.svg:1` (aria-label), `app/icon.png` (1024², 1.4 MB, an image), `app/opengraph-image.tsx:5`, `app/twitter-image.tsx:5`, `lib/social-image.tsx:170-176` ("Supo"/"Clip" wordmark).
- **`frontend/public/logo.png`** (1000², an image). It is also used by `app/share/[token]`, `app/status` and the marketing pages, which are dropped.
- **`frontend/messages/en`**: `metadata.json:2-3` (title and `%s | SupoClip`). These strings belong to dropped sections: `shell.json:49`, `settings.json:4,73,88,124,171,174,177`, `home.json:113`, `share.json:2,11,12`.
- `frontend/package.json:2` (`"name": "frontend"`, rename to clipwright).
- **Backend engine and worker**:
  - Temp prefixes: `clip_editor.py:206`, `media/captions.py:86`, `media/reframing.py:617`, `video_utils.py:347`.
  - Log text: `video_utils.py:734`.
  - Download filename: `api/routes/editor.py:289,299` (`supoclip-{clip}-{job}.mp4`).
  - User-facing text: `services/video_service.py:169`.
  - Queue names: `workers/job_queue.py:14-15`, `workers/tasks.py:231` (`supoclip_tasks`/`supoclip_fast`); comments in `services/clip_export_service.py:40,329-331`.
  - `repositories/edit_transaction.py:10` (`supoclip_edit_task`).
  - `auth_headers.py:17-19`, `observability.py:17` (`SUPOCLIP_SERVICE`), `main.py:2,63,76,82-83,208`, `worker_main.py:20`.
  - `database.py:18` (DB name), `config.py:177` (`SES_FROM_EMAIL` default).
  - `source_submission.py:21,35,41` (`supoclip-ios` UA).
  - `backend/pyproject.toml:2,4` (`supoclip-backend`) and the generated `src/supoclip_backend.egg-info/`.

### Domains, IDs and emails

- `www.supoclip.com`: site.ts:2, public/llms.txt (19×), DEPLOY_NOTES.md:55, 90.
- `api.supoclip.com` / `mcp.supoclip.com`: mcp/src/supoclip_mcp/config.py:16, server.py:7, mcp/README.md, compose:264.
- `support@supoclip.com`: app/terms/page.tsx:11, app/email/product-updates/unsubscribe/route.ts:16, backend/src/api/routes/email_preferences.py:38, 42, llms.txt:54.
- `privacy@supoclip.com`: app/privacy/page.tsx:11.
- GitHub `FujiwaraChoki/supoclip`: site.ts:4, app/page.tsx:53, app/blog/[slug]/page.tsx:331, components/articles/self-hosting-guide-article.tsx:80, components/landing-page.tsx:589, components/supo-live-article.tsx:12, llms.txt.
- App Store `6784760040`: site.ts:5-6, layout.tsx:63.
- RevenueCat `com.samihindi.supoclip.{pro,scale}.{monthly,annual}`: app/api/billing/revenuecat-webhook/route.ts:31-32, .env.example:292.
- Deep link `supoclip://social-callback`: app/api/social/callback/[provider]/route.ts:10.
- Vercel project `fujiwarachokis-projects/supoclip`: DEPLOY_NOTES.md:54.
- Axiom dataset `supoclip-prod`: compose:451, .env.example:218.
- Test domains `@supoclip.test`: e2e/global-setup.ts:11-12, e2e/local-workflow.spec.ts:176.

### Infra, config, tests and docs

- **`docker-compose.yml`**: container names `supoclip-*`, network `supoclip-network` (515), DB `supoclip/supoclip_password` (50, 125, 300, 486-488, 494), CORS default (208, 383), SES default (84, 214, 389).
- `.env.example:1,54,176,191,224,245,292`; `backend/.env.example:41-43,57`.
- `start.sh:3,15,63,100,111`; `Makefile:1-2`; `install_cron.sh`; `observability/vector.yaml:1,9-16`; `init.sql:1,259`.
- `frontend/playwright.config.ts:4,10,64`; `playwright.polish.config.ts:20`; e2e specs.
- Docs: `README.md`, `QUICKSTART.md`, `CONTRIBUTING.md`, `AGENTS.md`, `CLAUDE.md`, `CHANGELOG.md` (56×; copied into the frontend image for `/changelog`), `IMPLEMENTATION_PLAN.md` ("SupoClip + Claude"), `DEPLOY_NOTES.md`, `docs/*.md` (21 files), `backend/README.md`, `backend/REFACTORING_GUIDE.md`, `backend/fonts/README.md`.
- Assets: `assets/banner.jpg`.

### Deleted along with dropped features (no edits needed)

- `frontend/src/app/{[slug],affiliate,blog,changelog,demo,privacy,terms,status,share,page.tsx JSON-LD 33-95,sitemap.ts}`
- `components/{landing-page,landing/*,marketing/*,articles/*,supo-live-article,announcements,billing/upgrade-prompt}`
- `lib/{blog-posts,seo-pages,marketing-links,attribution,announcements,creator-code,demo}`
- `server/{affiliates,announcements}`
- `public/{llms.txt,app-store-badge.svg,blog/supoclip-*.webp,clips/*,videos/*}`
- Unused create-next-app SVGs: `public/{file,globe,next,vercel,window}.svg`
- Backend email services (`affiliate_`, `api_key_`, `password_reset_`, `subscription_`, `task_completion_`, `verification_email_service.py`) and `email_preferences.py`
- The whole `mcp/` directory

## 11. Questions to ask the user

1. **Vercel hosting.** Vercel functions can't run the long-lived Node worker, ffmpeg or Python, have no persistent disk, and limit request bodies to about 4.5 MB. The workable split is: the Next app on Vercel, the worker plus Python engine on an always-on machine (this PC or a VPS), MongoDB Atlas shared, and uploads and clips in Vercel Blob or R2 using direct browser uploads. Is that acceptable?
2. **Password reset.** With SES dropped, should forgot/reset password be removed, log the link to the console during local use, or use another email provider (Resend etc.)?
3. **AI providers.** Claude only, or keep the OpenAI, Gemini, OpenRouter and Ollama options in Settings?
4. **Sources.** Drop the Twitch/Kick sources and the paid Apify/RapidAPI YouTube fallbacks, keeping plain yt-dlp?
5. **Admin access.** Should only `is_admin` users be able to set the Claude and AssemblyAI keys, as today?
6. **Windows prerequisites** to confirm: install deno (or switch yt-dlp to Node), plus Noto Color Emoji and Noto fonts for caption emoji and multilingual fallback.