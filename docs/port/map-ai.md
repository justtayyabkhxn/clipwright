# AI and Transcription Layer Map (SupoClip to Clipwright)

I read all of `backend/src/ai.py` (1733 lines), `src/media/transcription.py`, the related parts of `media/timeline.py`, `media/captions.py`, `media/common.py`, `clip_duration.py`, `llm_connection.py`, `config.py` and `runtime_settings.py`, the call sites in `services/video_service.py`, `services/task_service.py` and `api/routes/admin.py`, and the unit tests that act as an executable spec for this layer. I modified no files.

**Recommendation in one line:** port the AI logic to TypeScript. Keep only the media work (ffmpeg audio extraction, audio peaks, rendering) in the Python engine, and have the TS side write the word-timing cache file in exactly the format the Python code reads today (section 4.4).

---

## 1. Public surface of `ai.py` and its callers

### 1.1 Constants (`ai.py:33-73`)

| Constant | Value | Used for |
|---|---|---|
| `IDEAL_CLIP_MIN/MAX_SECONDS` | 25 / 50 | Legacy. The real bounds come from `clip_duration()` |
| `MIN/MAX_ACCEPTED_CLIP_SECONDS` | 15 / 60 | Legacy |
| `TRANSCRIPT_ANALYSIS_CACHE_VERSION` | `"windowed-rerank-v6"` | Part of the cache key (`task_service.py:62-73`) |
| `TRANSCRIPT_ANALYSIS_MAX_ATTEMPTS` | 3 | Retry loop |
| `TRANSCRIPT_ANALYSIS_TIMEOUT_SECONDS` | 600 | Per-call wall-clock budget |
| `ANALYSIS_WINDOW_SECONDS` | 720 (12 min) | Window length |
| `ANALYSIS_WINDOW_OVERLAP_SECONDS` | 120 (2 min) | Window overlap |
| `ANALYSIS_SINGLE_WINDOW_MAX_SECONDS` | 900 (15 min) | Below this, the whole transcript is one window |
| `ANALYSIS_WINDOW_CONCURRENCY` | 3 | Windows analysed at once |
| `ANALYSIS_WINDOW_SEGMENT_TARGET` | `"3-5"` | Clips requested per window (single pass asks for `"2-5"`) |
| `ANALYSIS_TOTAL_TIMEOUT_SECONDS` | 1800 | Budget for all windows together |
| `RERANK_TIMEOUT_SECONDS` | 240 | Rerank call budget |
| `CANDIDATE_DEDUPE_OVERLAP_RATIO` | 0.5 | Dedup threshold |
| `SEGMENT_SNAP_TOLERANCE_SECONDS` | 8 | How far a timestamp may be snapped |
| `MIN_FINAL_CLIPS` / `MAX_FINAL_CLIPS` / `SECONDS_PER_FINAL_CLIP` | 5 / 20 / 300 | Final clip count formula |
| `TRANSIENT_MODEL_STATUS_CODES` | {408, 429, 500, 502, 503, 504, 529} | Retryable HTTP statuses |
| `HOOK_TITLE_MAX_CHARS` / `_WORDS` | 64 / 10 | Hook title caps |

Regexes:
- `TRANSCRIPT_SPAN_RE` / `TRANSCRIPT_LINE_PATTERN`: `^\[(\d{1,3}:\d{2}(?::\d{2})?)\s*-\s*(\d{1,3}:\d{2}(?::\d{2})?)\]\s*(.*)$`. Minutes go up to three digits, so labels like `100:05` are valid.
- `SIGNAL_LINE_PATTERN`: `^- \[(start)\s*-`
- `SPEAKER_PREFIX_PATTERN`: `^Speaker [^:]+:\s*`

### 1.2 Functions

| Function (line) | Inputs → output | Called from |
|---|---|---|
| `get_most_relevant_parts_by_transcript` (1645) | `transcript: str, clip_signals: str\|None, performance_context: str\|None, clip_length="auto"` → `TranscriptAnalysis`. Any exception is rewrapped as `RuntimeError("Transcript analysis failed: {e}")` | `video_service.py:325-345` (`VideoService.analyze_transcript`), called by `process_video_complete` at 853 |
| `get_most_relevant_parts_sync` (1730) | `asyncio.run` wrapper | Not called anywhere |
| `build_transcript_system_prompt(clip_length)` (421) | System prompt with bounds filled in | `get_transcript_agent` |
| `build_transcript_analysis_prompt(transcript, clip_signals, window, performance_context, clip_length)` (809) | User prompt | Single-pass path and windows |
| `build_candidate_rerank_prompt(candidates, performance_context)` (787) | User prompt | `rerank_candidates` |
| `rerank_candidates(candidates, performance_context)` (1383) | List in, list out. Never raises: any failure returns the first-pass order | Only when there are more than one window (1698) |
| `apply_candidate_ranking(candidates, ranking)` (1349) | Reorders and recalibrates scores. Raises `ValueError` if no ids are usable | `rerank_candidates` |
| `split_transcript_into_windows(transcript, ...)` (1169) | `[{start, end, transcript}]` | Main entry |
| `dedupe_overlapping_segments(segments, ratio=0.5)` (1277) | Sorted best-first, overlaps dropped | Main entry |
| `max_final_clips_for_duration(source_seconds, max_clips=20)` (1300) | int | Main entry, with `get_config().max_clips` |
| `sanitize_hook_title(raw)` (885) | `str\|None` | `_validate_segments` |
| `get_transcript_agent(clip_length)` (564), `get_rerank_agent()` (643), `get_broll_agent()` (718) | Lazily built pydantic-ai agents, cached until the config signature changes | The B-roll agent is dropped |
| `plan_broll_cues`, `build_broll_plan_prompt`, `BRollCue`, `BRollPlan`, `broll_plan_system_prompt` (675-770) | B-roll planning | `broll.py:445`. **Dropped** |
| `_get_missing_llm_key_error(model_name, config)` (445) | Error string or None | `api/routes/admin.py:11,190` (validates the `LLM` setting) |
| Private helpers: `_parse_transcript_lines` (80), `_parse_transcript_spans` (966), `_snap_bounds_to_transcript_lines` (99), `_snap_segment_bounds` (1480), `_extract_transcript_text_for_segment` (137), `_extract_transcript_text` (990), `_choose_repaired_bounds` (1004), `_repair_segment_bounds` (1060), `_validate_segments` (1507), `_sanitize_hook_span` (916), `_rescale_virality` (1312), `_overlap_ratio` (1268), `_segment_rank_key` (1261), `_merge_key_topics` (1633), `_filter_clip_signals_for_window` (1229), `_analyze_transcript_windows` (1411), `_run_transcript_analysis` (1114), `_is_transient_model_error` (1097), `_parse_transcript_timestamp_seconds` (938), `_format_transcript_timestamp` (950), `_format_minutes_label` (960), `_normalize_transcript_text` (76), `_performance_history_section` (773) | | |

`task_service.py:38` imports only `TRANSCRIPT_ANALYSIS_CACHE_VERSION`.

---

## 2. Output models (`ai.py:161-279`, `599-620`)

### 2.1 `ViralityAnalysis`

Every field has a default:

| Field | Type | Default | Constraint |
|---|---|---|---|
| `hook_score` | int | 15 | ge 0, le 25 |
| `engagement_score` | int | 15 | ge 0, le 25 |
| `value_score` | int | 15 | ge 0, le 25 |
| `shareability_score` | int | 15 | ge 0, le 25 |
| `total_score` | int | 60 | ge 0, le 100 |
| `hook_type` | `Literal["question","statement","statistic","story","contrast","none"] \| None` | `"none"` | enum |
| `virality_reasoning` | str | `"The model did not provide a detailed virality breakdown."` | |

### 2.2 `TranscriptSegment`

| Field | Type | Default | Notes |
|---|---|---|---|
| `start_time` | str | required | MM:SS |
| `end_time` | str | required | MM:SS |
| `text` | str | required | Aliases `text` / `segment` |
| `relevance_score` | float | 0.75 | 0.0-1.0. A before-validator divides values in (1, 100] by 100 (`_coerce_percent_relevance_score`, 259-270) |
| `reasoning` | str | `"Selected by the AI model as a clip candidate."` | |
| `virality` | `ViralityAnalysis` | factory defaults | |
| `hook_title` | `str\|None` | None | Aliases `hook_title` / `title` / `headline` |
| `hook_start_time` | `str\|None` | None | |
| `hook_end_time` | `str\|None` | None | |

Each field's `description` text is in the code and is sent in the schema.

### 2.3 Other models

- **`TranscriptAnalysis`**: `most_relevant_segments: List[TranscriptSegment]`, `summary: str`, `key_topics: List[str]`, all required. Unknown keys such as the legacy `broll_opportunities` are ignored (test `test_ai_models.py`).
- **`RankedCandidate`**: `candidate_id: int` (required), `score: int` (0-100, required), `reason: str` (default "").
- **`CandidateRanking`**: `ranking: List[RankedCandidate]`.

### 2.4 Schema actually sent to Claude

I dumped it with `anthropic.transform_schema`. Important for the port:

- `required` lists only `start_time`, `end_time`, `text` (segment); `most_relevant_segments`, `summary`, `key_topics` (top level); `candidate_id`, `score` (ranking). Every other field can be omitted, so the TS side must apply the defaults itself.
- `minimum` / `maximum` are **stripped** from the schema and moved into the description (for example `"{default: 15, maximum: 25, minimum: 0}"`). Claude can therefore return `hook_score: 27`.
  - Today pydantic rejects that and pydantic-ai triggers an output retry.
  - In the TS port, clamp the value instead of re-calling the model.
- `additionalProperties: false` is set on every object. The `hook_type` enum is kept.

---

## 3. Prompts

### 3.1 Where each prompt lives

| Prompt | Location | Placeholders |
|---|---|---|
| Clip-selection system prompt | `transcript_analysis_system_prompt`, `ai.py:282-419` (copy it verbatim) | `{minimum} {maximum} {ideal_minimum} {ideal_maximum}`, filled by `build_transcript_system_prompt` (421-426). There are no other braces in the text |
| Clip-selection user prompt | `build_transcript_analysis_prompt`, `ai.py:809-882` | See 3.3 |
| Rerank system prompt | `candidate_rerank_system_prompt`, `ai.py:622-637` | None |
| Rerank user prompt | `build_candidate_rerank_prompt`, `ai.py:787-806` | See 3.4 |

The system prompt covers, in order: output contract, core objectives, grounding rules, content-neutrality rules, selection criteria, "what a good clip feels like", virality rubric (four bands per 0-25 subscore), hook titles (3-9 words), clip boundaries (opening/ending), cold-open hook ("prefer null"), hook types, timing guidelines, timestamp requirements, scoring rules, and the closing "usually 2-5".

### 3.2 How the prompts are sent

- pydantic-ai sends the system prompt as `system`. The prompt-builder output is the only user message.
- There is no prefill and no conversation history, except the validation-error retry turns that pydantic-ai adds (`output_retries=2`, so at most 3 model calls).

### 3.3 User prompt dynamic parts (exact text)

**Segment target:** `segment_target = "3-5" if window else "2-5"`.

**Window note** (only when windowed):
```
\nThis transcript is one window ({MM:SS start} - {MM:SS end}) of a longer video. Other windows are analysed separately, so pick the best clips that exist inside this window only.\n
```
Labels come from `_format_minutes_label`, which uses unbounded minutes.

**Signals section** (only if `clip_signals` is set):
```
\n\nAdditional deterministic signals from transcript/audio analysis:\n{clip_signals}\n\nUse these as hints only. They should influence ranking, but every final segment must still be a coherent contiguous transcript range.
```

**Performance section** (`_performance_history_section`, 773-784). This is social data and will be dropped:
```
\n\nCreator performance history (real audience data from clips this creator already published):\n{ctx}\n\nUse this history to break ties and to bias hook_type, clip length and hook style toward what has demonstrably worked for this creator. It never justifies fabricating content, stretching timestamps, or picking a weak moment.
```

**Order of the body:**
1. Intro
2. Window note
3. Format example (`[00:12 - 00:21] Spoken text here`)
4. Five-step workflow
5. Selection target (uses `bounds.*`)
6. Critical accuracy requirements
7. `{signal_section}{performance_section}`
8. JSON-only output requirements (uses `bounds.minimum` / `bounds.maximum`)
9. `Transcript:\n{transcript}`

### 3.4 Rerank user prompt (exact text)

```
Rank these {N} clip candidates from the same video, best first.\n\n
candidate_id: {i}\ntime: {start} - {end} ({duration}s)\nhook_title: {hook_title or '(none)'}\ntext: {text}
```
Blocks are joined with `\n\n`, followed by the performance section.

### 3.5 Clip signals (deterministic; input to the prompt)

Built by `media/timeline.py:737-800` `build_clip_signal_summary(video_path, transcript)`, which runs before analysis (`video_service.py:845`). If it fails, `clip_signals` is None.

Scoring per transcript line:

| Signal | Points |
|---|---|
| Trigger-word regex (wait, what, no way, seriously, actually, but, however, because, mistake, secret, wild, crazy, insane, never, always, nobody, everybody, why, how, haha, laugh, lol, damn, and profanity) | +2.0 |
| Contains `?` | +1.5 |
| Contains `!` | +1.0 |
| "I/we thought/realized/found/learned/made/lost/won" | +1.0 |
| 8 words or fewer | +0.5 |
| Pause of at least 1 s before the line | +1.0 |
| Speaker change and line 6 s or shorter | +1.25 |
| Next speaker differs within 10 s | +1.0 |
| Contains an audio RMS peak | +1.25 |

- Audio peaks (`detect_audio_peak_times`, 687) come from ffmpeg `astats` (needs ffmpeg). It keeps the top 8 peaks at least 4 s apart.
- Output is the top 12 lines. The header is `Deterministic clip-worthiness signals to consider before ranking:`, then one line per signal: `- [{start_label} - {end_label}] score={x.1f}: {reasons}; {text}`.
- For windows, `_filter_clip_signals_for_window` keeps the header and only the signal lines whose start falls in `[window_start, window_end)`. It returns None if no lines are kept.

---

## 4. Transcript format passed to the LLM

### 4.1 Formatting (`media/transcription.py:620-682`)

`format_transcript_for_analysis(transcript)` takes the AssemblyAI object. Because `speaker_labels=True`, utterances are always present.

For each utterance:
- If it is longer than 45,000 ms or has more than 80 words, it is split by `_format_words_for_analysis`:
  - minimum 8 words, maximum 24 words, maximum 20,000 ms per line.
  - A line flushes when it reaches 24 words, or a word ends in `.`/`!`/`?` and the line has at least 8 words, or the line spans 20 s and has at least 8 words.
  - Text is rebuilt with `_join_transcript_tokens` (541-559), which removes the space before `, . ! ? ; :` and before `n't 're 've 'll 'd 'm 's`.
- Otherwise the utterance becomes one line: `[{MM:SS} - {MM:SS}] Speaker {label}: {utterance.text}`.

Other cases:
- With no utterances, the words path uses min and max of 8 words each, so every line is exactly 8 words or the remainder.
- Whisper dicts become `[s - e] text` with no speaker label.

`format_ms_to_timestamp(ms)` (677) floors to whole seconds and prints `MM:SS` with **unbounded minutes and no hours**. Lines are joined with `\n` and stored as `processing_cache.transcript_text`.

### 4.2 How `ai.py` parses that format back

| Parser | Returns | Notes |
|---|---|---|
| `_parse_transcript_lines` | `{start_time, end_time, start_seconds, end_seconds, text}` | Speaker prefix removed. Used for snapping and exact-label grounding |
| `_parse_transcript_spans` | `{start, end, text}` | Speaker prefix kept. Drops `end <= start`. Used for repair |
| `_parse_transcript_timestamp_seconds` | seconds | Accepts `M:SS` or `H:MM:SS` with `int()` parts. Anything else raises `ValueError` |
| `_format_transcript_timestamp` | label | Prints `HH:MM:SS` when hours are present. This is why repaired bounds are snapped again, back onto the MM:SS line labels |

### 4.3 Transcription providers

- `config.transcription_provider` is `assemblyai` (default), `whisper` or `youtube_captions`.
- `youtube_captions` returns plain text with no timestamps. Grounding then fails for every segment, so the task falls back to the fallback clip. Drop both Whisper and YouTube captions; AssemblyAI is the only one in scope.

### 4.4 Cached word-timing JSON

Path: `video_path.with_suffix(".transcript_cache.json")`. Only the last extension is replaced: `source.mp4` becomes `source.transcript_cache.json`. The file is written by `cache_transcript_data` (449-501).

```json
{
  "version": 2,
  "words": [{"text": "Hello,", "start": 1230, "end": 1500, "confidence": 0.98, "speaker": "A"}],
  "utterances": [{"text": "...", "start": 1230, "end": 9800, "speaker": "A", "words": [/* same shape */]}],
  "text": "full transcript text",
  "language_code": "en"
}
```

- Times are **integer milliseconds**.
- `language_code` comes from the response or the config and may be null.
- On load (504-520), a file without `version` gets `version: 2` and `utterances: []`.
- The schema version constant is `TRANSCRIPT_CACHE_SCHEMA_VERSION = 2` (`media/common.py:63`).
- The file is also persisted to storage: `MediaStorage.save_source_metadata`, `persist_cache_sidecar`, and `transcripts/{video_id}.transcript_cache.json` for YouTube (`media_storage.py:323-337`).
- For partial YouTube downloads, `youtube_source.py:273-325` `shift_transcript` / `copy_transcript_sidecar` remaps word times through a TimeMap. Words whose midpoint falls outside a section are dropped.

---

## 5. AssemblyAI request, polling and caching

### 5.1 Audio preparation (`transcription.py:34-76`)

- Command: `ffmpeg -y -i src [-map 0:a:{idx}] -vn -ac 1 -ar 16000 -b:a 64k {stem}.transcription.mp3`, with a 900 s timeout.
- The audio stream index comes from `select_audio_stream_index`, so the same track the renderer uses is transcribed.
- If the file already exists it is reused. If ffmpeg fails, the original video is sent instead.

### 5.2 Client and config (`transcription.py:346-372`)

- A per-job `aai.Client` is created with `http_timeout = ASSEMBLY_AI_REQUEST_TIMEOUT_SECONDS` (default 60, clamped to 5-300) and the configured API key.
- `TranscriptionConfig`:
  - `speaker_labels=True`, `punctuate=True`, `format_text=True`
  - `speech_models = ["universal-3-5-pro", "universal-2"]`, or `["universal-2"]` when the model is `nano` or `universal-2` (`_assemblyai_speech_models_value`, 165-174)
  - `language_code = TRANSCRIPTION_LANGUAGE or None`
  - `language_detection = True` only when no language is set
- Disfluencies and word boost are not set. Word timestamps are always returned by AssemblyAI.
- The speech model passed in is `"best"`, or `FAST_MODE_TRANSCRIPT_MODEL` (default `universal-3-5-pro`) when `processing_mode == "fast"` (`video_service.py:300-323`). Both map to the same model list.
- `TRANSCRIPTION_LANGUAGE` is normalised by `config.py`: lowercased, `-` becomes `_`, and `auto` becomes empty.

### 5.3 Upload, submit and poll (`transcription.py:79-162`)

**Upload:** up to 3 attempts. It retries on `httpx.TransportError` or `AssemblyAIError` with status in {408, 429, 500, 502, 503, 504}, sleeping 2^attempt (2 s, then 4 s). After that it raises `RuntimeError("AssemblyAI audio upload unavailable after 3 attempts (HTTP x).")`.

**Submit:** happens exactly once and is **never retried**, because it creates a paid job.

**Poll:**
- Each poll is `GET {ENDPOINT_TRANSCRIPT}/{id}` with a timeout of `min(30, remaining)`.
- Transport errors and HTTP {408, 429, 500, 502, 503, 504} retry the same job, sleeping `min(30, 2^min(failures, 4), remaining)`. Other HTTP errors raise.
- Polling stops on `completed` or `error`.
- Between polls it sleeps `aai.settings.polling_interval`. The SDK default is 3.0 s (confirmed in the installed SDK 0.63.0).
- The total deadline is `ASSEMBLY_AI_HTTP_TIMEOUT_SECONDS` (default 900). When it passes, it raises `TimeoutError` and does not resubmit.
- A job that ends in `error` raises `Exception("Transcription failed: {error}")`.

These behaviours are tested in `tests/unit/test_assemblyai_polling.py`.

### 5.4 When transcription runs (`video_service.py:779-800`)

Transcription runs if there is no cached transcript, or if the cached transcript's word-timing file is missing `words`. Afterwards the word timings are persisted before analysis starts.

### 5.5 How word timings are used downstream

All of these read the `.transcript_cache.json` file:

| Consumer | Location | What it does |
|---|---|---|
| `get_words_in_range` | `timeline.py:803` | Clip-relative words in float seconds |
| `get_absolute_words_in_range` | `timeline.py:838` | Absolute words, overlap-clipped |
| `get_words_for_keep_ranges` | `timeline.py:1074` | Projects words onto the output timeline, minus the crossfade at each junction |
| `build_assemblyai_ass_subtitles` | `captions.py:337-633` | Karaoke / fade / pop / bounce ASS events in chunks of `max_words_per_line`, plus the hook title |
| `build_hook_title_ass` | `captions.py:250` | Hook title overlay |
| `snap_clip_start_to_sentence` | `timeline.py:417-463` | Rewinds weak openers up to 8 s (`_WEAK_OPENERS`, `_BACK_REFERENCES`) |
| `extend_keep_ranges_to_sentence_boundary` | `timeline.py:46` | Extends the end up to 5.5 s and adds 0.35 s padding |
| `clamp_keep_ranges_to_max_duration` / `_end_at_cap` | `timeline.py:167`, `:201` | Trims to the cap, landing on a sentence end where possible |
| `build_clip_keep_ranges` | `timeline.py:930` | Filler removal and pause compression. Uses `language_code` through `clip_cleanup.default_filtered_words` |
| `build_hook_teaser_range` | `timeline.py:475` | Cold-open teaser, only when `HOOK_FIRST_TEASER` is on (default off) |
| Speaker framing | `speaker_framing.py:143` | Uses `word.speaker` |
| Text grounding | `video_service.py:106-128` `_ground_segment_text` → `get_transcript_text_in_range` | Rewrites each segment's text from words after analysis |
| Clip text | `keep_ranges_transcript_text` | Final stored clip text |
| Editor | `editor_service.py:452`, `clip_editor.py:266`, `editor_document.py:217-239` | Editor captions and renders |

**Port contract:** the Python engine can keep all of the above unchanged if the TS side writes this exact JSON next to the source file.

---

## 6. Long-video algorithm (`get_most_relevant_parts_by_transcript`, 1645-1727)

### 6.1 Steps

1. Build the agent. Parse `transcript_lines` and `transcript_spans` from the **full** transcript. Call `split_transcript_into_windows`.
2. **One window:** a single call with the full transcript and the unfiltered signals.
   **Several windows:** `_analyze_transcript_windows` (see 6.3).
3. Run each analysis's segments through `_validate_segments` against the full-transcript lines and spans, then concatenate.
4. `dedupe_overlapping_segments`. This runs in the single-window case too, so the final order is always best-first.
5. If there was more than one window, `rerank_candidates`.
6. Keep `candidates[:max_final_clips_for_duration(max line end_seconds, config.max_clips)]`.
7. Build the result:
   - `summary`: each window's summary, stripped and joined with a single space.
   - `key_topics`: `_merge_key_topics` (case-insensitive dedup, first 12).

### 6.2 Windowing (1169-1226)

- Lines matching the span regex are collected as `(start_seconds, line)`. `total_seconds` is the largest end (or start).
- If there are no lines, or `total_seconds <= 900`, there is one window `{0, total, original transcript}`.
- Otherwise the step is 600 s: windows are `[0,720]`, `[600,1320]`, and so on. The window that reaches `total` is clamped to `total` and ends the loop.
- If the last window is shorter than 360 s, it is removed and the previous window is extended to `total`.
- Lines are assigned **by start time only**: `ws <= start < we`, with the last window inclusive of its end. Lines are never cut.
- Test vectors:
  - 60 min gives `(0,720), (600,1320), (1200,1920), (1800,2520), (2400,3120), (3000,3600)`.
  - 23 min gives `(0,720), (600,1380)`.

### 6.3 Concurrency and failure handling (1411-1477)

- A semaphore allows 3 windows at once. `asyncio.wait` runs with a 1800 s timeout, after which pending windows are cancelled.
- Each window also has its own 600 s budget inside `_run_transcript_analysis`, starting when it runs.
- If the caller is cancelled, all window tasks are cancelled.
- Failed windows are logged and skipped. The first error is raised only if no window succeeded. If none succeeded and there were no errors (all timed out), it raises `RuntimeError("...took too long...")`.

### 6.4 Dedup (1268-1297)

- Candidates are sorted by `(virality.total_score, relevance_score)`, highest first. The sort is stable.
- A candidate is dropped if it overlaps an already-kept candidate by more than 0.5 of the **shorter** range.

### 6.5 Rerank (1349-1408)

- Only runs with 2 or more candidates and more than one window.
- Uses the `RERANK_LLM` model (default: `LLM`) with a 240 s budget.
- `apply_candidate_ranking`:
  - Duplicate and out-of-range ids are skipped.
  - Scores are clamped so they never increase down the list (`ceiling = min(score, ceiling)`).
  - Candidates the reranker left out are appended in their first-pass order, also clamped.
  - `_rescale_virality(v, new_total)` rescales the four subscores proportionally (each 0-25), truncates them, hands out the remainder by largest fraction, and sets `total = sum`.
- Any exception keeps the first-pass order. The error text is never logged.

### 6.6 Final count (1300-1309)

```
ceiling = max(1, min(20, max_clips))
count   = max(min(5, ceiling), min(ceiling, ceil(source_s / 300)))
```

- `MAX_CLIPS` is an env var, default 10 (`config.py:116`).
- With the default of 10: 25 min or less gives 5 clips, 45 min gives 9, 50 min or more gives 10.
- A second cap is applied later in `video_service.py:916-919`: `segments[:max(1, min(MAX_CLIPS, FAST_MODE_MAX_CLIPS if processing_mode == "fast"))]`.
- If no segments survive, `_build_fallback_segment` (148-178) produces one clip:
  - It runs from `00:00` for `CLIP_DURATION` (env, default 30) when the preset is auto, or for the preset's `ideal_minimum` otherwise, never longer than the video.
  - It has `relevance_score` 0.25, all scores 0, and `hook_type: "fallback"`.

---

## 7. Timestamp grounding and repair (`_validate_segments`, 1507-1630)

For each segment, in order:

1. **Drop** if the text is empty or has fewer than 3 whitespace-separated words. This uses the model's own text.
2. **Drop** if `start_time == end_time` (string comparison).
3. Parse both timestamps. A `ValueError` or `IndexError` anywhere in the steps below drops the segment.
4. **Snap** (`_snap_bounds_to_transcript_lines`, 99-134):
   - The start goes to the line start nearest the model's start (ties go to the earlier line). It must be within 8 s, or nothing is snapped.
   - The end goes to the nearest line end among lines ending after the snapped start (ties go to the later line). It must also be within 8 s.
   - On success, the segment takes the lines' own labels (`start_time` / `end_time`). On failure, the model's bounds are kept.
5. If the duration is outside the preset's `[minimum, maximum]`, **repair** it (`_choose_repaired_bounds`, 1004-1057):
   - **Too long:** `target_end = start + ideal_maximum`. Pick the largest span end in `[start + minimum, min(target_end, end)]`. If there is none, use `(start, target_end)` when `start + minimum <= target_end`, even though that is not a line boundary.
   - **Too short:** search every `(cs <= start, ce >= end)` from span starts and ends with `minimum <= duration <= maximum`. Minimise `ideal_penalty * 1000 + extra_context`, with ties broken by the smaller start, then the smaller end. `ideal_penalty` is the distance outside `[ideal_minimum, ideal_maximum]`.
   - A repair sets the labels with `_format_transcript_timestamp` (which can produce HH:MM:SS) and the text from overlapping spans. The bounds are then **snapped again** onto the line labels.
6. **Drop** if the duration is 0 or less, below `minimum`, or above `maximum`.
7. **Grounding:** `_extract_transcript_text_for_segment` needs a line whose `start_time` label equals the segment's exactly, then walks forward until a line's `end_time` label equals the segment's end, joining the speaker-stripped texts. If no such pair exists, the segment is **dropped**.
   - If `_normalize_transcript_text` (lowercase, `[^a-z0-9']+` becomes a space, whitespace collapsed; ASCII only) differs between the two, the segment text is replaced with the grounded text.
8. `virality.total_score` is set to the sum of the four subscores.
9. `hook_title = sanitize_hook_title(...)`. The hook span is cleaned by `_sanitize_hook_span` (916-935): it requires `start < hook_start < hook_end <= end` and `hook_end - hook_start <= 8`, otherwise both are set to null.

After the AI step, `video_service._ground_segment_text` rewrites the text again from word timings, and `create_single_clip` recomputes it a final time from keep ranges.

---

## 8. Hook titles

- **Generation:** the same LLM call produces them. The system prompt section is at 360-367 and the user-prompt rule at 877. Each title is 3-9 words, in the transcript's language, with no hashtags, emojis or quotes.
- **`sanitize_hook_title` (885-913):**
  1. `str.strip()`.
  2. Strip the characters `"'`` `“”‘’` from both ends.
  3. Remove `#\w+` (Python `\w` is Unicode-aware).
  4. Collapse whitespace.
  5. `rstrip(".,;:-–— ")`, so `?` and `!` are kept.
  6. Keep at most 10 words.
  7. If longer than 64 characters, cut at the last space within the first 65 characters when that space is past index 20; otherwise hard-cut at 64. Then `rstrip` again.
  8. An empty result becomes None.
- **Render (`captions.py:250-334`):**
  - Shown from 0.12 s to `min(4.0, max(1.5, duration - 0.25))`, with top alignment (8).
  - Font size is `min(96, max(caption_px + 8, round(caption_px * 1.35)))`.
  - Wraps to at most 2 balanced lines and shrinks to fit.
  - Power words and numbers use the highlight colour. Entrance is a fade (160/240 ms) plus an optional pop.
- **Storage:** `generated_clips.hook_title`. The editor's `hookTitle` is limited to 200 characters (`editor_service.py:325,478`).

---

## 9. Retry, timeout and transient-error logic

### 9.1 `_run_transcript_analysis(agent, prompt, timeout)` (1114-1166)

- `asyncio.timeout(timeout)` wraps **all** attempts and back-offs. The default is 600 s; rerank uses 240 s and B-roll 60 s.
- Up to 3 attempts. Only transient errors are retried, after a delay of `5 * 2^(n-1) + uniform(0, 1)`, which is about 5 s and then about 10 s.
- After the attempts are exhausted it raises `RuntimeError("The AI analysis service is temporarily unavailable after several attempts. Please try again shortly.") from None`. There is no error chain, so transcript data cannot leak.
- When the budget runs out it raises `RuntimeError("The AI analysis service took too long to respond. Please try again shortly.")`.
- Cancellation passes straight through.

### 9.2 `_is_transient_model_error` (1097-1111)

Walks the `__cause__` chain. An error is transient if it is:
- `ModelHTTPError` with a status in `TRANSIENT_MODEL_STATUS_CODES`, or
- `httpx.TimeoutException`, `NetworkError`, `RemoteProtocolError`, or `TimeoutError`.

Never retried: 400/401/403, `UnexpectedModelBehavior` (invalid output), `ValueError`.

### 9.3 Other retry layers

- pydantic-ai `output_retries=2`: on a schema or validator failure, the validation error is sent back to the model and the call is retried.
- The Anthropic SDK's own `max_retries` (default 2) also runs inside each attempt.

Tests: `tests/unit/test_ai_retry.py` (128 lines) and `test_claude_provider.py`.

---

## 10. Model and provider configuration

### 10.1 Provider handling

- `LLM` is a `provider:model` string. Supported providers: `google`/`google-gla`, `openai`, `openrouter`, `anthropic`, `ollama` (433). Only Claude is in scope; the others can go.
- Default when `LLM` is unset (`config._infer_default_llm`, 418-432): the first available of google, openai, `anthropic:claude-opus-5`, openrouter.

### 10.2 Anthropic path (`_build_transcript_model`, 506-525)

- `supports_json_schema_output` is forced on, giving `NativeOutput(TranscriptAnalysis, strict=True)`. This produces `output_config.format = {type: "json_schema", schema}`, with no tools or `tool_choice` (`_uses_native_output`, 493-498).
- `max_tokens: 16000`. No `thinking` parameter is sent, so Opus 5 runs adaptive thinking by default.
- For `claude-opus-5` and `claude-fable-5-1` only:
  - beta header `server-side-fallback-2026-07-01`
  - body field `fallbacks: "default"`
- Requests are non-streaming.

### 10.3 Key storage and connection test

- Keys are resolved by `Config._get_runtime_setting`: the env var, or the admin value AES-GCM-encrypted in Postgres `app_settings` (`runtime_settings.py`) when it is preferred or no env var is set.
- `llm_connection.test_anthropic_connection(key, model)` validates through the Models API only, so it costs no tokens.
  - Statuses: `ok`, `missing_key`, `invalid_key`, `permission_denied`, `model_not_found`, `rate_limited`, `connection_failed`, `api_error`.
  - `mask_secret` displays keys as `sk-ant-…a1b2`.
  - Exposed as `POST /admin/ai/test-connection` (`admin.py:136-153`).
  - This is the piece to keep for the "AI provider / Claude key" settings page.

---

## 11. `performance_context` (social; to be dropped)

- Loaded by `TaskService._load_performance_context` (`task_service.py:272-290`) through `SocialService.build_performance_context` (`social_service.py:1008-1016`, format at 1110-1143, capped at 2000 characters). It needs at least `SOCIAL_PERFORMANCE_MIN_POSTS` (3) measured posts.
- It is injected into every window prompt and the rerank prompt.
- When present it bypasses and skips writing the analysis cache (`task_service.py:387-389`, 487-501).
- **Port:** remove the parameter and `_performance_history_section`.

---

## 12. Clip length presets (`clip_duration.py`)

| Preset | min | max | ideal min | ideal max | UI label |
|---|---|---|---|---|---|
| `auto` | 15 | 60 | 25 | 50 | Auto length |
| `short` | 15 | 30 | 18 | 25 | Short (15–30s) |
| `medium` | 30 | 60 | 35 | 55 | Medium (30–60s) |
| `long` | 60 | 120 | 75 | 110 | Long (1–2 min) |

- **Validation:** `validate_clip_length` raises for anything that is not one of these four strings; the API returns 422 (`tasks.py:468`). `normalize_clip_length` turns stored bad values into `auto`.
- **Where presets are used:**
  - Both prompts, validation and repair.
  - Render cap: `max_clip_seconds = preset.maximum` (`task_service.py:551`, `clip_service.py:239`).
  - Fallback length.
  - Analysis cache key: auto uses the source key; other presets use `sha256(key|length:{preset})` (`task_service.py:76-86`). The source key is `sha256(source_type|processing_mode|windowed-rerank-v6|url[|q720])`.
- **Frontend:** `frontend/src/lib/clip-duration.ts`, `home-app.tsx:97-509`, `messages/en/home.json:120-129`. The user default is stored in `users.default_clip_length`.
- **Invariant (tested):** `ideal_maximum <= maximum - 5`, which leaves room to finish a sentence.

---

## 13. Assessment: port `ai.py` to TypeScript, or call it from Python

### 13.1 Option A: port to TS with `@anthropic-ai/sdk` structured outputs (recommended)

**Size:**
- In-scope logic is about 700 lines of Python: prompts (copied verbatim), 3 schemas, parsing, snap, repair, grounding, dedup, rerank, rescale, windowing, sanitising, retry. Expect about 600-800 lines of TS.
- Add about 250 lines for AssemblyAI over REST (upload, submit, poll) plus `format_transcript_for_analysis`, `_join_transcript_tokens`, and the cache-JSON writer.
- The clip-signals heuristics are about 60 lines. The audio-peak part needs ffmpeg, either through a Node `spawn` or a Python engine subcommand.

**Effort:** about 2-3 developer days, including porting the existing tests as golden vectors:
- `test_ai_windowed_selection.py` (338 lines)
- `test_ai_retry.py`
- `test_ai_grounding.py`
- `test_ai_prompt.py`
- `test_clip_duration.py`
- `test_assemblyai_polling.py`

**Shape of the call:**
- `client.beta.messages.create({ model: "claude-opus-5", max_tokens: 16000, system, messages: [{role: "user", content: prompt}], output_config: { format: { type: "json_schema", schema } }, betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" })`.
- Validate the result with zod `safeParse` using defaults and **clamps**, rather than `zodOutputFormat` with `.min` / `.max`. The SDK moves those constraints client-side, where they would fail the parse; today pydantic retries the model instead, which costs tokens.
- Read the JSON from the `text` blocks. With fallbacks on, `content` can also contain `fallback` blocks, so never assume `content[0]`.

**Risks and gotchas (all manageable):**

1. **Python semantics to match exactly:**
   - `\w` in `sanitize_hook_title` is Unicode in Python; in JS use `/#[\p{L}\p{N}_]+/gu`.
   - `\d` in timestamp regexes is Unicode in Python; harmless in practice.
   - `str.split()` with no argument; JS needs `trim().split(/\s+/)`.
   - `str.strip(chars)` / `rstrip(chars)` take a character set.
   - `min()` over tuples breaks ties element by element.
   - Stable sort with `reverse=True`; JS `sort` is stable since ES2019.
   - `int()` truncation in `_rescale_virality`; values are non-negative, so `Math.trunc` matches.
   - `seconds_to_mmss` uses `round()`, which is banker's rounding.
2. **Stop reasons:**
   - `stop_reason === "refusal"` (after fallbacks) or `"max_tokens"` means the JSON is not schema-valid. Treat it as an output failure: retry once at most, never as a transient error.
   - Map transient errors to the same status set plus `APIConnectionError` / `APIConnectionTimeoutError`.
   - Set the SDK's `maxRetries` deliberately; the SDK retries are on top of the 3-attempt loop.
3. **Timeouts:** reproduce the 600 s per-call, 1800 s all-windows and 240 s rerank budgets with `AbortController` plus `Promise.race`, and support cancellation (the task cancel flow). Run this in the local worker, not in a Vercel function: a long video can take up to 30 minutes.
4. **Optional fields:** they are optional in the strict schema, so apply every default client-side, including `virality` defaults that sum to 60.
5. **Tuning risk:** the prompts move over verbatim and the request shape is the same as today (`output_config` json_schema, no tools, `max_tokens` 16000, fallbacks), so model behaviour should not change.

### 13.2 Option B: keep `ai.py` and call it from the Python engine CLI

**Cost:** a thin CLI, about 50 lines (`analyze --transcript f --signals f --clip-length x` printing JSON).

**Drawbacks:**
- It drags along pydantic-ai, the multi-provider code, and `config.py` / `runtime_settings.py`. Those import sqlalchemy and cryptography and read a Postgres `app_settings` cache; in a CLI the cache is empty, so keys would come only from env vars.
- The Claude key saved through the settings UI in Mongo would have to be passed into the Python process environment on every call.
- Retry and cancellation would cross a process boundary.
- The Python engine would need network LLM keys, which goes against "media-only engine".

### 13.3 Verdict

Choose Option A. Every function in the AI layer is either pure logic or a single HTTP call, and the existing tests give exact vectors to port against. Transcription should move to TS as well (AssemblyAI REST), with ffmpeg audio extraction and audio peaks either spawned from Node or run as a small engine command. The one hard contract between the TS worker and the Python engine is the `.transcript_cache.json` file from section 4.4 (version 2, integer milliseconds, `speaker` and `language_code` fields, saved next to the source video). If it matches, all of the Python caption, timeline, cleanup and speaker-framing code runs unchanged.

### 13.4 Can be deleted

- B-roll agent and prompt (675-770)
- Performance context
- OpenRouter, Google, OpenAI and Ollama model builders
- Agent signature caching
- `get_most_relevant_parts_sync`
- Whisper and YouTube-caption providers
- `social_caption_service.py` (it has its own pydantic-ai Haiku agent)