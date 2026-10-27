# Setup

Clipwright runs directly on Windows, macOS and Linux. There is no Docker setup. You need three
things running: the Next.js app, the Node worker (both started by `pnpm dev`) and a MongoDB
database (Atlas free tier works). The worker runs the Python render engine as a subprocess.

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
git clone <your Clipwright repository URL> clipwright
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
cp web/.env.example web/.env.local
```

Set at least these two values:

```env
MONGODB_URI=mongodb+srv://clipwright:YOUR_PASSWORD@cluster0.xxxxx.mongodb.net/?retryWrites=true&w=majority
BETTER_AUTH_SECRET=<at least 32 random characters>
```

Generate a secret with `openssl rand -base64 48`, or
`node -e "console.log(require('crypto').randomBytes(48).toString('base64'))"`.

Everything else has a working default. The Anthropic and AssemblyAI keys can go here
(`ANTHROPIC_API_KEY`, `ASSEMBLY_AI_API_KEY`) or be saved in the app later (step 7). Every variable is
described in [configuration](configuration.md).

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
download them, export platform presets, restyle, or open a clip in the editor.

If something does not work, see [troubleshooting](troubleshooting.md).
