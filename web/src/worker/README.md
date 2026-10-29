# Worker

The Clipwright worker is a Node process. It claims jobs from the Mongo `jobs` collection and runs
each one through the Python engine (`engine/`, see its README) as a CLI subprocess. Route handlers
only enqueue jobs, so the web app never needs Python or ffmpeg.

## Running it

```
pnpm dev       # Next and the worker together
pnpm worker    # the worker alone (tsx src/worker/main.ts)
```

The worker loads `web/.env.local` the same way Next does (`@next/env`). It needs `MONGODB_URI`
and `BETTER_AUTH_SECRET`, plus the engine prerequisites: `engine/.venv` (`uv sync`), and `ffmpeg`,
`ffprobe` and `node` on `PATH`. Other variables it reads:

| Variable | Use |
|---|---|
| `WORKER_CONCURRENCY` | Number of jobs run at once (default 1). |
| `DATA_DIR` | `storage/` for files and `work/{jobId}/{claim token}` for job temp dirs (one per attempt). |
| `ENGINE_DIR`, `ENGINE_PYTHON` | Where the engine lives and which Python runs it. |
| `MAX_VIDEO_DURATION`, `MAX_CLIPS`, `CLIP_DURATION`, `YOUTUBE_MAX_HEIGHT`, `TRANSCRIPTION_LANGUAGE`, `SPEAKER_FRAMING`, `HOOK_FIRST_TEASER`, `ASSEMBLY_AI_HTTP_TIMEOUT_SECONDS` | Passed to the engine. |

The Anthropic and AssemblyAI keys and the Claude model are read at the start of each job, from the
environment or from Settings.

What the worker does while running:

- It writes `worker_status` every 10 s. The UI uses this to show whether the worker is online.
- Each slot loops: reap expired leases, claim a job, run it, finish it. When the queue is empty, a
  slot polls every second.
- A job holds a 60 s lease, renewed every 15 s. If a renewal sees `cancelRequested`, or finds the
  lease lost, the job's engine run is cancelled.
- Every 5 minutes a cron:
  - expires exports;
  - deletes finished job documents older than 7 days, with their files;
  - removes `work/` dirs older than 24 h;
  - deletes downloaded YouTube source videos that no task has used for 24 h. Their word timings stay;
  - deletes uploads older than 24 h that no task uses, with their word timings;
  - releases a `working` YouTube post whose job is no longer queued or running (its failure hook
    never completed) the way that hook would have: back in the queue in 2 minutes, or `failed`;
  - re-runs `createPostsForTask` for any task still `autopost: "pending"` more than 2 minutes after
    its last update (covers a crash between the completion CAS and the enqueue), and enqueues every
    due `publish_youtube` job (the posts whose `notBefore` has passed);
  - re-reads `videos.list?part=status` for posts uploaded at least 10 minutes ago, within the last
    48 h, to record their final privacy and upload status, and to trip the forced-private circuit
    breaker (`docs/youtube.md`) if YouTube locked one private. An account that needs a reconnect
    is skipped until it is reconnected.

**Stopping:** press Ctrl+C (SIGINT/SIGTERM). Running engines are cancelled and their jobs go back
to the queue without using up an attempt. Press Ctrl+C a second time to exit at once.

If the worker dies outright, the reaper requeues its jobs once their lease expires, as long as
attempts are left. When none are left, it runs the job type's failure hook (`run-job.ts`).

## Jobs

| Type | Payload | What it does |
|---|---|---|
| `process_task` | none; the task holds everything. `task.run.jobId` must equal the job id | Download (YouTube) or locate (upload) the video, then: `prepare-source` → `transcribe` → `signals` + Claude `selectClips` (cached in `processing_cache`) → `render-clips`. Each clip is stored and pushed as it renders. Progress messages are exact (DESIGN §6.2). |
| `restyle_task` | `{cleanupChanged}` | Re-renders every clip with the task's new settings. It uses the kept ranges when cleanup is unchanged, else re-cleans the source ranges. All clips are swapped in one write. If nothing renders, the old clips stay and the message is "Restyle failed…". |
| `prepare_editor` | `{filename}` | Runs `editor-prepare`. Writes `editor/{clipId}/{basisHash}/clean.mp4` and `thumbnails.jpg`, and seeds the draft at revision 0. |
| `export_editor` | `{document, preset, basis}` | Runs `editor-render` and writes `editor-exports/{jobId}.mp4`. Expires after 7 days. |
| `combine_editor` | `{inputs: CombineInput[]}` (from `drafts.ts`) | Runs `editor-combine`. Appends a new clip with a ready draft and writes the export to `editor-exports/{jobId}.mp4`. Result: `{clip_id, fileKey}`. |
| `export_clip` | `{preset, filename}` | Runs `export-preset` and writes `exports/{jobId}.mp4`. Fails if the clip's file changed. Expires after 7 days. |
| `publish_youtube` | `{postId}` | YouTube auto-post (see [`docs/youtube.md`](../../../docs/youtube.md)). Writes the clip's title, description, tags and hashtags with Claude, then uploads it with YouTube's resumable protocol and records the video id. Never runs twice for the same clip lineage. |

**Handlers:** each handler (`handlers/*.ts`) gets a `JobContext` (`context.ts`). The context
provides:

- the attempt's own work dir;
- an abort signal. It fires on a user cancel, on shutdown, and when the lease is lost: a heartbeat finds
  it taken, or no heartbeat got through for 45 s. Handlers call `ctx.throwIfStopped()` before task writes;
- throttled progress;
- an `engine()` runner that fills in `work_dir`, `cancel_file`, `fonts_dirs` and `config`.

**Tests:** the handler tests inject a fake engine runner and a fake Anthropic `fetch`. The real
engine runs only in the slow test:

```
CLIPWRIGHT_SLOW_TESTS=1 pnpm exec vitest run src/worker/integration.slow.test.ts
```
