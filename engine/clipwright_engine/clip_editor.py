"""Platform export presets and caption timing for edited clip text."""

from __future__ import annotations

import os
import shutil
import tempfile
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional

from .media.ffmpeg import ffprobe_duration, ffprobe_video_size, run_ffmpeg_with_progress
from .media.source_limits import FPS_EPSILON, MAX_OUTPUT_FPS, probe_video_geometry


@dataclass
class ExportPreset:
    name: str
    width: int
    height: int
    video_bitrate: str
    audio_bitrate: str


EXPORT_PRESETS = {
    "tiktok": ExportPreset("tiktok", 1080, 1920, "10M", "192k"),
    "reels": ExportPreset("reels", 1080, 1920, "12M", "192k"),
    "shorts": ExportPreset("shorts", 1080, 1920, "10M", "192k"),
}


def _ffprobe_size(path: Path) -> tuple[int, int]:
    """Displayed pixel size of the first video stream.

    Caption play resolution and editor scale filters run after ffmpeg's
    default autorotate, so this is the same size ``ffprobe_video_size`` returns.
    """
    return ffprobe_video_size(path)


def _double_bitrate(value: str) -> str:
    normalized = value.strip().lower()
    if normalized.endswith("m"):
        return f"{int(float(normalized[:-1]) * 2)}M"
    if normalized.endswith("k"):
        return f"{int(float(normalized[:-1]) * 2)}k"
    return value


def partial_path(output: Path) -> Path:
    """Where to encode ``output``: the temp (work) dir, so a cancelled render
    leaves nothing beside the destination."""
    return Path(tempfile.gettempdir()) / f"partial-{uuid.uuid4().hex}{output.suffix}"


def publish_render(temporary: Path, output: Path) -> None:
    """Move a finished render into place (an atomic rename on the same volume)."""
    output.parent.mkdir(parents=True, exist_ok=True)
    try:
        os.replace(temporary, output)
    except OSError:
        shutil.move(str(temporary), str(output))


def _caption_words_with_timings(
    words: List[str],
    timed_words: List[Dict[str, Any]],
    duration: float,
) -> List[Dict[str, Any]]:
    """Apply edited text to source timings, or evenly split when none exist."""
    if timed_words:
        source_count = len(timed_words)
        edited_count = len(words)
        if edited_count == source_count:
            return [
                {
                    "text": word,
                    "start": float(timed["start"]),
                    "end": float(timed["end"]),
                    "confidence": timed.get("confidence", 1.0),
                }
                for word, timed in zip(words, timed_words)
            ]

        # Word counts differ: spread the edited words proportionally across the
        # spoken span so timings stay strictly increasing (no stacked words).
        span_start = float(timed_words[0]["start"])
        span_end = max(float(timed_words[-1]["end"]), span_start + 0.05 * edited_count)
        step = (span_end - span_start) / max(edited_count, 1)
        return [
            {
                "text": word,
                "start": span_start + index * step,
                "end": span_start + (index + 1) * step,
                "confidence": 1.0,
            }
            for index, word in enumerate(words)
        ]

    word_duration = max(duration / max(len(words), 1), 0.1)
    return [
        {
            "text": word,
            "start": index * word_duration,
            "end": min(duration, (index + 1) * word_duration),
            "confidence": 1.0,
        }
        for index, word in enumerate(words)
    ]


def export_with_preset(
    input_path: Path,
    output_path: Path,
    preset_name: str,
    *,
    on_progress: Optional[Callable[[int], None]] = None,
) -> Path:
    """Re-encode a rendered clip to a platform preset (scale + pad, capped bitrate)."""
    preset = EXPORT_PRESETS.get(preset_name)
    if not preset:
        raise ValueError(f"Unknown export preset: {preset_name}")

    scale_filter = (
        f"scale={preset.width}:{preset.height}:"
        "force_original_aspect_ratio=decrease:flags=lanczos,"
        f"pad={preset.width}:{preset.height}:(ow-iw)/2:(oh-ih)/2,"
        "setsar=1"
    )
    geometry = probe_video_geometry(input_path)
    if geometry and geometry.fps is not None and geometry.fps > MAX_OUTPUT_FPS + FPS_EPSILON:
        scale_filter = f"fps={MAX_OUTPUT_FPS},{scale_filter}"
    temporary = partial_path(output_path)
    command = [
        "ffmpeg",
        "-y",
        "-i",
        str(input_path),
        "-vf",
        scale_filter,
        "-c:v",
        "libx264",
        "-preset",
        "slow",
        "-crf",
        "18",
        "-maxrate",
        preset.video_bitrate,
        "-bufsize",
        _double_bitrate(preset.video_bitrate),
        "-pix_fmt",
        "yuv420p",
        "-profile:v",
        "high",
        "-c:a",
        "aac",
        "-b:a",
        preset.audio_bitrate,
        "-ar",
        "48000",
        "-movflags",
        "+faststart",
        str(temporary),
    ]
    try:
        run_ffmpeg_with_progress(command, ffprobe_duration(input_path), on_progress)
        publish_render(temporary, output_path)
    finally:
        temporary.unlink(missing_ok=True)
    return output_path
