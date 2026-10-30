# Python media pipeline map and render-engine CLI boundary

All paths are relative to `C:\other-projects\original-app\backend\src\`. Line numbers were checked against the current files.

**Headline findings**
- **The engine will not import on Windows as-is.** `import fcntl` sits at module top in `media/source_limits.py:15`, `youtube_source.py:11`, `media_storage.py:13` and `editor_document.py:12`. `video_utils` imports `media.source_limits`, so the whole render stack fails at import.
- **Transitions are never applied.** `apply_transition_effect` (`video_utils.py:624`) has no callers, and `VideoService.apply_single_transition` (`services/video_service.py:603-617`) is a no-op. `transitions/*.mp4` are only listed by `GET /transitions`. The only cross-fades are inside a clip, between kept ranges (`media/ffmpeg.py:379-466`).
- **Face detection is YuNet, not MediaPipe.** It loads `media/models/face_detection_yunet_2023mar.onnx` and falls back to OpenCV DNN (only if those model files exist), then Haar.

---

## (a) End-to-end flow, source to rendered clip files

### A1. Main job: `workers/tasks.py:20 process_video_task` → `TaskService.process_task`
`TaskService.process_task` is at `services/task_service.py:313-705`.

1. **Cache lookup (orchestration).**
   - `_build_cache_key` (`task_service.py:62-73`) is `sha256(f"{source_type}|{processing_mode}|{TRANSCRIPT_ANALYSIS_CACHE_VERSION}|{url}" [+ "|q{quality}" for reduced-quality YouTube])`.
   - There is a per-clip-length analysis key (`:76-85`).
   - Cached `transcript_text` and `analysis_json` are read from `processing_cache` (`:372-383`). A personalised `performance_context` bypasses the cached analysis (`:387-389`).
2. **`VideoService.process_video_complete`** (`services/video_service.py:633-1009`). Progress is reported through the callback as (pct, message, status):
   1. `10` "Downloading video...":
      - **YouTube:** `async_get_youtube_video_info` (`youtube_utils.py:373`) does the pre-download duration guard (`video_service.py:677-687`). Then:
        - If a proxy is configured and nothing is cached: audio-first path, `download_analysis_source` (`youtube_source.py:672`).
        - Otherwise (**the default locally**): `cached_full_media(video_id)` (`youtube_source.py:985`), else `VideoService.download_video` (`:202-274`). That calls `resolve_full_youtube_download` (`youtube_source.py:999`), which calls `download_youtube_video` (`youtube_utils.py:652`). The provider order is `_provider_order` (`:620-637`): proxy, then RapidAPI/Apify, then plain yt-dlp (`_download_youtube_video_with_ytdlp`, `:515-617`).
        - yt-dlp writes to `{TEMP_DIR}/{video_id}.%(ext)s` (`:61`), using format `bv*[height<=H]+ba/b[height<=H]` (`youtube_proxy.py:130-132`) and merging to mp4. The download is then moved into the cache by `adopt_full_download` (`youtube_source.py:571-607`) as `youtube-cache/{id}/full.<ext>`.
      - **Upload:** `resolve_local_video_path("upload://x")` returns `{TEMP_DIR}/uploads/x` (`video_service.py:181-189`).
      - **Twitch/Kick:** goes through `stream_source` (out of scope).
   2. Post-download duration guard: `_get_file_duration` (ffprobe, `:131-145`) checked against `MAX_VIDEO_DURATION`, default 5400 s (`:762-768`).
   3. `15` "Preparing video...": `prepare_source` → `normalize_source_media` (`media/source_limits.py:470-488`). This re-encodes **in place** to fit 1920×1080 at ≤60 fps. It squares anamorphic SAR, tone-maps HDR with zscale and falls back to plain if that fails, and holds an fcntl lock.
   4. `30` "Generating transcript...":
      - Re-transcribes if there is no cached transcript, or the sidecar has no words (`:786-796`).
      - `get_video_transcript` (`media/transcription.py:319`) → `_get_transcript_with_assemblyai` (`:346-413`) → `_prepare_audio_for_transcription`. This writes `{stem}.transcription.mp3` (mono, 16 kHz, 64k, on the selected dialogue track, `:34-76`) → `_submit_and_wait_for_assemblyai_transcript` (upload retried 3×, bounded polling, `:79-162`).
      - AssemblyAI settings: `speaker_labels=True`, `speech_models=["universal-3-5-pro","universal-2"]`, language detection unless `TRANSCRIPTION_LANGUAGE` is set.
      - `format_transcript_for_analysis` (`:620-674`) produces the analysis text `"[MM:SS - MM:SS] Speaker A: text"`. Long utterances are split into 24-word / 20 s chunks.
      - `cache_transcript_data` (`:449-501`) writes the sidecar `<video>.transcript_cache.json`.
      - Whisper and YouTube-captions providers also exist (`:177-246`, `:248-316`).
   5. `persist_cache_sidecar` / `save_source_metadata` (S3 only).
   6. `50` "Analyzing content with AI...":
      - Unless a cached analysis exists, `build_clip_signal_summary` (`media/timeline.py:737-800`) runs. It is a regex/heuristic scorer over the transcript lines plus `detect_audio_peak_times` (ffmpeg `astats` over the **whole file**, `:687-734`).
      - Then `ai.get_most_relevant_parts_by_transcript(transcript, clip_signals, performance_context, clip_length)`. This is pure text in, JSON out (Pydantic AI), so it ports to TypeScript/Claude.
   7. Segment normalisation (`:867-914`):
      - virality is flattened to `virality_score`, `hook_score`, etc.
      - `_ground_segment_text` (`:106-128`) replaces `text` with the exact sidecar words in [start, end].
      - Capped at `MAX_CLIPS` (10), or `min(MAX_CLIPS, FAST_MODE_MAX_CLIPS)` in fast mode (`:916-919`).
      - With no segments, it uses a fallback segment `00:00`→ideal length (`:921-932`, `_build_fallback_segment :148-178`).
   8. Audio-first only (proxy or streams): `65` "Downloading selected segments...". `materialize_clip_source` (`youtube_source.py:887-982`) fetches padded ranges (default ±10 s) and assembles `youtube-work/{id}-{session}/render.mp4` plus a `.timeline.json` TimeMap. The transcript is shifted onto that timeline, then `prepare_source` runs again.
   9. Returns `{segments, segments_to_render, video_path, transcript, summary, key_topics, analysis_json}` (`:981-998`). **No clips are rendered here.**
3. **Back in `process_task`:**
   - Upserts `processing_cache` (`:480-500`) and deletes the old clip rows.
   - Per segment (`:522-601`):
     - checks cancel;
     - progress `70 + (i+1)/N*25` "Creating clip i/N...";
     - `localize_segment` if a TimeMap exists;
     - **`VideoService.create_single_clip`** (`video_service.py:456-600`);
     - `restore_clip_timeline`;
     - DB insert;
     - SSE `clip_ready`.
   - Then `100` "Complete!".
   - `finally: _cleanup_source_video` (`:157-205`). YouTube files under `youtube-cache` are kept. Uploads only lose `.transcription.mp3`.

### A2. Per-clip render chain: `create_single_clip` (`video_service.py:456-600`)
1. Bounds come from `keep_ranges`/`source_ranges` if provided; otherwise `parse_timestamp_to_seconds(start_time/end_time)` (`media/timeline.py:620-646`). The colon forms are integer-only.
2. Filename: `clip_{i+1}_{start_time without ':'}-{end_time without ':'}_{uuid12}.mp4` in `{TEMP_DIR}/clips/` (`:496-503`).
3. Keep-range construction (all in `media/timeline.py`; each step reloads the sidecar):
   - `snap_clip_start_to_sentence` (`:458-463`): sentence start within a 3 s window, plus a weak-opener rewind of ≤8 s (`:378-396`).
   - `build_clip_keep_ranges` (`:930-1048`): cleanup.
     - Filler phrases come from `default_filtered_words(language_code)` plus user `filtered_words` (`clip_cleanup.py:57-86`).
     - Pauses ≥ `pause_threshold_ms` (default 1200) are compressed, keeping 0.275 s at each edge, a 0.1 s lead-in and a 0.25 s tail.
   - `extend_keep_ranges_to_sentence_boundary` (`:46-121`): ≤5.5 s extension plus 0.35 s padding, or drops a dangling tail.
   - `apply_segment_hook_teaser` (`:604-617`): only when `HOOK_FIRST_TEASER=true`, which is **off by default**. It prepends a cold-open range, giving a non-monotonic range list.
   - `clamp_keep_ranges_to_max_duration(max_clip_seconds = clip_duration(clip_length).maximum)` (`:167-198`).
   - `keep_ranges_transcript_text` (`:466-472`) becomes the clip `text`.
   - If `keep_ranges` or `source_ranges` were provided (regeneration), the snap, teaser and text rewrite are skipped. `source_ranges` get cleanup re-applied; `keep_ranges` are used verbatim.
4. **`create_optimized_clip`** (`video_utils.py:257-460`):
   1. Fast stream-copy path (`:315-345`). It requires `extend_to_sentence=True`, but every pipeline caller passes `False` (`video_service.py:554`, `video_utils.py:561`, `clip_service.py:576`, `editor_service.py:434`), so it is **never hit** in practice.
   2. `tempfile.TemporaryDirectory("original-app_render_")` → `render_source_ranges_ffmpeg` (`media/ffmpeg.py:492-591`) writes `source.mp4`, an intermediate (x264 veryfast, CRF 16, AAC 192k) on the dialogue audio track (`select_audio_stream_index :91-139`):
      - **1 range:** `-ss` + `-t`.
      - **2-8 ranges, each ≥0.45 s and monotonic:** `xfade`/`acrossfade` cross-fades of ≤0.15 s (`crossfade_fade_for_ranges :379-396`, `render_ranges_crossfade_ffmpeg :399-466`).
      - **Otherwise:** trim/concat. It pre-seeks to the first range (`_input_window_for_ranges :469-489`).
   3. Output size: vertical modes are 1080×1920; `original` keeps the display size, fitted to 1080p (`:368-382`).
   4. Vertical only:
      - If `SPEAKER_FRAMING` (default true): `build_clip_speaker_turns` (`media/speaker_framing.py:136-149`) gives diarised turns and words on the output timeline.
      - `build_vertical_filter_plan` → `describe_vertical_layout` (`media/reframing.py:1230-1438`) → `(filter, mode "vf"|"complex", caption_y)`. Decision order:
        - narrow/portrait source: static crop plus Ken Burns (`kenburns_zoom_fragment :1148-1167`);
        - otherwise one pass of `analyze_vertical_clip` (`:778-877`): ffmpeg rawvideo bgr24 at 3 fps and 480 px wide, piped into YuNet/Haar boxes, scene-cut diffs and `ContextAnalyzer` (`media/scene_context.py`);
        - then `build_context_layout_plan`, giving face/fit shots;
        - reaction inset (`media/reaction_layout.py`; also reads 6 frames via `cv2.VideoCapture`);
        - all-fit: `build_full_frame_filter` (blurred background);
        - talking-head stack/stage/gallery (`media/talking_head_layout.py:277`);
        - speaker cuts or overlap stack (`speaker_framing.build_speaker_filter_plan :896-1028`, a second rawvideo decode);
        - tracked crop via a spring trajectory (`build_crop_trajectory :894-1007`, `build_smooth_pan_expression :1018-1036`, per-shot `build_scene_crop_expression :1119-1145`);
        - otherwise a static crop plus Ken Burns;
        - otherwise the scene-aware compositor (`:1182-1216`).
   5. `build_assemblyai_ass_subtitles` (`media/captions.py:337-633`) writes `captions.ass`:
      - word-synced karaoke, fade, pop, bounce or none;
      - emphasis and emoji (`emoji_captions.annotate_caption_words`), but only if `emoji_rendering_supported()` (`:72-126`), which probes ffmpeg and libass once per process;
      - glyph fallback to TikTokSans-Bold (`ensure_glyph_coverage :197-230`);
      - the hook title in the top safe area for about 4 s (`build_hook_title_ass :250-334`).
      - Font size is `get_scaled_font_size` = `base*width/560`, clamped to 26-132. The y position uses the template `position_y` or the layout `caption_y`.
      - `fonts_dir` is the folder of the resolved font file (`ass_fonts_dir :180-186`).
   6. `render_reframed_clip_ffmpeg` (`media/reframing.py:1441-1643`) is **one final encode** of reframing plus `subtitles=` burn:
      - video: libx264 preset medium, CRF 19, High@4.1, 30 fps CFR, `keyint=120` (`media/ffmpeg.py:303-323`);
      - audio: `loudnorm=I=-14:TP=-1.5:LRA=11`, AAC 192k at 48 kHz;
      - `+faststart`.
      - `vertical_pan`/`vertical_split` use `detect_speaker_reframe_plan` (`:576-675`: two-face motion via ffmpeg `metadata=...:file=`). `vertical_fit` uses the full-frame fit. `original` scales to 1080p, or does a byte copy when there are no subs and the source is within limits.
      - B-roll overlays are composited in this graph (being dropped).
   7. `shutil.move(final.mp4 → clip_path)`.
5. Optional `cap_video_short_side` (plan 720p, `media/ffmpeg.py:326-355`; drop it with billing). Then `save_clip_source_ranges` writes `<clip>.source_map.json` (`clip_source_map.py:57-77`), plus `save_clip_broll`.
6. Returns `clip_info`: `{clip_id, filename, path, start_time, end_time, duration, text, relevance_score, reasoning, virality_score, hook_score, engagement_score, value_score, shareability_score, hook_type, hook_title, keep_ranges}`.
   - **Inconsistency:** this path does **not** persist `caption_y`. The regeneration path (`video_utils.create_clips_from_segments :572-575`) does, through `save_clip_caption_settings`.

### A3. Other media flows that must keep working
| Flow | Orchestrator | Media calls |
|---|---|---|
| Regenerate all clips | `services/clip_service.py:100-286` | Gets the source again (cached YouTube full file or upload), `prepare_source`, then `VideoService.create_video_clips` (`video_service.py:381-453`) → `create_clips_with_transitions` → `create_clips_from_segments` (`video_utils.py:463-606`). Segments carry `keep_ranges` (unchanged cleanup) or `source_ranges` (changed cleanup). |
| Trim / split / merge | `clip_service.py:290-473` | `clip_editor.trim_clip_file :133-157`, `split_clip_file :160-195`, `merge_clip_files :198-231` (concat demuxer). All re-encode with x264 slow CRF 18 and AAC 256k. Range maths uses `clip_source_map.trim/split/slice_source_ranges :161-217`. |
| Caption edit | `clip_service.py:477-622` | `create_optimized_clip(add_subtitles=False, hook_title kept)` to a temp `clean.mp4` from the **source**, then `overlay_custom_captions` (`clip_editor.py:234-315`). Edited words are mapped onto timings (`_caption_words_with_timings :318-362`). Writes caption_settings to the sidecar. |
| Export preset | `services/clip_export_service.py:383-461` | `export_with_preset` (`clip_editor.py:457-517`). Presets tiktok/reels/shorts at 1080×1920, scale+pad, maxrate 10M/12M (`:36-40`). Progress comes from `-progress pipe:1` (`:384-454`). |
| Editor prepare | `services/editor_service.py:353-518` | Gets the source, then `create_optimized_clip(output_format="original", no subs)` → `editor/{sha}/clean.mp4`. `bake_editor_layout` (`:279-304`) composes split/stack/reaction/overlap layouts. `make_assets` (`:62-140`) does the ffprobe, a 160-bin waveform from f32le PCM, and a 12×1 thumbnail strip. It also builds the initial EditDocument (`initial_caption_style :146-181`, `generated_emphasis :184-199`). |
| Editor export | `editor_service.py:521-564` | `editor_document.render_document` (`:303-410`): trim/concat segments, scale/crop/pad framing, lutrgb/hue/gblur effects, `ass=` from `write_ass` (`:215-246`, reusing the generation ASS builder), volume. Uses x264 fast CRF 18, maxrate 10M/12M. `run_render` (`:249-300`) polls the `-progress` file and a `cancel-{job}` file. |
| Editor combine | `editor_service.py:567-756` | Builds a multi-input trim/scale/pad/concat ffmpeg graph (`:589-659`), then `render_document` with "tiktok", then `make_assets`. |

### A4. Dead or legacy code in this area
`VideoProcessor` (`video_utils.py:203-254`), `apply_transition_effect` (`:624-702`), `insert_broll_into_clip`/`apply_broll_to_clip` (`:769-958`), `create_9_16_clip`, `get_video_transcript_with_assemblyai`, the stream-copy fast path, `apply_single_transition`, and the `srt`/`ThreadPoolExecutor` imports in `media/common.py`.

---

## (b) Module inventory
"Engine" means it goes into the Python render engine. "TS" means port the orchestration to TypeScript. "Drop" means out of scope.

| Module | Purpose | Destination | External deps |
|---|---|---|---|
| `services/video_service.py` | Pipeline sequencing, download wrapper, per-clip render wrapper, upload path resolution | **TS** for `process_video_complete` (sequencing, progress, cancel, fallback segment, clip cap, `determine_source_type`). **Engine** for the sync bodies of `create_single_clip`, `prepare_source`, `_ground_segment_text`, `_get_file_duration` | yt-dlp, ffprobe. Imports `broll`, `stream_source`, `media_storage` (boto3) at top: strip these |
| `video_utils.py` | Facade re-exports, `create_optimized_clip`, `create_clips_from_segments` | **Engine** (delete the dead code) | ffmpeg |
| `media/common.py` | Constants and shared imports | **Engine** | cv2, numpy, assemblyai, httpx, srt (unused). `whisper` is imported at module load (`:37-43`, pulls in torch). `..config` pulls in `runtime_settings`, which needs sqlalchemy and cryptography |
| `media/ffmpeg.py` | ffprobe size/duration/audio track, filter escaping, range render, cross-fades, final encode args, short-side cap | **Engine** | ffmpeg/ffprobe on PATH |
| `media/transcription.py` | AssemblyAI (and Whisper) transcription, audio extraction, sidecar read/write, analysis formatting | **Engine** (or TS; the sidecar schema must stay identical either way) | AssemblyAI SDK; env `ASSEMBLY_AI_API_KEY`, `TRANSCRIPTION_LANGUAGE`, `ASSEMBLY_AI_HTTP_TIMEOUT_SECONDS`(900), `ASSEMBLY_AI_REQUEST_TIMEOUT_SECONDS`(60), `TRANSCRIPTION_PROVIDER`, `WHISPER_MODEL`, `FAST_MODE_TRANSCRIPT_MODEL` |
| `media/timeline.py` | Keep-range maths, sentence snapping, cleanup, hook teaser, clip signals, word projection | **Engine** (pure apart from ffmpeg `astats`) | ffmpeg; env `HOOK_FIRST_TEASER` |
| `media/captions.py` | ASS caption and hook-title generation, emoji probe, glyph fallback | **Engine** | ffmpeg with libass; `Noto Color Emoji` system font (not bundled); `backend/fonts` |
| `media/reframing.py` | Vertical layout planning, face track, scene cuts, crop expressions, final render | **Engine** | ffmpeg, cv2, numpy |
| `media/face_detection.py` | YuNet (`cv2.FaceDetectorYN`) and Haar | **Engine** | `media/models/face_detection_yunet_2023mar.onnx`; Haar XMLs from `cv2.data.haarcascades` |
| `media/scene_context.py` | Optical flow, text rows, histogram evidence for context-loss decisions | **Engine** | cv2, numpy |
| `media/talking_head_layout.py` | Stack, stage and gallery filter builders | **Engine** (pure) | none |
| `media/reaction_layout.py` | Reaction-webcam inset detection and layout | **Engine** | cv2 VideoCapture |
| `media/speaker_framing.py` | Diarised active-speaker cuts and overlap panels | **Engine** | ffmpeg rawvideo pipe, cv2 (profile Haar); env `SPEAKER_FRAMING` |
| `media/source_limits.py` | Normalise the source to ≤1080p and ≤60 fps in place; HDR tone map | **Engine** | ffmpeg (zscale optional); **fcntl** |
| `media/broll_overlay.py` | B-roll graph | **Drop** (`render_reframed_clip_ffmpeg` imports it: keep a stub or always pass `[]`) | none |
| `media/upload_limits.py` | Upload-size copy text | **TS** | none |
| `youtube_utils.py` | yt-dlp metadata and full download, provider chain, cleanup | **Engine** (yt-dlp path only; remove the Apify/RapidAPI imports at `:18,32`) | yt-dlp[default] (needs ffmpeg to merge; a JS runtime, deno by default). Optional YouTube Data API through `requests`. Env `YOUTUBE_DOWNLOAD_PROVIDER`, `YOUTUBE_METADATA_PROVIDER`, `YOUTUBE_DATA_API_KEY`/`GOOGLE_API_KEY`, `YOUTUBE_MAX_HEIGHT`(1080), `YOUTUBE_DOWNLOAD_MAX_BYTES` |
| `youtube_source.py` | YouTube cache dir and manifest, sections, TimeMap, local trim/concat | **Engine**: keep the full-file cache (`adopt_full_download`, `cached_full_media`, `resolve_full_youtube_download`). TimeMap and section code only matter if the proxy is kept | ffmpeg; **fcntl**; env `YOUTUBE_SOURCE_CACHE`(true), `YOUTUBE_SOURCE_CACHE_TTL_SECONDS`(604800), `YOUTUBE_SECTION_PADDING_SECONDS`(10) |
| `youtube_proxy.py` | Residential-proxy yt-dlp, HLS slicing, ByteBudget, error types | **Optional / drop** (keep `ByteBudget` and the exception classes, which other modules import) | deno (`:290`), bgutil PO-token plugin; env `YOUTUBE_PROXY_URL`, `_TIMEOUT_SECONDS`, `_COUNTRY`, `YOUTUBE_POT_PROVIDER_URL` |
| `stream_source.py` | Twitch/Kick | **Drop** | yt-dlp, Apify |
| `apify_youtube_downloader.py`, `rapidapi_youtube_downloader.py`, `budget_apify_downloader.py` | Paid download fallbacks | **Drop** | apify-client, requests, boto3 |
| `media_storage.py` | S3 refs, leased local cache, multipart upload, editor sync | **TS storage interface**. The engine only sees local paths | boto3; **fcntl** |
| `clip_editor.py` | Trim, split, merge, caption overlay, export presets | **Engine** | ffmpeg |
| `caption_templates.py` | 7 templates (default, hormozi, mrbeast, minimal, tiktok, neon, podcast) plus `TEMPLATE_DEFAULTS` | **Both**: TS needs it for the UI and validation, the engine for rendering. Share as one JSON file | none |
| `font_registry.py` | Font lookup (system plus `fonts/users/<id>`), TTF name and cmap parsing | **Engine** (TS can list `fonts/*.ttf` itself) | `fc-query` (Linux only, optional) |
| `emoji_captions.py` | Keyword emoji map, power words, rate-limited annotation | **Engine** (pure) | none |
| `clip_duration.py` | Presets auto 15-60, short 15-30, medium 30-60, long 60-120 | **Both** (TS validation; engine `max_clip_seconds`) | none |
| `clip_cleanup.py` | Cleanup normalisation and default filler lists | **Both** | none |
| `clip_source_map.py` | `.source_map.json` I/O and range slicing maths | **Engine** for the sidecar; the range maths (~60 lines) is also needed in TS if ranges move into Mongo | none |
| `editor_document.py` | EditDocument schema, render instructions, `run_render`, atomic JSON, lock | **Engine** for `render_document`, `write_ass`, `mapped_words`, `output_size`. **TS** for schema validation (port to zod), draft revisions and the lock (Mongo) | ffmpeg; pydantic; **fcntl** |
| `services/editor_service.py` | Editor prepare, export, combine jobs | **TS** for the jobs. **Engine** for `make_assets`, `bake_editor_layout`, `apply_editor_layout`, `editor_preserved_layout`, `initial_caption_style`, `generated_emphasis`, `caption_looks`, and the combine graph | numpy, ffmpeg; **`symlink_to` at `:663`** |
| `services/clip_service.py`, `services/task_service.py` | DB orchestration of edits and jobs | **TS** | none |
| `utils/async_helpers.py` | `run_in_thread`, plus shielded cancellation for media leases | **Drop** (the engine CLI is synchronous) | none |
| `ai.py` | Pydantic AI selection, rerank, hook titles | **TS** (Claude). Its inputs are the engine's `transcript_text` and `clip_signals` | none |
| `config.py` / `runtime_settings.py` | Env config. `runtime_settings` imports sqlalchemy and cryptography; `get_config()` rebuilds `Config()` on every call; `set_config_override` is at `config.py:434` | Replace with a slim engine config filled from the request JSON or env | python-dotenv |

The engine's import closure for rendering is `video_utils`, `media/*`, `clip_source_map`, `clip_cleanup`, `caption_templates`, `emoji_captions`, `font_registry`, `config`. Editing adds `clip_editor` and `editor_document`. Download adds `youtube_utils` and `youtube_source`.

---

## (c) Proposed render-engine CLI boundary

**Protocol**
- Invocation: `python -X utf8 -m clipwright_engine <command>`.
- **The request JSON goes on stdin**, which avoids Windows command-line length and quoting limits.
- stdout is NDJSON events:
  - `{"type":"progress","pct":0-100,"stage":"...","message":"..."}`
  - `{"type":"clip","index":i,"clip":{...}}`
  - final `{"type":"result","ok":true,"data":{...}}` or `{"type":"error","code":"too_long|download_failed|not_found|transcription_failed|render_failed|cancelled","message":"..."}`
- Logs go to stderr. Exit codes: 0 ok, 1 error, 2 cancelled.
- Common request fields: `temp_dir` (absolute), optional `cancel_file` (polled between clips and inside the render loops, replacing the Redis `task_cancel:{id}`), and `config` (`speaker_framing`, `hook_first_teaser`, `transcription_language`, `max_video_duration`, …), mapped onto `Config`.

| Command | Request (from the real signatures) | Result | Backed by |
|---|---|---|---|
| `probe` | `{path}` | `{duration, width, height (display, rotation-aware), fps, rotation, has_audio, audio_stream_index, hdr, within_1080p60}` | `ffprobe_duration`, `probe_video_geometry`, `ffprobe_has_audio`, `select_audio_stream_index`, `source_within_output_limits` |
| `youtube-info` | `{url}` | `{id,title,description,duration,uploader,upload_date,view_count,like_count,thumbnail,…}` | `get_youtube_video_info` (`youtube_utils.py:380`) |
| `fetch` | `{source:{kind:"youtube",url}\|{kind:"file",path}, max_duration_seconds, max_height?:≤1080}` | `{video_path, video_id?, duration, from_cache, normalized}` plus download progress events | duration guards, `cached_full_media` / `download_video` chain, `normalize_source_media` |
| `transcribe` | `{video_path, assemblyai_api_key, language?, speech_model?:"universal-3-5-pro"\|"universal-2", timeout_s?:900}` | `{transcript_text, sidecar_path, language_code, word_count}`. Writes `<video>.transcript_cache.json` | `_get_transcript_with_assemblyai`. The formatter needs the SDK object, so TS must keep `transcript_text`; the sidecar alone cannot rebuild it |
| `signals` | `{video_path, transcript_text}` | `{clip_signals}` | `build_clip_signal_summary` (only when the analysis is not cached) |
| `render-clips` | `{video_path, output_dir, segments:[Segment], options:{output_format:"vertical"\|"vertical_fit"\|"vertical_pan"\|"vertical_split"\|"original", add_subtitles, caption_template, font_family?, font_size?(12-72), font_color?, cleanup:Cleanup, max_clip_seconds}}` | One `clip` event per segment with ClipInfo (plus `caption_y`, `source_map_path`), then `{clips:[…], failed:[indexes]}` | Loop of `create_single_clip`, `save_clip_source_ranges`, `save_clip_caption_settings(caption_y)` (fixes the A2 inconsistency) |
| `edit` | `{op:"trim",input,output_dir,start_offset,end_offset,source_ranges}` / `{op:"split",input,output_dir,split_time,source_ranges}` / `{op:"merge",inputs:[{path,source_ranges}],output_dir}` | `{outputs:[{path, source_ranges, duration}]}` | `clip_editor` plus the `clip_source_map` range maths |
| `recaption` | `{source_video_path, local_ranges, output_dir, output_format, hook_title, style:{font_family,font_size,font_color,caption_template}, caption_text, position:"top"\|"middle"\|"bottom", position_y?, highlight_words[]}` | `{path}` | `create_optimized_clip(add_subtitles=False)` + `overlay_custom_captions` |
| `export-preset` | `{input, output, preset:"tiktok"\|"reels"\|"shorts"}` | progress events, then `{path}` | `export_with_preset(on_progress, should_stop)` |
| `editor-prepare` | `{source_video_path, local_ranges, work_dir, output_format, clip_text, hook_title, add_subtitles, caption_settings, task_style:{caption_template,font_family,font_size,font_color}}` | `{asset:{status:"ready",width,height,fps,duration,hasAudio,waveform[160]}, clean_path, thumbnails_path, initial_document:EditDocument}` | `editor_service.prepare_editor` media steps (`:421-494`) |
| `editor-render` | `{clean_path, document:EditDocument, preset:"tiktok"\|"reels"\|"shorts", output}` | progress events (from `-progress`), then `{path}` | `render_document`, `run_render` |
| `editor-combine` | `{inputs:[{clean_path, document, has_audio, width, height, source_ranges}], work_dir}` | `{clean_path, export_path, document, asset, source_ranges}` | `combine_editor` graph (`:589-659`), `render_document`, `make_assets` |

Font and template listings need no command: TS reads `fonts/*.ttf` and the shared template JSON.

### Data contracts

**Segment (input).** These are the fields the renderer reads:
- `start_time` and `end_time`: strings `"MM:SS"` / `"HH:MM:SS"`, or seconds. They are required because the filename uses them.
- `text`, `hook_title`, `hook_start_time?`, `hook_end_time?`.
- `keep_ranges?: [[s,e],…]` (used as-is) or `source_ranges?: [[s,e],…]` (cleanup re-applied). Both are in seconds on the local `video_path` timeline.
- Pass-through: `relevance_score`, `reasoning`, `virality_score`, `hook_score`, `engagement_score`, `value_score`, `shareability_score` (each 0-25; total 0-100), `hook_type`.

**Cleanup** (`clip_cleanup.py:120-131`): `{cut_long_pauses:bool, pause_threshold_ms:250-3000 (default 1200), remove_filler_words:bool, filtered_words:[str lower]}`. New-task defaults are pauses on and fillers on (`:51-52`).

**Transcript sidecar** (`media/transcription.py:488-496`, schema `version: 2`):
```json
{"version":2,
 "words":[{"text","start":ms_int,"end":ms_int,"confidence","speaker"}],
 "utterances":[{"text","start","end","speaker","words":[…]}],
 "text":"...","language_code":"en"}
```

**Clip sidecar** `<clip>.source_map.json` (`clip_source_map.py`):
```json
{"version":1,
 "source_ranges":[{"start","end"}],
 "caption_settings":{"position_y","font_size","position","highlight_words"},
 "broll":[…]}
```
Recommendation: store `source_ranges` and `caption_settings` on the Mongo clip document and pass them in, so the engine no longer depends on clip sidecars.

**EditDocument** (`editor_document.py:23-110`):
- `{version:1, segments[1..100]{id,start,end≥start+0.04}, words[≤5000]{id,start,end,text≤120,highlight}, volume 0-2, muted, hookTitle≤200}`
- `captions{enabled, font∈{TikTokSans-Regular,TikTokSans-Bold,Poppins-ExtraBold,THEBOLDFONT}, size 20-132, color/accent #RRGGBB, y 0.1-0.9, background, wordsPerLine 1-8, karaoke, uppercase, template}`
- `framing{aspect vertical|square|original, fit contain|cover, zoom 1-3, x,y 0-1}`
- `effects{brightness 40-180, contrast 40-180, saturation 0-220, blur 0-8, hue ±180}`

---

## (d) Windows-hostile constructs and what is needed

| # | Construct | Location | Effect on Windows | Fix |
|---|---|---|---|---|
| 1 | `import fcntl` and `fcntl.flock` | `media/source_limits.py:15,484,488`; `youtube_source.py:11,424,427`; `editor_document.py:12,133,137`; `media_storage.py:13,69,74,92,242,247,285,301,316,570,601,638,689` | `ModuleNotFoundError` at import; the engine cannot load | Replace with `filelock.FileLock` (already in `uv.lock`, only transitively through torch; add it explicitly), or make them no-ops when the TS worker serialises jobs (concurrency 1). `media_storage` is dropped anyway |
| 2 | `Path.symlink_to` | `services/editor_service.py:663` (combine cancel file) | Needs admin or Developer Mode, otherwise `OSError` | Pass the parent `cancel_file` path explicitly to the second render |
| 3 | `subprocess.run(..., text=True)` and default-encoding file writes | `media/ffmpeg.py:38-43` (all ffprobe/ffmpeg calls), `media/source_limits.py:174,236,335`, `clip_editor.py:48,52,400`, `youtube_source.py:848,870`, `youtube_proxy.py:1017`, `editor_service.py:66`, `editor_document.py:324`, `font_registry.py:28`, `video_service.py:134`; concat list `clip_editor.py:205-211` (`NamedTemporaryFile("w")`) | The cp1252 locale can raise `UnicodeDecodeError` on UTF-8 ffmpeg stderr (titles, emoji) and mis-encode non-ASCII paths in the concat list | Run the engine with `PYTHONUTF8=1` (`-X utf8`). One flag covers every site |
| 4 | Relative paths in the concat list | `clip_editor.py:210` writes `str(path)`; the list sits in the OS temp dir. Default `TEMP_DIR="temp"` is relative (`config.py:119`); Docker sets the absolute `/app/uploads` (`docker-compose.yml:126,301`) | ffmpeg resolves relative entries against the list's folder, so **merge breaks** with a relative `TEMP_DIR` on any OS | Use `path.resolve()` (as `youtube_source.py:857` already does) and always pass an absolute `temp_dir` |
| 5 | Command-line length (CreateProcess limit 32,767 chars vs about 128 KB per argument on Linux) | Long `-filter_complex` and crop-x expressions: `reframing.py:1018-1036` (≤90 keyframes, `:1001`), `:1119-1145` (one expression per shot, nested), `:1195-1200` (`between()` lists), `speaker_framing.py:682-720`, stacked overlap filter `:862-894`, editor combine graph `editor_service.py:589-659` | Long clips with many shots can fail to spawn (`WinError 206`) | Write graphs to a file and use `-/filter_complex <file>` (ffmpeg ≥7) or `-filter_complex_script`; or cap keyframes per shot |
| 6 | Killing only the direct child | `editor_document.py:291-298`, `clip_editor.py:432-445`; and Node → python → ffmpeg | On Windows `kill()` is TerminateProcess on python only; ffmpeg is orphaned and keeps files locked | Cancel through `cancel_file` (the engine terminates its own ffmpeg), with `taskkill /PID <pid> /T /F` from Node as a fallback |
| 7 | `os.replace` / `Path.replace` over a file another process has open | `editor_document.py:124` (`atomic_json` for status/draft files the API polls), `media/ffmpeg.py:354`, `media/source_limits.py:360`, `youtube_source.py:458`, `editor_service.py:268`, `editor_document.py:405`, `media_storage.py:214` | Intermittent `PermissionError` (WinError 5/32) | Move job status and drafts to Mongo. Keep one worker per source file, or retry the replace |
| 8 | Deleting files that are open | `TemporaryDirectory` at `video_utils.py:347`, `captions.py:86`, `reframing.py:617`, `editor_service.py:637`, `clip_service.py:564`; `unlink` in `youtube_utils.py:215-234, 798-856` | Cleanup raises if a handle is still open | `TemporaryDirectory(ignore_errors... )` → use `ignore_cleanup_errors=True` (Python 3.10+); keep single-writer discipline |
| 9 | ffmpeg filter-path escaping | `media/ffmpeg.py:285-300` (two-level escape covering drive colons, backslashes and quotes); used at `:373-375`, `reframing.py:626,629`, `clip_editor.py:297-299`, `editor_document.py:362` | Already Windows-safe. `editor_document.py:362` falls back to the relative `Path('fonts')` | Always pass an absolute `fonts_dir` |
| 10 | `Path(command[0]).name == "ffmpeg"` | `editor_document.py:259` | If ffmpeg is configured as `...\ffmpeg.exe`, editor progress is silently disabled | Compare `Path(...).stem`, or keep bare `ffmpeg` on PATH |
| 11 | `fc-query` | `font_registry.py:29` | Not present; handled (`supported_languages` is `None`) | None needed |
| 12 | Emoji and multilingual glyph fallback | `media/common.py:67` (`Noto Color Emoji`); Docker installs `fonts-noto-core/cjk/color-emoji` and runs `fc-cache` (`Dockerfile:7-15`) | The emoji probe fails, so emojis are auto-disabled (`captions.py:120-126`). CJK/Hindi depend on libass falling back to Windows fonts | Bundle Noto fonts into `fonts/`, or accept no emoji. Use an ffmpeg build whose libass has a font provider (DirectWrite or fontconfig with a `fonts.conf`) |
| 13 | OpenCV and non-ASCII paths | `cv2.imread` at `captions.py:114`; `cv2.VideoCapture` at `reframing.py:232`, `reaction_layout.py:99` | Fails on non-ASCII paths on Windows | Keep `TEMP_DIR` ASCII-only and short |
| 14 | MAX_PATH 260 | Editor dirs (64-hex names plus `combine_*`), yt-dlp `.parts-r-0000000000-0000000000` work dirs (`youtube_proxy.py:890`) and fragments | Long-path failures | Use a short `TEMP_DIR` (e.g. `C:\cw\data`) or enable `LongPathsEnabled` |
| 15 | Heavy import at load time | `media/common.py:37-43` imports `whisper`, which pulls in torch; pyproject makes `openai-whisper` mandatory | Every CLI call pays several seconds of torch import | Make it a lazy import, or drop Whisper |
| 16 | Config imports database code | `config.py` → `runtime_settings.py:9-11` imports sqlalchemy and cryptography | Extra dependencies just to read env vars | Use a slim engine config |
| 17 | `/tmp`, `os.fork`, `signal` | None in `src` (checked by grep) | None | None |

**Windows prerequisites**
- Python 3.11 with opencv-python, numpy, assemblyai, httpx, yt-dlp[default], pydantic and python-dotenv. Remove fastapi, sqlalchemy, asyncpg, arq, redis, boto3, posthog, apify-client, pydantic-ai, anthropic and torch/whisper from the engine.
- **ffmpeg and ffprobe on PATH**, from a gyan.dev "full" or BtbN GPL build. Required features: libx264, libass (`subtitles` and `ass` filters), xfade/acrossfade, zoompan, gblur, unsharp, tblend, signalstats, metadata, astats, showinfo, lutrgb, hue, tile, loudnorm, anullsrc, zscale (optional), `-progress`.
- A JS runtime for yt-dlp: deno on PATH. yt-dlp may also be configured to use the worker's node through `js_runtimes`; I have not verified that option against the pinned yt-dlp version.
- `PYTHONUTF8=1`, and an absolute, short, ASCII `TEMP_DIR`.
- Vercel cannot host the engine (ffmpeg, OpenCV, long runs). The TS worker must copy inputs from storage to local disk, including the source file **and** its `.transcript_cache.json`, and upload the outputs afterwards.

---

## (e) Caching and where it is stored
1. **Transcript sidecar.** `video_path.with_suffix(".transcript_cache.json")` next to the source: written at `media/transcription.py:454`, read at `:506`. Re-read by almost every timeline and caption function.
   - `{stem}.transcription.mp3` is reused if present (`:36-38`).
   - YouTube timings are mirrored to S3 as `transcripts/{video_id}.transcript_cache.json` (`media_storage.py:322-333`), saved in `task_service._cleanup_source_video :175` and restored in `video_service.download_video :268-273`.
   - Copied and time-shifted for assembled timelines by `copy_transcript_sidecar` (`youtube_source.py:315-325`).
   - A sidecar without words forces re-transcription (`video_service.py:786-796`).
2. **`processing_cache` table** (`init.sql:119-128`): `cache_key PK, source_url, source_type, video_path, transcript_text, analysis_json`, upserted with COALESCE (`repositories/cache_repository.py:37-75`).
   - Keys: `task_service.py:62-85`, versioned by `TRANSCRIPT_ANALYSIS_CACHE_VERSION="windowed-rerank-v6"` (`ai.py:37`). Non-auto clip lengths add a derived analysis-only key.
   - Read by `process_task :372-383`, `update_clip_captions` (`clip_service.py:508-514`) and `prepare_editor` (`editor_service.py:390-395`) to find the source file, with a re-download fallback.
   - `video_path` is a local path (or S3 ref) that can go stale once the YouTube cache TTL deletes the file.
3. **YouTube source cache.** `{TEMP_DIR}/youtube-cache/{video_id}/` holds:
   - `manifest.json`: `{version:1, video_id, audio_policy:"original-v1", audio, full, ranges:[{start,end,file,bytes}]}` (`youtube_source.py:431-458`);
   - `full.<ext>`, `audio-original-v1.<ext>`, `r-<startms>-<endms>.mp4`, and a `.lock` file.
   - TTL is `YOUTUBE_SOURCE_CACHE_TTL_SECONDS` = 7 days, swept by manifest mtime on each access (`:465-476`). Disable with `YOUTUBE_SOURCE_CACHE=false`. Mirrored to S3 `youtube-cache/{id}/{name}`.
   - Per-job `{TEMP_DIR}/youtube-work/{id}-{session}/render.mp4` plus `.timeline.json` is removed in `cleanup_downloaded_files` (`youtube_utils.py:798-856`). Raw yt-dlp output in `{TEMP_DIR}/{video_id}.*` is cleared before each download (`:215-234`).
4. **Normalised source** is rewritten in place, so sidecars stay valid. The `.{name}.normalize.lock` file is left beside it (`source_limits.py:482`). On S3 a `.capped.mp4` copy is kept beside the stored original (`media_storage.py:377-400`).
5. **S3 media cache** `{TEMP_DIR}/media-cache/{sha256(ref)}/` with `.lease`, `.download` and `.access` files; TTL `MEDIA_CACHE_TTL_SECONDS` (minimum 4 h, default 24 h). This is S3-only and gets dropped.
6. **Editor state** `{TEMP_DIR}/editor/{sha256(task:clip:filename)}/` (`editor_document.py:113-116`):
   - `asset.json`, `draft.json` (`{revision, document}`), `original.json`, `clean.mp4`, `thumbnails.jpg`;
   - per job: `request-*.json`, `job-*.json`, `progress-*.txt`, `log-*.txt`, `cancel-*`, `export-*.mp4`, `captions-*.ass`;
   - `.lock` and `.s3-manifest`.
7. **Other directories:**
   - `{TEMP_DIR}/clips/` holds clips and their `.source_map.json`;
   - `{TEMP_DIR}/uploads/{uuid}{ext}` holds uploads;
   - `{TEMP_DIR}/clip-exports/{export_id}/` holds preset exports;
   - `{TEMP_DIR}/stream-work/` is for streams (dropped).
8. **In-process caches** (each CLI invocation repeats these):
   - the emoji probe `_EMOJI_SUPPORT_CACHE` (`captions.py:80-124`), about one ffmpeg run per process;
   - font codepoints and names (`lru_cache`, `font_registry.py:20,320`);
   - the Whisper model cache (`media/common.py:130`).

**Existing regression suite.** CLAUDE.md says there are no tests, but `backend/tests/unit` contains media tests the engine should pass on Windows: `test_ffmpeg_filter_escaping`, `test_caption_render_roundtrip`, `test_clip_boundaries`, `test_face_detection`, `test_reaction_layout`, `test_scene_context*`, `test_speaker_framing`, `test_talking_head_layout`, `test_range_seek`, `test_audio_track_selection`, `test_source_limits`, `test_editor_document`, `test_editor_reframe`, `test_ffprobe_video_size`, `test_caption_glyph_fallback` and `test_clip_source_map`. Several of them (`test_editor_document`, `test_ffmpeg_filter_escaping`, `test_media_storage`, `test_task_service`, `test_video_cleanup`, `test_broll`) mention fcntl or `/tmp` and will need path fixes.