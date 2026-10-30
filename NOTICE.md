# Notice

## Upstream project

Clipwright is based on **SupoClip**, an open-source AI video clipping tool by
[FujiwaraChoki](https://github.com/FujiwaraChoki) and its contributors:

- Source: <https://github.com/FujiwaraChoki/supoclip>
- License: GNU Affero General Public License v3.0

Clipwright started from a fork of SupoClip with Claude support (commit `29dc44b` in this
repository's history) and keeps SupoClip's Python video renderer, clip-selection prompts and
algorithms, caption templates and editor design.

## This version

Clipwright is a **modified version** of SupoClip, distributed under the same
[GNU Affero General Public License v3.0](LICENSE). The main modifications, made starting in
October 2026:

- renamed to Clipwright, with a new logo;
- the FastAPI backend, PostgreSQL, Redis and the ARQ worker replaced by a Next.js app, MongoDB and a
  Node worker;
- the Python renderer turned into a command-line engine run by the worker;
- clip selection ported from Python to TypeScript and limited to Anthropic Claude;
- Docker removed; the app runs directly on Windows, macOS and Linux;
- many hosted-service features removed (billing, social publishing, analytics, API keys, MCP,
  B-roll, emails and others).

[CHANGELOG.md](CHANGELOG.md) lists the changes in more detail. The full history of modifications is
the git history of this repository.

## Your obligations

The AGPL-3.0 applies to Clipwright as a whole. In particular, section 13 requires that if you modify
Clipwright and let people use it over a network, you offer those users the complete corresponding
source code of your version. Clipwright links to its source from the sidebar and the sign-in pages;
set `NEXT_PUBLIC_SOURCE_CODE_URL` to your repository so that link points at your version.

Keep this notice and the [LICENSE](LICENSE) file in any copy or
derivative you distribute.

## Third-party components

Bundled fonts and their licenses are listed in [web/fonts/SOURCES.md](web/fonts/SOURCES.md). Other
dependencies are installed by pnpm and uv under their own licenses.
