# Changelog

What changed in Clipwright for people using and running it. Newest first. Tag entries **New**,
**Improved**, **Fixed** or **Under the hood**.

## Unreleased

## 0.1.0 — first release

Clipwright 0.1.0 is a rebrand and re-platform of an earlier open-source Python clipping app
(AGPL-3.0). See [NOTICE.md](NOTICE.md).

- **New:** Clipwright name, logo and wordmark. An "AGPL-3.0 · Source" link in the
  sidebar and on the sign-in pages, configurable with `NEXT_PUBLIC_SOURCE_CODE_URL`.
- **New:** runs locally on Windows, macOS and Linux with no Docker. `pnpm dev` starts the Next.js app
  and the worker together; configuration lives in `web/.env.local`.
- **New:** MongoDB (Atlas free tier works) replaces PostgreSQL and Redis. The job queue, task
  progress and settings all live in MongoDB.
- **New:** a Node worker (`web/src/worker`) with leases, heartbeats, automatic requeue after a
  crash, and a cleanup cron for expired exports, old jobs, temp dirs and unused sources.
- **New:** the Python renderer is now a standalone CLI engine (`engine/`, managed by uv) that the
  worker runs per step, with cancellation that kills ffmpeg.
- **New:** the first account to sign up becomes the admin (`ADMIN_EMAILS` adds more). Password reset
  links are printed to the server console.
- **New:** admins save the Anthropic and AssemblyAI keys in **Settings → AI and transcription**,
  encrypted in MongoDB, with a free Claude connection test. The UI shows which key is missing.
- **New:** the UI warns when the worker is not running, and `/api/health` reports database and
  worker status.
- **Improved:** Claude is the only LLM (default `claude-opus-5`), called from TypeScript with
  JSON-schema output, output repair, retries within a time budget and the server-side refusal
  fallback. Prompts and selection logic match the original app's.
- **Improved:** restyling all clips runs as a background job. Cancelling or a failed restyle keeps
  the existing clips and restores the previous settings.
- **Improved:** uploads stream straight to disk; clip and editor media support HTTP Range requests.
- **Improved:** YouTube downloads use yt-dlp with Node as its JavaScript runtime. YouTube URLs are
  checked against YouTube hosts and stored in one canonical form.
- **Improved:** progress updates by polling every 2 s instead of server-sent events.
- **Removed:** billing and plans, social publishing and analytics, admin pages beyond settings, API
  keys and the MCP server, the creator program, B-roll, emails, PostHog/Axiom observability, all
  languages except English, marketing pages, the iOS integration, share links, Twitch/Kick/Apify and
  proxy downloads, Whisper and other LLM providers, transitions, and the legacy
  trim/split/merge/caption endpoints (the editor covers them).
