# Clipwright

Clipwright turns long videos into short vertical clips. Give it a YouTube URL or a video file and it
transcribes the speech, has Claude pick and score the strongest self-contained moments, and renders
9:16 clips with face-aware framing and word-synced captions. You can then restyle every clip at once
or fine-tune any clip in the built-in editor, and optionally auto-post finished clips to YouTube
Shorts.

It runs on your own machine (Windows, macOS or Linux) with **no Docker**. You need a MongoDB
database (the free Atlas tier is enough) and your own Anthropic and AssemblyAI API keys.

---

## Contents

1. [Features](#features)
2. [How it works](#how-it-works)
3. [Prerequisites](#1-prerequisites)
4. [Get the code](#2-get-the-code)
5. [Install dependencies](#3-install-dependencies)
6. [Create a MongoDB database](#4-create-a-mongodb-database)
7. [Configure the app](#5-configure-the-app)
8. [Run it](#6-run-it)
9. [First-time setup in the app](#7-first-time-setup-in-the-app)
10. [Optional: YouTube auto-post](#optional-youtube-auto-post)
11. [Everyday commands](#everyday-commands)
12. [Troubleshooting](#troubleshooting)
13. [Documentation](#documentation)
14. [License](#license)

---

## Features

- **Sources:** public YouTube videos and uploaded files (`.mp4 .mov .avi .mkv .webm .m4v`, up to
  4 GB by default).
- **AI clip selection:** Claude reads the timestamped transcript and returns 15–60 s segments with a
  virality score, its reasoning and a hook title. Long videos are analysed in overlapping windows
  and reranked together.
- **Rendering:** 9:16 crops that follow faces, fit/pan/split-screen layouts, animated word-synced
  caption templates, bundled and custom fonts, optional pause and filler-word removal.
- **Live progress** for every step, with cancel and resume.
- **Clip editor:** timeline, trim, caption editing, autosave, undo/redo, combine clips, export in
  the browser or on the server; TikTok/Reels/Shorts export presets.
- **Settings:** an admin saves the API keys (encrypted in MongoDB) and picks the Claude model; each
  user sets caption defaults.
- **YouTube auto-post (optional):** connect a channel once and every finished clip is uploaded as a
  Short with a Claude-written title, description and tags.

## How it works

| Part | Tech | Where |
|---|---|---|
| Web app + API | Next.js 15, React 19, Tailwind v4, Better Auth | `web/` |
| Worker | Node (tsx); claims jobs from MongoDB, calls Claude, drives the engine | `web/src/worker/` |
| Render engine | Python 3.11 (uv), ffmpeg, OpenCV, yt-dlp; a CLI run by the worker | `engine/` |
| Database | MongoDB: users, tasks, clips, drafts, job queue, encrypted settings | Atlas or local |
| Clip selection | Anthropic Claude | API key |
| Transcription | AssemblyAI | API key |
| Media files | Local disk | `data/` (git-ignored) |

One command (`pnpm dev`) starts both the web app and the worker.

---

## 1. Prerequisites

Install these once. Open a **new terminal** after installing so `PATH` changes take effect.

| Tool | Version | Check with |
|---|---|---|
| [Git](https://git-scm.com/downloads) | any | `git --version` |
| [Node.js](https://nodejs.org/) | 22 or newer | `node --version` |
| pnpm | 10 | `npx -y pnpm@10 --version` (no install needed) |
| [uv](https://docs.astral.sh/uv/) | recent | `uv --version` |
| ffmpeg + ffprobe | any build with **libass** and **libx264** | `ffmpeg -version` |

You do **not** need to install Python yourself: uv downloads Python 3.11 for the engine.

### Windows

```powershell
winget install Git.Git
winget install OpenJS.NodeJS.LTS
winget install astral-sh.uv
winget install Gyan.FFmpeg
```

No winget? Use the installers from the links above. For ffmpeg, download the "essentials" or
"full" build from [gyan.dev](https://www.gyan.dev/ffmpeg/builds/), unzip it to `C:\ffmpeg`, and add
`C:\ffmpeg\bin` to your user `PATH`. For uv you can also run
`powershell -ExecutionPolicy ByPass -c "irm https://astral.sh/uv/install.ps1 | iex"`, or, if you
already have Python, `python -m pip install --user uv` and use `python -m uv` in place of `uv`.

### macOS

```bash
brew install git node@22 uv ffmpeg
```

### Linux (Debian/Ubuntu)

```bash
sudo apt install git ffmpeg fontconfig fonts-noto-core fonts-noto-cjk fonts-noto-color-emoji
curl -LsSf https://astral.sh/uv/install.sh | sh
# Node 22+: use your distro package, NodeSource, or nvm (https://github.com/nvm-sh/nvm)
```

### Check that ffmpeg has caption support

```bash
ffmpeg -hide_banner -filters  | grep -E " (ass|subtitles) "   # both lines must appear
ffmpeg -hide_banner -encoders | grep libx264
```

In PowerShell, replace `grep` with `findstr`.

## 2. Get the code

```bash
git clone https://github.com/justtayyabkhxn/clipwright.git
cd clipwright
```

On Windows, keep the folder at a short path without unusual characters (for example
`C:\src\clipwright`) to avoid long-path problems.

## 3. Install dependencies

```bash
# Python render engine (creates engine/.venv with Python 3.11)
cd engine
uv sync
cd ..

# Web app and worker
cd web
npx -y pnpm@10 install
```

`npx -y pnpm@10` works without installing pnpm. If you prefer a plain `pnpm` command, run
`corepack enable` once and use `pnpm` everywhere below.

pnpm may print "Ignored build scripts" warnings. They are safe to ignore for running the app.

## 4. Create a MongoDB database

The free **MongoDB Atlas M0** tier is enough.

1. Sign in at [cloud.mongodb.com](https://cloud.mongodb.com/) and create a project.
2. **Create** a cluster and choose the free **M0** tier, in a region near you.
3. **Database Access → Add New Database User:** password auth, role "Read and write to any
   database". Avoid `@ : / ? #` in the password, or URL-encode them.
4. **Network Access → Add IP Address:** add your current IP.
5. On the cluster, click **Connect → Drivers → Node.js** and copy the connection string, for example
   `mongodb+srv://USER:PASSWORD@cluster0.xxxxx.mongodb.net/?retryWrites=true&w=majority`.

You don't need to create collections; the app creates them on first use.

Using a local `mongod` instead? That works too; set `MONGODB_TRANSACTIONS=false` in the next step
unless it runs as a replica set.

## 5. Configure the app

Still in `web/`, copy the template:

```bash
cp .env.example .env.local            # PowerShell: Copy-Item .env.example .env.local
```

Open `web/.env.local` and set the two required values:

| Variable | Value |
|---|---|
| `MONGODB_URI` | The connection string from step 4. |
| `BETTER_AUTH_SECRET` | At least 32 random characters. Generate one with `node -e "console.log(require('crypto').randomBytes(48).toString('base64'))"`. |

Keep `BETTER_AUTH_SECRET` stable: it also encrypts the API keys you save in the app.

The API keys are optional here. You can paste them in the app instead (step 7), where they are
stored encrypted:

| Variable | Where to get it |
|---|---|
| `ANTHROPIC_API_KEY` | [console.anthropic.com](https://console.anthropic.com/settings/keys) |
| `ASSEMBLY_AI_API_KEY` | [assemblyai.com](https://www.assemblyai.com/dashboard) |
| `CLAUDE_MODEL` | Optional, default `claude-opus-5`. `claude-sonnet-5` is cheaper. |

Every other variable has a sensible default. The full list is in
[docs/configuration.md](docs/configuration.md).

## 6. Run it

From `web/`:

```bash
npx -y pnpm@10 dev
```

This starts the web app on **http://localhost:3000** and the background worker. Wait for
`Ready in …` and a `[worker] … started` line, then open the URL. The first page load compiles and
can take 10–20 seconds.

Keep this terminal open; stop everything with `Ctrl+C`.

## 7. First-time setup in the app

1. Open http://localhost:3000 and **sign up**. The first account becomes the **admin**.
2. Go to **Settings → AI and transcription**.
3. Paste your Anthropic key, click **Test connection**, pick a model and **Save**. Then paste your
   AssemblyAI key and **Save**. (Skip this if you put the keys in `.env.local`.)
4. Back on the home page, paste a YouTube URL or upload a video and start a generation.

Progress shows live. When it completes, your clips appear on the task page, ready to download,
restyle or edit.

---

## Optional: YouTube auto-post

To upload finished clips to a YouTube channel automatically, create a Google OAuth client and add to
`web/.env.local`:

```
GOOGLE_OAUTH_CLIENT_ID=...
GOOGLE_OAUTH_CLIENT_SECRET=...
```

Then restart `pnpm dev` and connect your channel under **Settings → YouTube**. The full Google Cloud
setup (APIs to enable, redirect URI, consent screen, quotas) is in [docs/youtube.md](docs/youtube.md).

## Everyday commands

Run these from `web/` unless noted.

| Task | Command |
|---|---|
| Start app + worker | `npx -y pnpm@10 dev` |
| Start only the web app / only the worker | `npx -y pnpm@10 run dev:web` / `npx -y pnpm@10 run worker` |
| Unit and integration tests | `npx -y pnpm@10 exec vitest run` |
| Type check | `npx -y pnpm@10 exec tsc --noEmit -p .` |
| Lint | `npx -y pnpm@10 run lint` |
| End-to-end tests | `npx -y pnpm@10 exec playwright test` |
| Production build | `npx -y pnpm@10 run build` |
| Engine tests (in `engine/`) | `uv run python -X utf8 -m pytest -q` |
| Update yt-dlp (in `engine/`) | `uv lock --upgrade-package yt-dlp && uv sync` |

With GNU make installed, the root `Makefile` wraps these: `make setup`, `make dev`, `make test`,
`make check`, `make build`.

## Troubleshooting

| Problem | Fix |
|---|---|
| `uv` or `ffmpeg` not found | Open a new terminal after installing, or add the tool's folder to `PATH`. |
| `Invalid environment configuration` | `MONGODB_URI` or `BETTER_AUTH_SECRET` is missing, or the secret is shorter than 32 characters. |
| Can't connect to MongoDB | Add your current IP under Atlas → **Network Access**; URL-encode special characters in the password. |
| "Worker offline" in the app | The worker isn't running. Use `pnpm dev` (starts both), or run `pnpm run worker` in a second terminal. |
| "Add your Anthropic API key…" | Save the keys in **Settings → AI and transcription**, or set them in `.env.local`. |
| YouTube download fails | Update yt-dlp (see the commands table), and make sure `node` is on `PATH`. |
| Captions missing or render fails | Your ffmpeg lacks libass/libx264; install a full build (see Prerequisites). |
| Windows: `Failed to load native binding` | Set `SWC_NATIVE_BINDING_CACHE` to a writable folder, e.g. `$env:SWC_NATIVE_BINDING_CACHE='C:\swc-cache'`, then rerun. |
| Windows: `python` opens the Microsoft Store | Ignore system Python; the engine uses `engine/.venv`, created by `uv sync`. |
| Git: "detected dubious ownership" | Run git as `git -c safe.directory='*' …`, or open the folder as its owner. |

More cases are in [docs/troubleshooting.md](docs/troubleshooting.md).

## Documentation

| Guide | What it covers |
|---|---|
| [Setup](docs/setup.md) | Longer version of this README |
| [Configuration](docs/configuration.md) | Every environment variable and its default |
| [Architecture](docs/architecture.md) | Components, request flows, jobs, data model, storage |
| [Claude integration](docs/claude-integration.md) | Keys, model choice, how selection works, costs |
| [YouTube auto-post](docs/youtube.md) | Google Cloud setup and how auto-posting behaves |
| [Testing](docs/testing.md) | Unit, engine, slow and end-to-end tests |
| [Troubleshooting](docs/troubleshooting.md) | Worker, yt-dlp, keys, ffmpeg, Windows issues |
| [Deploying to Vercel](docs/deploying-to-vercel.md) | What works today and what is still missing |
| [Design spec](docs/port/DESIGN.md) | Contracts for routes, collections, jobs and the engine |
| [Contributing](CONTRIBUTING.md) | Development workflow and checks |

## License

Clipwright is licensed under the [GNU Affero General Public License v3.0](LICENSE). Attribution and
details are in [NOTICE.md](NOTICE.md).

If you deploy a **modified** version for other people to use over a network, AGPL-3.0 section 13
requires you to offer them its source code. The app shows a "Source" link in the sidebar and on the
sign-in pages; set `NEXT_PUBLIC_SOURCE_CODE_URL` in `web/.env.local` to your own repository.
#   c l i p w r i g h t  
 