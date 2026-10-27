# Deploying to Vercel

**Short version: not supported yet.** Clipwright was built so the web app can move to Vercel later,
but one piece is missing: shared file storage. Today, run everything on one machine (see
[setup](setup.md)). This page lists what is ready and what still has to be built.

## Target layout

```
Vercel (Next.js app: UI + API routes)  ──┐
                                         ├── MongoDB Atlas (shared)
Always-on machine (worker + engine)    ──┤
                                         └── Object storage, e.g. Vercel Blob or Cloudflare R2 (shared)
```

The web app on Vercel only reads and writes MongoDB and storage and enqueues jobs. A separate,
always-on machine (a VM, a home server, any box with Node 22, uv and ffmpeg) runs `pnpm worker`,
which claims the jobs and runs the Python engine. Both sides use the same `MONGODB_URI` and the
same storage bucket.

## What is ready

- **No Python, ffmpeg or long-running work in route handlers.** Every heavy step is a job in the
  `jobs` collection. Route handlers return in well under a second.
- **MongoDB only, no transactions in app code.** The client is cached on `globalThis`, which suits
  serverless functions. Atlas works from anywhere.
- **Progress by polling**, not SSE or WebSockets, so no long-lived connections.
- **`next build` needs no database or env** (configuration is parsed on first use), and the bundled
  fonts are included in the font routes' output (`outputFileTracingIncludes` in `next.config.ts`).
- **The worker is a separate process** with leases, heartbeats and a reaper, so it can run on any
  machine that reaches MongoDB. The UI already warns when no worker heartbeat is seen.
- **A `Storage` interface** (`web/src/server/storage.ts`) that every route and the worker go
  through, with strict key validation.
- **Browser-side editor export** (mediabunny) does not touch the server at all.

## What is missing

1. **A remote storage driver.** `STORAGE_DRIVER` accepts only `local`, and `LocalStorage` writes under
   `DATA_DIR`. Vercel functions have no persistent, shared disk, so uploads, clips, editor media,
   exports and user fonts would be lost or invisible to the worker. Needed: a Blob or R2 (S3 API)
   driver implementing the `Storage` interface. `localPath()` downloads to a local cache for the
   engine; `putFile()` uploads the engine's output.
2. **Direct-to-storage uploads.** Uploads are streamed through `POST /api/upload`, but Vercel caps a
   function's request body at a few megabytes, far below a video. Needed: `POST
   /api/upload/authorization` returning a signed (multipart) upload URL from the new driver, and
   client code in `web/src/lib/video-upload.ts` that uploads straight to storage when
   `directUpload` is true. The client currently ignores the authorization response and always
   posts to `/api/upload`. Font uploads (up to 10 MB) have the same issue.
3. **Serving files from storage.** Clip playback, editor media and downloads are streamed by route
   handlers with Range support (`serveStorageFile`). From Vercel they should redirect to short-lived
   signed URLs instead of proxying video through functions.
4. **Worker deployment.** Run `pnpm worker` (not `pnpm dev`) on the always-on machine with the same
   `web/.env.local` values plus storage credentials, under a process manager (systemd, pm2, a
   Windows service) that restarts it. `pnpm start` runs Next and the worker together for a
   single-machine production setup, which is not what you want here.

## Vercel settings once storage exists

- Root directory: `web`. Install `pnpm install`, build `pnpm build`.
- Environment variables: `MONGODB_URI`, `MONGODB_DB`, `BETTER_AUTH_SECRET` (the same value on the
  worker; it also decrypts saved keys unless `APP_SETTINGS_ENCRYPTION_KEY` is set on both),
  `BETTER_AUTH_URL=https://<your domain>`, `NEXT_PUBLIC_APP_URL=https://<your domain>`, and
  `NEXT_PUBLIC_SOURCE_CODE_URL` pointing at your fork's public source (AGPL-3.0 requires it for a
  modified version offered to users over a network).
- Atlas **Network Access** must allow Vercel's changing IPs (or use Atlas's Vercel integration) and
  the worker machine's IP.
- The Anthropic and AssemblyAI keys only need to reach the worker: set them on the worker machine or
  save them in Settings (stored encrypted in MongoDB).

If you build the storage driver, keep the key layout from
[architecture](architecture.md#storage-layout) and add it to `docs/port/DESIGN.md` §4.
