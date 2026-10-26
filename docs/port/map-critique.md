# Completeness critique of the SupoClip → Clipwright port maps

The maps are mostly accurate. The gaps below are what would be lost or break if the port were built from them as written. I checked every item against the code, and ran tests on this machine where noted. All test output went to the scratchpad; no project files were modified.

## 0. Tests I ran (none of the maps did these)

- **The Python engine imports on Windows if `fcntl` is stubbed.**
  - A 6-line `fcntl` shim on `sys.path` let all of these import: `src.video_utils`, `clip_editor`, `editor_document`, `media.reframing`, `youtube_source`, `youtube_utils`, `media.transcription`, `media.timeline`.
  - Importing `src.video_utils` takes **11.0 s**, almost all of it torch, pulled in by the whisper import at `media/common.py:37-43`. `sqlalchemy` also loads, through `config.py:5` → `runtime_settings`. `boto3` and `pydantic_ai` do not.
  - So a CLI that starts a new Python process per call pays about 11 s each time. Either make the whisper import lazy or keep one long-lived engine process.
- **A full render works on Windows.**
  - Call: `create_optimized_clip(src, 1, 9, out, add_subtitles=True, caption_template="hormozi", output_format="vertical", keep_ranges=[(1,4),(6,9)], hook_title=..., extend_to_sentence=False)`.
  - Input: a synthetic 1920×1080 source plus a hand-written v2 `src.transcript_cache.json`.
  - Result: 1080×1920 h264/aac, 5.9 s long, rendered in 12.2 s. The two-range crossfade, blurred-fit layout (no faces in the source), karaoke captions (green highlight, uppercase) and the THEBOLDFONT hook title all rendered correctly.
- **ffmpeg** is `C:\ffmpeg\bin`, version 8.0.1 essentials (gyan.dev). It has every filter the code uses: zscale, xfade, acrossfade, loudnorm, gblur, lutrgb, hue, tile, zoompan, ass, subtitles, astats, signalstats, tblend, unsharp, metadata, showinfo, anullsrc, tonemap. libx264 and aac are present.
- **libass picks up the bundled fonts through `fontsdir`.** The font family names differ from the file names, which is fine because the engine resolves them with `get_font_family_name`:
  - THEBOLDFONT → "THE BOLD FONT FREE VERSION"
  - TikTokSans-Regular → "TikTok Sans Light"
  - TikTokSans-Bold → "TikTok Sans"
  - Poppins-ExtraBold → "Poppins ExtraBold"
- **Emoji are disabled on Windows, safely.** Missing glyphs fall back to Segoe UI Emoji, which renders in monochrome. The colour probe (`media/captions.py:72-127`) therefore returns False and caption emojis are turned off. `fonts/README.md` and `SOURCES.md` produce harmless "Error opening memory font" log lines.
- **Python.** `python` on PATH is the Microsoft Store alias stub (`...\WindowsApps\python`). The real interpreter is `backend/.venv/Scripts/python.exe` (3.11.15). The worker must start that exact path and pass `PYTHONUTF8=1`.
- **yt-dlp without deno.** Installed yt-dlp is 2026.10.21. Its default is `js_runtimes={'deno':{}}` (`yt_dlp/YoutubeDL.py:739`), and deno is not installed. Node is supported with a minimum version of 22.0.0 (`yt_dlp/utils/_jsruntime.py:120`); this machine has v22.17.0. Two options:
  - Add `"js_runtimes": {"node": {}}` in `youtube_utils.py:61-67` (download options) and `:103-112` (info options); `youtube_proxy.py:290-293` hard-codes deno.
  - Or install deno.
- **No `.env` files exist** at the repo root, in `backend/` or in `frontend/`. `config.py:7` calls `load_dotenv()`, which searches upward from `backend/src`. The engine should take its config from the request JSON instead.

## 1. KEEP-scope features no map covers, or covers too vaguely

**1. The AssemblyAI key has no kept UI.**
- `ai-provider-settings.tsx` only handles `LLM` and `ANTHROPIC_API_KEY` (L36-40, L102-106).
- `ASSEMBLY_AI_API_KEY` can only be edited in `components/admin/runtime-settings-form.tsx`, which is rendered only by the dropped `app/admin/page.tsx`.
- `GET /ai/provider` reports `configured` from the LLM key alone (`media.py:354-365` → `ai.py:445`). With no AssemblyAI key the UI shows "Ready", and tasks fail at the 30% transcription step.
- Decision needed: env-only, or add the field to Settings.

**2. Exact runtime-settings and test-connection contracts** (the maps only summarised these).
- `PATCH` body is `{updates: {KEY: str}, delete_keys: [KEY], prefer_admin_values: {KEY: bool}}`.
  - Unknown keys → 400 "Unsupported setting key(s): …".
  - Blank update values are skipped.
  - An `LLM` value is validated by `_get_missing_llm_key_error`, except that a missing-key error is tolerated (`admin.py:156-187`).
- Each setting in the response is `{key, label, description, input_type, source: admin|environment|unset, configured, value_hint, has_admin_value, has_env_value, prefer_admin_value, overridden_by_env, updated_at}` (`admin.py:96-130`).
  - `value_hint` is masked for password fields and raw for text fields such as `LLM`.
  - The UI parses the model out of `value_hint.startsWith("anthropic:")` (`ai-provider-settings.tsx:39`).
- `mask_secret` (`llm_connection.py:14-23`):
  - 12 characters or fewer: `"…"` plus the last 2 characters (only if longer than 4), otherwise just `"…"`.
  - Longer: `sk-ant-` (or the first 3 characters) + `…` + the last 4 characters.
- Test-connection:
  - A non-anthropic provider → 400.
  - An empty `api_key` means "test the saved key".
  - Steps: `models.list(limit=100)`, then `models.retrieve(model)` if the model is not in the list; NotFound → `model_not_found`.
  - Client settings are `max_retries=0`, timeout 15 s (`llm_connection.py:30-72`).
  - The UI keeps only models whose ids start with `claude-` (`ai-provider-settings.tsx:72`).
- The frontend map is wrong about line numbers here: `use-ai-provider.ts` is 48 lines long, and its module cache is at L27-35, not L529-538.

**3. YouTube word timings are lost after 7 days in local mode.** No map flags this.
- `sweep_expired_cache` deletes the whole `youtube-cache/{id}` directory once the manifest is older than the TTL (`youtube_source.py:465-476`). That includes `full.transcript_cache.json`, which `adopt_full_download` copies there (`youtube_source.py:571-607`).
- `restore_youtube_metadata` does nothing unless S3 is enabled (`media_storage.py:330-333`).
- Consequences:
  - Editor prepare, restyle and caption edits after the TTL run with no words, so clips come out without captions.
  - A resume pays AssemblyAI again: re-transcription is forced when the sidecar has no words (`video_service.py:783-796`).
- Port: store the v2 transcript JSON durably, keyed by source (a storage key such as `transcripts/{videoId|uploadId}.json`), and write it next to the source before every engine call.

**4. Restyle (`POST /tasks/{id}/settings`) as a job needs a UI contract.** The maps say "make it a job" but not how the UI reacts.
- Today the page awaits the response, re-fetches, and then shows a "settings applied" toast (`app/tasks/[id]/page.tsx:486-512`). A 202 would fire that toast too early.
- The page skips fetching clips while `status === "queued"` (around L282). SSE and polling only run for queued or processing (`page.tsx:371`).
- So the job should set `status: "processing"` and keep the old clips until it commits. On failure it should return to `completed`, not `error`, matching the "existing clips are unchanged" message.
- Partial failure must be preserved: survivors replace all rows and failed clips are dropped (`clip_service.py:255-286`).
- The render cap is `max(preset.maximum, 60)` (`clip_service.py:236-241`, `media/common.py:73`).
- Clip ids change, so the restyle job must also delete the old clips' drafts.

**5. Progress message strings are a contract.** `ProcessingPanel` regexes the message text to pick the step (`clip-wall.tsx:558-617`). Keep these exact strings: "Downloading video...", "Preparing video...", "Generating transcript...", "Analyzing content with AI...", "Creating video clips...", "Creating clip {i}/{N}...", "Complete!".

**6. Editor prepare can stay stuck in "preparing" forever.** If the job is lost, `prepare` just returns `{status: "preparing"}` without re-enqueueing (`editor.py:86-88`). In the port, the draft's status must be tied to its job, and the lease reaper must set it to `failed`.

**7. "Worker unavailable" needs a heartbeat check.** Today 503s ("The rendering worker is unavailable", "The export worker is unavailable") come from enqueue failures. An insert into Mongo never fails, so a stopped Windows worker would leave jobs queued forever with no message. Enqueue routes should check a worker heartbeat document.

**8. Account deletion leaves user fonts behind.** Files under `backend/fonts/users/<id>/` (`font_registry.py:10,55-61`) are neither deleted today nor covered by the orphan sweep. Add them to the `beforeDelete` cleanup.

**9. User fonts on a separate worker machine.** The engine resolves fonts from the local `FONTS_DIR` plus the user directories (`captions.py:180-186`, `allow_all_user_fonts`). If fonts are uploaded through Vercel into Blob or R2, the worker must sync each user's fonts to local disk before rendering.

**10. Bundled fonts live outside the Next app.** `backend/fonts` is outside `frontend/`, so Vercel would not deploy it. Move it to a directory both the Next app and the engine use, and serve it from the `/api/fonts/[name]` route (the editor's `FontFace` and the home page `@font-face` depend on it).

**11. `lib/seo.ts` (`noIndexMetadata`) must stay.** It is imported by kept layouts: `list`, `tasks`, `settings`, `sign-in`, `sign-up`, `forgot-password`, `reset-password` (and `share`). The frontend map drops `seo-pages` but does not mention `seo`.

**12. Kept tests to port as specs** (no map lists them):
- Vitest:
  - `components/editor/use-editor.test.tsx`, `lib/editor/document.test.ts`, `hooks/use-task-progress.test.tsx`
  - `lib/clip-export.test.ts`, `lib/video-upload.test.ts`, `lib/library-groups.test.ts`, `lib/font-options.test.ts`, `lib/auth-redirect.test.ts`, `lib/copy-text.test.ts`, `lib/auth-client.test.tsx`
  - `components/{home-app,transcript-preview,font-select-option,video-source-icon,delete-account-section}.test.tsx`, `components/settings/ai-provider-settings.test.tsx`, `components/auth/{sign-in,sign-up,password-reset}.test.tsx`
  - `app/{list,settings}/page.test.tsx`
  - `app/api/{preferences,tasks,tasks/create,upload,upload/authorization,fonts/[fontName]}/route.test.ts`
- Playwright: `editor-studio`, `generation-status`, `library-groups`, `local-workflow`, `app`.
- Drop: `src/i18n/messages.test.ts` (checks that all locales match) and `src/middleware.test.ts`.

## 2. Contradictions between maps

1. **Where `fcntl` is imported.**
   - Editor map lists 2 modules, data map lists 3.
   - Pipeline and runtime maps list 4, which is correct: `editor_document.py:12`, `media/source_limits.py:15`, `media_storage.py:13`, `youtube_source.py:11` (confirmed by grep).
2. **Where transcription runs.**
   - Pipeline map: an engine `transcribe` command (Python SDK).
   - AI map: port it to TypeScript over REST, and rewrite `format_transcript_for_analysis` and the sidecar writer.
   - My recommendation is the pipeline version. The polling and retry code, the formatter and the v2 sidecar writer already exist and are tested (`tests/unit/test_assemblyai_polling.py`). The engine also needs ffmpeg for audio extraction and dialogue-track selection (`transcription.py:34-76`), and the key can come in the request JSON. Clip selection with Claude moves to TS either way.
3. **Caption-templates payload.**
   - The frontend map leaves out `highlight_color`.
   - Actual output of `get_template_info()`: `[{id, name, description, animation, font_family, font_size, font_color, highlight_color}]`. The 7 entries:

     | id | animation | font_family | font_size | font_color | highlight_color |
     |---|---|---|---|---|---|
     | default | karaoke | THEBOLDFONT | 32 | #FFFFFF | #FFE000 |
     | hormozi | karaoke | THEBOLDFONT | 32 | #FFFFFF | #00FF66 |
     | mrbeast | karaoke | THEBOLDFONT | 34 | #FFFF00 | #FF2D2D |
     | minimal | fade | TikTokSans-Regular | 26 | #FFFFFF | #FFFFFF |
     | tiktok | karaoke | TikTokSans-Bold | 28 | #FFFFFF | #FE2C55 |
     | neon | karaoke | THEBOLDFONT | 30 | #00FFFF | #FF00FF |
     | podcast | karaoke | TikTokSans-Regular | 28 | #FFFFFF | #FFB800 |

   - The full template dicts (21 keys each, plus `TEMPLATE_DEFAULTS`) dump cleanly with `.venv/Scripts/python -c "from src.caption_templates import CAPTION_TEMPLATES"`. Generate the shared JSON from that.
4. **One `jobs` collection vs three status vocabularies.** The data map's proposal uses `queued|running|succeeded|failed|cancelled`, but the clients expect different strings per endpoint:
   - Editor jobs: `queued|rendering|completed|failed|cancelled`, plus `"cancelling"` on DELETE (`lib/editor/document.ts:74`, `export-panel.tsx:386-427`).
   - Preset exports: `queued|running|succeeded|failed` (`lib/clip-export.ts:1,108`).
   - Tasks: `queued|processing|completed|error|cancelled`.

   Map the statuses per API in the route serializers.
5. **`output: 'standalone'`.**
   - Runtime map: keep it (`next.config.ts:23`).
   - Vercel does not need it, and with pnpm on Windows `next build` standalone can fail creating symlinks (EPERM) unless Developer Mode is on. That is a known Next issue I did not reproduce here. Remove it.
6. **Progress order.** `65 "Downloading selected segments..."` is emitted after `70` (`video_service.py:865` then `:937-939`), so the task-api map is right. It only happens on the proxy/stream path, which can be dropped.
7. **Preferences shape.** The frontend map keeps `notifyOnCompletion` in GET/PATCH `/api/preferences`; the data map drops the column. Drop the key from the route and the settings save (`settings/page.tsx:249`).

## 3. Contracts that were not precise enough

- **Error envelope parsed by every client** (`lib/api-error.ts:46-96`):
  - Message: `message`, else `error`, else a string `detail`, else `detail.message`.
  - `code`: `detail.code`.
  - Trace id: the `x-trace-id` header, else `trace_id` in the body.
  - Next routes can return `{detail: "..."}` or `{error: "..."}`.
  - `isUpgradeErrorCode` (L23-25) is billing-only; delete its callers.
- **Upload authorization union** (`lib/video-upload.ts:59-79, 136-176`). The client takes the S3 branch whenever `"storage" in auth`.
  - **The port must never return `{storage: "local"}`.** The current Next route filters it out (`api/upload/authorization/route.ts`: it only passes `storage === "s3"` through).
  - For local disk, return `{directUpload: false}`; the client then POSTs multipart field `video` to `/api/upload` and expects `{video_path}`.
  - For Blob/R2, reuse the S3 branch: `{storage: "s3", video_path, uploadId, partSize, parts: [{partNumber, url}]}` plus `/api/upload/{parts,complete,abort}`.
- **Fields the UI actually reads.**
  - Task (`app/tasks/[id]/page.tsx:98-118`): `id, user_id, source_title, source_type, source_url, status, progress, progress_message, clips_count, created_at, updated_at, font_family|null, font_size|null, font_color|null, caption_template, cut_long_pauses, pause_threshold_ms, remove_filler_words, filtered_words, share_enabled?`.
  - Clip (`page.tsx:75-96`; `clip-wall.tsx`; score breakdown keys at L108-111): `id, filename, video_url, clip_order, duration, start_time, end_time, text, relevance_score, virality_score, hook_score, engagement_score, value_score, shareability_score, hook_type, hook_title`.
  - Unused, so the port can omit them: `file_path`, `caption_settings`, the embedded `clips` on GET task, `error_code`, `cache_hit`, `stage_timings_json`, `processing_mode`, `completion_notification_sent_at`. Grep of `app`, `components`, `hooks` and `lib` finds no reads.
  - `video_url` may be `/tasks/...` or `/api/tasks/...`, because `getClipUrl` adds `/api` only when it is missing (`clip-actions.ts:9-12`).
  - `videoSourceKind` treats anything that is not youtube/twitch/kick as an upload (`video-source-icon.tsx:16-18`), so `source.type` can be renamed safely.
- **Null font fields mean "use the template's value".** `buildFontOptionsPayload` sends nulls (`lib/font-options.ts`). The renderer falls back to `font_family or template["font_family"]` (`video_utils.py:427`, `captions.py:379-381`). The task document must store null, not a default.
- **`download_url` on preset exports is ignored by the client.** It only parses it (`clip-export.ts:66`) and builds the file path itself (`clipExportFilePath`, L19-26). Return null.
- **Downloads.** The download link is an `<a download>` that may redirect to storage on another origin, where the `download` attribute is ignored. Signed storage URLs must set `Content-Disposition: attachment; filename=...`.
- **Removing SSE needs a hook change.** If the SSE route returns 404, `onerror` leaves `reconnecting` stuck true and the browser keeps reconnecting (`use-task-progress.ts:34-38`). Either keep a short SSE route, or delete the EventSource and rely on the existing 5-second poll (L62), shortened to 2 s. Polling already brings in incremental clips, because clips are fetched whenever status is not `queued`.
- **`/api/tasks/` (trailing slash) gets a 308 to `/api/tasks`** (`generations.ts:17`). The redirect is harmless. Keep the route at `api/tasks/route.ts`.

## 4. Risks for a local Windows run without Docker (beyond the maps)

- **The upload route will exhaust memory.** `api/upload/route.ts` buffers `await request.formData()` for files up to the 4 GB default (`video-upload.ts:4`). The local route should stream to disk (busboy, or a raw PUT body).
- **Python process cost.** Each engine process pays about 11 s of imports, and `python` on PATH is the Store stub (section 0).
- **YouTube downloads.** Without a JS runtime configured, yt-dlp has no deno to run, so extraction may be degraded (section 0).
- **Spawning from Node.** Use `windowsHide: true`, kill with `taskkill /T /F`, and keep the temp directory and storage root on the same volume so `fs.rename` does not fail with EXDEV.
- **Speed.** Rendering ran at about 2× the clip duration on this machine for a clip with no faces (6 s clip in 12.2 s). Keep worker concurrency at 1-2, not arq's `max_jobs=4`.
- **The engine can't import `VideoService` or the editor service.**
  - `services/video_service.py` imports at top level: `repositories.minute_usage_repository` (:14, DB), `ai` (:56, pydantic-ai), `broll` (:49), `media_storage` (:60), `stream_source` (:68), `utils.async_helpers` (:13).
  - `services/editor_service.py:20-22` imports `media_storage`, `stream_source` and `async_helpers`.
  - Move these bodies into an engine module: `create_single_clip` (`video_service.py:456-600`), `prepare_source`, `_ground_segment_text`, and from the editor service `make_assets`, `bake_editor_layout`, `initial_caption_style`, `generated_emphasis`, `caption_looks`, plus the combine graph.
- **Section downloads need the proxy.** Without `YOUTUBE_PROXY_URL`, `materialize_clip_source` raises `PartialDownloadUnavailable` (`youtube_source.py:913-915`), so every editor or restyle run after the cache expires re-downloads the full video (`video_service.py:224-254`). If the proxy path is dropped, sources are always full files, `local_ranges_for` is the identity, and all TimeMap code can go.
- **Settings encryption key.** If the Claude key stays encrypted in Mongo, the worker needs the same secret in its environment as the Next app (`APP_SETTINGS_ENCRYPTION_KEY`, falling back to `BETTER_AUTH_SECRET`, at least 16 characters; `runtime_settings.py:55-66`).

## 5. Kept code tangled with dropped features (not in the maps)

- `components/delete-account-section.tsx:8-9` imports DataFast `track` and PostHog `resetAnalytics`. The frontend map cites only L241-242.
- `home-app.tsx:313` passes the billing-derived `uploadLimitBytes`; use `maxVideoUploadBytes()` instead.
- `ai-provider-settings.tsx` depends on the admin routes and `session.user.is_admin` (`settings/page.tsx:313`). Nothing assigns admin.
- `config.py:5` → `runtime_settings` → sqlalchemy and cryptography. Confirmed: sqlalchemy loads when the engine imports.
- `media/reframing.py:49` imports `broll_overlay`. Keep it as a pure module, or stub it.
- `lib/generations.ts` `timeAgo` has a 6-locale `JUST_NOW` map. Reduce it to English.
- **Legacy trim, split, merge, captions and regenerate endpoints** (`tasks.py:955-1109`) have no caller in `frontend/src`; only MCP calls the legacy export. The editor already covers trim (segments), split, captions (words) and combine. Recommendation: don't port them; the editor satisfies "clip editing".
- **`processing_mode`** is always `"fast"` in the UI. Its only effects are `FAST_MODE_MAX_CLIPS` and the cache key, because "best" and fast map to the same AssemblyAI model list (`transcription.py:165-174`). It can be fixed as a constant.

## Questions for the user (merged from all maps)

1. **Hosting split.** Is this acceptable: the Next app on Vercel; the worker plus Python and ffmpeg on an always-on machine (this PC or a VPS); MongoDB Atlas; media in Vercel Blob or Cloudflare R2? The storage needs CORS for the editor's canvas and presigned multipart uploads.
2. **Uploads.** Must uploads work on Vercel in v1? That means direct-to-storage uploads, because Vercel caps function request bodies at about 4.5 MB.
3. **API keys.** Where do the Claude and AssemblyAI keys live: env only, set by an admin in Settings (and how is the first admin made, e.g. an `ADMIN_EMAILS` env var), or per user?
4. **Password reset.** Remove forgot/reset, log the link to the console, or use a provider such as Resend or SMTP?
5. **Optional features.** Keep share links? Drop Twitch/Kick, the YouTube proxy path, and the legacy clip-edit endpoints?
6. **Local database.** Local MongoDB, or Atlas (which gives transactions and change streams)?
7. **yt-dlp JS runtime.** Install deno, or switch yt-dlp to Node?
8. **Existing data.** Do existing Postgres users or tasks need migrating, or is this a fresh start?

Scratchpad test files (synthetic only) are in `C:\Users\wefor\AppData\Local\Temp\claude\C--other-projects-supoclip\4ac2f41d-0bf2-456a-819d-126608c4e66c\scratchpad\`: `shim\fcntl.py`, `src.mp4`, `out_clip.mp4`, `strip.png`, `t.ass`.