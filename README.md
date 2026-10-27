# Clipwright

Clipwright turns long videos into short vertical clips. Give it a YouTube URL or a video file; it
transcribes the speech, has Claude pick and score the strongest self-contained moments, and renders
9:16 clips with face-aware framing and word-synced captions. Then you can restyle every clip at once
or fine-tune any clip in a built-in editor.

It runs on your own machine (Windows, macOS or Linux) with no Docker, against a MongoDB database
(the free Atlas tier is enough). You bring your own Anthropic and AssemblyAI API keys.

> Clipwright is a modified version of [SupoClip](https://github.com/FujiwaraChoki/supoclip) and is
> licensed under AGPL-3.0. See [NOTICE.md](NOTICE.md).

## How it fits together

| Part | Tech | Role |
|---|---|---|
| Web app | Next.js 15, React 19, Tailwind v4, Better Auth | UI and API routes in `web/` |
| Worker | Node (tsx), in `web/src/worker` | Claims jobs from MongoDB, calls Claude, drives the engine |
| Render engine | Python 3.11 (uv), ffmpeg, OpenCV, yt-dlp | CLI in `engine/`: download, transcribe, render |
| Database | MongoDB | Users, tasks, clips, drafts, the job queue, encrypted settings |
| Clip selection | Anthropic Claude (default `claude-opus-5`) | Picks, scores and titles the clips |
| Transcription | AssemblyAI | Word-level timestamps for cuts and captions |

`pnpm dev` starts the web app and the worker together. Media files live under `data/`.

## Features

- **Sources:** public YouTube videos (downloaded with yt-dlp) and uploaded files (.mp4, .mov, .avi,
  .mkv, .webm, .m4v; up to 4 GB by default).
- **AI clip selection:** Claude reads the timestamped transcript and returns 15 to 60 s segments with
  a virality score (hook, engagement, value, shareability), the reasoning and a hook title. Long
  videos are analysed in overlapping windows and reranked together.
- **Rendering:** vertical 9:16 crops that follow faces, a fit, pan or split-screen layout, or the
  original aspect; caption templates with animated, word-synced subtitles; bundled fonts plus your
  own uploads; optional pause and filler-word removal; a hook title on the first seconds.
- **Live progress** for every step, plus cancel and resume.
- **Task page:** clip wall with scores, focus view, downloads, TikTok/Reels/Shorts preset exports,
  delete, and **restyle** all clips with new caption settings in the background.
- **Clip editor:** timeline, trim and caption editing, autosave with conflict detection, undo/redo,
  apply a style to all clips, combine clips, and export in the browser or on the server.
- **Settings:** the admin saves the Anthropic and AssemblyAI keys (encrypted in MongoDB) and picks
  the Claude model, with a free connection test; every user sets caption defaults and can delete
  their account.

## Quick start

You need **Node 22+**, **pnpm 10** (or `npx -y pnpm@10`), **uv**, **ffmpeg with libass and
libx264**, and a **MongoDB connection string**. [docs/setup.md](docs/setup.md) walks through
installing each one on Windows, macOS and Linux and creating a free Atlas cluster.

```bash
git clone <your Clipwright repository URL> clipwright
cd clipwright

cd engine && uv sync && cd ..            # Python render engine (engine/.venv)
cd web
npx -y pnpm@10 install                   # or `pnpm install` after `corepack enable`
cp .env.example .env.local               # PowerShell: Copy-Item .env.example .env.local
```

Edit `web/.env.local` and set `MONGODB_URI` and `BETTER_AUTH_SECRET` (at least 32 random characters).
Then, still in `web/`:

```bash
npx -y pnpm@10 dev
```

Open [http://localhost:3000](http://localhost:3000) and sign up. **The first account becomes the
admin.** Go to **Settings → AI and transcription**, paste your Anthropic key, click **Test
connection**, pick a model and save; then paste your AssemblyAI key and save it. Paste a YouTube URL
on the home page and start your first generation.

With GNU make: `make setup`, then `make dev`.

## Documentation

| Guide | What it covers |
|---|---|
| [Setup](docs/setup.md) | Prerequisites, MongoDB Atlas, configuration, first run |
| [Configuration](docs/configuration.md) | Every environment variable and its default |
| [Architecture](docs/architecture.md) | Components, request flows, jobs, data model, storage |
| [Claude integration](docs/claude-integration.md) | Keys, model choice, how selection works, costs |
| [Testing](docs/testing.md) | Unit, engine, slow and end-to-end tests; manual checklist |
| [Troubleshooting](docs/troubleshooting.md) | Worker offline, yt-dlp, keys, ffmpeg, Windows issues |
| [Deploying to Vercel](docs/deploying-to-vercel.md) | What works today and what is still missing |
| [Design spec](docs/port/DESIGN.md) | Authoritative contracts for routes, collections, jobs and the engine |
| [Contributing](CONTRIBUTING.md) | Development workflow and checks |

## License and source

Clipwright is based on [SupoClip](https://github.com/FujiwaraChoki/supoclip) and, like it, is licensed
under the [GNU Affero General Public License v3.0](LICENSE). Credit and details are in
[NOTICE.md](NOTICE.md).

AGPL-3.0 section 13 applies to network use: **if you deploy a modified version of Clipwright for
other people to use, you must offer them its complete source code.** The app shows a "Source" link
in the sidebar and on the sign-in pages; set `NEXT_PUBLIC_SOURCE_CODE_URL` in `web/.env.local` to the
public repository of your version before you deploy it.
