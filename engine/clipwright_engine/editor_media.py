"""Media work behind the clip editor: preview assets, layouts, initial drafts, combine."""

from __future__ import annotations

import contextlib
import functools
import json
import logging
import re
import subprocess
import tempfile
import uuid
from pathlib import Path
from typing import Any, Callable, Dict, Iterator, List, Optional, get_args

from .caption_templates import CAPTION_TEMPLATES, get_template
from .clip_source_map import normalize_source_ranges, ranges_as_dicts, slice_source_ranges
from .config import get_config
from .editor_document import CaptionStyle, EditDocument, mapped_words, render_document
from .media.common import VALID_OUTPUT_FORMATS
from .media.ffmpeg import run_ffmpeg_with_progress

logger = logging.getLogger(__name__)


def _run(command: List[str], text: bool = True) -> subprocess.CompletedProcess:
    kwargs = {"text": True, "encoding": "utf-8", "errors": "replace"} if text else {}
    return subprocess.run(command, capture_output=True, check=True, **kwargs)


@contextlib.contextmanager
def _staged(output_dir: Path, *names: str) -> Iterator[List[Path]]:
    """Work-dir paths for ``names``, moved into ``output_dir`` once the block succeeds.

    A cancelled or failed job therefore never leaves partial files in output_dir.
    """
    from .clip_editor import publish_render

    with tempfile.TemporaryDirectory(prefix="stage_", ignore_cleanup_errors=True) as staging:
        paths = [Path(staging) / name for name in names]
        yield paths
        for path in paths:
            publish_render(path, output_dir / path.name)


def make_assets(clean: Path, thumbnails: Path) -> Dict[str, Any]:
    """Probe ``clean``, compute a 160-bin waveform and write a 12x1 thumbnail strip."""
    import numpy as np

    metadata = json.loads(
        _run(["ffprobe", "-v", "error", "-show_streams", "-show_format", "-of", "json", str(clean)]).stdout
    )
    video = next(
        stream for stream in metadata["streams"] if stream["codec_type"] == "video"
    )
    numerator, denominator = video.get("avg_frame_rate", "30/1").split("/")
    fps = float(numerator) / max(1, float(denominator))
    duration = float(metadata["format"]["duration"])
    audio = any(stream["codec_type"] == "audio" for stream in metadata["streams"])
    waveform: List[float] = []
    if audio:
        samples = _run(
            ["ffmpeg", "-v", "error", "-i", str(clean), "-vn", "-ac", "1", "-ar", "8000", "-f", "f32le", "-"],
            text=False,
        )
        values = np.frombuffer(samples.stdout, dtype="float32")
        waveform = [
            round(float(np.max(np.abs(chunk))), 4) if len(chunk) else 0
            for chunk in np.array_split(values, 160)
        ]
    _run(
        [
            "ffmpeg", "-v", "error", "-y", "-i", str(clean),
            "-vf",
            f"fps={12 / duration},scale=160:90:force_original_aspect_ratio=decrease,pad=160:90:(ow-iw)/2:(oh-ih)/2,tile=12x1",
            "-frames:v", "1",
            str(thumbnails),
        ]
    )
    return {
        "width": video["width"],
        "height": video["height"],
        "fps": fps or 30,
        "duration": duration,
        "hasAudio": audio,
        "waveform": waveform,
    }


EDITOR_FONTS = set(get_args(CaptionStyle.model_fields["font"].annotation))


def initial_caption_style(
    task: dict, caption_settings: dict, enabled: bool, width: int, height: int
) -> dict:
    """Start the editor from the look the generated clip was rendered with.

    ``width``/``height`` are the generated clip's dimensions; size and position
    reproduce the generation renderer's pixel maths at that size.
    """
    from .media.captions import get_safe_vertical_position, get_scaled_font_size

    template = get_template(task.get("caption_template") or "default")
    font = task.get("font_family") or template["font_family"]
    if font not in EDITOR_FONTS:
        font = template["font_family"] if template["font_family"] in EDITOR_FONTS else "TikTokSans-Regular"
    base_size = caption_settings.get("font_size") or task.get("font_size") or template["font_size"]
    font_px = get_scaled_font_size(int(base_size), width)
    color = task.get("font_color") or template["font_color"]
    accent = template.get("highlight_color") or "#FACC15"
    position_y = caption_settings.get("position_y") or template.get("position_y") or 0.78
    # Generation centres the text at this pixel row; the editor stores it as a fraction.
    center_px = get_safe_vertical_position(height, int(font_px * 1.5), float(position_y))
    return {
        "enabled": enabled,
        "font": font,
        # The editor sizes text in 1080-wide units.
        "size": max(20, min(132, round(font_px * 1080 / width))),
        "color": color if re.fullmatch(r"#[0-9a-fA-F]{6}", color or "") else "#FFFFFF",
        "accent": accent if re.fullmatch(r"#[0-9a-fA-F]{6}", accent) else "#FACC15",
        "y": max(0.1, min(0.9, center_px / height)),
        "background": bool(template.get("background") and template.get("background_color")),
        "wordsPerLine": max(1, min(8, int(template.get("max_words_per_line") or 4))),
        "karaoke": template.get("animation") == "karaoke",
        "uppercase": bool(template.get("uppercase")),
        "template": task.get("caption_template") or "default",
    }


def generated_emphasis(words: list[dict], task: dict) -> set[int]:
    """Words the generated clip accented (power words, numbers, emoji words).

    The editor seeds them as highlights so users see and can toggle them.
    """
    from .emoji_captions import annotate_caption_words
    from .media.captions import emoji_rendering_supported

    template = get_template(task.get("caption_template") or "default")
    _, emphasis = annotate_caption_words(
        words,
        enable_emoji=bool(template.get("emoji", True)) and emoji_rendering_supported(),
        enable_emphasis=template.get("animation", "karaoke") != "none",
    )
    return emphasis


# Layouts that are a composed frame, not a crop the editor can rebuild.
PRESERVED_LAYOUT_KINDS = frozenset({"split", "stack", "reaction", "overlap"})


def editor_preserved_layout(
    clip_path: Path,
    output_format: str,
    speaker_turns: list | None = None,
    speaker_words: list | None = None,
) -> dict | None:
    """Split-screen or stacked plan to bake into the editor source.

    Returns None for original, speaker-pan, and any vertical clip whose plan
    is a plain crop. Those keep the editor's existing vertical or original crop.
    """
    from .media.reframing import (
        describe_vertical_layout,
        detect_speaker_reframe_plan,
        ffprobe_video_size,
    )

    try:
        if output_format == "vertical_split":
            plan = detect_speaker_reframe_plan(clip_path, "vertical_split")
            if not plan or plan.get("mode") != "split":
                return None
            return {
                "kind": "split",
                "output_format": "vertical_split",
                "speaker_plan": plan,
            }
        if output_format != "vertical":
            return None
        width, height = ffprobe_video_size(clip_path)
        described = describe_vertical_layout(
            clip_path, width, height, speaker_turns, speaker_words
        )
    except Exception:
        logger.warning("Could not read an editor reframing plan", exc_info=True)
        return None
    if described["kind"] not in PRESERVED_LAYOUT_KINDS:
        return None
    return {
        "kind": described["kind"],
        "output_format": "vertical",
        "vertical_plan": (described["video_filter"], described["mode"]),
    }


def apply_editor_layout(source: Path, layout: dict) -> bool:
    """Replace ``source`` with the composed layout. False leaves it untouched."""
    from .media.reframing import render_reframed_clip_ffmpeg

    dest = source.with_name(f".layout-{uuid.uuid4().hex}.mp4")
    try:
        ok, _, _ = render_reframed_clip_ffmpeg(
            source,
            dest,
            layout["output_format"],
            speaker_plan=layout.get("speaker_plan"),
            vertical_plan=layout.get("vertical_plan"),
        )
        if not ok or not dest.is_file() or dest.stat().st_size == 0:
            return False
        dest.replace(source)
        return True
    except Exception:
        logger.warning("Could not apply the editor reframing layout", exc_info=True)
        return False
    finally:
        dest.unlink(missing_ok=True)


def bake_editor_layout(
    clean: Path,
    output_format: str,
    source: Path,
    ranges: list,
) -> bool:
    """Compose a split or stacked layout into ``clean`` when the clip has one."""
    from .media.speaker_framing import build_clip_speaker_turns

    turns: list = []
    words: list = []
    # Clip generation only supplies diarized speakers when speaker framing is
    # on. Loading them here unconditionally can bake an overlap layout the
    # generated clip never had, just by opening the editor.
    if output_format == "vertical" and get_config().speaker_framing:
        try:
            turns, words = build_clip_speaker_turns(source, ranges)
        except Exception:
            logger.warning("Speaker turns unavailable for the editor layout", exc_info=True)
    layout = editor_preserved_layout(clean, output_format, turns, words)
    if not layout:
        return False
    return apply_editor_layout(clean, layout)


@functools.cache
def caption_looks() -> dict:
    """Template styling the editor preview draws on top of its own caption style."""
    looks = {}
    for template_id in CAPTION_TEMPLATES:
        template = get_template(template_id)
        looks[template_id] = {
            "animation": template.get("animation", "karaoke"),
            "wordPop": bool(template.get("word_pop", True)),
            "wordBox": bool(template.get("word_box")),
            "wordBoxColor": template.get("word_box_color") or template.get("highlight_color"),
            "highlightColor": template.get("highlight_color"),
            "emphasisColor": template.get("emphasis_color") or template.get("highlight_color"),
            "strokeColor": template.get("stroke_color"),
            "strokeWidth": int(template.get("stroke_width", 3) or 0),
            "shadow": bool(template.get("shadow")),
            "glow": bool(template.get("glow")),
            "backgroundColor": template.get("background_color"),
        }
    return looks


def prepare_editor_media(
    source: Path,
    source_ranges: list,
    output_dir: Path,
    output_format: str,
    clip_text: str,
    hook_title: Optional[str],
    add_subtitles: bool,
    caption_settings: dict,
    task_style: dict,
) -> Dict[str, Any]:
    """Uncaptioned trim of the clip's source ranges, its assets and first draft."""
    from .clip_editor import _caption_words_with_timings
    from .media.timeline import get_words_for_keep_ranges
    from .media.transcription import load_cached_transcript_data
    from .video_utils import create_optimized_clip

    ranges = normalize_source_ranges(source_ranges)
    if not ranges:
        raise ValueError("The clip has no source ranges")
    if output_format not in VALID_OUTPUT_FORMATS:
        output_format = "vertical"
    with _staged(output_dir, "clean.mp4", "thumbnails.jpg") as (clean, thumbnails):
        if not create_optimized_clip(
            source,
            ranges[0][0],
            ranges[-1][1],
            clean,
            add_subtitles=False,
            output_format="original",
            keep_ranges=ranges,
            hook_title=None,
            extend_to_sentence=False,
        ):
            raise RuntimeError("Could not prepare the original video")
        # Split-screen and stacked layouts are a composed frame, not a vertical or
        # original crop. Bake that frame into the editor source so preview and
        # export show it. Other clips keep this uncropped trim.
        if output_format in {"vertical", "vertical_split"}:
            bake_editor_layout(clean, output_format, source, ranges)
        asset = make_assets(clean, thumbnails)
    clean, thumbnails = output_dir / "clean.mp4", output_dir / "thumbnails.jpg"
    transcript = load_cached_transcript_data(source)
    timed = get_words_for_keep_ranges(transcript, ranges) if transcript else []
    duration = asset["duration"]
    words = _caption_words_with_timings((clip_text or "").split(), timed, duration)
    emphasis = generated_emphasis(words, task_style)
    original_format = output_format == "original"
    # Vertical clips are generated at 1080x1920; "original" keeps the source size.
    # A baked split or stack is already 1080x1920, so this vertical cover
    # shows that frame in full instead of cropping the source again.
    clip_width, clip_height = (
        (asset["width"], asset["height"]) if original_format else (1080, 1920)
    )
    document = (
        EditDocument.model_validate(
            {
                "segments": [{"id": "original", "start": 0, "end": duration}],
                "framing": {"aspect": "original" if original_format else "vertical"},
                "captions": initial_caption_style(
                    task_style, caption_settings or {}, add_subtitles, clip_width, clip_height
                ),
                "hookTitle": (hook_title or "")[:200],
                "words": [
                    {
                        "id": f"word-{i}",
                        "start": max(0, min(w["start"], duration - 0.01)),
                        "end": max(0.01, min(w["end"], duration)),
                        "text": w["text"][:120],
                        "highlight": i in emphasis,
                    }
                    for i, w in enumerate(words)
                    if w["start"] < duration and w["end"] > 0
                ],
            }
        )
        .validate_duration(duration)
        .model_dump()
    )
    return {
        "asset": asset,
        "clean_path": str(clean),
        "thumbnails_path": str(thumbnails),
        "initial_document": document,
    }


def combine_editor_media(
    inputs: List[Dict[str, Any]],
    output_dir: Path,
    on_progress: Optional[Callable[[int], None]] = None,
) -> Dict[str, Any]:
    """Join several drafts' cuts into one new clip (clean source, export, draft).

    Pass 1 concatenates every input's segments into a fitted, 30 fps clean
    source; pass 2 renders the combined document over it with the first
    input's caption style.
    """
    if len(inputs) < 2:
        raise ValueError("Combine needs at least two clips")
    command, filters, joins, all_words, ranges = ["ffmpeg", "-y"], [], [], [], []
    cursor = 0.0
    width, height = int(inputs[0]["width"]), int(inputs[0]["height"])
    scale = min(1, 1920 / max(width, height))
    width, height = int(width * scale) // 2 * 2, int(height * scale) // 2 * 2
    first_document: Optional[dict] = None
    for i, entry in enumerate(inputs):
        command += ["-i", str(Path(entry["clean_path"]).resolve())]
        document = EditDocument.model_validate(entry["document"])
        if first_document is None:
            first_document = document.model_dump()
        all_words += [
            {
                **w,
                "id": uuid.uuid4().hex,
                "start": w["start"] + cursor,
                "end": w["end"] + cursor,
            }
            for w in mapped_words(document)
        ]
        for j, segment in enumerate(document.segments):
            key = f"{i}_{j}"
            filters.append(
                f"[{i}:v]trim=start={segment.start}:end={segment.end},setpts=PTS-STARTPTS,scale={width}:{height}:force_original_aspect_ratio=decrease,pad={width}:{height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30[v{key}]"
            )
            if entry.get("has_audio"):
                filters.append(
                    f"[{i}:a]atrim=start={segment.start}:end={segment.end},asetpts=PTS-STARTPTS,aresample=48000,aformat=channel_layouts=stereo[a{key}]"
                )
            else:
                filters.append(
                    f"anullsrc=r=48000:cl=stereo,atrim=duration={segment.end - segment.start}[a{key}]"
                )
            joins += [f"[v{key}][a{key}]"]
            cursor += segment.end - segment.start
            ranges += slice_source_ranges(entry.get("source_ranges"), segment.start, segment.end)
    filters.append("".join(joins) + f"concat=n={len(joins)}:v=1:a=1[v][a]")
    combined = EditDocument.model_validate(
        {
            **(first_document or {}),
            "segments": [{"id": "combined", "start": 0, "end": cursor}],
            "words": all_words,
            # The first clip's headline doesn't describe the combination.
            "hookTitle": "",
        }
    ).validate_duration(cursor)

    def scaled(low: int, high: int) -> Callable[[int], None]:
        return lambda percent: on_progress(low + (high - low) * percent // 100) if on_progress else None

    command += [
        "-filter_complex", ";".join(filters),
        "-map", "[v]", "-map", "[a]",
        "-c:v", "libx264", "-preset", "fast", "-crf", "18",
        "-c:a", "aac", "-movflags", "+faststart",
    ]
    names = ("clean.mp4", "export.mp4", "thumbnails.jpg")
    with _staged(output_dir, *names) as (clean, export, thumbnails):
        run_ffmpeg_with_progress([*command, str(clean)], cursor, scaled(0, 50))
        render_document(clean, combined, "tiktok", export, scaled(50, 99))
        asset = make_assets(clean, thumbnails)
    return {
        "clean_path": str(output_dir / names[0]),
        "export_path": str(output_dir / names[1]),
        "thumbnails_path": str(output_dir / names[2]),
        "document": combined.model_dump(),
        "asset": asset,
        "source_ranges": ranges_as_dicts(ranges),
    }
