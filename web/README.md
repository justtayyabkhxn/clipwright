# Clipwright web

The Next.js 15 app: UI, API route handlers and the Node worker (`src/worker`). See
[`docs/port/DESIGN.md`](../docs/port/DESIGN.md) for the architecture.

```bash
pnpm install
pnpm dev          # Next on :3000 plus the worker
pnpm dev:web      # Next only
pnpm worker       # worker only
pnpm test         # vitest
pnpm lint
pnpm test:e2e     # Playwright; needs MONGODB_URI (a replica set) for the seeded specs
```

Configuration lives in `web/.env.local` (see `.env.example`). The Claude and AssemblyAI keys can
instead be saved by an admin under **Settings → AI**.

UI copy is English only, kept in `messages/en/*.json` and loaded through next-intl.

## License

Clipwright is based on [SupoClip](https://github.com/FujiwaraChoki/supoclip) and is licensed under
AGPL-3.0, like the upstream project. The app links to its source from the sidebar and the sign-in
pages; set `NEXT_PUBLIC_SOURCE_CODE_URL` to point that link at your own fork.
