# Frontend map for the Clipwright port (KEEP scope)

All paths are under `C:\other-projects\supoclip\frontend\`. Every fact below was checked in the code. Line numbers refer to the files as they are now.

---

## 1. Pages and routes: KEPT vs DROPPED

### 1a. Inventory of `src/app`

| Route / file | Decision | Notes |
|---|---|---|
| `src/app/layout.tsx` | **KEEP (strip)** | Root layout: fonts, `NextIntlClientProvider`, `TooltipProvider`, `Toaster`. See §3 for what to cut. |
| `src/app/page.tsx` → `components/home-router.tsx` → `components/home-app.tsx` | **KEEP** (create screen) | `page.tsx` is a server page with JSON-LD and SEO metadata (drop that). `HomeRouter` shows `LandingPage` when signed out and `HomeApp` when signed in. Replace the landing page with a redirect to `/sign-in`. |
| `src/app/error.tsx`, `global-error.tsx`, `loading.tsx`, `not-found.tsx` | **KEEP (strip PostHog)** | `loading.tsx` re-exports `PageLoading`. |
| `src/app/sign-in/{layout,page}.tsx` | **KEEP** | `AuthFrame` + `SignIn` |
| `src/app/sign-up/{layout,page}.tsx` | **KEEP** | `AuthFrame` + `SignUp` |
| `src/app/forgot-password/{layout,page}.tsx` | **KEEP? (decision needed)** | Depends on backend email (SES), which is dropped. See §7. |
| `src/app/reset-password/{layout,page}.tsx` | **KEEP? (decision needed)** | Same email dependency. |
| `src/app/list/{layout,page}.tsx` | **KEEP** (library) | The layout wraps the page in `AppShell`. |
| `src/app/tasks/layout.tsx` | **KEEP** | Wraps `/tasks/*` in `AppShell`. |
| `src/app/tasks/[id]/page.tsx` | **KEEP** (task detail) | 1072 lines |
| `src/app/tasks/[id]/edit/page.tsx` | **KEEP** (editor) | |
| `src/app/settings/{layout,page}.tsx` | **KEEP (strip heavily)** | Keep the AI provider and caption defaults sections only. |
| `src/app/share/[token]/page.tsx` + `share/layout.tsx` | **OPTIONAL (trivial)** | 197 lines. Reuses `ClipTile`/`ClipFocus`. One GET for JSON plus a clip-file URL. |
| `src/app/settings/api-keys/page.tsx` | DROP | API keys |
| `src/app/settings/social/page.tsx` | DROP | social |
| `src/app/settings/creator-program/page.tsx` | DROP | affiliate |
| `src/app/analytics/{layout,page}.tsx` | DROP | social analytics |
| `src/app/admin/{layout,page}.tsx`, `admin/announcements/page.tsx` | DROP | The Claude key is configured from Settings, not `/admin` (see §1b). |
| `src/app/affiliate/page.tsx` | DROP | |
| `src/app/[slug]/page.tsx` | DROP | SEO landing pages |
| `src/app/blog/**`, `changelog/page.tsx`, `demo/page.tsx`, `privacy/page.tsx`, `terms/page.tsx` | DROP | marketing and legal |
| `src/app/status/page.tsx` | DROP | Service-status page; reads `prisma.serviceStatus`. |
| `src/app/robots.ts`, `sitemap.ts`, `opengraph-image.tsx`, `twitter-image.tsx` | DROP | SEO |
| `src/app/email/product-updates/unsubscribe/route.ts` | DROP | emails |
| `middleware.ts` (frontend root) | DROP | Only implements `NEXT_PUBLIC_LANDING_ONLY_MODE`. |
| `src/instrumentation-client.ts`, `src/instrumentation.ts` | DROP | PostHog init, `installTraceFetch()`, PostHog server error capture. |

### 1b. Dependencies of each kept page

**Shared chrome: `components/app/app-shell.tsx`**
- What it provides:
  - Desktop sidebar that collapses to an icon rail. It is forced collapsed on `/tasks/*/edit` (L54).
  - Collapse state in localStorage `supoclip.sidebar.collapsed` (L56-62, L190).
  - Mobile header and tab bar.
  - ⌘K command palette and the `N` shortcut for a new generation (L65-81).
  - `RecentProjects`: the last 5 tasks via `fetchGenerations()`, refetched on every pathname change (L201-232).
  - `ProviderIndicator`, built on `useAiProvider` (L235-255).
  - `UserRow` with sign-out (L318-348).
  - `CommandPalette`: static actions plus a search over tasks (L352-444).
- Uses:
  - `hooks/use-ai-provider`, `lib/auth-client` (`signOut`, `useSession`), `lib/generations` (`fetchGenerations`, `timeAgo`), `components/app/status-badge`, `lib/utils`.
  - UI: `dialog`, `tooltip`, `kbd`; `next/image` with `/logo.png`.
- Branding strings to change: `"SupoClip + Claude"` aria-labels at L102 and L160; `BrandWordmark` at L192-198.

**`/` (`components/home-app.tsx`, 892 lines)**
- Components: `AppShell`, `GenerationCard`, `CaptionSizeControl`, `VideoSourceIcon`, `FontSelectOption` (which pulls in `FontLanguageInfo`).
- UI: `button`, `input`, `alert`, `skeleton`, `popover`, `select`, `switch`, `kbd`.
- Libs:
  - `lib/video-upload`: `uploadVideoFile`, `validateVideoSourceUrl`, `getYouTubeThumbnailUrl`, `maxVideoUploadBytes`, `formatUploadLimit`, `FONT_SEARCH_THRESHOLD`.
  - `lib/font-options` (`buildFontOptionsPayload`, `FONT_TEMPLATE_DEFAULT_VALUE`).
  - `lib/generations`, `lib/clip-duration` (`CLIP_LENGTHS` = auto/short/medium/long), `lib/api-error`, `hooks/use-ai-provider`, `lib/utils`.
- Behaviour to keep:
  - Loads `clipLength` from `GET /api/preferences` (L125-144).
  - Saves clip length through a serialized `PATCH /api/preferences {clipLength}` queue (L146-164).
  - Loads fonts and injects an `@font-face` `<style id="custom-fonts">` with `src: url('/api/fonts/<name>')` (L166-192).
  - Loads caption templates (L195-198) and the 8 most recent tasks (L206-211).
  - Font upload `POST /api/fonts/upload` with FormData field `file`; it then selects `data.font.name` (L232-262).
  - Drag-and-drop or picker for a video file (accept `video/*`; extension check mp4/mov/avi/mkv/webm/m4v; size cap) (L213-230).
- Submit (L286-368):
  1. Validate the URL.
  2. For uploads, call `uploadVideoFile()`, which returns `video_path`.
  3. `POST /api/tasks/create` (body in §2).
  4. `window.location.href = /tasks/${task_id}`.
- Pause threshold is clamped to 250-3000 (default 1200). Filtered words are comma-split, trimmed and lowercased.
- Options UI:
  - Clip length popover.
  - Captions popover: on/off switch, template radio list, font select, size, color swatches `#FFFFFF #000000 #FFD700 #FF6B6B #4ECDC4 #45B7D1` plus a custom color, and a live `CaptionPreview`.
  - Framing popover: `vertical | vertical_fit | vertical_pan | vertical_split | original` (L51-53, L619-644).
  - Cleanup popover: cut long pauses, threshold, remove filler words, extra words (L653-688).
- `AiProviderNote` (L762-776) links to `/settings#ai`.

**`/list` (`app/list/page.tsx`)**
- Uses:
  - `GenerationCard`, `PageLoading`, `status-badge` (`ACTIVE_TASK_STATUSES` = queued/processing; `RESUMABLE_TASK_STATUSES` = cancelled/error).
  - `lib/generations.fetchGenerations`, `lib/library-groups.groupByOriginalVideo` (groups by YouTube id, upload URL, or source_id).
  - `lib/api-error`.
  - UI: `button`, `skeleton`, `input`, `kbd`, `alert`, `checkbox`, `separator`, `tooltip`, `alert-dialog`.
- Features:
  - Search, with `/` to focus.
  - Filters: all / ready / active / attention.
  - Sort: newest or by video.
  - Multi-select with a floating batch bar (cancel / resume / delete via parallel per-task fetches).
  - Polls the list every 5s while any task is active, and refreshes on window focus (L127-141).

**`/tasks/[id]` (`app/tasks/[id]/page.tsx`)**
- Uses:
  - `hooks/use-task-progress`, `components/app/clip-wall` (`ClipTile`, `ClipFocus`, `ProcessingPanel`, `EmptyState`), `components/app/status-badge`, `page-state`.
  - `lib/clip-actions` (`getClipUrl`, `requestAction`, `EXPORT_PRESETS` tiktok/reels/shorts), `lib/clip-export` (`pollClipExport`, `clipExportFilePath`, `triggerFileDownload`).
  - `lib/copy-text` (share only), `lib/font-options`, `lib/generations.timeAgo`, `i18n/config.intlLocale`, `video-source-icon`, `font-select-option`, `caption-size-control`.
  - UI: `button`, `input`, `select`, `alert-dialog`, `sheet`, `tooltip`.
- Transitively, `clip-wall` pulls in `dynamic-video-player`, `transcript-preview`, `clip-cover` (`ClipCover`, `ScoreRing`) and `use-ai-provider`.
- Features:
  - Title edit (PATCH).
  - Cancel and resume.
  - "Restyle" sheet that re-renders every clip.
  - Delete task, delete clip, delete user font.
  - Download as original, or as a preset export (poll, then download).
  - Sort by score or timeline.
  - Focus dialog with prev/next (←/→/j/k).
  - Live progress over SSE, with incremental clips.
- `readOnly` is true when `session.user.id !== task.user_id` (L637). The backend lets admins read other users' tasks; once admin is dropped this can always be false.

**`/tasks/[id]/edit` (`app/tasks/[id]/edit/page.tsx`)**
- Loads the task and its clips with `editorRequest` (requires `status === "completed"`). Picks the clip from `?clip=`, falling back to the first. Renders `EditorWorkspace`.
- The editor stack, all kept:
  - `components/editor/editor-workspace.tsx`: clip list, multi-select combine, apply caption style to all clips, keyboard shortcuts (space, ←/→, shift, I, O, S, mod+Z, mod+shift+Z, mod+Y, mod+S, ?), restore original, reload saved draft, JSON draft backup download.
  - `components/editor/use-editor.ts`: history capped at 50 with 700ms edit coalescing by group; autosave 700ms after a change; serialized save queue; localStorage draft cache `supoclip-editor:${endpoint}`; revision conflict handling; `beforeunload` guard.
  - `components/editor/preview.tsx`: hidden `<video crossOrigin="anonymous" src=${endpoint}/media/clean.mp4>` drawn to a canvas each animation frame through `drawEditorFrame`; WebAudio gain for volume; drag to move captions or framing; loop; playback rate; safe-area guides.
  - `components/editor/timeline.tsx`: thumbnail strip `${endpoint}/media/thumbnails.jpg`, waveform from `asset.waveform`, trim slider, in/out inputs, split, segment reorder, duplicate, remove, zoom 1×/2×/4×.
  - `components/editor/inspector.tsx`: four tabs.
    - Captions: presets, a hard-coded font list (`TikTokSans-Regular | TikTokSans-Bold | Poppins-ExtraBold | THEBOLDFONT`, L218-223), size 20-132, position, colors, background/karaoke/uppercase, words per caption 1-8, save/load style to localStorage `supoclip-caption-style`, apply to all, hook title (max 200), transcript word editor (text, timing, highlight, delete, add, script rewrite via `replaceWords`).
    - Framing: aspect vertical/square/original, fit, zoom, x, y.
    - Audio: volume 0-200%, mute.
    - Effects: brightness, contrast, saturation, blur, hue.
  - `components/editor/export-panel.tsx`:
    - Preset tiktok/reels/shorts.
    - Mode "server" (background job) or "browser" (`mediabunny` on-device encode via `lib/editor/export-draft.ts`).
    - Export all clips.
    - Job queue polled every 3s across all clips; cancel job; download finished job.
  - `components/editor/studio-ui.tsx`: `Panel`, `Section`, `Field`, `Range`, `Keys`, `ToolButton`, and English→i18n maps for status and error messages (L194-236).
  - `lib/editor/document.ts`: `EditDocument` v1 and `EditorState` types, plus the timeline maths.
  - `lib/editor/render.ts`: canvas caption, hook-title and effects renderer that mirrors the Python ASS renderer. It loads fonts through `FontFace("Editor-<name>", url(/api/fonts/<name>))`.
- npm dependency: `mediabunny`.

**`/settings` (`app/settings/page.tsx`)**
- Keep:
  - `Section id="ai"` with `components/settings/ai-provider-settings.tsx`.
  - The caption defaults section: font select, size slider 12-48, color swatches plus hex input, and a preview (L320-391).
  - The sticky save bar, which saves through `PATCH /api/preferences`.
  - `DeleteAccountSection` (`components/delete-account-section.tsx`), which uses `authClient.deleteUser({password})`.
- `ai-provider-settings` imports the `RuntimeSetting` type from the dropped `components/admin/runtime-settings-form.tsx` (L12). Move that type.

**Auth pages**
- `components/auth/auth-frame.tsx`: an async server component. Uses the `/logo.png` "SupoClip" wordmark and `clip-cut-animation.tsx` (built on `motion/react`; decorative, optional).
- `sign-in.tsx`: `signIn.email({email,password})`, then `router.push(postAuthPath(location.search))`.
- `sign-up.tsx`: `signUp.email({email,password,name})`, then `location.href = postAuthPath(...)`.
- `forgot-password.tsx`: `requestPasswordReset({email, redirectTo:"/reset-password"})`.
- `reset-password.tsx`: `resetPassword({newPassword, token})`.
- `lib/auth-redirect.ts` (`postAuthPath`) only accepts a same-site `?next=`.

**Branding strings found in kept code:** `"SupoClip"` in `auth-frame.tsx:13`, `global-error.tsx`, `not-found.tsx`, `layout.tsx` metadata and `lib/site.ts`. Filenames `supoclip-draft-${id}.json` (`editor-workspace.tsx:379`) and `supoclip-${preset}.mp4` (`export-draft.ts:172`). localStorage keys `supoclip-editor:*`, `supoclip-caption-style`, `supoclip.sidebar.collapsed`. Manual-copy element id `supoclip-manual-copy` (`copy-text.ts`).

**i18n namespaces used by kept code:** `common`, `metadata`, `shell`, `auth`, `settings` (including `settings.ai`), `home`, `library`, `task`, `editor`; also `share` if share is kept, and `language` (drop it with the switcher). The catalogs are in `messages/en/*.json`, loaded by `src/i18n/load-messages.ts`. Dropping i18n means either keeping next-intl with only `en`, or inlining these strings.

**UI primitives used by kept code:** `button`, `input`, `select`, `alert`, `tooltip`, `label`, `dialog`, `skeleton`, `kbd`, `toggle-group`, `switch`, `slider`, `separator`, `popover`, `checkbox`, `badge`, `alert-dialog`, `toggle`, `textarea`, `tabs`, `sonner` (which uses `next-themes` `useTheme`), `sheet`, `progress`. Unused by kept code: `avatar`, `card`, `dropdown-menu`.

**Styles:** `globals.css` defines `--brand`, `--canvas`, the sidebar tokens, `font-display` (Newsreader serif), `.animate-rise`, `.progress-sheen`, `.scrollbar-none`, and the `command-bar-in`/`command-bar-pulse` keyframes. It imports `tw-animate-css` and `tw-shimmer` (the `.shimmer` class).

---

## 2. Next API routes used by kept pages

How the routes work:
- "Proxy" routes use `fetchBackend()` (`src/server/backend-api.ts:49-68`) or a hand-rolled `fetch` to `BACKEND_INTERNAL_URL || NEXT_PUBLIC_API_URL || http://localhost:8000`.
- `fetchBackend` sets `redirect:"manual"`, so a backend 307 to S3 passes through to the browser via `Location`.
- `createProxyResponse` (L70-86) streams the body and forwards only these headers: `accept-ranges, cache-control, content-length, content-range, content-disposition, content-type, etag, last-modified, location, x-trace-id`.
- "Session" below means `getServerSession()` / `auth.api.getSession`; it returns `401 {error:"Unauthorized"}` when there is no user.

### 2a. Catch-all `src/app/api/tasks/[...path]/route.ts`
- Methods: GET, POST, PATCH, DELETE.
- Requires a session (L10-13).
- Proxies to `/tasks/${path.join("/")}${search}`.
- Forwards the body as text (except GET/HEAD), plus `Content-Type`, `Accept`, `Range`, `If-Range`, and `request.signal` (L15-46).

Every path the kept frontend sends through it:

| Client call (file:line) | Backend | Request | Response the frontend reads |
|---|---|---|---|
| GET `/api/tasks/{id}` (`tasks/[id]/page.tsx:249`, `edit/page.tsx:30`) | GET `/tasks/{id}` (`backend/.../tasks.py:669`) | — | A task dict built by `get_task_by_id`: `id, user_id, source_id, source_title, source_type, source_url, status, progress, progress_message, font_family, font_size, font_color, caption_template, include_broll, processing_mode, created_at, updated_at, …`. It also includes `clips[]` (each with `caption_settings`; the frontend ignores these clips and fetches `/clips` separately), `clips_count`, and the source metadata `output_format, add_subtitles, clip_length, cut_long_pauses, pause_threshold_ms, remove_filler_words, filtered_words`. **`share_enabled` is never returned** (not among the keys in `task_repository.py:139-166`). The frontend only sets it locally after a share POST. |
| GET `/api/tasks/{id}/clips` (`page.tsx:284`, `edit/page.tsx:34`) | GET `/tasks/{id}/clips` (`tasks.py:691`) | — | `{task_id, clips: Clip[], total_clips}`. Clip fields: `id, filename, start_time, end_time, duration, text, relevance_score, reasoning, clip_order, created_at, video_url:"/tasks/{task}/clips/{id}/file", virality_score, hook_score, engagement_score, value_score, shareability_score, hook_type, hook_title` (`clip_repository.py:175-195`). |
| PATCH `/api/tasks/{id}` (`page.tsx:411`) | PATCH `/tasks/{id}` (`tasks.py:812`) | `{title}` | ok / error only. The backend updates `sources.title`. |
| DELETE `/api/tasks/{id}` (`page.tsx:436`, `list/page.tsx:288`) | DELETE `/tasks/{id}` | — | ok |
| DELETE `/api/tasks/{id}/clips/{clipId}` (`page.tsx:458`) | DELETE `/tasks/{id}/clips/{clipId}` | — | ok |
| POST `/api/tasks/{id}/cancel` (`page.tsx:722` via `requestAction`, `list/page.tsx:254`) | POST `/tasks/{id}/cancel` | — | `{message}` (ignored) |
| POST `/api/tasks/{id}/resume` (`page.tsx:733`, `list/page.tsx:272`) | POST `/tasks/{id}/resume` | — | ok. On error the code is checked for `SUBSCRIPTION_REQUIRED`/`VIDEO_TOO_LONG` (billing; drop). |
| POST `/api/tasks/{id}/settings` (`page.tsx:488`) | POST `/tasks/{id}/settings` (`tasks.py:1112`) | `{font_family\|null, font_size\|null, font_color\|null, caption_template, cut_long_pauses, pause_threshold_ms, remove_filler_words, filtered_words[], apply_to_existing:true}` | `{task, message}`. The page then re-fetches. **The backend re-renders every clip synchronously inside the request** (`clip_service.py:86-87` → `regenerate_all_clips_for_task`). |
| POST/DELETE `/api/tasks/{id}/share` (`page.tsx:588, 618`) — optional | `/tasks/{id}/share` | — | POST returns `{share_token, share_path:"/share/{token}"}` (409 unless the task is completed). DELETE returns `{message}`. |
| GET `/api/tasks/{id}/progress` (EventSource, `use-task-progress.ts:33`) | GET `/tasks/{id}/progress` (SSE, `tasks.py:752`) | — | See §6 |
| GET `/api/tasks/{id}/clips/{clipId}/file[?download=true][&v=<filename>]` (`getClipUrl(video_url, filename)` in `clip-actions.ts:84-87`, `generations.ts:24` cover, `page.tsx:571-572`) | GET `/tasks/{id}/clips/{clipId}/file` (`tasks.py:909`) | Range headers | `video/mp4` FileResponse (inline, or attachment when `download=true`), or 307 to S3. `v=` is only a cache-buster. `ClipCover` appends `#t=0.5`. |
| POST `/api/tasks/{id}/clips/{clipId}/exports` (`page.tsx:548`) | `clip_exports.py:67` | `{preset}` (JSON) | 202 `{id, status: queued\|running\|succeeded\|failed, progress, preset, error, download_url}` (`clip_export_service.py:180-185`) |
| GET `/api/tasks/{id}/clips/{clipId}/exports/{exportId}` (`page.tsx:554`) | `clip_exports.py:88` | — | same job object. Polled at 1s, 1.5s, 2.3s, 3.4s, then every 5s, with a 20-min cap (`clip-export.ts:128-130, 188-225`). |
| GET `/api/tasks/{id}/clips/{clipId}/exports/{exportId}/file` (`clip-export.ts:138` via an `<a download>`) | `clip_exports.py:107` | — | mp4 stream or redirect |
| GET `/api/tasks/{id}/clips/{clipId}/editor` (`use-editor.ts:168`, `export-panel.tsx:65,143`) | `editor.py:59` | — | `EditorState` (`lib/editor/document.ts:78-92`): `{status: unprepared\|preparing\|ready\|failed, basis:<clip filename>, error?, duration, width, height, fps, hasAudio, waveform:number[], draft:{revision, document:EditDocument}, original:EditDocument, jobs:ExportJob[] (latest 20), captionLooks?: Record<template, CaptionLook>}` |
| POST `…/editor/prepare` (`use-editor.ts:172`, `export-panel.tsx:67`, `editor-workspace.tsx:399`) | `editor.py:80` | — | 202 `{status}`. The client re-polls GET every 1500ms. |
| PATCH `…/editor` (`use-editor.ts:130`, `editor-workspace.tsx:120`) | `editor.py:106` | `{basis, revision:int, document:EditDocument}` | `{revision}`. 409 if the basis changed, the preview is not ready, or the revision conflicts. 400 if validation fails. |
| GET `…/editor/media/clean.mp4` (`preview.tsx:261`, `export-panel.tsx:179`) and `…/editor/media/thumbnails.jpg` (`timeline.tsx:142`, `editor-workspace.tsx:448`) | `editor.py:155` | Range | file or 307. Only those two names are allowed. |
| POST `…/editor/exports` (`export-panel.tsx:196`) | `editor.py:183` | `{basis, preset: tiktok\|reels\|shorts, document}` | 202 `{id (32 hex), status:"queued", progress:0}`. 429 if 3 jobs are already active. |
| GET `…/editor/exports/{jobId}` (`editor-workspace.tsx:149`) | `editor.py:238` | — | `{id, status: queued\|rendering\|completed\|failed\|cancelled, progress, error?, clip_id? (combine only)}` |
| DELETE `…/editor/exports/{jobId}` (`export-panel.tsx:436`) | `editor.py:250` | — | `{status: cancelled\|cancelling\|…}` |
| GET `…/editor/exports/{jobId}/file` (`export-panel.tsx:418`, `<a download>`) | `editor.py:272` | — | mp4 |
| POST `/api/tasks/{id}/editor/combine` (`editor-workspace.tsx:140`) | `editor.py:304` | `{clip_ids: string[2..20]}` | 202 `{id, anchor_clip_id}`. The client then polls `…/clips/{anchor}/editor/exports/{id}` every 1.5s (10-min cap) until it gets `clip_id`, then calls `refreshClips(clip_id)`. |

The backend also has trim, split, merge, caption-patch, regenerate and legacy-export endpoints (`PATCH /tasks/{id}/clips/{clip}`, `/split`, `/clips/merge`, `/captions`, `/regenerate`, `GET …/export?preset=`, at `tasks.py:955-1240`). **Nothing in `frontend/src` calls them** (checked by grep). In the web app, trim, split, merge and captions all happen through the editor draft plus export/combine.

### 2b. Other proxy routes

| Route (file) | Auth | Backend | Request | Response |
|---|---|---|---|---|
| GET `/api/tasks` (`api/tasks/route.ts`). The client calls `/api/tasks/` (`generations.ts:17`). | session | GET `/tasks/` (`tasks.py:399`, limit 50) | — | `{tasks: GenerationSummary[], total}`. `GenerationSummary` (`generations.ts:1-14`): `id, user_id, source_id, source_title, source_type, source_url, status, clips_count, top_virality_score, cover_clip_id, created_at, updated_at`. The backend also sends `processing_mode`, `completion_notification_sent_at`. Ordered newest first. |
| POST `/api/tasks/create` (`api/tasks/create/route.ts`). Hand-rolled fetch, not `fetchBackend`. | session | POST `/tasks/` | `{source:{url, title\|null}, font_options:{font_family\|null, font_size\|null, font_color\|null}, caption_template, processing_mode:"fast", output_format, clip_length, add_subtitles, include_broll, cut_long_pauses, pause_threshold_ms, remove_filler_words, filtered_words[]}` (`home-app.tsx:317-334`). `url` is the YouTube/Twitch/Kick URL or the `video_path` returned by upload (`upload://<uuid>.<ext>` or an S3 URL). | `{task_id, job_id, message}`. Text passthrough with `x-trace-id`. Before inserting, the backend runs a yt-dlp preflight for duration and title (YouTube/Twitch/Kick) or an ffprobe for uploads. |
| POST `/api/upload` (`api/upload/route.ts`) | session | POST `/upload` multipart | FormData `video`. Requires `Content-Length` (411 otherwise); 413 if over the cap plus 1 MB. Buffers `request.formData()`. | `{message, video_path}` |
| POST `/api/upload/authorization` (`api/upload/authorization/route.ts`) | session | POST `/upload/authorize` | `{filename, size, contentType}` | If the backend says S3: `{storage:"s3", video_path, uploadId, partSize, parts:[{partNumber,url}]}`. Else, without `BACKEND_AUTH_SECRET`: `{directUpload:false, reason:"signed_backend_auth_required"}`, so the client uses `/api/upload`. Else: `{directUpload:true, uploadUrl: NEXT_PUBLIC_API_URL+"/upload", headers: <signed auth headers>}`, so the browser posts straight to the backend. |
| POST `/api/upload/{complete\|abort\|parts}` (`api/upload/[action]/route.ts`) | session | POST `/upload/{action}` | `complete`: `{video_path, uploadId, parts:[{partNumber,etag}]}`. `abort`: `{video_path, uploadId}`. `parts`: `{video_path, uploadId, partNumbers:[n]}`. | `complete` returns `{video_path}`. `parts` returns `{parts:[{partNumber,url}]}`. |
| GET `/api/fonts` (`api/fonts/route.ts`) | session | GET `/fonts`, retried at `/api/fonts` on 404 | — | `{fonts: FontOption[]}`, where FontOption is `{name, display_name, scope:"system"\|"user", format?, supported_languages?: string[]\|null}` (`font-select-option.tsx:209-215`) |
| GET `/api/fonts/{fontName}` (`api/fonts/[fontName]/route.ts`) | session | GET `/fonts/{name}` (404 → `/api/fonts/{name}`) | — | font bytes (`font/ttf\|otf`), `Cache-Control: private, no-cache`. Used by `@font-face` and editor `FontFace`, so it depends on cookies. |
| DELETE `/api/fonts/{fontName}` | session | DELETE `/fonts/{name}` | — | `{font_name, message}`. 403 for system fonts. |
| POST `/api/fonts/upload` (`api/fonts/upload/route.ts`) | session | POST `/fonts/upload` (404 → `/api/fonts/upload`) | FormData `file` (.ttf/.otf) | `{font:{name, display_name, filename, format, scope:"user"}, message}`. The backend returns 403 for non-paid users when monetization is on. |
| GET `/api/caption-templates` (`api/caption-templates/route.ts`) | **none** | GET `/caption-templates` | — | `{templates:[{id, name, description, animation, font_family?, font_size?, font_color?}]}` |
| GET `/api/ai/provider` (`api/ai/provider/route.ts`) | **none** | GET `/ai/provider` | — | `{provider, model, configured}` (no secrets). Cached module-wide in `use-ai-provider.ts:529-538`; refetched on the window event `ai-provider-changed`. |
| GET/PATCH `/api/admin/runtime-settings` (`api/admin/runtime-settings/route.ts`) | session + `user.is_admin` (403 otherwise) | `/admin/runtime-settings` | PATCH body from `ai-provider-settings.tsx:101-105`: `{updates:{LLM:"anthropic:<model>", ANTHROPIC_API_KEY?}, prefer_admin_values:{LLM:bool, ANTHROPIC_API_KEY:bool}}`, or `{delete_keys:["ANTHROPIC_API_KEY"]}` | `{settings: RuntimeSetting[]}`. Each setting: `{key, label, description, input_type, source: environment\|admin\|unset, configured, value_hint (masked), has_admin_value, has_env_value, prefer_admin_value, overridden_by_env, updated_at}` (`admin/runtime-settings-form.tsx:10-24`) |
| POST `/api/admin/ai/test-connection` (`api/admin/ai/test-connection/route.ts`) | session + admin | POST `/admin/ai/test-connection` | `{provider:"anthropic", api_key\|null, model}` | `{ok, status: ok\|missing_key\|invalid_key\|permission_denied\|model_not_found\|rate_limited\|connection_failed\|api_error, message, models:[{id, display_name}]}` |
| GET `/api/broll/status` | none | GET `/broll/status` | — | `{configured, provider}`. **Drop** with B-roll. |
| GET `/api/share/{token}[/clips/{clipId}/file][?download=true]` (`api/share/[...path]/route.ts`) — optional | none; segments must match `^[A-Za-z0-9_-]+$` | GET `/tasks/shared/...` | — | `{source_title, source_type, status, clips_count, created_at, clips:[{id, filename, start_time, end_time, duration, text, relevance_score, reasoning, clip_order, created_at, virality/hook/engagement/value/shareability scores, hook_type, hook_title, video_url}]}` (`tasks.py:385-396`) |

### 2c. Routes implemented in Next directly (not proxies)

| Route | What it does |
|---|---|
| `/api/auth/[...all]` (`route.ts`) | `toNextJsHandler(auth.handler)`: Better Auth. The client uses `signIn.email`, `signUp.email`, `signOut`, `useSession`, `requestPasswordReset`, `resetPassword`, `deleteUser({password})`. |
| GET/PATCH `/api/preferences` (`api/preferences/route.ts`) | Prisma `user` (see §5). GET returns `{fontFamily (default "TikTokSans-Regular"), fontSize (24), fontColor ("#FFFFFF"), notifyOnCompletion (true), clipLength ("auto")}`. PATCH accepts any subset of those keys and validates: fontFamily a non-empty string; fontSize an integer 12-48; fontColor `#RRGGBB`; notifyOnCompletion a boolean; clipLength auto/short/medium/long. It returns the same shape. |
| GET `/api/service-status/video-downloads` | Prisma `serviceStatus`. **Drop.** |
| `/api/tasks/billing-summary` | A proxy to `/tasks/billing/summary` plus a Stripe repair step. **Drop.** |

### 2d. API routes not used by any kept page (drop all)
`admin/affiliates/[id]`, `admin/announcements/**`, `admin/users/[id]/admin`, `admin/users/[id]/legacy-hd`, `affiliates/**`, `announcements`, `api-keys/**`, `attribution/**` (including `attribution/clip-export`, which is called by `trackClipExport`), `billing/**` (checkout, portal, resume, webhook, revenuecat-webhook), `broll/status`, `feedback`, `service-status/video-downloads`, `social/**`, `tasks/billing-summary`, and `share/**` if share is cut. The rewrites `/js/script.js`, `/api/events` (DataFast) and `/ingest/*` (PostHog) in `next.config.ts` go too.

---

## 3. Where kept code depends on DROPPED features

| File | Dropped dependency (lines) |
|---|---|
| `app/layout.tsx` | Imports `AttributionTracker`, `DataFastIdentity`, `FeedbackButton`, `PostHogIdentity`, `APP_STORE_ID` (L7-8, 11-12, 14). DataFast env (L39-42). `itunes.appId` metadata (L62-64). DataFast `<Script>`s (L101-119). Components rendered at L125-128. `NextIntlClientProvider` (L122), only needed if i18n stays. |
| `app/page.tsx` | JSON-LD with `APP_STORE_URL` and SEO metadata (whole file). `HomeRouter` renders `LandingPage` (`home-router.tsx:5,20`) and checks `isLandingOnlyModeEnabled` (`lib/app-flags.ts`). |
| `app/error.tsx` L4, L7, L9-11; `app/global-error.tsx` L4, L7, L10-12 | `posthog.captureException` |
| `components/app/app-shell.tsx` | `resetAnalytics` (L14, L323). `useBillingSummary` (L15, L52). `useSocialAccess` (L16, L87, L368). `billingPlanMessageKey`/`getUpgradeState` (L17-18). `Announcements` (L21, L151, L164). NAV entries `social`/`analytics` (L34-35) and `agents` → `/settings/api-keys` (L36). Admin link (L86, L91). `UsageCard` (L153, L281-316). Palette entries social/analytics/keys (L374-376). |
| `components/home-app.tsx` | `PaymentFailedBanner`/`SubscriptionCancelBanner` (L19-20, L391-398). `upgrade-prompt` and `billing-plans` (L21-22, L31). `useBillingSummary` (L29, L111). `hasPaidAccess` (L32). DataFast `track` (L33, L349-360). Upgrade state (L112-117, L278-279, L289-292, L336-344, L751-757). `uploadLimitBytes` from billing (L121-123); use `maxVideoUploadBytes()` only. Custom-font paid gate (L269-271, L563, L567-571). `limitNote` (L381-386, L718). `PlanStatusNudge` (L409, L838-892). B-roll state, fetch and chip (L103-104, L199-203, L328, L354, L646-651). `VideoDownloadStatus` (L15, L411). The completion-email footnote `t.rich("completionEmails")` (L719-723). |
| `app/tasks/[id]/page.tsx` | `trackClipExport` (L12, L565, L577). `useBillingSummary`/`UpgradeDialog`/`upgradeReasonForError` (L39-40, L181-182, L735-738, L1063-1069). Social: imports (L67-73), state (L159-161), load/poll/toasts (L188-237), `ClipPublishButton` (L850-858), `ClipPostList` (L860-865). Share (optional): L157-158, L583-632, L751-766, plus `useCopyText` (L38, L140). |
| `components/editor/export-panel.tsx` | `useSession` + `trackClipExport` (L32-33, L93, L186, L420). `useSession` is used only for tracking. |
| `lib/clip-export-tracking.ts` | Entire file (DataFast `track`, attribution, `POST /api/attribution/clip-export`). |
| `app/settings/page.tsx` | Banners (L10-11). `useSocialAccess` (L18, L64). `billing-plans` (L19-28). `LanguageSwitcher` (L29, L316-318). `upgrade-prompt`/`startUpgrade`/`CreatorCodeField` (L30-33). `track` (L35, L199, L225, L258). Billing state and handlers (L59-62, L68-73, L76-97, L167-232). Notifications/emails section (L393-401, plus the `notifyOnCompletion` save at L249). Plan section (L403-566). Links to API keys, social and creator program (L568-595). `hasAppStoreSubscription` (L599-602). |
| `components/delete-account-section.tsx` | `track`/`resetAnalytics` (L241-242, L306, L309). App Store alert (L261, L341-348). |
| `components/settings/ai-provider-settings.tsx` | Imports the `RuntimeSetting` type from the dropped `components/admin/runtime-settings-form.tsx` (L12). |
| `components/auth/sign-in.tsx` | `track` (L7, L39-41) |
| `components/auth/sign-up.tsx` | attribution + `track` (L100, L102, L133-136) |
| `lib/auth.ts` | `prepareAccountDeletion`, which checks Stripe, the affiliate Stripe promo code and social revocation, and does Prisma `source.deleteMany` (L6, L44-46; `server/account-deletion.ts`). Password reset and verification emails go through backend SES `/account/password-reset-email` and `/account/verification-email` (L13-28, L56-73, L78-83). Prisma adapter (L2-3, L38-40). |
| `lib/trace-fetch.ts` (installed by `instrumentation-client.ts`) | Wraps `window.fetch` to add `x-trace-id` and report 5xx to PostHog. Drop it; `server/backend-api.ts backendTraceHeaders` can go too. |
| `next.config.ts` | `@posthog/nextjs-config` (L3, L44-62). PostHog rewrites (L6-19, L25). DataFast rewrites (L29-41). next-intl plugin (L2, L4, L42). `output:'standalone'` and `distDir` env. |
| `package.json` deps to remove | `@posthog/nextjs-config`, `posthog-js`, `posthog-node`, `stripe`, `@prisma/client`, `prisma` (+ scripts `prisma generate`, `postinstall`), dev `@electric-sql/pglite`. Possibly `next-intl`, `motion`. |

The dropped modules themselves: `components/billing/*`, `payment-failed-banner`, `subscription-cancel-banner`, `clip-publisher`, `scheduled-posts`, `social-provider-icon`, `views-chart`, `announcements`, `feedback-button`, `posthog-identity`, `datafast-identity`, `attribution-tracker`, `language-switcher`, `landing-page`, `landing/*`, `marketing/*`, `articles/*`, `supo-live-article`, `admin/*`, `app/video-download-status`. Also `hooks/use-billing-summary`, `use-social-access`, `use-announcements`. Also `lib/{announcements, attribution, billing-plans, blog-posts, changelog, clip-export-tracking, creator-code, datafast, demo, landing-faq, marketing-links, monetization, posthog, posthog-config, seo-pages, social, social-image, start-upgrade, stripe, subscription-status, trace-fetch}`. Also `server/{account-deletion (rewrite), affiliates, announcements, billing-plans, posthog, stripe, stripe-subscription-sync, user-acquisition}`.

---

## 4. How the frontend authenticates to the backend

- Browser to Next: the Better Auth session cookie. `lib/auth-client.ts` uses `createAuthClient()` with the default same-origin base URL. Its `useSession` wrapper reports `isPending` until hydration (L102-109).
- Next to backend: `lib/backend-auth.ts buildBackendAuthHeaders(userId)` (L114-129).
  - Without `BACKEND_AUTH_SECRET`: only `x-supoclip-user-id: <userId>`.
  - With the secret: also `x-supoclip-ts: <unix seconds>` and `x-supoclip-signature: hex(HMAC-SHA256(secret, "<userId>:<ts>"))`.
- `fetchBackend` (`server/backend-api.ts:49-68`) merges `x-trace-id` (forwarded from the incoming request if it matches `^[A-Za-z0-9._-]{8,128}$`, otherwise a random UUID), the auth headers when `userId` is passed, then `headers`, then `extraHeaders`.
- The backend checks (`backend/src/auth_headers.py:55-111`): signed headers are required when a secret is configured and unsigned auth is not allowed; timestamp skew must be within `auth_signature_ttl_seconds`; `hmac.compare_digest`. An API key (`Authorization: Bearer` / `x-api-key`) takes precedence (L113-140; dropped).
- `userId` is always the Better Auth `session.user.id`, which is the same id as `users.id` (the backend reads `users.is_admin` by it).
- Routes that send no user id: `/api/caption-templates`, `/api/ai/provider`, `/api/broll/status`, `/api/share/**`.
- The direct-upload branch of `/api/upload/authorization` hands the signed headers to the browser (L46-60), which then posts to `NEXT_PUBLIC_API_URL/upload` itself.
- Admin gating: the Next routes check `session.user.is_admin`, a Better Auth `additionalFields.is_admin` with `input:false` (`lib/auth.ts:48-53`). The backend re-checks `users.is_admin`.
- **In the port** all of this collapses to `auth.api.getSession({headers})` inside each Next route, with no HMAC. A Python CLI called by the worker needs no auth.

---

## 5. Prisma usage in the frontend

- `src/lib/prisma.ts`: a singleton `PrismaClient` from `../generated/prisma`. `src/server/prisma.ts` wraps it as `getPrismaClient()`.
- Schema: `prisma/schema.prisma` (postgresql), 26 migrations under `prisma/migrations/`.

| File | Reads / writes |
|---|---|
| `lib/auth.ts:38-40` | Better Auth `prismaAdapter(prisma, {provider:"postgresql"})`. It reads and writes `users` (model `User`: `id, name, email, emailVerified, image, createdAt, updatedAt, is_admin, …`), `session` (`id, expiresAt, token, createdAt, updatedAt, ipAddress, userAgent, userId`), `account` (`id, accountId, providerId, userId, accessToken, refreshToken, idToken, *ExpiresAt, scope, password, createdAt, updatedAt`) and `verification` (`id, identifier, value, expiresAt, createdAt, updatedAt`). |
| `app/api/preferences/route.ts:18-28, 107-126` | **KEEP.** `user.findUnique` / `user.update` on `default_font_family, default_font_size, default_font_color, notify_on_completion, default_clip_length` |
| `server/account-deletion.ts:23-69` | `user.findUnique` (subscription fields), `affiliate.findUnique`, `source.deleteMany` (sources referenced only by this user's tasks). The port needs a Mongo version that deletes the user's tasks, clips, sources and files. |
| `app/api/service-status/video-downloads/route.ts:8`, `app/status/page.tsx:60` | `serviceStatus` (DROP) |
| `app/admin/page.tsx:125-234` | user/task counts, lists, `task.groupBy`, `affiliate.findMany` (DROP) |
| `app/api/admin/users/[id]/admin/route.ts`, `…/legacy-hd/route.ts:37` | `user.update(Many)` (DROP) |
| `app/api/admin/announcements/**`, `app/api/announcements/route.ts:8` | `announcement` (DROP) |
| `app/api/affiliates/**`, `app/api/admin/affiliates/[id]/route.ts`, `server/affiliates.ts` | `affiliate`, `user` (DROP) |
| `app/api/attribution/**`, `server/user-acquisition.ts:37-38` | `$queryRawUnsafe` on `user_acquisition` (DROP) |
| `app/api/billing/{checkout,portal,resume,webhook,revenuecat-webhook}`, `server/stripe-subscription-sync.ts` | `user`, `stripeWebhookEvent`, `revenueCatWebhookEvent` (DROP) |

**Caption defaults do nothing downstream.** `default_font_family/size/color` are written by `/settings` and read back only by `GET /api/preferences`. Neither `home-app.tsx` (its font state starts as `null`, meaning template default) nor the backend reads them (`grep` in `backend/src` finds no `default_font_*`). Only `default_clip_length` is applied, as the home preselect. `notify_on_completion` is used only by backend completion emails (dropped).

---

## 6. SSE and progress consumption (`hooks/use-task-progress.ts`)

**Connection**
- `new EventSource("/api/tasks/${taskId}/progress")` (L33). It only opens while `active`, which the task page sets to `status ∈ {queued, processing}` (`page.tsx:371`).
- Proxied through the catch-all; `createProxyResponse` streams it, keeping content-type and cache-control.

**Named events the client listens to** (`message` events with no name are ignored):

| Event | Data (JSON in `data:`) | Client action |
|---|---|---|
| `status` | Initial snapshot `{task_id, status, progress, message}` (`tasks.py:765-776`) | `onProgress(data)`. If `status` is completed, cancelled or error, it calls `reconcile()`. |
| `progress` | `{task_id, progress:int 0-100, message, status}` (`workers/progress.py:29-34`; the event name defaults to "progress" in `tasks.py:796`) | same as `status` |
| `clip_ready` | `{task_id, event_type:"clip_ready", clip_index, total_clips, clip}` (`progress.py:59-65`). `clip` is the full `get_clip_by_id` row, including `task_id`, `file_path` (a server path) and `video_url`. | `onClip(data.clip)`. The page upserts by id and sorts by `clip_order` (`page.tsx:377-378`). |
| `close` | `{status}`. Sent at once if the task is already terminal, or after a terminal progress event. | `source.close()` then `reconcile()` |

**Robustness**
- `onerror` sets `reconnecting = true` and calls `reconcile()`, leaving the browser to auto-reconnect. `onopen` clears `reconnecting`.
- A JSON parse failure triggers `reconcile()`.
- `reconcile()` = `refresh()` = `fetchTaskStatus(0,0,true)`, a background GET of the task and its clips, with no overlap guard needed (`refreshing` flag).
- It also runs on a 5s interval, on `visibilitychange` to visible, and on `online` (L62-65). SSE is only the fast path; polling alone is enough.

**What the UI needs from each update:** `progress` (number) and `message` (string). `ProcessingPanel` (`clip-wall.tsx:558-617`) works out the step (fetching, transcribing, finding, rendering) by regex on the message (`/render|clip \d|saving/`, `/analy|moment|segment|ai /`, `/transcri/`, `/download|fetch/`), falling back to progress thresholds 20/45/65/100.

---

## 7. Port risks and questions (all seen in the code)

1. **Uploads on Vercel.** `/api/upload` buffers `request.formData()`, and the cap defaults to 4 GB (`video-upload.ts:73`). Vercel functions cannot take that body. The existing S3 multipart client flow (`video-upload.ts:247-333`, with `/api/upload/{authorization,parts,complete,abort}`) is the right model: switch it to Blob or R2 client upload. Locally, a disk-backed route is fine. **Ask the user** whether uploads must work on Vercel in v1.
2. **SSE through a Vercel function** is limited by max duration. The hook's reconnect plus 5s polling already copes. A Mongo-backed version can be a polled GET or a short-lived SSE route that reads the task document.
3. **Media proxying.** Clip files, editor `clean.mp4`/`thumbnails.jpg` and font files are streamed through Next with Range headers. On Vercel these should be signed Blob/R2 URLs or redirects. The client already follows redirects because `redirect:"manual"` passes `Location` through. The editor `<video>` uses `crossOrigin="anonymous"`, so the storage needs CORS.
4. **Restyle runs inside the request.** `POST /tasks/{id}/settings` with `apply_to_existing` re-renders every clip during the HTTP call. It must become a worker job, and the UI needs a pending state.
5. **Who can set the Claude key.** Configuring it requires `is_admin`, and nothing in the frontend assigns admin. **Ask the user** whether the first user becomes admin, the key comes from env only, or the key is per user.
6. **Forgot and reset password** need an email sender, and SES is dropped. **Ask the user** whether to drop these flows or pick a provider.
7. **Task creation preflight.** `/api/tasks/create` relies on a backend yt-dlp or ffprobe preflight for title and duration. In the port this moves into the worker job.
8. **Twitch and Kick** URLs are accepted by `validateVideoSourceUrl` (`video-upload.ts:105-126`) and `VideoSourceIcon`. The scope says YouTube plus upload; cut them or keep them.
9. **Share links** are trivial to keep: one page, one GET, a file route and the `share_enabled` toggle. The backend never returns `share_enabled` on GET, so the "disable link" button only shows after sharing in the current session.
10. **Tests exist**, contrary to CLAUDE.md's "No tests": vitest `*.test.ts(x)` in `src` and Playwright in `e2e/`. Most cover dropped features.