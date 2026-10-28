# Testing

All commands below use `npx -y pnpm@10`; with Corepack enabled, plain `pnpm` works the same.

## Quick reference

| What | Command | Needs |
|---|---|---|
| Web unit and integration tests | `cd web && npx -y pnpm@10 exec vitest run` | Nothing external (in-memory MongoDB) |
| Type check | `cd web && npx -y pnpm@10 exec tsc --noEmit -p .` | |
| Lint | `cd web && npx -y pnpm@10 run lint` | |
| Real-engine worker test (slow) | `cd web && CLIPWRIGHT_SLOW_TESTS=1 npx -y pnpm@10 exec vitest run src/worker/integration.slow.test.ts` | `engine/.venv`, ffmpeg |
| Engine tests | `cd engine && uv run python -X utf8 -m pytest -q` | ffmpeg |
| Engine YouTube fetch | `cd engine && CLIPWRIGHT_NETWORK_TESTS=1 uv run python -X utf8 -m pytest tests/test_network.py` | Network |
| End-to-end (browser) | `cd web && npx -y pnpm@10 exec playwright test` | Playwright Chromium |
| Production build | `cd web && npx -y pnpm@10 run build` | |

With GNU make: `make test` (web vitest plus engine pytest), `make check` (tsc plus lint), `make build`.

## Web (vitest)

```bash
cd web
npx -y pnpm@10 exec vitest run                 # everything, once
npx -y pnpm@10 exec vitest run src/server/ai   # one folder
npx -y pnpm@10 run test:watch                  # watch mode
```

- MongoDB-backed tests start `mongodb-memory-server` (one in-memory server per test file). The first
  run downloads a `mongod` binary into the user cache.
- Storage tests use a temporary `DATA_DIR`.
- Worker handler tests inject a fake engine runner and a fake Anthropic `fetch`; the Claude tests
  run the real SDK request path against a fake `fetch`. No test makes a paid call.
- `src/server/settings.test.ts` decrypts a ciphertext produced once by SupoClip's original Python
  implementation, which keeps saved keys compatible.

### Slow real-engine test

`src/worker/integration.slow.test.ts` runs the real Python engine and ffmpeg on a synthetic video:
it processes an upload into two clips (with fake Claude and AssemblyAI), then prepares and exports
one of them in the editor. It is skipped unless `CLIPWRIGHT_SLOW_TESTS=1` is set and takes about
two minutes.

```bash
cd web
CLIPWRIGHT_SLOW_TESTS=1 npx -y pnpm@10 exec vitest run src/worker/integration.slow.test.ts
```

In PowerShell: `$env:CLIPWRIGHT_SLOW_TESTS = "1"; npx -y pnpm@10 exec vitest run src/worker/integration.slow.test.ts`.

## Engine (pytest)

```bash
cd engine
uv run python -X utf8 -m pytest -q
```

The unit and CLI tests generate synthetic sources with ffmpeg and need no network. One network test
fetches a real YouTube video and only runs with `CLIPWRIGHT_NETWORK_TESTS=1`. `-X utf8` keeps output
encoding consistent on Windows.

## End-to-end (Playwright)

`web/e2e/full-flow.spec.ts` drives the whole app in Chromium: sign-up (first user becomes admin),
saving keys and testing the connection, connecting YouTube, uploading a video and generating clips,
auto-posting both clips (exactly one public `videos.insert` each, with Claude's metadata), playback
and download, a TikTok preset export, the editor (prepare, edit, autosave across a reload, server
export), the library, and deleting a clip and the task. Global setup
(`web/e2e/global-setup.ts`) starts everything it needs, so it requires no real accounts or database
server:

- It starts **fake Claude, AssemblyAI and Google HTTP servers** (Google covers OAuth, `channels.list`,
  the resumable upload and `videos.list` through `GOOGLE_BASE_URL_OVERRIDE`), so no keys are needed
  and nothing is billed or posted.
- It uses an **in-memory MongoDB** (`mongodb-memory-server`).
- It runs the real worker and Python engine, so `engine/.venv` and ffmpeg must be installed.

```bash
cd web
npx -y pnpm@10 exec playwright install chromium   # once
npx -y pnpm@10 exec playwright test
```

Reports go to `web/playwright-report/` and failure traces to `web/test-results/` (both git-ignored).

## Manual end-to-end checklist (real keys)

Run this before a release, with a real Atlas database and real Anthropic and AssemblyAI keys. It
costs a little Claude and AssemblyAI usage.

1. `web/.env.local` has `MONGODB_URI` and `BETTER_AUTH_SECRET`. `cd web && npx -y pnpm@10 dev`.
2. `http://localhost:3000/api/health` returns `ok: true`, `db: true`, `worker.online: true`.
3. Sign up. The first account is an admin (Settings shows editable AI fields).
4. **Settings → AI and transcription:** paste the Anthropic key, **Test connection** shows
   `Connected` and lists models. Pick a model, **Save**. Paste the AssemblyAI key, **Save key**. The
   status shows Ready.
5. **YouTube generation:** paste a short (2 to 5 minute) public YouTube video. Watch the progress go
   through "Downloading video...", "Preparing video...", "Generating transcript...", "Analyzing
   content with AI...", "Creating clip i/N..." and "Complete!".
6. On the task page: clips play, scores and hook titles show, download works, a preset export
   (TikTok, Reels or Shorts) finishes and downloads.
7. **Upload generation:** upload a short MP4 and repeat steps 5 and 6.
8. **Cancel and resume:** start a generation, cancel during transcription, then resume; it completes
   and reuses the download.
9. **Restyle:** change the caption template with "apply to existing clips". The old clips stay until
   the new ones replace them. Start another restyle and cancel it: the old clips and old settings
   remain.
10. **Editor:** open a clip, wait for prepare, edit a caption and trim; reload the page and check that
    the autosave kept the edit. Undo and redo. Export in the browser and on the server; both
    downloads play.
11. **Combine:** select two clips and combine them; the new clip appears in the task.
12. **Worker offline:** stop the worker (`Ctrl+C` in its pane or run `pnpm dev:web`), create a
    generation: the UI warns that the worker isn't running and the task stays queued. Start the worker
    again (`pnpm worker`): the task runs.
13. Delete a clip, then the task; then delete the test account from Settings.

Record the date, OS, model and anything that failed in the pull request.
