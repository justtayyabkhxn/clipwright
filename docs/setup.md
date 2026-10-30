# Setup

Clipwright runs directly on Windows, macOS and Linux. There is no Docker setup. You need three
things running: the Next.js app, the Node worker (both started by `pnpm dev`) and a MongoDB
database (Atlas free tier works). The worker runs the Python render engine as a subprocess.

## In short

```bash
cd engine && uv sync && cd ..              # 1. Python render engine (one time)
cd web && npx -y pnpm@10 install           # 2. web dependencies (one time)
cp .env.example .env.local                 # 3. then set MONGODB_URI and BETTER_AUTH_SECRET
npx -y pnpm@10 dev                         # 4. app + worker on http://localhost:3000
```

Then sign up (the first account is the admin), add the Anthropic and AssemblyAI keys in
**Settings → AI and transcription**, and generate clips from the home page. On Windows, if step 4
fails with "Failed to load native binding", see [step 5](#windows-failed-to-load-native-binding).
The sections below explain each step.

## 1. Prerequisites

| Tool | Version | Why |
|---|---|---|
| Node.js | 22 or newer | The web app and worker. Also the JavaScript runtime yt-dlp uses for YouTube, so `node` must be on `PATH`. |
| pnpm | 10 (the repo pins `pnpm@10.27.0`) | Installs the web dependencies. |
| uv | recent | Installs Python 3.11 and the engine's dependencies into `engine/.venv`. You do not need a system Python. |
| ffmpeg and ffprobe | a build with **libass** and **libx264** | Rendering, captions and probing. `zscale` is optional. |

### Node.js

- Windows: the LTS installer from [nodejs.org](https://nodejs.org/), or `winget install OpenJS.NodeJS.LTS`.
- macOS: `brew install node@22` (or the nodejs.org installer, or nvm).
- Linux: your distribution's Node 22 package, NodeSource, or nvm.

Check with `node --version`.

### pnpm

Either enable it through Corepack, which reads the pinned version from `web/package.json`:

```bash
corepack enable
```

or skip installing it and prefix every command with `npx -y pnpm@10` instead of `pnpm`, for
example `npx -y pnpm@10 install`. (Corepack ships with Node 22 and 24. If your Node has no
`corepack` command, run `npm install -g corepack` or use the `npx` form.)

### uv

- Windows: `powershell -ExecutionPolicy ByPass -c "irm https://astral.sh/uv/install.ps1 | iex"` (or `winget install astral-sh.uv`).
- macOS/Linux: `curl -LsSf https://astral.sh/uv/install.sh | sh` (or `brew install uv`).

### ffmpeg

- **Windows:** download a build from [gyan.dev](https://www.gyan.dev/ffmpeg/builds/). The
  "essentials" and "full" builds both include libass and libx264. Unzip it to a short path such as
  `C:\ffmpeg` and add `C:\ffmpeg\bin` to your user `PATH`, then open a new terminal.
- **macOS:** `brew install ffmpeg`.
- **Linux (Debian/Ubuntu):** `sudo apt install ffmpeg`. For emoji and non-Latin captions also
  install `fontconfig fonts-noto-core fonts-noto-cjk fonts-noto-color-emoji`.

Check that the build has what Clipwright needs:

```bash
ffmpeg -hide_banner -filters | grep -E " (ass|subtitles) "     # both lines must appear
ffmpeg -hide_banner -encoders | grep libx264
ffprobe -version
```

(In PowerShell use `findstr` instead of `grep`.)

## 2. Get the code and install dependencies

```bash
git clone https://github.com/justtayyabkhxn/clipwright.git clipwright
cd clipwright

cd web
pnpm install                      # or: npx -y pnpm@10 install
cd ../engine
uv sync                           # creates engine/.venv with Python 3.11
cd ..
```

If you have GNU make (macOS, Linux, or Git Bash with make installed), `make setup` does the same and
also copies `web/.env.example` to `web/.env.local` when it does not exist yet.

On Windows, keep the checkout at a short path (for example `C:\src\clipwright`); see
[troubleshooting](troubleshooting.md#windows-long-paths).

## 3. MongoDB Atlas M0

Clipwright stores everything except media files in MongoDB. The free Atlas tier is enough.

1. Sign up or sign in at [cloud.mongodb.com](https://cloud.mongodb.com/).
2. Create a project (any name), then **Create** a cluster and choose the free **M0** tier. Pick a
   provider and a region near you.
3. **Database Access → Add New Database User.** Choose password authentication, a username and a
   password, and the built-in role "Read and write to any database". Save the password; avoid
   characters like `@ : / ? #` or URL-encode them in the connection string.
4. **Network Access → Add IP Address.** Add your current IP address. (Allowing `0.0.0.0/0` works for a
   quick test but opens the cluster to the internet; remove it afterwards.)
5. On the cluster, click **Connect → Drivers**, choose Node.js, and copy the connection string. It looks
   like `mongodb+srv://<user>:<password>@<cluster>.mongodb.net/?retryWrites=true&w=majority`.
   Replace `<password>` with the real password.

You do not need to create a database or collections: `MONGODB_DB` (default `clipwright`) names the
database, and the app and worker create the collections and indexes on first use.

Atlas is a replica set, so leave `MONGODB_TRANSACTIONS=true`. If you use a standalone local `mongod`
instead, set `MONGODB_TRANSACTIONS=false`.

## 4. Configure `web/.env.local`

```bash
cp web/.env.example web/.env.local        # PowerShell: Copy-Item web\.env.example web\.env.local
```

Both the Next app and the worker read this file.

**Required:**

| Variable | Value |
|---|---|
| `MONGODB_URI` | Your Atlas connection string from step 3, e.g. `mongodb+srv://clipwright:YOUR_PASSWORD@cluster0.xxxxx.mongodb.net/?retryWrites=true&w=majority`. URL-encode special characters in the password, and allow your IP under Atlas → **Network Access**. |
| `BETTER_AUTH_SECRET` | At least 32 random characters. It signs sessions, and it also encrypts the keys saved in Settings unless `APP_SETTINGS_ENCRYPTION_KEY` is set. |

Generate a secret with `openssl rand -base64 48`, or
`node -e "console.log(require('crypto').randomBytes(48).toString('base64'))"`. Don't change it
later without also setting `APP_SETTINGS_ENCRYPTION_KEY` to the old value, or keys saved in Settings
can no longer be read (save them again if that happens).

**API keys.** You can leave these empty and save them in the app after signing up (step 7); saved
keys are encrypted in MongoDB. A value set here wins over a saved one unless the admin ticks "use
the saved values instead".

| Variable | Value |
|---|---|
| `ANTHROPIC_API_KEY` | `sk-ant-…` from the [Anthropic Console](https://console.anthropic.com/settings/keys). Usage is billed by Anthropic. |
| `ASSEMBLY_AI_API_KEY` | Your AssemblyAI key, used for transcription. Usage is billed by AssemblyAI. |
| `CLAUDE_MODEL` | Optional. Default `claude-opus-5`; `claude-sonnet-5` is cheaper. |

**Defaults that are fine for a local run** (leave them as they are):

| Variable | Default |
|---|---|
| `BETTER_AUTH_URL` | `http://localhost:3000` |
| `MONGODB_DB` | `clipwright` |
| `MONGODB_TRANSACTIONS` | `true`. Atlas supports transactions; set `false` only for a standalone local `mongod`. |
| `DATA_DIR` | `<repo>/data`. Uploads, clips and exports are stored here. On Windows keep it short and ASCII. |
| `ENGINE_PYTHON` | `engine/.venv/Scripts/python.exe` on Windows, `engine/.venv/bin/python` elsewhere |
| `WORKER_CONCURRENCY` | `1` |

**Before you put it online for other people,** set `NEXT_PUBLIC_SOURCE_CODE_URL` to the public
repository of your version. Clipwright is AGPL-3.0, so a modified version that others use over a
network must offer them its source; the app's "Source" link points there.

Every variable, including the limits (`MAX_VIDEO_DURATION`, `MAX_CLIPS`, upload size) and
processing options, is described in [configuration](configuration.md).

## 5. Start Clipwright

```bash
cd web
pnpm dev                          # or: npx -y pnpm@10 dev
```

This starts two processes with prefixed logs:

- `web`: Next.js on [http://localhost:3000](http://localhost:3000) (Turbopack).
- `worker`: the job worker (`tsx watch src/worker/main.ts`). It restarts on code changes.

Other scripts: `pnpm dev:web` (Next only), `pnpm worker` (worker only), and for a production-style
run `pnpm build` then `pnpm start` (both processes again).

`http://localhost:3000/api/health` returns `{"ok": true, "db": true, "worker": {"online": true, ...}}`
when the database answers and the worker is alive.

If the home page says **the worker isn't running**, only the web process started. `pnpm dev` runs
both; otherwise start the worker in a second terminal with `pnpm worker`. Jobs created while the
worker was down wait in the queue and run once it starts.

### Windows: "Failed to load native binding"

On some Windows machines `pnpm dev` or `pnpm build` stops while loading `next.config.ts` with
`Failed to load native binding` (from `@swc/core`). SWC refuses to use its default binary cache when
the folder's permissions allow other accounts to replace files. Point it at a folder only your
account controls, in the same terminal before starting:

```powershell
# PowerShell
$env:SWC_NATIVE_BINDING_CACHE = "C:\swc-cache-claude"
```

```bash
# Git Bash
export SWC_NATIVE_BINDING_CACHE='C:\swc-cache-claude'
```

On the original development machine `C:\swc-cache-claude` already exists with the right
permissions. Elsewhere, create a folder that only your account can access and use that path. In
PowerShell:

```powershell
New-Item -ItemType Directory -Force C:\swc-cache | Out-Null
icacls C:\swc-cache /inheritance:r /grant:r "${env:USERNAME}:(OI)(CI)F"
$env:SWC_NATIVE_BINDING_CACHE = "C:\swc-cache"
```

More in [troubleshooting](troubleshooting.md).

## 6. Create the admin account

Open [http://localhost:3000](http://localhost:3000). Signed out, you land on the sign-in page. Choose
**Sign up** and create an account. **The first account created becomes the admin.** Addresses listed
in `ADMIN_EMAILS` also become admins when they sign up. Set `DISABLE_SIGN_UP=true` afterwards if
nobody else should register.

There is no email provider. "Forgot password" prints the reset link to the terminal running
`pnpm dev`: `[auth] Password reset link for <email>: <url>`.

## 7. Add the AI keys

As the admin, open **Settings → AI and transcription**:

1. Paste an Anthropic API key (from the [Anthropic Console](https://console.anthropic.com/settings/keys))
   and click **Test connection**. The test uses the free Models API.
2. Pick a Claude model (default Claude Opus 5) and click **Save**.
3. Paste an AssemblyAI API key (from your AssemblyAI dashboard) and click **Save key**. There is no
   free AssemblyAI test; the first generation shows whether it works.

The keys are encrypted in MongoDB and never sent back to the browser. Other users see the status
read-only. Usage is billed to your Anthropic and AssemblyAI accounts. More in
[Claude integration](claude-integration.md).

## 8. Make your first clips

On the home page paste a YouTube URL or upload a video file, pick the caption style and options,
and start. Progress updates every 2 seconds. Finished clips appear on the task page, where you can
download them, export platform presets, restyle, or open a clip in the editor. If a generation
fails, the task page shows the reason (for example a missing key).

## 9. Keeping it working

- **YouTube downloads failing:** YouTube changes often and yt-dlp follows. Update it with
  `cd engine && uv lock --upgrade-package yt-dlp && uv sync`, then restart `pnpm dev`.
- **Password reset:** there is no email provider, so "Forgot password" prints the reset link in the
  terminal running `pnpm dev`.
- **Your files** live under `DATA_DIR` (default `data/` in the repo). Deleting a task deletes its
  clips; uploads and downloaded YouTube sources that no task uses are cleaned up after 24 hours.

If something does not work, see [troubleshooting](troubleshooting.md).
