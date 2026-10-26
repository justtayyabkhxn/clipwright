# Clipwright render engine

A Python CLI the Clipwright worker runs as a subprocess for everything that needs
ffmpeg, OpenCV, yt-dlp or AssemblyAI. The protocol and every command's request and
result are specified in `docs/port/DESIGN.md` §7.

```
<json request> | python -X utf8 -m clipwright_engine <command>
```

stdout carries only NDJSON events (`progress`, `clip_start`, `clip`, `clip_failed`,
then `result` or `error`); logs go to stderr. Exit codes: 0 success, 1 error,
2 cancelled (the request's `cancel_file` appeared; ffmpeg children are killed first).

## Setup

Requires Python 3.11 (managed by uv) and `ffmpeg`, `ffprobe` and `node` (>= 22, the
yt-dlp JS runtime) on `PATH`. The ffmpeg build needs libx264, libass, zscale is optional.

```
cd engine
uv sync                 # creates engine/.venv
uv run pytest           # unit and CLI tests (synthetic ffmpeg sources, no network)
CLIPWRIGHT_NETWORK_TESTS=1 uv run pytest tests/test_network.py   # one real YouTube fetch
```

Fonts come from the request's `fonts_dirs` (the bundled `web/fonts` first). The
caption templates in `clipwright_engine/caption_templates.py` are the source of
`web/src/lib/caption-templates.json`; `tests/test_engine_helpers.py` checks they match.
