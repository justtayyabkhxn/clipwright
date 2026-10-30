# Clip editor subsystem map (The original app → Clipwright port)

All paths are relative to `C:\other-projects\original-app`. Every line number below was checked against the source.

---

## 0. Key facts that shape the port

1. **Editor drafts are not stored in Postgres.** No migration creates an editor-drafts table. Drafts, the asset state and the editor's export jobs are JSON files in one directory per clip, `{TEMP_DIR}/editor/{sha256(task_id:clip_id:filename)}/` (`backend/src/editor_document.py:113-116`). Optimistic concurrency uses a `fcntl.flock` file lock plus a revision number (`editor_document.py:129-157`).
2. **Two separate export job systems exist:**
   - **Editor exports** (`/editor/exports`) render the edit document from the editor's own uncaptioned source. The job state is a file, `job-{id}.json`, in the editor directory.
   - **Preset clip exports** (`/clips/{id}/exports`) re-encode the already-rendered clip to a platform preset. They use the Postgres table `clip_exports` (`backend/src/migrations/sql/20261025_0001_clip_exports.sql`).
3. **The legacy edit endpoints are not called by the web frontend.** Trim, split, merge, captions and regenerate in `tasks.py` have no callers anywhere in `frontend/src` (grep confirmed). The MCP server calls only `GET .../export` (`mcp/src/original-app_mcp/server.py:701`). The editor's segments and words replace those endpoints without touching the generated clip; a "combine" job is the only editor action that adds a clip row.
4. **Windows blockers in the current Python code:**
   - `import fcntl` at module level in `editor_document.py:12` and `media_storage.py:13`. Both modules fail to import on Windows.
   - `run_render` only adds `-progress` when `Path(command[0]).name == "ffmpeg"` (`editor_document.py:259`). If the binary is called `ffmpeg.exe`, the flags are skipped and progress stays at 0%.
   - `combine_editor` calls `symlink_to` (`editor_service.py:663`), which needs admin rights or Developer Mode on Windows.
5. **Preview and browser export run entirely in the browser** (canvas plus `mediabunny`). Only "background" export and combine use ffmpeg on the server.

---

## 1. Edit document model (every field)

Python is the source of truth: `backend/src/editor_document.py:23-110`. The Pydantic models use `extra="forbid", allow_inf_nan=False` (line 24). The TS mirror is `frontend/src/lib/editor/document.ts:1-71`.

### `EditDocument` (editor_document.py:89-110)
| Field | Type / constraint | Default |
|---|---|---|
| `version` | `Literal[1]` | 1 |
| `segments` | `list[Segment]`, 1–100 items | required |
| `words` | `list[Word]`, at most 5000 | `[]` |
| `captions` | `CaptionStyle` | defaults below |
| `framing` | `Framing` | defaults below |
| `effects` | `Effects` | defaults below |
| `volume` | float 0–2 | 1 |
| `muted` | bool | false |
| `hookTitle` | str, max 200 | `""` (optional in TS) |

`validate_duration(duration)` (lines 101-110) rejects these cases:
- any segment or word end greater than `duration + 0.05`: "An edit extends past the original clip" / "A caption extends past the original clip";
- duplicate segment IDs or duplicate word IDs: "Editor item IDs must be unique".

### `Segment` (27-36)
- `id` is a string of 1–100 characters.
- `start` must be ≥ 0 and `end` > 0.
- `end - start` must be ≥ 0.04 ("at least one frame long").
- Times are in **source (clean.mp4) seconds**.
- Segment order is the playback order. Segments can be reordered and duplicated, and the same source range can appear twice.

### `Word` (39-50)
- `id` is a string of 1–100 characters.
- `start` must be ≥ 0, `end` > 0, and `end` > `start`.
- `text` is at most 120 characters.
- `highlight` is a bool (emphasis colour), default false.
- Times are in source (clean.mp4) seconds.

### `CaptionStyle` (53-70)
| Field | Constraint | Default |
|---|---|---|
| `enabled` | bool | true |
| `font` | `"TikTokSans-Regular" \| "TikTokSans-Bold" \| "Poppins-ExtraBold" \| "THEBOLDFONT"` | `Poppins-ExtraBold` |
| `size` | int 20–132, in 1080-wide units | 54 |
| `color` | `#RRGGBB` | `#FFFFFF` |
| `accent` | `#RRGGBB` | `#FACC15` |
| `y` | float 0.1–0.9 (caption centre as a fraction of height) | 0.78 |
| `background` | bool | true |
| `wordsPerLine` | int 1–8 | 4 |
| `karaoke` | bool (accent on the spoken word) | false (optional in TS) |
| `uppercase` | bool | false (optional in TS) |
| `template` | str 1–50 (caption template id) | `"default"` (optional in TS) |

### `Framing` (73-78): the reframe / layout options
| Field | Values | Default |
|---|---|---|
| `aspect` | `"vertical"` (1080×1920), `"square"` (1080×1080), `"original"` (source size, longest side capped at 1920, even dimensions) | `vertical` |
| `fit` | `"cover"` \| `"contain"` | `cover` |
| `zoom` | 1–3 | 1 |
| `x`, `y` | 0–1, a normalized anchor for both the crop offset and the letterbox offset | 0.5 |

### `Effects` (81-86)
| Field | Range | Default |
|---|---|---|
| `brightness` | 40–180 (%) | 100 |
| `contrast` | 40–180 (%) | 100 |
| `saturation` | 0–220 (%) | 100 |
| `blur` | 0–8 (px at 1080 width) | 0 |
| `hue` | -180–180 (degrees) | 0 |

The TS `DEFAULT_EFFECTS` constant is at `document.ts:93-99`.

### Editor state returned by GET (TS `EditorState`, document.ts:78-92)

```
status: "unprepared"|"preparing"|"ready"|"failed"
basis: string                      // clip.filename; changes when the clip file is rewritten
error?: string
duration, width, height, fps: number
hasAudio: boolean
waveform: number[]                 // 160 peak values 0..1
draft: { revision: number; document: EditDocument }
original: EditDocument             // the document as first prepared ("Restore original")
jobs: ExportJob[]                  // {id, status: queued|rendering|completed|failed|cancelled, progress, error?, clip_id?}
captionLooks?: Record<templateId, CaptionLook>
```

`CaptionLook` (document.ts:33-45) is built by `caption_looks()` in `editor_service.py:329-350`:

```
animation: none|karaoke|pop|fade|bounce
wordPop, wordBox: bool
wordBoxColor, highlightColor, emphasisColor, strokeColor, backgroundColor: string|null
strokeWidth: int
shadow, glow: bool
```

The look is built from `CAPTION_TEMPLATES` (`backend/src/caption_templates.py:22-160`; template ids are `default, hormozi, mrbeast, minimal, tiktok, neon, podcast`). `get_template` (line 208) merges a template over `TEMPLATE_DEFAULTS`.

### Pure document helpers (already TypeScript; keep as is)
All in `frontend/src/lib/editor/document.ts`:
- `editDuration` (102): sum of segment lengths.
- `timecode` (104).
- `uid` (106): `crypto.randomUUID`.
- `outputSize` (107-115): mirrors Python `output_size`, `editor_document.py:160-166`.
- `frameRect` (116-134): cover uses max(scale), contain uses min(scale); the result is multiplied by zoom, rounded to even numbers and placed at `(W-w)*x, (H-h)*y`.
- `mappedWords` (135-153): mirrors Python `mapped_words`, `editor_document.py:169-185`. It projects source-time words through each segment in order onto the output timeline, clips each word to the segment and drops empty text.
- `captionGroups` (155-160): fixed-size chunks of `wordsPerLine`.
- `activeWordIndex` (162-166).
- `outputTime` (167-179).
- `splitSegment` (180-196): splits at `at` when both halves are ≥ 0.04 s; the new half gets a new uid.
- `replaceWords(words, text, duration)` (198-254): an LCS diff that keeps the timing of unchanged words and spreads inserted words evenly over the replaced span. It throws "Edit this long transcript one word at a time." when `rows*cols > 1_000_000`.

---

## 2. Draft lifecycle: create, save, autosave, versioning

### 2.1 Prepare (creation)
**Route:** `POST /tasks/{task_id}/clips/{clip_id}/editor/prepare` → 202 (`backend/src/api/routes/editor.py:80-103`).
- It holds the directory lock. If the status is already `ready` or `preparing` it returns `{"status": ...}`.
- Otherwise it writes `asset.json = {"status":"preparing"}`, enqueues the ARQ job `prepare_editor(task_id, clip_id, filename)` and returns `{"status":"preparing"}`.
- If the enqueue fails it writes `{"status":"failed","error":"The rendering worker is unavailable. Try again shortly."}` and returns 503.

**Worker:** `prepare_editor` (`backend/src/services/editor_service.py:353-518`).
1. Restore the editor directory from S3 (`MediaStorage.restore_editor`). Load the clip and task, and check that `clip.filename == filename`; otherwise fail with "The original clip changed. Reopen the editor."
2. Read the clip's source ranges with `_get_clip_source_ranges` (`clip_service.py:655-664`). They come from the `{clip}.source_map.json` sidecar, falling back to `[(start_time, end_time)]` parsed from mm:ss.
3. Resolve the source video:
   - processing cache entry (`_build_cache_key(url, type, mode, download_quality)`);
   - else a YouTube download of only the needed ranges;
   - else a Twitch/Kick section download;
   - else the local upload.
   - If none works, fail with "The original source is unavailable...".
   - Then `prepare_source()` and `local_ranges_for()` (`youtube_source.py:362`).
4. Render an **uncaptioned, uncropped** trim to `clean.mp4` with `create_optimized_clip(source, first_start, last_end, clean, add_subtitles=False, output_format="original", keep_ranges=local_ranges, hook_title=None, extend_to_sentence=False)` (lines 424-435; `video_utils.py:257`).
5. If the task's `output_format` is `vertical` or `vertical_split`, run `bake_editor_layout()` (lines 279-304). It composites a **split / stack / reaction / overlap** layout into `clean.mp4` (`PRESERVED_LAYOUT_KINDS`, line 203).
   - Detection uses `detect_speaker_reframe_plan(clip,"vertical_split")` and `describe_vertical_layout(...)`.
   - Rendering uses `render_reframed_clip_ffmpeg` (`media/reframing.py:576, 1250, 1441`).
   - Diarized speaker turns are loaded only when `SPEAKER_FRAMING` is on (`config.py:261`).
   - Other clips keep the plain trim, and the editor's `Framing` does the crop.
6. `make_assets(directory)` (lines 62-140) does three things:
   - `ffprobe -show_streams -show_format -of json` reads width, height, fps (`avg_frame_rate`), duration and hasAudio.
   - **Waveform:** `ffmpeg -i clean.mp4 -vn -ac 1 -ar 8000 -f f32le -` is split into 160 chunks; each value is the chunk's max |sample|, rounded to 4 decimals.
   - **Thumbnail sprite:** `ffmpeg -y -i clean.mp4 -vf "fps={12/duration},scale=160:90:force_original_aspect_ratio=decrease,pad=160:90:(ow-iw)/2:(oh-ih)/2,tile=12x1" -frames:v 1 thumbnails.jpg` (one 1920×90 jpg).
   - It returns `{status:"ready", width, height, fps, duration, hasAudio, waveform}`.
7. Build the words:
   - Load the cached transcript with `load_cached_transcript_data(source)` and get `get_words_for_keep_ranges(transcript, local_ranges)`.
   - `_caption_words_with_timings(clip.text.split(), timed, duration)` (`clip_editor.py:318-362`): with equal word counts, edited text takes the source timings 1:1; otherwise words are spread evenly over the spoken span; with no transcript they are spread evenly over the duration.
   - `generated_emphasis(words, task)` (lines 184-199) calls `annotate_caption_words` to seed `highlight` on power words.
8. Initial document (lines 466-494):

```
segments: [{id:"original", start:0, end:duration}]
framing.aspect: "original" if output_format=="original" else "vertical"
captions: initial_caption_style(task, caption_settings, add_subtitles, clip_w, clip_h)
hookTitle: clip.hook_title[:200]
words: [{id:"word-{i}", start, end (clamped to duration), text[:120], highlight: i in emphasis}]
```

   - `clip_w, clip_h` is 1080×1920 unless the format is original (lines 463-465).
   - `initial_caption_style` (lines 146-181) reproduces the generation renderer's caption look:
     - `font_px = get_scaled_font_size(base, width)` (`media/captions.py:44-51`, which is `round(base*w/560)` clamped to 26..132);
     - `size = font_px*1080/width` clamped to 20..132;
     - `y = get_safe_vertical_position(h, font_px*1.5, position_y)/h` (`captions.py:60-69`);
     - `accent` = template highlight colour;
     - `background` = template background && background_color;
     - `karaoke` = whether the template animation is karaoke;
     - `font` falls back to the template font, then `TikTokSans-Regular` when not in `EDITOR_FONTS`.
9. Under the lock: if `draft.json` does not exist yet, write `draft.json = {"revision":0,"document":initial}` and `original.json = initial`. Then write `asset.json = metadata`. An existing draft is never overwritten.
10. On any exception: `asset.json = {"status":"failed","error":"Could not prepare the source video. Check that the source is available, then retry."}`.
11. In `finally`: clean up any downloaded source and run `storage.save_editor(directory)` (S3 snapshot).

ARQ settings: default worker `max_tries=3`, `job_timeout=10800`, `max_jobs=4`, queue `original-app_tasks` (`backend/src/workers/tasks.py:198-246`).

### 2.2 Read
**Route:** `GET /tasks/{task_id}/clips/{clip_id}/editor` (`editor.py:59-77`).
- Owner-only check (`_require_task_owner`, `tasks.py:329-338`). The clip must belong to the task.
- `read_state(directory)` (`editor_service.py:51-59`):
  - if `asset.json` is missing → `{"status":"unprepared"}`;
  - if ready → asset fields + `draft` (draft.json) + `original` (original.json).
- On ready it also runs `upgrade_document()` on both draft and original **at read time** (`editor_service.py:307-326`; nothing is persisted). This fills `captions.template/karaoke/uppercase` from the template and `hookTitle` from `clip.hook_title` when old drafts lack them. It also adds `captionLooks`.
- It always adds `basis = clip.filename` and `jobs` = the 20 newest `job-*.json` files by mtime, each `{id, ...status}`.

### 2.3 Save (versioned, optimistic)
**Route:** `PATCH /tasks/{task_id}/clips/{clip_id}/editor` (`editor.py:106-152`).
- Body: `{basis: string, revision: int>=0 (not bool), document: EditDocument}`.
- 409 "The original clip changed. Reopen the editor." if `basis != clip.filename`.
- 409 "Wait for the editor preview to finish preparing" if the status is not ready.
- 400 on validation errors.
- `save_document(dir, doc, revision, duration)` (`editor_document.py:144-157`):
  - validates the duration;
  - takes the lock and compares `revision` with the stored `draft.json.revision`;
  - on mismatch → `RevisionConflict` → **409** "This clip was edited in another tab. Reload the saved draft before continuing.";
  - otherwise atomically writes `{"revision": revision+1, "document": ...}` (`atomic_json` = temp file + `os.replace`, lines 119-126).
- Response: `{revision, document}`.
- After saving it uploads JSON-only to S3, non-blocking.
- **There is no version history server-side.** Only the latest revision is kept, plus `original.json` from prepare.

**Basis invalidation:** when legacy trim/split/captions/regenerate/settings rewrite a clip's file, `clip_repo.update_clip` → `queue_clip_delete` (`backend/src/repositories/media_repository.py:57-63`) queues deletion of the old editor directory, and the new filename hashes to a new, empty directory. **Rewriting a clip loses its draft.**

### 2.4 Client: autosave, local cache, recovery
All in `frontend/src/components/editor/use-editor.ts`.
- `editorRequest(url, method, body)` (6-28): JSON fetch with `cache:"no-store"`; throws an `Error` built from the parsed API error.

**Load (162-232):**
- GET the editor state.
- If `unprepared` → POST `/prepare`, then poll every 1.5 s.
- If `preparing` → poll every 1.5 s.
- If `failed` → set the error.
- If `ready` → set `revision` and `saved` (JSON of the server draft).

**localStorage recovery** uses key `original-app-editor:${endpoint}` with value `{basis, revision, saved, history}` (46-66):
- If the cache's basis matches and `history.present.version===1`:
  - if the local revision equals the server revision, or the local present equals the server draft → use the local history (keeps undo stack across reloads);
  - else if the local present is unsaved → keep the local history, set `revision=local.revision`, and set a conflict error ("A newer draft exists on the server...").
- Status becomes "Recovered local draft" when present differs from saved.

**Autosave (233-237):**
- A 700 ms debounce after each `history` change calls `save()`.
- Autosave is **suspended while `error` is set**.

**`save()` (119-161):**
- A serialized drain loop: it waits for any in-flight save and loops until `present === saved`.
- Each pass PATCHes `{basis, revision, document}` and updates `revision` from the response.
- On failure the status becomes "Save failed · draft kept locally" and the error is rethrown.
- This behaviour is pinned by `use-editor.test.tsx:7-54` (overlapping saves send revisions 0 then 1).

**Other client behaviour:**
- `beforeunload` warns while unsaved (238-248).
- `reload()` (249-263) discards local history and loads the server draft.
- Status strings ("Preparing preview…", "All changes saved", "Unsaved changes", "Saving…", "Save failed · draft kept locally", "Recovered local draft") are mapped to i18n keys in `components/editor/studio-ui.tsx:191-236`. English copy lives in `frontend/messages/en/editor.json`.

**Workspace actions** (`components/editor/editor-workspace.tsx`):
- Switching clips calls `save()` first and aborts on failure (103-112).
- "Restore original" = `editor.update(() => structuredClone(asset.original))`, which is undoable (670-677).
- On error the user can: retry save, download a backup (`original-app-draft-{clipId}.json`), or "Reload saved" (356-411).
- If no document has loaded, "Retry preparation" POSTs `/prepare` and reloads the page.

---

## 3. Undo / redo
`use-editor.ts:29-118`, entirely client-side React state, also saved to localStorage.
- `History = {past: EditDocument[], present, future}`.
- `update(change, group="")` (78-98):
  - applies `change(present)`;
  - a no-op is detected by comparing `JSON.stringify` and ignored;
  - **coalesces** when the group equals the last group and less than 700 ms has passed (`past` is not pushed);
  - otherwise pushes `present` onto `past`, capped at **50** (`.slice(-50)`);
  - clears `future`.
- `undo` and `redo` (99-118) move between stacks and reset the coalescing group.
- Groups in use:
  - `"trim"` (`timeline.tsx:66`);
  - `"drag-caption"`, `"drag-frame"` (`preview.tsx:313, 341`);
  - `"caption-style"` (`inspector.tsx:129`);
  - `"hook-title"`, `"script"`, `word-${id}`, `timing-${id}`, `"zoom"`, `"position"`, `"volume"`, and each effect key (`inspector.tsx`).
- Shortcuts (`editor-workspace.tsx:170-271`; disabled inside inputs, dialogs, sliders, listboxes, and for keys that tabs, radios and switches own):

| Keys | Action |
|---|---|
| mod+Z | undo |
| mod+shift+Z or mod+Y | redo |
| mod+S | save |
| Space | play / pause (clicks the button) |
| ← / → | step 1/fps |
| shift+← / → | step 1 s |
| I | set in point |
| O | set out point |
| S | split at playhead |
| ? | help dialog |

---

## 4. Editor UI components (state management, port to TS as is)
- **`frontend/src/app/tasks/[id]/edit/page.tsx` (1-94):**
  - loads `GET /api/tasks/{id}`; if completed, loads `GET /api/tasks/{id}/clips`;
  - selects `?clip=` or the first clip and renders `EditorWorkspace` keyed by `${id}:${clip.id}`;
  - shows a "processing/empty" screen until the task is completed;
  - clip selection updates the URL with `history.replaceState`.
- **Entry points:** `/tasks/{id}/edit` (`app/tasks/[id]/page.tsx:768`) and `/tasks/{id}/edit?clip={id}` (`components/app/clip-wall.tsx:93, 205`).
- **`ClipSummary`** fields (`export-panel.tsx:39-46`): `id, filename, clip_order, duration, text, video_url`.
- **Clip rail** (`editor-workspace.tsx:423-543`):
  - thumbnails from `/editor/media/thumbnails.jpg`;
  - checkboxes to choose clips for combine (selection order shown as #n);
  - Combine requires at least 2 selected clips; "Restore original" is here too.
- **Combine flow** (131-169):
  - `save()`, then `readyEditor()` for each selected clip;
  - POST `/api/tasks/{id}/editor/combine {clip_ids}`;
  - poll `GET .../clips/{anchor}/editor/exports/{jobId}` every 1.5 s until `clip_id`, failed or cancelled; give up after 10 min;
  - then `refreshClips(newId)`.
- **"Apply caption style to all clips"** (113-130): for each other clip, `readyEditor(url)` (prepares it if needed and polls up to 10 min, `export-panel.tsx:61-81`), then PATCH `{basis, revision, document: {...draft, captions: style}}`.
- **Preview** (`components/editor/preview.tsx`):
  - a hidden `<video crossOrigin="anonymous" src={endpoint}/media/clean.mp4>` feeds a canvas 640 px tall, with width = aspect × 640;
  - a `requestAnimationFrame` loop calls `drawEditorFrame` (150-200) and handles segment jumps (next segment, loop to segment 0, or pause at the end);
  - volume runs through WebAudio `GainNode`, which allows boost above 1.0 (100-122, 128-136);
  - controls: loop toggle, speed 0.5–2×, frame step ±1/fps;
  - drag on the canvas moves `captions.y` (captions tab, clamped 0.1–0.9) or `framing.x/y` (framing tab) (289-351);
  - a safe-area overlay is inset 8% left/right, 10% top and 20% bottom (352-358);
  - a font load failure shows a hint.
- **Timeline** (`components/editor/timeline.tsx`):
  - zoom 100/200/400%;
  - a thumbnail strip and a 160-bar SVG waveform;
  - the active segment is highlighted and other areas are dimmed; a playhead; click to seek;
  - a two-thumb trim slider with step 1/fps and min gap 0.04 (`setRange`, 52-67);
  - In/Out number inputs and Set In / Set Out from the playhead;
  - split at playhead when more than 0.04 s from both edges;
  - segment chips; move earlier/later (swap); duplicate (new uid); remove (at least 1 must remain).
- **Inspector** (`components/editor/inspector.tsx`), four tabs:
  - **Captions:**
    - enabled switch;
    - three quick looks: `clean` = background off + `#FFFFFF`, `highlight` = on + `#FACC15`, `pop` = on + `#A3E635` (168-206);
    - font select with the 4 fonts; size 20–132; position 10–90%; text and highlight colour pickers;
    - background, karaoke and uppercase switches; words per caption 1–8;
    - Save/Load style in localStorage key `original-app-caption-style` (296-332); "Apply to all clips";
    - **hook title** input, max 200 (352-366);
    - **transcript**: "Edit script" textarea using `replaceWords`; per word: text edit, highlight toggle, delete, start/end number inputs, seek; "Add word" at the playhead lasting 0.5 s (368-617).
  - **Framing:** aspect 9:16 / 1:1 / source; fit fill(cover) / contain; zoom 1–3; horizontal and vertical 0–100%; a "Center" button resets x=y=0.5 and zoom=1 (619-747).
  - **Audio:** volume 0–200%; mute; a boost warning above 100%; a no-audio-track notice (748-783).
  - **Effects:** brightness, contrast, saturation, blur (step 0.1) and hue sliders; Reset sets `DEFAULT_EFFECTS` (784-830).

---

## 5. Preview vs export rendering

### 5.1 Browser preview and browser export (TypeScript, runs on the client)
**`frontend/src/lib/editor/render.ts`, `drawEditorFrame(ctx, doc, sw, sh, time, draw, looks)` (113-139):**
- Draws a black background.
- Applies the CSS filter `brightness(b%) contrast(c%) saturate(s%) blur(blur*W/1080 px) hue-rotate(h deg)` and draws the video at `frameRect`.
- Scales the context to output pixels, so preview and export share every measurement, then draws captions and the hook title.

**Captions (141-265):**
- Look resolution `resolveLook` (80-104) mirrors Python `editor_caption_template`:
  - `karaoke` forces the karaoke animation; otherwise a template karaoke animation becomes `none`;
  - the emphasis colour follows the accent when it was tied to the highlight colour;
  - the background toggle picks `backgroundColor ?? #00000080`.
- Animations use linear keyframes that mirror ASS `\t`:
  - karaoke + wordPop: scale 0.92→1 over 0.14 s;
  - pop: 0.88→1.06→1;
  - bounce: 0.7→1.12→1;
  - fade: alpha over 0.12 s.
- Layout and drawing:
  - text wraps at W−120 px;
  - line height is 1.2 × size;
  - outline width = `max(strokeWidth, round(size*strokeWidth/26))`;
  - shadow offset = `max(2, size/20)`;
  - the active word can get a rounded "word box" pill;
  - colours: active word → accent, highlighted word → emphasis colour, other words → caption colour.
- `setAssFont` (60-66) rescales the font so its ascender+descender height matches libass sizing.
- Fonts load through `FontFace("Editor-{name}", url(/api/fonts/{name}))` (22-39). This needs the proxy route `frontend/src/app/api/fonts/[fontName]/route.ts`, which forwards to backend `GET /fonts/{name}`.

**Hook title (285-369):**
- Visible from 0.12 s to `min(4, max(1.5, dur-0.25))`; for clips of 1.5 s or less, from 0 to `max(0.5, dur)`.
- Fades in over 0.16 s and out over 0.24 s; pops 0.9→1 when wordPop is on.
- One line, or two lines balanced around the middle (`balanceTitle`).
- Font size = `clamp(floor(captionPx*0.82), 34, 66)`, shrunk to fit and never below 30.
- Top margin = `max(48, 7% of height)`.
- Drawn as a box when the template has no outline but has a background colour; otherwise outlined.
- Words containing digits are drawn in the emphasis colour.

**Browser export** (`frontend/src/lib/editor/export-draft.ts:10-179`, using the `mediabunny` dependency, `frontend/package.json:38`):
- Fetches the whole of `clean.mp4` as a Blob, which is a large download.
- Checks `canEncodeVideo("avc", {w, h, bitrate})` where bitrate is 12 Mbit/s for reels and 10 Mbit/s otherwise.
- Audio uses AAC, falling back to Opus, at 192 kbit/s.
- For each segment it decodes the video samples, draws them with `drawEditorFrame` onto a `CanvasSource` at the output time, and copies audio samples with the gain applied (`muted ? 0 : volume`).
- Writes MP4 to a `BufferTarget` and downloads it as `original-app-{preset}.mp4`.
- Cancelled through an `AbortSignal`.

### 5.2 Server export (Python render engine) — `render_document(directory, job_id, document, preset)` (editor_document.py:303-410)

1. Input: `clean.mp4`. `sw, sh` come from `_ffprobe_size` (`clip_editor.py:70-76` → `media/ffmpeg.py:221`, which accounts for display rotation).
2. `W, H = output_size(doc, sw, sh)` (lines 160-166).
3. **Geometry** (lines 311-317):
   - `scale = (max if cover else min)(W/sw, H/sh) * zoom`; `rw, rh` = `sw*scale`, `sh*scale` rounded to even numbers (min 2);
   - `cw = min(W, rw)`, `ch = min(H, rh)`;
   - filter: `scale={rw}:{rh},crop={cw}:{ch}:{(rw-cw)*x}:{(rh-ch)*y},pad={W}:{H}:{(W-cw)*x}:{(H-ch)*y}:black,setsar=1`.
4. **Effects** (lines 318-323):
   - `gain = b/100 * c/100`, `offset = 128*(1-c/100)`;
   - `lutrgb=r='clip(val*{gain}+{offset},0,255)':g=...:b=...,hue=h={hue}:s={sat/100}`;
   - plus `,gblur=sigma={blur*W/1080}` when blur > 0.
5. Audio probe: `ffprobe -v error -select_streams a:0 -show_entries stream=index -of csv=p=0`.
6. Filter graph (lines 342-363):
   - per segment i: `[0:v]trim=start=S:end=E,setpts=PTS-STARTPTS[v{i}]` and, if there is audio, `[0:a]atrim=start=S:end=E,asetpts=PTS-STARTPTS[a{i}]`;
   - join: `{joins}concat=n={N}:v=1:a={0|1}[video][audio]`;
   - output: `[video]{geometry},{effects},ass={captions-{job}.ass}:fontsdir={fontsdir}[outv]`;
   - audio: `[audio]volume={0 if muted else volume}[outa]`.
7. **ASS file**: `write_ass()` (lines 215-246) calls the generation renderer `build_assemblyai_ass_subtitles` (`media/captions.py:337-375`) with:
   - `clip_start=0`, `clip_end=Σ segment lengths`, `W, H`, `font_family=style.font`;
   - `caption_words=mapped_words(doc)` when captions are enabled, else `[]`; `include_captions=style.enabled`;
   - `template_override=editor_caption_template(style)` (lines 188-212);
   - `font_px_override=round(size*W/1080)`, `center_y_override=round(y*H)`;
   - `emphasis_indices` = indexes of highlighted words; `wrap_lines=True`;
   - `hook_title=doc.hookTitle or None`.
   - If nothing is written, an empty valid `[Script Info]`/`[Events]` ASS is written instead.
   - `fontsdir = ass_fonts_dir(font)` (`captions.py:180-186`), defaulting to `Path('fonts')`.
   - Paths are escaped with `ffmpeg_escape_filter_value` (`media/ffmpeg.py:285-300`), which already handles Windows drive colons.
8. Command (lines 370-398):

```
ffmpeg -y -i clean.mp4 -filter_complex "<graph>" -map [outv] [-map [outa] -c:a aac -b:a 192k]
  -c:v libx264 -preset fast -crf 18 -maxrate {12M if preset=="reels" else 10M} -bufsize 24M
  -pix_fmt yuv420p -movflags +faststart .export-{job}.mp4
```

   On success the temp file is renamed to `export-{job}.mp4`. **The preset only changes maxrate**; resolution comes from `framing.aspect`.
9. `run_render(command, dir, job, duration)` (lines 249-300):
   - inserts `-progress progress-{job}.txt -nostats` after `ffmpeg`;
   - polls every 0.25 s and parses `out_time_us` → percent, capped at 99;
   - writes `job-{job}.json = {"status":"rendering","progress":p}`;
   - checks for the `cancel-{job}` file and raises `InterruptedError`;
   - on exit code ≠ 0: "Video rendering failed: " + the last 1500 characters of stderr;
   - always terminates (then kills) the child and deletes the progress and log files.

### 5.3 Combine — `combine_editor` (editor_service.py:567-756)
1. Reads `request-{job}.json.inputs`. Each input is `{id, filename, document (upgraded), state:{width, height, hasAudio}, ranges}`.
2. Output size = the first input's width × height scaled so the longest side is at most 1920, with even dimensions.
3. **Pass 1** (lines 594-659): for each input i and segment j:
   - video: `[i:v]trim=start:end,setpts=PTS-STARTPTS,scale=W:H:force_original_aspect_ratio=decrease,pad=W:H:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30[v{i}_{j}]`;
   - audio: `[i:a]atrim=...,asetpts=PTS-STARTPTS,aresample=48000,aformat=channel_layouts=stereo[a{i}_{j}]`, or `anullsrc=r=48000:cl=stereo,atrim=duration=D` when the input has no audio;
   - join with `concat=n=K:v=1:a=1[v][a]`, encoded with `-c:v libx264 -preset fast -crf 18 -c:a aac -movflags +faststart work/clean.mp4` through `run_render`.
   - Words are remapped with `mapped_words` plus a running offset and get new IDs. Source ranges are accumulated with `slice_source_ranges` (`clip_source_map.py:161-192`).
4. **Pass 2:** `render_document(work, job, combinedDoc, "tiktok")`. The combined document is the first input's document with `segments=[{id:"combined", 0, total}]`, all words, and `hookTitle=""`.
5. `cap_export_for_plan` downscales for Pro plans (billing; drop in the port).
6. Copies the result to `{TEMP_DIR}/clips/combined_{uuid}.mp4`, saves the source map, runs `make_assets(work)`, and copies the export to the anchor directory as `export-{job}.mp4`.
7. Creates the new clip's editor directory with `clean.mp4`, `thumbnails.jpg`, draft revision 0, an `original.json` equal to the document, and `asset.json`.
8. DB, under `task_edit_transaction` (row lock; checks that every input's id and filename is unchanged), creates the clip:
   - `start "00:00"`, `end mm:ss(total)`, `duration`;
   - `text` = the joined words;
   - `relevance 0`, `reasoning "Combined in the clip editor"`;
   - `clip_order = max+1`, then reorder.
9. Job result: `{"status":"completed","progress":100,"clip_id":newId}`. Inputs and their drafts are left unchanged.
10. If the job does not commit, the staged files are queued for deletion.

---

## 6. Export presets (platforms and resolutions)
- **Backend** `EXPORT_PRESETS` (`backend/src/clip_editor.py:27-40`):

| Preset | Size | Video bitrate | Audio |
|---|---|---|---|
| `tiktok` | 1080×1920 | 10M | 192k |
| `reels` | 1080×1920 | 12M | 192k |
| `shorts` | 1080×1920 | 10M | 192k |

- **Frontend copy:** `EXPORT_PRESETS` in `frontend/src/lib/clip-actions.ts:3-7` (id, label, width, height, bitrate). The task page select adds `"original"`, which is a direct file download with `?download=true` (`app/tasks/[id]/page.tsx:156, 568-580, 822-827`).
- **Preset encode** `export_with_preset` (`clip_editor.py:457-517`):

```
ffmpeg -y -i clip.mp4 -vf "[fps=60,]scale=1080:1920:force_original_aspect_ratio=decrease:flags=lanczos,pad=1080:1920:(ow-iw)/2:(oh-ih)/2,setsar=1"
  -c:v libx264 -preset slow -crf 18 -maxrate {br} -bufsize {2*br} -pix_fmt yuv420p -profile:v high
  -c:a aac -b:a 192k -ar 48000 -movflags +faststart out.mp4
```

  - The `fps=60` prefix is added only when the source exceeds `MAX_OUTPUT_FPS + FPS_EPSILON` (`media/source_limits.py:29-31`).
  - The queued version adds `-progress pipe:1 -nostats` and parses `out_time=HH:MM:SS.xx` (`_export_with_progress`, lines 384-454; `should_stop` raises `ExportCancelled`).
- **In the editor**, the preset only selects maxrate on the server or the bitrate in the browser; the estimated size shown is `bitrate_Mbps*duration/8` MB (`export-panel.tsx:218-235`).

---

## 7. Job / progress models

### 7.1 Editor export / combine jobs (files, `editor.py` + `editor_service.py`)
- **Files in the editor directory:** `request-{job}.json` (input), `job-{job}.json` (status), `cancel-{job}` (flag), `progress-{job}.txt`, `log-{job}.txt`, `captions-{job}.ass`, `.export-{job}.mp4` → `export-{job}.mp4`.
  - Other files: `asset.json`, `draft.json`, `original.json`, `clean.mp4`, `thumbnails.jpg`, `.lock`, `.sync`, `.s3-manifest`, `.s3-checked`, `.access`, `.media-lease`.
- **Job id:** 32 hex characters (`uuid4().hex`), validated by `^[a-f0-9]{32}$` (`editor.py:50-56`).
- **Statuses:** `queued → rendering → completed | failed | cancelled`.
  - Shape: `{status, progress 0-100, error?, clip_id? (combine)}`.
  - Error text: "Export failed. Your draft is safe; retry the export." (`editor_service.py:555-562`); for combine, "Could not combine drafts. The original clips are unchanged."
- **Limit:** at most 3 queued or rendering jobs per clip directory (429; `editor.py:203-210, 345-354`). Combine counts against the anchor (first selected) clip.
- **Cancel:** creates the `cancel-{job}` file. A queued job is set to cancelled immediately. A rendering job returns `"cancelling"`; the render loop sees the flag and writes cancelled (`editor.py:250-269`).
- **`export_editor` worker** (`editor_service.py:521-564`): restore media, check the clip still exists, read the request, check the cancel flag, `render_document`, `cap_export_for_plan` (billing; drop), persist to S3, write `completed/100`.
- **Client progress:** the export panel polls `GET editor` for each clip every 3 s (`export-panel.tsx:139-161`). There is no SSE.

### 7.2 Preset clip exports (Postgres `clip_exports`)
- **Table** (`20261025_0001_clip_exports.sql:3-37`):

```
id, task_id, clip_id, user_id, preset, options_hash(64), source_file_path,
status ∈ {queued, running, succeeded, failed}, progress 0-100, error_message,
file_path, download_filename, created_at, updated_at, expires_at
```

  - Partial unique index on `(clip_id, options_hash)` where status is queued, running or succeeded (idempotency).
  - Plus indexes on `clip_id`, `task_id`, `expires_at` and stale rows.
- **Repository:** `backend/src/repositories/clip_export_repository.py:21-347`:
  - `pg_advisory_xact_lock` per `clip:hash`;
  - `get_live` with `FOR UPDATE`;
  - `mark_running` (progress ≥ 1);
  - `update_progress` (monotonic, below 100);
  - `touch` (heartbeat);
  - `mark_succeeded`, `mark_failed(statuses)`;
  - `lock_expired SKIP LOCKED`, `purge_failures(days)`, `live_ids`.
- **Service:** `backend/src/services/clip_export_service.py`:
  - `options_hash = sha256({preset, source_file_path})` (60-67), so a regenerated clip gets a new hash;
  - filename `{stem}_{preset}.mp4` (70-78);
  - constants: TTL 7 days, stale after 180 s without a heartbeat, queued cap 1 h, missing-job grace 60 s, job timeout 30 min (35-47);
  - `start_export` (283-345): lock → reap stale → reuse a live or succeeded row if the file is present and not expired → else insert queued and enqueue `export_clip_preset(export_id)` with `_job_id="clip-export:{id}"`; `max_tries=1` (`workers/tasks.py:220-224`);
  - `export_clip_preset` worker (382-471): mark running → check that `clip.file_path` is unchanged → encode into `{TEMP_DIR}/clip-exports/{id}/{id}.mp4` with a progress pump writing every 2 s (474-496) → upload when S3 is on → `mark_succeeded`;
  - `present_export` (258-280): reaps stale rows, marks a missing file as failed, adds `download_url`;
  - `expire_clip_exports` (357-371) runs from the `cleanup_media` cron every 5 minutes (`workers/media_cleanup.py:185-197`).
- **Client:** `frontend/src/lib/clip-export.ts`:
  - `pollClipExport` with backoff `min(5000, 1000*1.5^n)` and a 20-minute limit;
  - `clipExportFilePath`, `triggerFileDownload`;
  - used by `app/tasks/[id]/page.tsx:543-566`.
  - `lib/clip-export-tracking.ts` is analytics only (DataFast / attribution); **drop**.

---

## 8. Endpoint reference (request → response)

The browser always calls `/api/tasks/...`. The catch-all `frontend/src/app/api/tasks/[...path]/route.ts:6-75` checks the session and forwards method, body, Content-Type, Accept, Range and If-Range to the backend `/tasks/...`. It uses `redirect:"manual"` (`server/backend-api.ts:49-87`), so S3 307 responses reach the browser.

### Editor (`backend/src/api/routes/editor.py`; owner-only)
| Method / path | Request | Response |
|---|---|---|
| `GET /tasks/{t}/clips/{c}/editor` | – | `EditorState` (§1) |
| `POST .../editor/prepare` | – | 202 `{status:"preparing"\|"ready"}`; 503 when the worker is down |
| `PATCH .../editor` | `{basis, revision, document}` | `{revision, document}`; 409 basis changed / not ready / revision conflict; 400 invalid |
| `GET .../editor/media/{asset}` | asset ∈ `clean.mp4`, `thumbnails.jpg` | file (`private, no-cache`) or 307 to a signed S3 URL; 404 "Preview not ready" |
| `POST .../editor/exports` | `{basis, preset: tiktok\|reels\|shorts (default tiktok), document}` | 202 `{id, status:"queued", progress:0}`; 409 not ready / basis; 400; 429 (3 active); 503 |
| `GET .../editor/exports/{job}` | – | `{id, status, progress, error?, clip_id?}`; 404 |
| `DELETE .../editor/exports/{job}` | – | `{status: "cancelled" \| "cancelling" \| <current>}` |
| `GET .../editor/exports/{job}/file` | – | mp4 attachment `original-app-{clip[:8]}-{job[:6]}.mp4` or 307; 409 "Export is not ready" |
| `POST /tasks/{t}/editor/combine` | `{clip_ids: string[2..20], distinct}` | 202 `{id, anchor_clip_id}`; 400; 404; 409 a clip is not prepared; 429; 503 |

### Preset exports (`backend/src/api/routes/clip_exports.py`; owner or admin reader)
| Method / path | Request | Response |
|---|---|---|
| `POST /tasks/{t}/clips/{c}/exports` | `?preset=` or JSON `{preset}` | 202 `{id, status, progress, preset, error, download_url}`; 400 invalid preset; 503 |
| `GET .../exports/{e}` | – | the same object; 404 |
| `GET .../exports/{e}/file` | – | mp4 attachment or 307; 409 not ready; 404 file missing |

### Legacy clip edits (`backend/src/api/routes/tasks.py`; owner; each runs inside `serialized_task_edit`, which takes `SELECT ... FOR UPDATE` on `tasks` and rejects with "Wait for processing to finish before editing this task" while queued or processing — `repositories/edit_transaction.py:24-63`)

| Method / path | Request | Response |
|---|---|---|
| `PATCH /tasks/{t}/clips/{c}` (trim, 955-980) | `{start_offset≥0, end_offset≥0}` (finite) | `{clip}` |
| `POST .../clips/{c}/split` (983-1006) | `{split_time>0}` | `{message:"Clip split successfully"}` |
| `POST /tasks/{t}/clips/merge` (1009-1030) | `{clip_ids: string[] (≥2 distinct)}` | `{message, clip_id}` |
| `PATCH .../clips/{c}/captions` (1033-1082) | `{caption_text, position: top\|middle\|bottom, highlight_words[], font_size? 12–72, position_y? 0.1–0.85}` | `{clip}` |
| `POST .../clips/{c}/regenerate` (1085-1109) | `{start_offset, end_offset}` | `{clip, message}` (same as trim) |
| `GET .../clips/{c}/export?preset=` (1189-1237) | – | synchronous encode streamed as `{stem}_{preset}.mp4`, temp file deleted afterwards |
| `POST /tasks/{t}/settings` (1112-1186) | `{font_family?, font_size?, font_color?, caption_template, include_broll?, apply_to_existing, cleanup fields}` | `{task, message}` (used by the task page; regenerates every clip) |
| `DELETE /tasks/{t}/clips/{c}` (873-906) | – | `{message}` |

What the legacy services do (`backend/src/services/clip_service.py`):
- **trim** (289-334): `trim_clip_file` re-encodes from the rendered clip. The command is `ffmpeg -ss S -i in -t D` with `_encode_args` = libx264 slow crf 18 high, aac 256k, faststart (`clip_editor.py:88-157`). Source ranges are recomputed with `trim_source_ranges` and the caption settings sidecar is copied.
- **split** (337-406): `split_clip_file` clamps the split point to [0.2, dur−0.2] and runs two re-encodes. The first clip is updated, a second clip is inserted at `order+1` copying all scores and the hook title, then clips are reordered.
- **merge** (409-473): sorted by `clip_order`, concat demuxer (`-f concat -safe 0`) then re-encode. The first clip is updated with the merged ranges and joined text; the others are deleted.
- **captions** (476-622): re-renders from the **source**:
  1. `create_optimized_clip` with the task's output format, keep ranges and hook title, no subtitles;
  2. `overlay_custom_captions` (`clip_editor.py:234-315`) builds ASS with `position_y`, `highlight_words` and the user's text mapped to transcript timings, burned in with `-vf subtitles=filename=...:fontsdir=...`;
  3. optional `cap_video_short_side`;
  4. saves `caption_settings {font_size, position, position_y, highlight_words}` in the sidecar.
- **Sidecar** `{clip}.source_map.json` = `{version:1, source_ranges:[{start,end}], caption_settings?, broll?}` (`backend/src/clip_source_map.py:19-158`). Range maths: `slice/trim/split_source_ranges` (161-217); ranges shorter than 0.05 s are dropped.

---

## 9. Pure media work (Python engine CLI) vs state management (port to TS)

### Keep in Python, exposed as CLI subcommands with JSON in/out and progress lines on stdout
| Proposed command | Wraps | Inputs → outputs |
|---|---|---|
| `editor-prepare` | `prepare_editor` steps 3–7: source resolve/download, `create_optimized_clip(original, keep_ranges)`, `bake_editor_layout`, `make_assets`, transcript word timing, `generated_emphasis`, `initial_caption_style` (or port its maths) | task/clip settings, source path, ranges → `clean.mp4`, `thumbnails.jpg`, metadata JSON (`width, height, fps, duration, hasAudio, waveform`), initial document JSON |
| `editor-render` | `render_document` + `write_ass` + `editor_caption_template` + `build_assemblyai_ass_subtitles` + `ass_fonts_dir` | `clean.mp4`, document JSON, preset → `export.mp4`, progress % |
| `editor-combine` | `combine_editor` pass 1 (concat filter) + pass 2 `render_document` + `make_assets` | list of (clean.mp4, document, hasAudio, size) → combined `clean.mp4`, `export.mp4`, metadata, combined words |
| `preset-export` | `export_with_preset` | clip.mp4, preset → mp4, progress |
| `clip-trim` / `clip-split` / `clip-merge` / `clip-captions` (if kept) | `trim_clip_file`, `split_clip_file`, `merge_clip_files`, `create_optimized_clip` + `overlay_custom_captions` | files → files |

When wrapping these:
- Remove `fcntl`. Locking becomes the job owner's concern in Mongo.
- Report progress on stdout instead of `job-*.json` files.
- Cancellation becomes "Node kills the process tree" (on Windows `taskkill /T /F`), replacing the `cancel-*` flag files.
- Fix the `ffmpeg.exe` name check and drop the symlink.

### Port to TypeScript (Next API routes + Mongo + Node worker)
- **EditDocument schema** (zod mirror of §1, keeping `extra=forbid`, non-finite rejection and `validate_duration`).
- **`editor_drafts` collection:** `{taskId, clipId, basis(filename), revision, document, original, asset:{status, error?, width, height, fps, duration, hasAudio, waveform}, mediaKeys}`.
  - Save = `findOneAndUpdate({_id, revision}, {$set:{document}, $inc:{revision:1}})`; no match → 409 with the same message.
- **Read-time `upgrade_document`** and **`caption_looks`**. `caption_looks` is static template data, so the caption templates need a shared JSON or TS copy.
- **Jobs** (one Mongo queue for prepare, export, combine and preset-export):
  - statuses, progress, error, `clip_id`;
  - the 3-active limit;
  - `cancelRequested`;
  - heartbeat and stale reaping (see the `clip_exports` rules), TTL / expiry for preset exports, and idempotency `sha256({preset, sourcePath})`.
- **Combine DB step:** create the clip (relevance 0, reasoning text, order max+1, joined text, sliced source ranges) and seed the new clip's draft.
- **Legacy edit DB side:** range maths (`clip_source_map.py`, pure functions), mm:ss formatting (`_seconds_to_mmss`, `clip_service.py:625-630`), clip row updates and reordering. Source ranges and caption settings move onto the clip document instead of the sidecar file.
- **Media serving routes** for `clean.mp4`, `thumbnails.jpg` and export files, through the storage interface. **Range support is required** for `<video>` seeking.
- **All frontend files** (`components/editor/*`, `lib/editor/*`, `lib/clip-export.ts`, the edit page) carry over almost unchanged. Only the URLs and branding change (`original-app-editor:` and `original-app-caption-style` localStorage keys, download filenames `original-app-*.mp4`, `original-app-draft-*.json`).

### Drop
- `cap_export_for_plan` / `cap_video_short_side` (billing-driven 720p cap; `editor_service.py:25-48`).
- S3 manifest sync (`media_storage.py:561-699`; replace with the storage interface).
- B-roll carry-over in the legacy edits.
- `trackClipExport`.
- The admin-reader path in `_require_task_reader`.

---

## 10. Vercel / hosting points to settle
- When clips are on Blob/R2, the preview's `<video crossOrigin="anonymous">` drawn to canvas and the browser export's `fetch(clean.mp4)` both need **CORS headers** on the storage URL, otherwise the canvas is tainted. Today the route either streams the file or 307-redirects to a signed URL.
- Browser export downloads the whole of `clean.mp4` into memory. That is fine on desktop and heavy on mobile.
- The font route `/api/fonts/{name}` must serve the TTFs bundled in `backend/fonts/` so `FontFace` loads in the browser.
- Editor prepare, export and combine must run in the local Node worker plus the Python engine. ffmpeg and libass are not available in Vercel functions. The Next routes only enqueue jobs and read state.