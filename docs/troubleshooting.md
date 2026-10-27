# Troubleshooting

Start with `http://localhost:3000/api/health`. It returns
`{"ok": ..., "db": ..., "worker": {"online": ..., "heartbeatAt": ...}}` and HTTP 503 unless both the
database and the worker are fine. Worker logs are the `worker` lines in the `pnpm dev` terminal;
engine stderr is included at the end of engine error messages.

## The worker is offline

**Symptom:** a toast or banner says "The Clipwright worker isn't running", and tasks stay at
`queued`.

- `pnpm dev` starts both Next and the worker. If you ran `pnpm dev:web` or `next dev`, start the
  worker separately with `pnpm worker` (in `web/`). Queued jobs run as soon as it starts.
- If the worker exits at once, read its first error. Common ones: `Invalid environment
  configuration: MONGODB_URI is required` (it reads `web/.env.local`, so run it from `web/`), or a
  MongoDB connection error (below).
- The UI calls the worker online when its heartbeat (written every 10 s to `worker_status`) is less
  than 30 s old. A worker that is alive but stuck on a database connection shows as offline.
- A job interrupted by a crash goes back to the queue when its 60 s lease expires. After its last
  attempt the task shows "The worker stopped while processing this video. Resume to try again."

## MongoDB connection errors

- `MongoServerSelectionError` / timeouts: your IP is not in Atlas **Network Access**, or a VPN or
  firewall blocks port 27017. Add the current IP in Atlas.
- `bad auth : authentication failed`: wrong user or password in `MONGODB_URI`. URL-encode special
  characters in the password.
- Sign-up fails with a transaction error on a local standalone `mongod`: set
  `MONGODB_TRANSACTIONS=false`, or run `mongod --replSet rs0` and initiate the replica set.

## Missing keys

- "Add your Anthropic API key in Settings → AI before generating clips." or "Add your AssemblyAI API
  key in Settings → AI before generating clips.": an admin must save the key under **Settings → AI
  and transcription**, or set `ANTHROPIC_API_KEY` / `ASSEMBLY_AI_API_KEY` in `web/.env.local` and
  restart. Then **Resume** the task.
- The settings page lists missing keys under "Missing: ...". Non-admins only see the status; ask an
  admin.
- A key was saved but the error persists: if `APP_SETTINGS_ENCRYPTION_KEY` (or
  `BETTER_AUTH_SECRET`, when the former is unset) changed after saving, the stored key cannot be
  decrypted any more (the server logs `[settings] Unable to decrypt runtime setting ...`). Save it
  again.
- Claude errors and their fixes: see [Claude integration](claude-integration.md#troubleshooting).

## YouTube downloads fail

**Symptom:** the task fails during "Downloading video..." with "YouTube download failed: ...".

1. **Update yt-dlp.** YouTube changes often and old yt-dlp versions break. In `engine/`:

   ```bash
   uv lock --upgrade-package yt-dlp
   uv sync
   ```

   (`uv lock --upgrade-package yt-dlp --dry-run` shows whether a newer version exists.) Restart the
   worker afterwards. Commit the updated `engine/uv.lock` if you maintain a fork.
2. **Node must be on `PATH`** for the worker: yt-dlp uses Node as its JavaScript runtime to solve
   YouTube's challenges. Check `node --version` in the same terminal.
3. **Private, age-restricted, members-only or region-locked videos** cannot be downloaded; there is
   no cookie or proxy support. Live streams are not supported. Use a public video or download it
   yourself and upload the file.
4. "Sign in to confirm you're not a bot" usually means YouTube is rate-limiting your IP. Wait, try
   another network, or upload the file instead.
5. "Video is too long (N min). Maximum allowed duration is M minutes.": raise `MAX_VIDEO_DURATION`
   (seconds) or use a shorter video.
6. To test yt-dlp alone: `cd engine && CLIPWRIGHT_NETWORK_TESTS=1 uv run python -X utf8 -m pytest tests/test_network.py`.

Only YouTube URLs (youtube.com, m.youtube.com, music.youtube.com, youtu.be) and uploaded files are
accepted; other sites are rejected when the task is created.

## AssemblyAI errors

These surface during "Generating transcript...".

| Message | Fix |
|---|---|
| "An AssemblyAI API key is required to transcribe this video." | Save the AssemblyAI key (see "Missing keys"). |
| "AssemblyAI audio upload unavailable after 5 attempts (network error: ConnectError)." (or another `...Error`) | The worker could not reach AssemblyAI for about 30 seconds: Wi-Fi, VPN or DNS dropped, or a firewall or antivirus blocked Python. The worker log shows each failed attempt with the full reason (`AssemblyAI audio upload failed (...)`). Check your connection and click **Resume**: the downloaded video is cached, so only the transcription is redone. |
| "AssemblyAI audio upload unavailable after 5 attempts (HTTP 5xx)." | AssemblyAI is having trouble. Resume the task later. |
| An authentication error from AssemblyAI (HTTP 401) | The key is wrong or revoked; it is not retried. Copy it again from the AssemblyAI dashboard. |
| "AssemblyAI transcript ... did not complete within 900s" | Long video or a slow queue. Raise `ASSEMBLY_AI_HTTP_TIMEOUT_SECONDS`, then resume. |
| "Transcription failed: ..." | AssemblyAI rejected the audio (for example no speech, unsupported language, or an account limit). Check the message and your AssemblyAI account. Set `TRANSCRIPTION_LANGUAGE` if detection picks the wrong language. |
| Keys from an EU AssemblyAI project fail | Set `ASSEMBLYAI_BASE_URL=https://api.eu.assemblyai.com`. |

## ffmpeg problems

- "Could not start the render engine" or errors mentioning `ffmpeg`/`ffprobe` not found: ffmpeg is
  not on the worker's `PATH`. Open a new terminal after editing `PATH` and check `ffmpeg -version`.
- **ffmpeg without libass:** clips fail to render, with an error like `No such filter: 'ass'` or
  `No such filter: 'subtitles'` in the engine output. Install a build with libass: gyan.dev
  "essentials" or "full" on Windows, `brew install ffmpeg` on macOS, `apt install ffmpeg` on
  Debian/Ubuntu. Check with `ffmpeg -hide_banner -filters | grep -E " (ass|subtitles) "`.
- `Unknown encoder 'libx264'`: the build lacks libx264; use one of the builds above.

## Captions

- **Emoji are missing from captions.** The engine adds caption emojis only when libass can render
  the colour font "Noto Color Emoji". It probes this once per worker process by burning one emoji,
  and logs `Caption colour-emoji rendering supported: False` (or "Emoji support probe failed ...;
  disabling caption emojis") when it cannot. The captions still render, with keyword emphasis but
  no emoji. On Linux install `fonts-noto-color-emoji` (and `fontconfig`); on macOS and Windows install
  the Noto Color Emoji font. Windows' own Segoe UI Emoji is not used. Restart the worker after
  installing fonts.
- Non-Latin characters show as boxes or a different font: the chosen caption font lacks those
  glyphs. Pick a font whose info popover lists the language, upload one, or install the Noto fonts.

## Windows

### `python` opens the Microsoft Store, or exits with code 9009

The `python.exe` on `PATH` is the Store stub. Clipwright never needs it: the engine runs with
`engine/.venv/Scripts/python.exe`, created by `uv sync`. Make sure you ran `uv sync` in `engine/`,
and do not set `ENGINE_PYTHON=python`. To run engine commands by hand, use `uv run python ...` or
the venv's interpreter. You can also turn the stub off under **Settings → Apps → Advanced app
settings → App execution aliases** (`python.exe`, `python3.exe`).

### `next build` fails with "Failed to load native binding"

SWC (pulled in through next-intl's `@swc/core`) unpacks its native addon into a cache directory.
When the default cache location has restrictive ACLs, loading the binding fails. Point the cache at
a folder you own:

```bash
# Git Bash
export SWC_NATIVE_BINDING_CACHE='C:\swc-cache'
# PowerShell
$env:SWC_NATIVE_BINDING_CACHE = 'C:\swc-cache'
```

then run `npx -y pnpm@10 run build` again. Create the folder first, and set the variable for your
user permanently (System Properties → Environment Variables) if it keeps happening.

### Windows long paths

`node_modules` and the engine's work dirs can exceed the old 260-character path limit, which shows up
as `ENOENT`, `EPERM` or "path too long" errors during `pnpm install` or rendering.

- Clone to a short path such as `C:\src\clipwright`, and keep `DATA_DIR` short and ASCII (for example
  `DATA_DIR=C:\cw-data`).
- Enable long paths (admin PowerShell, then reboot):
  `New-ItemProperty -Path "HKLM:\SYSTEM\CurrentControlSet\Control\FileSystem" -Name LongPathsEnabled -Value 1 -PropertyType DWORD -Force`
- For git: `git config --global core.longpaths true`.

### "dubious ownership" from git

If the folder was created by another Windows account, git refuses to run. Either take ownership of
the folder, or pass `-c safe.directory=C:/path/to/clipwright` to each git command.

## Other

- **Upload fails with 413:** the file is bigger than `MAX_VIDEO_UPLOAD_BYTES` (default 4 GB). Raise it
  and `NEXT_PUBLIC_MAX_VIDEO_UPLOAD_BYTES` together, then restart.
- **"We couldn't find this uploaded video. Upload it again.":** uploads that no task uses are deleted
  after 24 hours. Upload the file again.
- **Restyle failed or was cancelled:** the task returns to `completed` with "Restyle failed. Your
  existing clips are unchanged." (or "Restyle cancelled. ..."), and the previous settings are restored.
- **Password reset email never arrives:** there is no email provider. The reset link is printed in
  the `pnpm dev` terminal as `[auth] Password reset link for <email>: <url>`.
