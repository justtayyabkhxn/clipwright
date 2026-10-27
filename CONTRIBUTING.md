# Contributing to Clipwright

Thanks for helping. Clipwright is licensed under AGPL-3.0 (see [LICENSE](LICENSE) and
[NOTICE.md](NOTICE.md)). By submitting a contribution you agree that it is licensed under the same
AGPL-3.0 terms, and you confirm you have the right to submit it.

## Set up

Follow [docs/setup.md](docs/setup.md): Node 22+, pnpm 10 (or `npx -y pnpm@10`), uv, and ffmpeg with
libass and libx264. Then:

```bash
cd web && npx -y pnpm@10 install
cd ../engine && uv sync
```

For day-to-day development you need a `web/.env.local` with `MONGODB_URI` and
`BETTER_AUTH_SECRET`. The tests themselves need no database or API keys.

## Checks before a pull request

```bash
cd web
npx -y pnpm@10 exec tsc --noEmit -p .
npx -y pnpm@10 run lint
npx -y pnpm@10 exec vitest run

cd ../engine
uv run python -X utf8 -m pytest -q
```

Also run these when they apply:

- Changes to the worker, the engine runner or the engine CLI:
  `CLIPWRIGHT_SLOW_TESTS=1 npx -y pnpm@10 exec vitest run src/worker/integration.slow.test.ts`
  (in `web/`).
- Changes to pages or end-to-end flows: `npx -y pnpm@10 exec playwright test` (in `web/`).
- Changes to build config or server/client boundaries: `npx -y pnpm@10 run build`.

[docs/testing.md](docs/testing.md) explains every suite and has a manual checklist for changes that
need real keys.

## Style

- Read [CLAUDE.md](CLAUDE.md) for the conventions. In short: route handlers stay thin and never run
  Python or ffmpeg; heavy work is a job; multi-step writes are single-document compare-and-set
  updates; server modules the worker imports must not import `server-only` or `next/*`.
- If you change a route, collection, job payload, storage key or engine command, update
  [docs/port/DESIGN.md](docs/port/DESIGN.md) in the same pull request.
- New environment variables go in `web/src/server/env.ts`, `web/.env.example` and
  [docs/configuration.md](docs/configuration.md).
- TypeScript is strict and lint runs with `--max-warnings 0`. Keep the existing formatting.
- Python targets 3.11; keep the engine free of database access, LLM calls and env-var keys.
- UI copy goes in `web/messages/en/*.json`. The product name is Clipwright.
- Add or update tests with every behaviour change. Tests must not call paid APIs; use the fakes.
- Keep pull requests focused, and explain the user-visible effect in the description.

## Changelog

If a change is visible to people using Clipwright, add a line under "Unreleased" in
[CHANGELOG.md](CHANGELOG.md), tagged **New**, **Improved**, **Fixed** or **Under the hood**.
