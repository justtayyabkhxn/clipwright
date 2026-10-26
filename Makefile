# Clipwright tasks. GNU make in Git Bash (Windows), macOS or Linux.
# Every target is a thin wrapper; the commands are also listed in docs/setup.md and docs/testing.md.

# pnpm when it is on PATH (e.g. after `corepack enable`), otherwise a one-off pnpm 10 through npx.
PNPM ?= $(shell command -v pnpm >/dev/null 2>&1 && echo pnpm || echo npx -y pnpm@10)

.PHONY: setup dev worker test test-web test-engine check build

setup:
	cd web && $(PNPM) install
	cd engine && uv sync
	@if [ ! -f web/.env.local ]; then cp web/.env.example web/.env.local; echo "Created web/.env.local: set MONGODB_URI and BETTER_AUTH_SECRET"; fi

dev:
	cd web && $(PNPM) dev

worker:
	cd web && $(PNPM) worker

test: test-web test-engine

test-web:
	cd web && $(PNPM) exec vitest run

test-engine:
	cd engine && uv run python -X utf8 -m pytest -q

check:
	cd web && $(PNPM) exec tsc --noEmit -p .
	cd web && $(PNPM) run lint

build:
	cd web && $(PNPM) run build
