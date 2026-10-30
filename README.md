<div align="center">

# Clipwright

**Turn long videos into short, captioned vertical clips with AI.**

Paste a YouTube link or upload a video. Clipwright transcribes it, lets Claude pick the best moments,
and renders 9:16 clips with face-tracking crops and word-synced captions.

[![License: AGPL-3.0](https://img.shields.io/badge/license-AGPL--3.0-blue.svg)](LICENSE)
![Node 22+](https://img.shields.io/badge/node-22%2B-339933?logo=node.js&logoColor=white)
![Python 3.11](https://img.shields.io/badge/python-3.11-3776AB?logo=python&logoColor=white)
![Next.js 15](https://img.shields.io/badge/Next.js-15-000000?logo=next.js&logoColor=white)
![MongoDB](https://img.shields.io/badge/MongoDB-Atlas-47A248?logo=mongodb&logoColor=white)

[Features](#features) •
[Quick start](#quick-start) •
[Setup guide](#setup-guide) •
[Commands](#commands) •
[Troubleshooting](#troubleshooting) •
[Docs](#documentation)

</div>

---

## Features

- 🎬 **Any source** — public YouTube videos or uploaded files (MP4, MOV, AVI, MKV, WebM, M4V; up to 4 GB).
- 🧠 **AI clip selection** — Claude reads the transcript and picks 15–60 second moments, each with a
  virality score, reasoning and a hook title.
- 📱 **Vertical rendering** — 9:16 crops that follow faces, split-screen and pan layouts, and
  animated word-by-word captions.
- ✂️ **Clip editor** — timeline, trimming, caption editing, undo/redo, combining clips, and
  TikTok / Reels / Shorts export presets.
- 🎨 **Restyle** — change the caption style of every clip at once.
- 📤 **YouTube auto-post** *(optional)* — upload finished clips as Shorts with AI-written titles and
  descriptions.
- 💻 **Runs locally** — Windows, macOS or Linux. No Docker.

## How it works

```
YouTube URL / upload
        │
        ▼
  Next.js web app  ──►  MongoDB job queue  ──►  Node worker
                                                   │
                     AssemblyAI (transcript) ◄─────┤
                     Claude (pick clips)     ◄─────┤
                     Python engine + ffmpeg  ◄─────┘  (download, crop, captions)
                                                   │
                                                   ▼
                                           clips in data/storage
```

| Part | Built with | Folder |
| --- | --- | --- |
| Web app and API | Next.js 15, React 19, Tailwind CSS v4, Better Auth | `web/` |
| Background worker | Node.js (tsx) | `web/src/worker/` |
| Render engine | Python 3.11, ffmpeg, OpenCV, yt-dlp | `engine/` |
| Database | MongoDB | — |

---

## Quick start

Already have Node 22+, uv, ffmpeg and a MongoDB connection string? Then:

```bash
git clone https://github.com/justtayyabkhxn/clipwright.git
cd clipwright

cd engine && uv sync && cd ..
cd web && npx -y pnpm@10 install
cp .env.example .env.local      # then set MONGODB_URI and BETTER_AUTH_SECRET
npx -y pnpm@10 dev
```

Open **http://localhost:3000**, sign up (the first account is the admin), and add your API keys under
**Settings → AI and transcription**.

New to any of these tools? Follow the step-by-step guide below.

---

## Setup guide

### Step 1 — Install the prerequisites

| Tool | Version | Check |
| --- | --- | --- |
| [Git](https://git-scm.com/downloads) | any | `git --version` |
| [Node.js](https://nodejs.org/) | 22 or newer | `node --version` |
| [uv](https://docs.astral.sh/uv/) | latest | `uv --version` |
| [ffmpeg](https://ffmpeg.org/download.html) | with libass and libx264 | `ffmpeg -version` |

> [!NOTE]
> You don't need to install Python or pnpm yourself: uv downloads Python 3.11 for the engine, and
> `npx -y pnpm@10` runs pnpm on demand.

<details>
<summary><b>Windows</b></summary>

<br>

```powershell
winget install Git.Git
winget install OpenJS.NodeJS.LTS
winget install astral-sh.uv
winget install Gyan.FFmpeg
```

Close and reopen your terminal afterwards so the new commands are on `PATH`.

</details>

<details>
<summary><b>macOS</b></summary>

<br>

```bash
brew install git node@22 uv ffmpeg
```

</details>

<details>
<summary><b>Linux (Debian / Ubuntu)</b></summary>

<br>

```bash
sudo apt install git ffmpeg fontconfig fonts-noto-core fonts-noto-cjk fonts-noto-color-emoji
curl -LsSf https://astral.sh/uv/install.sh | sh
```

For Node.js 22+, use [nvm](https://github.com/nvm-sh/nvm) or
[NodeSource](https://github.com/nodesource/distributions).

</details>

### Step 2 — Get the code

```bash
git clone https://github.com/justtayyabkhxn/clipwright.git
cd clipwright
```

> [!TIP]
> On Windows, clone into a short path such as `C:\src\clipwright` to avoid long-path errors.

### Step 3 — Install dependencies

```bash
# Python render engine (creates engine/.venv)
cd engine
uv sync
cd ..

# Web app and worker
cd web
npx -y pnpm@10 install
```

If pnpm prints an "Ignored build scripts" warning, you can ignore it.

### Step 4 — Create a free MongoDB database

1. Sign in to [MongoDB Atlas](https://cloud.mongodb.com/) and create a free **M0** cluster.
2. Under **Database Access**, add a user with a password.
3. Under **Network Access**, add your current IP address.
4. Click **Connect → Drivers** and copy the connection string:

   ```
   mongodb+srv://USER:PASSWORD@cluster0.xxxxx.mongodb.net/?retryWrites=true&w=majority
   ```

The app creates its collections automatically on first run.

### Step 5 — Configure

In the `web/` folder, copy the example config:

```bash
cp .env.example .env.local
```

<sub>PowerShell: `Copy-Item .env.example .env.local`</sub>

Then open `web/.env.local` and fill in:

```env
# Required
MONGODB_URI=mongodb+srv://USER:PASSWORD@cluster0.xxxxx.mongodb.net/?retryWrites=true&w=majority
BETTER_AUTH_SECRET=paste-a-random-string-of-at-least-32-characters

# Optional: you can also add these later in the app's Settings page
ANTHROPIC_API_KEY=sk-ant-...
ASSEMBLY_AI_API_KEY=...
```

Generate a secret with:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('base64'))"
```

> [!IMPORTANT]
> Don't change `BETTER_AUTH_SECRET` later: it also encrypts the API keys saved in the app.

Get your API keys from the [Anthropic Console](https://console.anthropic.com/settings/keys) and
[AssemblyAI](https://www.assemblyai.com/dashboard). Every other setting has a sensible default; see
[docs/configuration.md](docs/configuration.md) for the full list.

### Step 6 — Run

From the `web/` folder:

```bash
npx -y pnpm@10 dev
```

This starts the web app **and** the background worker. When you see `Ready`, open
**http://localhost:3000**. The first page load takes a few seconds while it compiles.

### Step 7 — Make your first clips

1. **Sign up.** The first account automatically becomes the admin.
2. Open **Settings → AI and transcription**, paste your Anthropic key, click **Test connection**,
   and save. Then save your AssemblyAI key. *(Skip this if you put the keys in `.env.local`.)*
3. Go back to the home page, paste a YouTube link or upload a video, and click **Generate clips**.

You can watch progress live. When it finishes, your clips are ready to download, restyle or edit. 🎉

---

## Optional: YouTube auto-post

Add a Google OAuth client to `web/.env.local`:

```env
GOOGLE_OAUTH_CLIENT_ID=...
GOOGLE_OAUTH_CLIENT_SECRET=...
```

Restart the app and connect your channel under **Settings → YouTube**. The full Google Cloud setup is
in [docs/youtube.md](docs/youtube.md).

## Commands

Run these in `web/` unless the table says otherwise.

| What | Command |
| --- | --- |
| Start app + worker | `npx -y pnpm@10 dev` |
| Run tests | `npx -y pnpm@10 exec vitest run` |
| Type check | `npx -y pnpm@10 exec tsc --noEmit -p .` |
| Lint | `npx -y pnpm@10 run lint` |
| End-to-end tests | `npx -y pnpm@10 exec playwright test` |
| Production build | `npx -y pnpm@10 run build` |
| Engine tests *(in `engine/`)* | `uv run python -X utf8 -m pytest -q` |
| Update yt-dlp *(in `engine/`)* | `uv lock --upgrade-package yt-dlp && uv sync` |

## Troubleshooting

<details>
<summary><b>"Invalid environment configuration"</b></summary>

<br>

`MONGODB_URI` or `BETTER_AUTH_SECRET` is missing from `web/.env.local`, or the secret is shorter
than 32 characters.

</details>

<details>
<summary><b>Can't connect to MongoDB</b></summary>

<br>

Add your current IP under Atlas → **Network Access**. If your password contains special characters
(`@ : / ? #`), URL-encode them in the connection string.

</details>

<details>
<summary><b>The app says "Worker offline"</b></summary>

<br>

The worker isn't running. Start the app with `npx -y pnpm@10 dev`, which runs both, or run
`npx -y pnpm@10 run worker` in a second terminal.

</details>

<details>
<summary><b>YouTube downloads fail</b></summary>

<br>

Update yt-dlp (see [Commands](#commands)) and make sure `node` is on your `PATH`.

</details>

<details>
<summary><b>Captions are missing or rendering fails</b></summary>

<br>

Your ffmpeg build lacks libass or libx264. Install a full build (see [Step 1](#step-1--install-the-prerequisites)).

</details>

<details>
<summary><b>Windows: "Failed to load native binding"</b></summary>

<br>

Point the SWC cache at a writable folder, then run again:

```powershell
$env:SWC_NATIVE_BINDING_CACHE = 'C:\swc-cache'
```

</details>

More fixes are in [docs/troubleshooting.md](docs/troubleshooting.md).

## Documentation

| Guide | Covers |
| --- | --- |
| [Setup](docs/setup.md) | Detailed installation guide |
| [Configuration](docs/configuration.md) | Every environment variable |
| [Architecture](docs/architecture.md) | How the pieces fit together |
| [Claude integration](docs/claude-integration.md) | Models, clip selection and costs |
| [YouTube auto-post](docs/youtube.md) | Google Cloud setup and behaviour |
| [Testing](docs/testing.md) | Unit, engine and end-to-end tests |
| [Troubleshooting](docs/troubleshooting.md) | Common problems and fixes |
| [Deploying to Vercel](docs/deploying-to-vercel.md) | Hosting status |
| [Contributing](CONTRIBUTING.md) | Development workflow |

## License

Clipwright is licensed under the [GNU AGPL-3.0](LICENSE). See [NOTICE.md](NOTICE.md) for
attribution.

If you host a modified version for other people, the AGPL requires you to share its source code: set
`NEXT_PUBLIC_SOURCE_CODE_URL` in `web/.env.local` to your repository.
