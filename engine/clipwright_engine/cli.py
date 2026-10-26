"""JSON-over-stdio CLI: ``python -X utf8 -m clipwright_engine <command>``.

The request is one JSON object on stdin. stdout carries only NDJSON events
(progress, clip_start, clip, clip_failed, then a final result or error); logs
go to stderr. Exit codes: 0 success, 1 error, 2 cancelled.

Heavy libraries (OpenCV, yt-dlp, the AssemblyAI SDK) are imported by the
command that needs them, so starting the process stays cheap.
"""

from __future__ import annotations

import json
import logging
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import weakref
from pathlib import Path
from types import SimpleNamespace
from typing import Any, Callable, Dict, TextIO

from .config import EngineConfig, get_config, normalize_transcription_language, set_config

EXIT_OK, EXIT_ERROR, EXIT_CANCELLED = 0, 1, 2
CANCEL_POLL_SECONDS = 0.25

logger = logging.getLogger("clipwright_engine")


class EngineError(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


class Events:
    """NDJSON writer. The lock keeps lines whole when the cancel watcher writes."""

    def __init__(self, stream: TextIO):
        self.stream = stream
        self.lock = threading.Lock()

    def write(self, payload: Dict[str, Any]) -> None:
        self.stream.write(json.dumps(payload, ensure_ascii=False, allow_nan=False) + "\n")
        self.stream.flush()

    def emit(self, type: str, **fields: Any) -> None:
        with self.lock:
            self.write({"type": type, **fields})

    def progress(self, message: str) -> Callable[[int], None]:
        return lambda pct: self.emit("progress", pct=pct, message=message)


# Every child process (ffmpeg, ffprobe, yt-dlp's helpers) is tracked so the
# cancel watcher can stop them before exiting. Windows children also get no
# console window of their own.
_children: "weakref.WeakSet[subprocess.Popen]" = weakref.WeakSet()
_cancelling = threading.Event()
# Spawn+register and the cancel sweep exclude each other, so a child started
# while cancelling is either refused or registered in time to be killed.
_spawn_lock = threading.Lock()
_BasePopen = subprocess.Popen


class _TrackedPopen(_BasePopen):
    def __init__(self, *args, **kwargs):
        if os.name == "nt":
            kwargs["creationflags"] = kwargs.get("creationflags", 0) | subprocess.CREATE_NO_WINDOW
        with _spawn_lock:
            if _cancelling.is_set():
                raise OSError("Cancelled")
            super().__init__(*args, **kwargs)
            _children.add(self)


def _kill_children() -> None:
    with _spawn_lock:
        _cancelling.set()
        for child in list(_children):
            try:
                if child.poll() is None:
                    child.kill()
            except OSError:
                pass


def _watch_cancel(cancel_file: Path, events: Events) -> None:
    while not cancel_file.exists():
        time.sleep(CANCEL_POLL_SECONDS)
    _kill_children()
    # Holding the lock means nothing else reaches stdout after this line.
    events.lock.acquire()
    try:
        events.write({"type": "error", "code": "cancelled", "message": "Cancelled"})
    finally:
        os._exit(EXIT_CANCELLED)


# --- request helpers -------------------------------------------------------


def _string(request: Dict[str, Any], key: str) -> str:
    value = request.get(key)
    if not isinstance(value, str) or not value.strip():
        raise EngineError("invalid_request", f"{key} is required")
    return value.strip()


def _path(request: Dict[str, Any], key: str, must_exist: bool = False) -> Path:
    path = Path(_string(request, key))
    if not path.is_absolute():
        raise EngineError("invalid_request", f"{key} must be an absolute path")
    if must_exist and not path.is_file():
        raise EngineError("not_found", f"File not found: {path}")
    return path


def _media_error(exc: Exception) -> EngineError:
    return EngineError("render_failed", str(exc) or "Rendering failed")


def _probe(path: Path) -> Dict[str, Any]:
    from .media.ffmpeg import ffprobe_duration, ffprobe_has_audio
    from .media.source_limits import probe_video_geometry

    geometry = probe_video_geometry(path)
    try:
        if geometry is None:
            raise RuntimeError
        duration = ffprobe_duration(path)
    except RuntimeError:
        raise EngineError("invalid_request", f"Could not read the video file: {path.name}")
    return {
        "duration": duration,
        "width": geometry.display_width,
        "height": geometry.display_height,
        "fps": geometry.fps,
        "has_audio": ffprobe_has_audio(path),
    }


# --- commands --------------------------------------------------------------


def cmd_probe(request: Dict[str, Any], events: Events) -> Dict[str, Any]:
    return _probe(_path(request, "path", must_exist=True))


def cmd_youtube_info(request: Dict[str, Any], events: Events) -> Dict[str, Any]:
    from .youtube_utils import get_youtube_video_id, get_youtube_video_info

    url = _string(request, "url")
    video_id = get_youtube_video_id(url)
    if not video_id:
        raise EngineError("invalid_request", "Invalid YouTube URL")
    try:
        info = get_youtube_video_info(url)
    except Exception as exc:
        raise EngineError("metadata_unavailable", f"Could not read this YouTube video: {exc}")
    return {
        "video_id": info.get("id") or video_id,
        "title": info.get("title"),
        "duration": info.get("duration"),
        "thumbnail": info.get("thumbnail"),
        "uploader": info.get("uploader"),
    }


def cmd_fetch_youtube(request: Dict[str, Any], events: Events) -> Dict[str, Any]:
    from .media.source_limits import normalize_source_media
    from .youtube_utils import download_youtube_video, get_youtube_video_id

    url = _string(request, "url")
    video_id = request.get("video_id") or get_youtube_video_id(url)
    if not isinstance(video_id, str) or not video_id:
        raise EngineError("invalid_request", "Invalid YouTube URL")
    output = _path(request, "output_path")
    from_cache = output.is_file() and output.stat().st_size > 0
    if not from_cache:
        progress = events.progress("Downloading video...")
        progress(0)
        try:
            downloaded = download_youtube_video(
                url,
                video_id,
                Path(request["work_dir"]) / "download",
                request.get("max_height") or get_config().youtube_max_height,
                on_progress=progress,
            )
        except RuntimeError as exc:
            raise EngineError("download_failed", str(exc))
        # Normalize before publishing so the stored file is only ever final.
        try:
            normalize_source_media(downloaded)
        except RuntimeError as exc:
            raise _media_error(exc)
        output.parent.mkdir(parents=True, exist_ok=True)
        try:
            os.replace(downloaded, output)
        except OSError:
            if not output.is_file():  # another volume: copy instead of rename
                shutil.move(str(downloaded), str(output))
        progress(100)
    info = _probe(output)
    return {
        "video_path": str(output),
        "duration": info["duration"],
        "width": info["width"],
        "height": info["height"],
        "from_cache": from_cache,
    }


def cmd_prepare_source(request: Dict[str, Any], events: Events) -> Dict[str, Any]:
    from .media.source_limits import exceeds_output_limits, normalize_source_media, probe_video_geometry

    path = _path(request, "video_path", must_exist=True)
    limit = int(request.get("max_duration_seconds") or get_config().max_video_duration)
    duration = _probe(path)["duration"]
    if duration > limit:
        raise EngineError(
            "too_long",
            f"Video is too long ({int(duration) // 60} min). "
            f"Maximum allowed duration is {limit // 60} minutes.",
        )
    before = probe_video_geometry(path)
    normalized = bool(
        before and exceeds_output_limits(before.display_width, before.display_height, before.fps)
    )
    try:
        normalize_source_media(path)
    except RuntimeError as exc:
        raise _media_error(exc)
    info = _probe(path)
    return {
        "duration": info["duration"],
        "width": info["width"],
        "height": info["height"],
        "normalized": normalized,
    }


def cmd_transcribe(request: Dict[str, Any], events: Events) -> Dict[str, Any]:
    from .media.transcription import (
        _get_transcript_with_assemblyai,
        format_transcript_for_analysis,
        load_cached_transcript_data,
    )

    video = _path(request, "video_path", must_exist=True)
    sidecar = load_cached_transcript_data(video)
    if sidecar and sidecar.get("words"):
        # Word timings are already paid for; rebuild the analysis text from them.
        text = "\n".join(format_transcript_for_analysis(sidecar))
    else:
        api_key = request.get("assemblyai_api_key")
        if not isinstance(api_key, str) or not api_key.strip():
            raise EngineError("transcription_failed", "An AssemblyAI API key is required to transcribe this video.")
        config = get_config()
        language = (
            normalize_transcription_language(request["language"])
            if request.get("language") is not None
            else config.transcription_language
        )
        runtime = SimpleNamespace(
            assembly_ai_api_key=api_key.strip(),
            assembly_ai_http_timeout_seconds=config.assembly_ai_http_timeout_seconds,
            assembly_ai_request_timeout_seconds=config.assembly_ai_request_timeout_seconds,
            transcription_language=language,
        )
        try:
            text = _get_transcript_with_assemblyai(video, "universal-3-5-pro", runtime)
        except Exception as exc:
            raise EngineError("transcription_failed", str(exc) or "Transcription failed")
        sidecar = load_cached_transcript_data(video) or {}
    return {
        "transcript_text": text,
        "language_code": sidecar.get("language_code"),
        "word_count": len(sidecar.get("words") or []),
    }


def cmd_signals(request: Dict[str, Any], events: Events) -> Dict[str, Any]:
    from .media.timeline import build_clip_signal_summary

    video = _path(request, "video_path", must_exist=True)
    transcript = request.get("transcript_text")
    if not isinstance(transcript, str):
        raise EngineError("invalid_request", "transcript_text is required")
    try:
        summary = build_clip_signal_summary(video, transcript)
    except Exception as exc:
        logger.warning("Clip signal extraction failed: %s", exc)
        summary = None
    return {"clip_signals": summary or None}


def cmd_render_clips(request: Dict[str, Any], events: Events) -> Dict[str, Any]:
    from .clip_cleanup import normalize_clip_cleanup_settings
    from .media.common import VALID_OUTPUT_FORMATS
    from .video_utils import create_clips_from_segments

    video = _path(request, "video_path", must_exist=True)
    output_dir = _path(request, "output_dir")
    segments = request.get("segments")
    if not isinstance(segments, list) or not all(
        isinstance(s, dict) and isinstance(s.get("start_time"), str) and isinstance(s.get("end_time"), str)
        for s in segments
    ):
        raise EngineError("invalid_request", "segments must be a list with start_time and end_time strings")
    options = request.get("options") or {}
    output_format = options.get("output_format") or "vertical"
    if output_format not in VALID_OUTPUT_FORMATS:
        raise EngineError("invalid_request", f"Unknown output_format: {output_format}")
    cleanup = options.get("cleanup") or {}
    font_size = options.get("font_size")
    clips, failed = create_clips_from_segments(
        video,
        segments,
        output_dir,
        font_family=options.get("font_family") or None,
        font_size=int(font_size) if font_size else None,
        font_color=options.get("font_color") or None,
        caption_template=options.get("caption_template") or "default",
        output_format=output_format,
        add_subtitles=bool(options.get("add_subtitles", True)),
        cleanup_settings=normalize_clip_cleanup_settings(
            cleanup.get("cut_long_pauses", False),
            cleanup.get("pause_threshold_ms"),
            cleanup.get("remove_filler_words", False),
            cleanup.get("filtered_words"),
        ),
        max_clip_seconds=float(options.get("max_clip_seconds") or 60.0),
        on_event=events.emit,
    )
    return {"clips": clips, "failed": failed}


def _preset(request: Dict[str, Any], default: str | None = None) -> str:
    from .clip_editor import EXPORT_PRESETS

    preset = request.get("preset") or default
    if preset not in EXPORT_PRESETS:
        raise EngineError("invalid_request", f"Unknown export preset: {preset}")
    return preset


def cmd_export_preset(request: Dict[str, Any], events: Events) -> Dict[str, Any]:
    from .clip_editor import export_with_preset

    source = _path(request, "input", must_exist=True)
    output = _path(request, "output")
    preset = _preset(request)
    try:
        export_with_preset(source, output, preset, on_progress=events.progress("Exporting..."))
    except RuntimeError as exc:
        raise _media_error(exc)
    return {"path": str(output)}


def _document(value: Any):
    from pydantic import ValidationError

    from .editor_document import EditDocument

    try:
        return EditDocument.model_validate(value)
    except ValidationError as exc:
        raise EngineError("invalid_request", f"Invalid edit document: {exc}")


def cmd_editor_prepare(request: Dict[str, Any], events: Events) -> Dict[str, Any]:
    from .editor_media import prepare_editor_media

    source = _path(request, "source_video_path", must_exist=True)
    output_dir = _path(request, "output_dir")
    task_style = request.get("task_style") or {}
    try:
        return prepare_editor_media(
            source,
            request.get("source_ranges") or [],
            output_dir,
            request.get("output_format") or "vertical",
            request.get("clip_text") or "",
            request.get("hook_title"),
            bool(request.get("add_subtitles", True)),
            request.get("caption_settings") or {},
            task_style,
        )
    except (RuntimeError, ValueError, subprocess.CalledProcessError) as exc:
        raise _media_error(exc)


def cmd_editor_render(request: Dict[str, Any], events: Events) -> Dict[str, Any]:
    from .editor_document import render_document

    clean = _path(request, "clean_path", must_exist=True)
    output = _path(request, "output")
    document = _document(request.get("document"))
    preset = _preset(request, "tiktok")
    try:
        render_document(clean, document, preset, output, events.progress("Rendering..."))
    except (RuntimeError, subprocess.CalledProcessError) as exc:
        raise _media_error(exc)
    return {"path": str(output)}


def cmd_editor_combine(request: Dict[str, Any], events: Events) -> Dict[str, Any]:
    from .editor_media import combine_editor_media

    inputs = request.get("inputs")
    if not isinstance(inputs, list) or len(inputs) < 2 or not all(isinstance(i, dict) for i in inputs):
        raise EngineError("invalid_request", "inputs must list at least two clips")
    for entry in inputs:
        _path(entry, "clean_path", must_exist=True)
        _document(entry.get("document"))
        if not (int(entry.get("width") or 0) > 0 and int(entry.get("height") or 0) > 0):
            raise EngineError("invalid_request", "Each input needs its width and height")
    output_dir = _path(request, "output_dir")
    try:
        return combine_editor_media(inputs, output_dir, events.progress("Combining..."))
    except (RuntimeError, ValueError, subprocess.CalledProcessError) as exc:
        raise _media_error(exc)


COMMANDS: Dict[str, Callable[[Dict[str, Any], Events], Dict[str, Any]]] = {
    "probe": cmd_probe,
    "youtube-info": cmd_youtube_info,
    "fetch-youtube": cmd_fetch_youtube,
    "prepare-source": cmd_prepare_source,
    "transcribe": cmd_transcribe,
    "signals": cmd_signals,
    "render-clips": cmd_render_clips,
    "export-preset": cmd_export_preset,
    "editor-prepare": cmd_editor_prepare,
    "editor-render": cmd_editor_render,
    "editor-combine": cmd_editor_combine,
}


def _start(request: Dict[str, Any], events: Events) -> None:
    """Apply the common request fields: work_dir, config, fonts_dirs, cancel_file."""
    work_dir = _path(request, "work_dir")
    temp_dir = work_dir / "tmp"
    temp_dir.mkdir(parents=True, exist_ok=True)
    # Every tempfile the engine (or a library) creates lands in the job's work_dir.
    tempfile.tempdir = str(temp_dir)
    try:
        set_config(EngineConfig.from_request(request))
    except (TypeError, ValueError) as exc:
        raise EngineError("invalid_request", str(exc))
    subprocess.Popen = _TrackedPopen
    cancel_file = request.get("cancel_file")
    if cancel_file:
        cancel_path = Path(str(cancel_file))
        if not cancel_path.is_absolute():
            raise EngineError("invalid_request", "cancel_file must be an absolute path")
        threading.Thread(target=_watch_cancel, args=(cancel_path, events), daemon=True).start()


def main(argv: list[str] | None = None) -> int:
    argv = sys.argv[1:] if argv is None else argv
    # Events own the real stdout. Everything else written to fd 1 (prints,
    # inherited child handles) is redirected to stderr.
    events = Events(os.fdopen(os.dup(1), "w", encoding="utf-8", newline="\n"))
    os.dup2(2, 1)
    sys.stdout = sys.stderr
    logging.basicConfig(
        stream=sys.stderr,
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )

    handler = COMMANDS.get(argv[0]) if len(argv) == 1 else None
    if handler is None:
        events.emit(
            "error",
            code="invalid_request",
            message=f"Usage: python -m clipwright_engine <{'|'.join(COMMANDS)}>",
        )
        return EXIT_ERROR
    try:
        try:
            request = json.loads(sys.stdin.buffer.read().decode("utf-8") or "{}")
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise EngineError("invalid_request", f"stdin is not valid JSON: {exc}")
        if not isinstance(request, dict):
            raise EngineError("invalid_request", "The request must be a JSON object")
        _start(request, events)
        data = handler(request, events)
    except EngineError as exc:
        events.emit("error", code=exc.code, message=str(exc))
        return EXIT_ERROR
    except Exception as exc:
        logger.exception("Engine command %s failed", argv[0])
        events.emit("error", code="internal", message=str(exc) or type(exc).__name__)
        return EXIT_ERROR
    events.emit("result", data=data)
    return EXIT_OK
