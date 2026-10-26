"""Render one clip: keep-range planning, reframing, captions and the final encode."""

import logging
import re
import shutil
import tempfile
import uuid
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Tuple

from .caption_templates import get_template
from .clip_source_map import normalize_source_ranges, ranges_as_dicts, source_range_bounds
from .config import get_config
from .media.captions import ass_fonts_dir, build_assemblyai_ass_subtitles
from .media.common import VALID_OUTPUT_FORMATS
from .media.ffmpeg import ffprobe_video_size, render_source_ranges_ffmpeg, round_to_even
from .media.reframing import build_vertical_filter_plan, render_reframed_clip_ffmpeg
from .media.source_limits import fit_within_1080p, probe_video_geometry
from .media.speaker_framing import build_clip_speaker_turns
from .media.timeline import (
    apply_segment_hook_teaser,
    build_clip_keep_ranges,
    build_keep_ranges_from_source_ranges,
    clamp_keep_ranges_to_max_duration,
    extend_keep_ranges_to_sentence_boundary,
    get_transcript_text_in_range,
    keep_ranges_transcript_text,
    parse_timestamp_to_seconds,
    snap_clip_start_to_sentence,
    snap_keep_ranges_to_sentence_start,
)
from .media.transcription import load_cached_transcript_data

logger = logging.getLogger(__name__)


def create_optimized_clip(
    video_path: Path,
    start_time: float,
    end_time: float,
    output_path: Path,
    add_subtitles: bool = True,
    font_family: Optional[str] = None,
    font_size: Optional[int] = None,
    font_color: Optional[str] = None,
    caption_template: str = "default",
    output_format: str = "vertical",
    keep_ranges: Optional[List[Tuple[float, float]]] = None,
    hook_title: Optional[str] = None,
    extend_to_sentence: bool = True,
    layout_report: Optional[Dict[str, Any]] = None,
) -> bool:
    """Create a clip with optional subtitles. Returns False when rendering fails.

    output_format is one of VALID_OUTPUT_FORMATS: the vertical modes render
    1080x1920; "original" keeps the source size, capped at 1080p.
    ``layout_report["caption_y"]`` receives the caption row the layout chose.
    """
    try:
        if keep_ranges:
            effective_keep_ranges = normalize_source_ranges(keep_ranges)
        else:
            effective_keep_ranges = (
                [(start_time, end_time)] if end_time - start_time > 0.05 else []
            )
        if extend_to_sentence:
            if not keep_ranges:
                # Only raw bounds are snapped; supplied ranges may carry
                # cleanup cuts or manual trims that must not be undone.
                effective_keep_ranges = snap_keep_ranges_to_sentence_start(
                    video_path, effective_keep_ranges,
                )
            effective_keep_ranges = extend_keep_ranges_to_sentence_boundary(
                video_path, effective_keep_ranges,
            )
            effective_keep_ranges = clamp_keep_ranges_to_max_duration(
                video_path, effective_keep_ranges,
            )
        duration = sum(end - start for start, end in effective_keep_ranges)
        if duration <= 0:
            logger.error(f"Invalid clip duration: {duration:.1f}s")
            return False

        logger.info(
            f"Creating clip: {start_time:.1f}s - {end_time:.1f}s ({duration:.1f}s) "
            f"subtitles={add_subtitles} template '{caption_template}' format={output_format}"
        )

        with tempfile.TemporaryDirectory(prefix="render_", ignore_cleanup_errors=True) as temp_dir:
            temp_root = Path(temp_dir)
            source_clip_path = temp_root / "source.mp4"
            final_clip_path = temp_root / "final.mp4"
            ass_path = temp_root / "captions.ass"

            if not render_source_ranges_ffmpeg(
                video_path,
                effective_keep_ranges,
                source_clip_path,
            ):
                raise RuntimeError("ffmpeg source-range render failed")

            reframe_format = (
                output_format if output_format in VALID_OUTPUT_FORMATS else "vertical"
            )

            # Output dimensions are known ahead of the render: vertical modes are
            # always 1080x1920, "original" keeps the (even) source size. Knowing
            # them lets us build the ASS captions up front and burn them in the
            # SAME pass as reframing — one encode instead of two.
            src_w, src_h = ffprobe_video_size(source_clip_path)
            if reframe_format == "original":
                # Captions are burned after the 1080p/60 scale, so their play
                # resolution has to be the capped display size. A 4K or rotated
                # master would otherwise place them on the unscaled frame.
                geometry = probe_video_geometry(source_clip_path)
                if geometry is not None:
                    target_width, target_height = fit_within_1080p(
                        geometry.display_width, geometry.display_height
                    )
                    target_width, target_height = round_to_even(target_width), round_to_even(target_height)
                else:
                    target_width, target_height = round_to_even(src_w), round_to_even(src_h)
            else:
                target_width, target_height = 1080, 1920

            speaker_turns: List[Dict[str, Any]] = []
            speaker_words: List[Dict[str, Any]] = []
            vertical_plan = None
            caption_y = None
            if reframe_format == "vertical":
                if get_config().speaker_framing:
                    try:
                        speaker_turns, speaker_words = build_clip_speaker_turns(
                            video_path, effective_keep_ranges
                        )
                    except Exception as exc:
                        logger.warning("Speaker turn extraction failed: %s", exc)
                try:
                    video_filter, mode, caption_y = build_vertical_filter_plan(
                        source_clip_path, src_w, src_h, speaker_turns, speaker_words
                    )
                    vertical_plan = (video_filter, mode)
                except Exception as exc:
                    logger.warning("Vertical layout planning failed: %s", exc)
                    caption_y = None
            if layout_report is not None and caption_y is not None:
                layout_report["caption_y"] = caption_y

            burn_ass_path: Optional[Path] = None
            fonts_dir: Optional[Path] = None
            if (add_subtitles or hook_title) and build_assemblyai_ass_subtitles(
                video_path,
                start_time,
                end_time,
                target_width,
                target_height,
                ass_path,
                font_family,
                font_size,
                font_color,
                caption_template,
                effective_keep_ranges,
                hook_title=hook_title,
                include_captions=add_subtitles,
                position_y_override=caption_y,
            ):
                burn_ass_path = ass_path
                fonts_dir = ass_fonts_dir(
                    font_family or get_template(caption_template)["font_family"]
                )

            framed_ok = render_reframed_clip_ffmpeg(
                source_clip_path,
                final_clip_path,
                reframe_format,
                subtitle_ass_path=burn_ass_path,
                fonts_dir=fonts_dir,
                speaker_turns=speaker_turns,
                speaker_words=speaker_words,
                vertical_plan=vertical_plan,
            )[0]
            if not framed_ok:
                raise RuntimeError("ffmpeg reframe render failed")

            shutil.move(str(final_clip_path), str(output_path))
            logger.info(f"Successfully created clip with ffmpeg: {output_path}")
            return True

    except Exception as e:
        logger.error(f"Failed to create clip: {e}")
        return False


def _ground_segment_text(segment: Dict[str, Any], video_path: Path) -> str:
    """The exact sidecar words inside the segment's labels, else its own text."""
    text = str(segment.get("text") or "").strip()
    start_label = str(segment.get("start_time") or "").strip()
    end_label = str(segment.get("end_time") or "").strip()
    transcript_data = load_cached_transcript_data(video_path)
    if not transcript_data or not start_label or not end_label:
        return text
    start_seconds = parse_timestamp_to_seconds(start_label)
    end_seconds = parse_timestamp_to_seconds(end_label)
    if end_seconds <= start_seconds:
        return text
    return get_transcript_text_in_range(transcript_data, start_seconds, end_seconds).strip() or text


def create_single_clip(
    video_path: Path,
    segment: Dict[str, Any],
    clip_index: int,
    output_dir: Path,
    font_family: Optional[str] = None,
    font_size: Optional[int] = None,
    font_color: Optional[str] = None,
    caption_template: str = "default",
    output_format: str = "vertical",
    add_subtitles: bool = True,
    cleanup_settings: Optional[Dict[str, Any]] = None,
    max_clip_seconds: float = 60.0,
) -> Dict[str, Any]:
    """Render one segment and return its clip info. Raises when it cannot.

    A segment carrying ``keep_ranges`` is rendered from exactly those ranges
    (a restyle with unchanged cleanup); ``source_ranges`` get cleanup applied
    again; otherwise the AI labels are snapped, cleaned, extended and capped.
    """
    provided_keep_ranges = normalize_source_ranges(segment.get("keep_ranges"))
    source_ranges = normalize_source_ranges(segment.get("source_ranges"))
    provided_bounds = source_range_bounds(provided_keep_ranges or source_ranges)
    if provided_bounds:
        start_seconds, end_seconds = provided_bounds
    else:
        start_seconds = parse_timestamp_to_seconds(segment["start_time"])
        end_seconds = parse_timestamp_to_seconds(segment["end_time"])
    if end_seconds - start_seconds <= 0:
        raise ValueError(
            f"Invalid clip bounds {segment.get('start_time')} - {segment.get('end_time')}"
        )

    # Labels come from model output: keep only their digits so a label can
    # never steer the file out of output_dir.
    clip_filename = (
        f"clip_{clip_index + 1}_"
        f"{re.sub(r'[^0-9]', '', str(segment['start_time']))}-"
        f"{re.sub(r'[^0-9]', '', str(segment['end_time']))}_"
        f"{uuid.uuid4().hex[:12]}.mp4"
    )
    clip_path = output_dir / clip_filename
    fresh = not provided_keep_ranges and not source_ranges
    if provided_keep_ranges:
        # Verbatim: they were already extended when first rendered, and
        # extending again creeps into the next sentence when speech is fast.
        keep_ranges = provided_keep_ranges
    else:
        if source_ranges:
            keep_ranges = build_keep_ranges_from_source_ranges(
                video_path, source_ranges, cleanup_settings
            )
        else:
            start_seconds = snap_clip_start_to_sentence(video_path, start_seconds, end_seconds)
            keep_ranges = build_clip_keep_ranges(
                video_path, start_seconds, end_seconds, cleanup_settings
            )
        keep_ranges = extend_keep_ranges_to_sentence_boundary(video_path, keep_ranges)
    clip_text = segment.get("text", "")
    if fresh:
        clip_text = _ground_segment_text(segment, video_path)
        keep_ranges = apply_segment_hook_teaser(video_path, keep_ranges, segment)
    # Rewind and sentence extension happen before this, so the stored ranges —
    # and the render, which must not extend them again — stay inside the cap.
    keep_ranges = clamp_keep_ranges_to_max_duration(video_path, keep_ranges, max_clip_seconds)
    if fresh:
        # Snapping, cleanup, the teaser and the cap change what is spoken;
        # keep the stored text word-for-word with the timeline.
        clip_text = keep_ranges_transcript_text(video_path, keep_ranges) or clip_text

    layout_report: Dict[str, Any] = {}
    if not create_optimized_clip(
        video_path,
        start_seconds,
        end_seconds,
        clip_path,
        add_subtitles,
        font_family,
        font_size,
        font_color,
        caption_template,
        output_format,
        keep_ranges,
        segment.get("hook_title"),
        extend_to_sentence=False,
        layout_report=layout_report,
    ):
        raise RuntimeError(f"Clip {clip_index + 1} could not be rendered")

    caption_settings: Dict[str, Any] = {
        "font_size": int(font_size or get_template(caption_template)["font_size"]),
    }
    if layout_report.get("caption_y") is not None:
        caption_settings["position_y"] = float(layout_report["caption_y"])
    duration = sum(end - start for start, end in keep_ranges)
    logger.info(f"Created clip {clip_index + 1}: {duration:.1f}s")
    return {
        "index": clip_index,
        "filename": clip_filename,
        "path": str(clip_path),
        "start_time": segment["start_time"],
        "end_time": segment["end_time"],
        "duration": duration,
        "text": clip_text,
        "keep_ranges": [[round(start, 6), round(end, 6)] for start, end in keep_ranges],
        "source_ranges": ranges_as_dicts(keep_ranges),
        "caption_settings": caption_settings,
    }


def create_clips_from_segments(
    video_path: Path,
    segments: List[Dict[str, Any]],
    output_dir: Path,
    font_family: Optional[str] = None,
    font_size: Optional[int] = None,
    font_color: Optional[str] = None,
    caption_template: str = "default",
    output_format: str = "vertical",
    add_subtitles: bool = True,
    cleanup_settings: Optional[Dict[str, Any]] = None,
    max_clip_seconds: float = 60.0,
    on_event: Optional[Callable[..., None]] = None,
) -> Tuple[List[Dict[str, Any]], List[int]]:
    """Render every segment; one failure never stops the rest.

    ``on_event(type, **fields)`` receives clip_start, clip and clip_failed.
    Returns (clips, failed indexes).
    """
    emit = on_event or (lambda *_args, **_kwargs: None)
    output_dir.mkdir(parents=True, exist_ok=True)
    clips: List[Dict[str, Any]] = []
    failed: List[int] = []
    for index, segment in enumerate(segments):
        emit("clip_start", index=index, total=len(segments))
        try:
            clip = create_single_clip(
                video_path,
                segment,
                index,
                output_dir,
                font_family,
                font_size,
                font_color,
                caption_template,
                output_format,
                add_subtitles,
                cleanup_settings,
                max_clip_seconds,
            )
        except Exception as exc:
            logger.error(f"Error creating clip {index + 1}: {exc}")
            failed.append(index)
            emit("clip_failed", index=index, message=str(exc) or "Clip rendering failed")
            continue
        clips.append(clip)
        emit("clip", index=index, clip=clip)
    logger.info(f"Successfully created {len(clips)}/{len(segments)} clips")
    return clips, failed
