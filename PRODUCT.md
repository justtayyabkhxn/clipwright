# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Developers who self-host. They clone the repository, run it on their own machine (Windows, macOS or
Linux), bring their own API keys, and use it to turn long videos into Shorts and, optionally, post
them to their own YouTube channel automatically. They read setup steps carefully and expect the
truth about what each piece needs.

## Product Purpose

Clipwright turns long videos (a YouTube URL or an uploaded file) into short 9:16 clips: AssemblyAI
transcribes, Claude picks and scores the strongest self-contained moments, a Python engine renders
them with face-aware framing and word-synced captions, and an editor refines them. With YouTube
connected, every finished clip can post itself as a Short. Success is a pipeline that runs
unattended once set up: long video in, posted Shorts out, performance coming back.

## Positioning

Self-hosted and open source (AGPL-3.0), bring-your-own-keys: no subscription, no per-minute credits,
the code and the data stay on the user's machine and their own MongoDB. Claude does the clip
judgement; posting goes to the user's own channel through their own Google OAuth client.

## Operating Context

- Runs with `pnpm dev` (Next.js app on :3000 plus a Node worker) and a Python 3.11 engine (uv) with
  ffmpeg. No Docker. The worker must be running for anything to process or post.
- MongoDB is the only database (the free Atlas tier is enough).
- The first account to sign up becomes the admin, who saves the Anthropic and AssemblyAI keys in
  Settings (or in `web/.env.local`).
- YouTube auto-post is optional and needs a Google Cloud OAuth client
  (`GOOGLE_OAUTH_CLIENT_ID`/`SECRET`); see `docs/youtube.md`.

## Capabilities and Constraints

- Sources: public YouTube URLs (yt-dlp) and uploads (.mp4, .mov, .avi, .mkv, .webm, .m4v; up to 4 GB).
- Claude (default `claude-opus-5`) returns 15–60 s segments with a virality score, reasoning and a
  hook title; long videos are analysed in overlapping windows and reranked.
- Rendering: face-tracked vertical crops, fit/pan/split layouts, 7 caption templates with animated
  word-synced subtitles, pause and filler-word removal, hook title overlay.
- Editor: timeline, trim, caption editing, restyle all clips, combine, exports (TikTok/Reels/Shorts presets).
- YouTube auto-post: Claude-written titles, descriptions, tags and hashtags; uploads 10 minutes
  apart; hourly view/like/comment stats; a "What performs" breakdown; clip selection learns from the
  channel's best clips once 10 have stats; optional playlists and full-video links.
- Limits to state honestly: until the user's Google project passes YouTube's audit, uploads are
  locked private and the default quota allows only a handful of uploads a day.
- Not built: hosted SaaS, billing, Instagram/TikTok posting, scheduling beyond the 10-minute gap.

## Brand Commitments

- Product name is **Clipwright**. The app shows the AGPL-3.0 license and a link to the source;
  upstream credit lives in NOTICE.md.
- Existing logo: an SVG mark plus wordmark component in the app.

## Evidence on Hand

- Real product facts in `README.md`, `docs/setup.md`, `docs/youtube.md`, `docs/configuration.md`.
- No testimonials, user counts, benchmarks, customer logos or press exist. Do not invent any.

## Product Principles

1. Tell the truth about setup: every key, service and limit is named, with where to get it.
2. Own your pipeline: self-hosted, your keys, your channel, your data.
3. Unattended once configured: the value is the loop running without you.
4. Credit the upstream project plainly.
