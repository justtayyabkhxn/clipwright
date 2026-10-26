"""Ffmpeg helpers for the video pipeline."""

from functools import lru_cache
from typing import Callable, List
from typing import Optional
from pathlib import Path
from typing import Tuple
from ..clip_source_map import normalize_source_ranges
from ..config import get_config
import json
import os
import re
import subprocess
import tempfile
from .common import (
    AUDIO_BITRATE,
    CROSSFADE_MAX_SECONDS,
    FINAL_VIDEO_CRF,
    FINAL_VIDEO_PRESET,
    INTERMEDIATE_CRF,
    LOUDNORM_FILTER,
    OUTPUT_FPS,
    logger,
)


def round_to_even(value: int) -> int:
    """Round integer to nearest even number for H.264 compatibility."""
    return value - (value % 2)


def clamp_even(value: int, minimum: int, maximum: int) -> int:
    """Clamp an integer to an even value within inclusive bounds."""
    if maximum < minimum:
        return round_to_even(minimum)
    return round_to_even(max(minimum, min(value, maximum)))


# CreateProcess caps a Windows command line at 32,767 characters, and tracked
# crop expressions can pass that, so long graphs are read from a script file.
INLINE_FILTER_LIMIT = 2000
_FILTER_SCRIPT_OPTIONS = {
    "-filter_complex": "-filter_complex_script",
    "-vf": "-filter_script:v",
    "-filter:v": "-filter_script:v",
    "-af": "-filter_script:a",
}


@lru_cache(maxsize=1)
def _ffmpeg_major_version() -> int:
    """Major ffmpeg version; git builds count as current, a failed probe as old."""
    try:
        result = subprocess.run(
            ["ffmpeg", "-hide_banner", "-version"],
            capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=30,
        )
    except (OSError, subprocess.SubprocessError):
        return 0
    match = re.search(r"ffmpeg version n?(\d+)\.", result.stdout or "")
    return int(match.group(1)) if match else 99


def externalize_filter_graphs(command: List[str]) -> Tuple[List[str], List[Path]]:
    """Move long filter values into script files; returns (command, files to delete)."""
    if not command or Path(command[0]).stem != "ffmpeg":
        return command, []
    launched = list(command)
    scripts: List[Path] = []
    for index in range(1, len(launched) - 1):
        option = launched[index]
        if option not in _FILTER_SCRIPT_OPTIONS or len(launched[index + 1]) <= INLINE_FILTER_LIMIT:
            continue
        handle, name = tempfile.mkstemp(prefix="graph-", suffix=".txt")
        with os.fdopen(handle, "w", encoding="utf-8") as script:
            script.write(launched[index + 1])
        scripts.append(Path(name))
        # ffmpeg 7 deprecated the *_script options in favour of "-/option file".
        launched[index] = (
            "-/" + option.lstrip("-")
            if _ffmpeg_major_version() >= 7
            else _FILTER_SCRIPT_OPTIONS[option]
        )
        launched[index + 1] = name
    return launched, scripts


def run_ffmpeg_command(command: List[str], timeout: int = 900) -> subprocess.CompletedProcess:
    """Run ffmpeg/ffprobe and log stderr on failure."""
    launched, scripts = externalize_filter_graphs(command)
    try:
        result = subprocess.run(
            launched,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=timeout,
        )
    finally:
        for script in scripts:
            script.unlink(missing_ok=True)
    if result.returncode != 0:
        logger.error("Command failed: %s\n%s", " ".join(command)[:2000], result.stderr[-4000:])
    return result


def _progress_seconds(line: str) -> Optional[float]:
    key, _, value = line.strip().partition("=")
    if key != "out_time_us":
        return None
    try:
        return max(0.0, float(value) / 1_000_000)
    except ValueError:
        return None


def run_ffmpeg_with_progress(
    command: List[str],
    duration: float,
    on_progress: Optional[Callable[[int], None]] = None,
) -> None:
    """Run ffmpeg, reporting encode percent (0-99) from ``-progress pipe:1``.

    stderr goes to a temp file so a chatty encode cannot fill a pipe. Raises
    RuntimeError with the log tail when ffmpeg fails.
    """
    launched = list(command)
    # Only ffmpeg understands the progress flags (it may be "ffmpeg.exe").
    if launched and Path(launched[0]).stem == "ffmpeg":
        launched[1:1] = ["-progress", "pipe:1", "-nostats"]
    launched, scripts = externalize_filter_graphs(launched)
    try:
        with tempfile.TemporaryFile() as log:
            process = subprocess.Popen(
                launched,
                stdout=subprocess.PIPE,
                stderr=log,
                text=True,
                encoding="utf-8",
                errors="replace",
            )
            last = -1
            try:
                assert process.stdout is not None
                for line in process.stdout:
                    seconds = _progress_seconds(line)
                    if on_progress is None or seconds is None or duration <= 0:
                        continue
                    percent = min(99, int(seconds / duration * 100))
                    if percent > last:
                        last = percent
                        on_progress(percent)
                process.wait()
            finally:
                if process.poll() is None:
                    process.kill()
                    process.wait()
            if process.returncode:
                log.seek(0)
                tail = log.read().decode("utf-8", errors="replace")[-1500:]
                raise RuntimeError("Video rendering failed: " + tail)
    finally:
        for script in scripts:
            script.unlink(missing_ok=True)


def ffprobe_has_audio(video_path: Path) -> bool:
    result = run_ffmpeg_command(
        [
            "ffprobe",
            "-v",
            "error",
            "-select_streams",
            "a:0",
            "-show_entries",
            "stream=codec_type",
            "-of",
            "csv=p=0",
            str(video_path),
        ],
        timeout=60,
    )
    return result.returncode == 0 and "audio" in result.stdout


# ISO 639-1 → ISO 639-2 (B and T forms) for the languages container tags most
# often carry, so an explicit TRANSCRIPTION_LANGUAGE can pick the matching track.
_ISO_639_2_CODES = {
    "ar": {"ara"}, "bg": {"bul"}, "ca": {"cat"}, "cs": {"ces", "cze"},
    "da": {"dan"}, "de": {"deu", "ger"}, "el": {"ell", "gre"}, "en": {"eng"},
    "es": {"spa"}, "fa": {"fas", "per"}, "fi": {"fin"}, "fr": {"fra", "fre"},
    "he": {"heb"}, "hi": {"hin"}, "hr": {"hrv"}, "hu": {"hun"}, "id": {"ind"},
    "it": {"ita"}, "ja": {"jpn"}, "ko": {"kor"}, "ms": {"msa", "may"},
    "nl": {"nld", "dut"}, "no": {"nor", "nob", "nno"}, "pl": {"pol"},
    "pt": {"por"}, "ro": {"ron", "rum"}, "ru": {"rus"}, "sk": {"slk", "slo"},
    "sv": {"swe"}, "th": {"tha"}, "tr": {"tur"}, "uk": {"ukr"}, "ur": {"urd"},
    "vi": {"vie"}, "zh": {"zho", "chi"},
}
# Commentary, audio-description and dub tracks are never the primary dialogue.
_SECONDARY_AUDIO_DISPOSITIONS = ("comment", "visual_impaired", "hearing_impaired", "dub")


def _audio_language_matches(tag: str, preferred_language: str) -> bool:
    tag = tag.strip().lower()
    base = preferred_language.strip().lower().replace("-", "_").split("_", 1)[0]
    return tag == base or tag in _ISO_639_2_CODES.get(base, set())


def select_audio_stream_index(
    video_path: Path, preferred_language: Optional[str] = None
) -> Optional[int]:
    """Pick the dialogue audio track, as an index for ``0:a:N``, or None if silent.

    Transcription and every render of the source must read the same track;
    ffmpeg's implicit choice (most channels) and ``[0:a]`` (first track) can
    differ on multi-track uploads, desyncing captions from the audio.
    ``preferred_language`` defaults to the configured TRANSCRIPTION_LANGUAGE.
    """
    if preferred_language is None:
        preferred_language = get_config().transcription_language
    result = run_ffmpeg_command(
        [
            "ffprobe",
            "-v",
            "error",
            "-select_streams",
            "a",
            "-show_entries",
            "stream=index:stream_tags=language:stream_disposition",
            "-of",
            "json",
            str(video_path),
        ],
        timeout=60,
    )
    if result.returncode != 0:
        return None
    try:
        streams = json.loads(result.stdout or "{}").get("streams") or []
    except ValueError:
        return None
    if not streams:
        return None

    def rank(item: Tuple[int, dict]) -> Tuple[int, int, int, int]:
        position, stream = item
        disposition = stream.get("disposition") or {}
        language = (stream.get("tags") or {}).get("language") or ""
        language_miss = int(
            bool(preferred_language)
            and not _audio_language_matches(language, preferred_language or "")
        )
        secondary = int(any(disposition.get(key) for key in _SECONDARY_AUDIO_DISPOSITIONS))
        not_primary = int(not (disposition.get("default") or disposition.get("original")))
        return language_miss, secondary, not_primary, position

    return min(enumerate(streams), key=rank)[0]


def audio_stream_map_args(audio_stream: Optional[int]) -> List[str]:
    """Explicit ``-map`` args for the first video track plus the chosen audio."""
    args = ["-map", "0:v:0"]
    if audio_stream is not None:
        args += ["-map", f"0:a:{audio_stream}"]
    return args


def stream_rotation_degrees(stream: dict) -> int:
    """Display rotation in degrees from a stream's rotate tag or display matrix.

    ``tags.rotate`` wins when it parses. Otherwise the first side-data
    ``rotation`` is used (ffprobe's display-matrix angle). ``0`` means the
    coded frame is already the displayed orientation.
    """
    tags = stream.get("tags") or {}
    raw = tags.get("rotate")
    if raw is not None:
        try:
            return int(round(float(raw)))
        except (TypeError, ValueError):
            pass
    for side in stream.get("side_data_list") or []:
        if not isinstance(side, dict) or "rotation" not in side:
            continue
        try:
            return int(round(float(side["rotation"])))
        except (TypeError, ValueError):
            continue
    return 0


def displayed_video_size(width: int, height: int, rotation: int) -> Tuple[int, int]:
    """Pixel size after a 90° or 270° display rotation.

    Matches ``VideoGeometry.display_width`` / ``display_height`` for square
    pixels. Sample aspect ratio is not applied: crop and scale filters address
    stored pixels, and anamorphic sources are squared only by normalization.
    """
    if abs(rotation) % 180 == 90:
        return height, width
    return width, height


def parse_ffprobe_video_size(payload: object) -> Tuple[int, int]:
    """Displayed size of the first video stream in an ffprobe JSON document.

    Extra streams and side-data entries are ignored. A display-matrix rotation
    of 90° or 270° swaps the coded width and height, because ffmpeg autorotates
    before user filters unless ``-noautorotate`` is set.
    """
    if not isinstance(payload, dict):
        raise ValueError("ffprobe size payload is not an object")
    streams = payload.get("streams")
    if not isinstance(streams, list):
        raise ValueError("ffprobe returned no video stream")
    stream = None
    for candidate in streams:
        if not isinstance(candidate, dict):
            continue
        codec_type = candidate.get("codec_type")
        if codec_type not in (None, "video"):
            continue
        if "width" not in candidate or "height" not in candidate:
            continue
        stream = candidate
        break
    if stream is None:
        raise ValueError("ffprobe returned no video stream")
    try:
        width = int(stream["width"])
        height = int(stream["height"])
    except (TypeError, ValueError) as exc:
        raise ValueError("ffprobe returned invalid video dimensions") from exc
    if width <= 0 or height <= 0:
        raise ValueError("ffprobe returned invalid video dimensions")
    return displayed_video_size(width, height, stream_rotation_degrees(stream))


def ffprobe_video_size(video_path: Path) -> Tuple[int, int]:
    """Displayed pixel size of the first video stream.

    The probe is JSON, not ``csv=s=x``. A stream with side data (a display
    matrix, HDR metadata, SEI) makes that csv writer emit a trailing separator,
    so ``1920x1080`` becomes ``1920x1080x`` and ``split("x", 1)`` leaves the
    height as ``1080x``.

    The returned size is the one ffmpeg filters see. Autorotate is on by
    default and this pipeline never passes ``-noautorotate``, so a phone file
    stored as 1920×1080 with rotation -90 is 1080×1920 inside crop, scale, and
    rawvideo analysis.
    """
    result = run_ffmpeg_command(
        [
            "ffprobe",
            "-v",
            "error",
            "-select_streams",
            "v:0",
            "-show_entries",
            "stream=width,height,codec_type:stream_tags=rotate:stream_side_data=rotation",
            "-of",
            "json",
            str(video_path),
        ],
        timeout=60,
    )
    if result.returncode != 0:
        raise RuntimeError(f"Unable to read video size for {video_path}")
    try:
        payload = json.loads(result.stdout or "")
    except ValueError as exc:
        raise RuntimeError(
            f"Unable to read video size for {video_path}: probe output was not JSON"
        ) from exc
    try:
        return parse_ffprobe_video_size(payload)
    except (TypeError, ValueError) as exc:
        raise RuntimeError(f"Unable to read video size for {video_path}: {exc}") from exc


def ffprobe_duration(video_path: Path) -> float:
    result = run_ffmpeg_command(
        [
            "ffprobe",
            "-v",
            "error",
            "-show_entries",
            "format=duration",
            "-of",
            "default=noprint_wrappers=1:nokey=1",
            str(video_path),
        ],
        timeout=60,
    )
    if result.returncode != 0:
        raise RuntimeError(f"Unable to read duration for {Path(video_path).name}")
    try:
        return max(0.0, float(result.stdout.strip()))
    except ValueError:
        pass
    # Streamed WebM/Matroska (browser recordings) has no container duration;
    # demux every packet (no decode) and take where the last one ends.
    scan = run_ffmpeg_command(
        [
            "ffprobe",
            "-v",
            "error",
            "-show_entries",
            "packet=pts_time,duration_time",
            "-of",
            "csv=p=0",
            str(video_path),
        ],
        timeout=600,
    )
    end = 0.0
    for line in scan.stdout.splitlines():
        fields = line.split(",")
        try:
            pts = float(fields[0])
        except ValueError:
            continue
        try:
            pts += float(fields[1])
        except (ValueError, IndexError):
            pass
        end = max(end, pts)
    if end <= 0:
        raise RuntimeError(f"Invalid duration for {Path(video_path).name}")
    return end


def ffmpeg_escape_filter_value(value: str) -> str:
    """Escape a value for use as a filter option inside an ffmpeg filtergraph.

    ffmpeg unescapes filter arguments twice: once when splitting the
    filtergraph (special: backslash, quote, ``[ ] , ;``) and once when
    splitting a filter's ``key=value:...`` options (special: backslash,
    quote, colon). Escaping for both levels keeps Windows drive colons,
    backslashes, apostrophes and brackets in paths intact.
    """
    option_level = re.sub(r"([\\':])", r"\\\1", str(value))
    return re.sub(r"([\\'\[\],;])", r"\\\1", option_level)


def ffmpeg_escape_filter_path(path: Path) -> str:
    """Escape a filesystem path for use as an ffmpeg filter option value."""
    return ffmpeg_escape_filter_value(str(path))


def build_final_video_encode_args(
    crf: int = FINAL_VIDEO_CRF,
    preset: str = FINAL_VIDEO_PRESET,
    fps: int | str = OUTPUT_FPS,
    level: str = "4.1",
) -> List[str]:
    """libx264 args for the quality-determining final pass (CFR, H.264 High).

    Level 4.1 covers 1080p30. Original-format output at 60 fps (or 59.94)
    needs 4.2 or x264 rejects the stream.
    """
    return [
        "-c:v", "libx264",
        "-preset", preset,
        "-crf", str(crf),
        "-pix_fmt", "yuv420p",
        "-profile:v", "high",
        "-level", level,
        "-r", str(fps),
        "-x264-params", "keyint=120:min-keyint=30:scenecut=40",
    ]


def build_audio_output_args(has_audio: bool, loudnorm: bool = True) -> List[str]:
    """Audio encode args (with optional loudness normalisation) or `-an`."""
    if not has_audio:
        return ["-an"]
    args: List[str] = []
    if loudnorm:
        args += ["-af", LOUDNORM_FILTER]
    args += ["-c:a", "aac", "-b:a", AUDIO_BITRATE, "-ar", "48000"]
    return args


def subtitles_filter_fragment(
    ass_path: Path, fonts_dir: Optional[Path] = None
) -> str:
    """ffmpeg `subtitles` filter fragment burning an ASS file (with fonts dir)."""
    fragment = f"subtitles=filename={ffmpeg_escape_filter_path(ass_path)}"
    if fonts_dir:
        fragment += f":fontsdir={ffmpeg_escape_filter_path(fonts_dir)}"
    return fragment


def crossfade_fade_for_ranges(keep_ranges: List[Tuple[float, float]]) -> float:
    """Crossfade duration render_source_ranges will use, or 0.0 for hard concat.

    A single source of truth so caption timing (which compacts the same ranges)
    stays perfectly in sync with the crossfade-shortened video timeline.
    """
    ranges = normalize_source_ranges(keep_ranges)
    if len(ranges) < 2 or len(ranges) > 8:
        return 0.0
    # A hook teaser plays ranges out of source order; hard-cut out of the cold
    # open so persisted source maps (which assume concatenation) stay exact.
    if any(ranges[i + 1][0] < ranges[i][0] for i in range(len(ranges) - 1)):
        return 0.0
    durations = [end - start for start, end in ranges]
    if min(durations) < 0.45:
        return 0.0
    fade = min(CROSSFADE_MAX_SECONDS, min(durations) * 0.5)
    return fade if fade >= 0.06 else 0.0


def render_ranges_crossfade_ffmpeg(
    video_path: Path,
    keep_ranges: List[Tuple[float, float]],
    output_path: Path,
    audio_stream: Optional[int],
    transition: str = "fade",
) -> bool:
    """Stitch kept ranges together with short crossfades instead of hard cuts.

    Turns the abrupt jump cuts left by pause/filler removal into quick, smooth
    dissolves (video xfade + audio acrossfade), which read as intentional,
    polished transitions.
    """
    keep_ranges = normalize_source_ranges(keep_ranges)
    n = len(keep_ranges)
    if n < 2:
        return False
    durations = [end - start for start, end in keep_ranges]
    fade = crossfade_fade_for_ranges(keep_ranges)
    if fade <= 0:
        return False
    has_audio = audio_stream is not None
    seek_args, origin = _input_window_for_ranges(keep_ranges)

    parts: List[str] = []
    for idx, (start, end) in enumerate(keep_ranges):
        rel_start, rel_end = start - origin, end - origin
        parts.append(
            f"[0:v]trim=start={rel_start:.3f}:end={rel_end:.3f},setpts=PTS-STARTPTS,"
            f"fps={OUTPUT_FPS},format=yuv420p,setsar=1[v{idx}]"
        )
        if has_audio:
            parts.append(
                f"[0:a:{audio_stream}]atrim=start={rel_start:.3f}:end={rel_end:.3f},asetpts=PTS-STARTPTS[a{idx}]"
            )

    cur_v = "[v0]"
    cumulative = durations[0]
    for i in range(1, n):
        offset = cumulative - fade
        out = f"[vx{i}]"
        parts.append(
            f"{cur_v}[v{i}]xfade=transition={transition}:duration={fade:.3f}:"
            f"offset={offset:.3f}{out}"
        )
        cumulative = cumulative + durations[i] - fade
        cur_v = out

    map_args = ["-map", cur_v]
    if has_audio:
        cur_a = "[a0]"
        for i in range(1, n):
            out = f"[ax{i}]"
            parts.append(f"{cur_a}[a{i}]acrossfade=d={fade:.3f}{out}")
            cur_a = out
        map_args += ["-map", cur_a]

    command = [
        "ffmpeg", "-y", *seek_args, "-i", str(video_path),
        "-filter_complex", ";".join(parts),
        *map_args,
        "-c:v", "libx264", "-preset", "veryfast", "-crf", str(INTERMEDIATE_CRF),
        "-pix_fmt", "yuv420p",
    ]
    if has_audio:
        command += ["-c:a", "aac", "-b:a", "192k"]
    command += ["-movflags", "+faststart", str(output_path)]
    return run_ffmpeg_command(command, timeout=1800).returncode == 0


def _input_window_for_ranges(
    keep_ranges: List[Tuple[float, float]],
) -> Tuple[List[str], float]:
    """Seek to the first kept moment and stop just after the last one.

    Multi-range trims used to open the source at t=0, so a 40s clip taken from
    minute 30 decoded the whole prefix. Timestamps after `-ss` (before `-i`)
    start at 0, so callers subtract the returned origin from every trim.
    """
    origin = min(start for start, _ in keep_ranges)
    end = max(end for _, end in keep_ranges)
    # A few dozen milliseconds at the head is not worth a seek. Shifting trims
    # without seeking would start each piece early, so leave those timestamps
    # absolute.
    if origin <= 0.05:
        origin = 0.0
    args: List[str] = []
    if origin > 0:
        args.extend(["-ss", f"{origin:.3f}"])
    args.extend(["-t", f"{max(0.2, end - origin + 1.0):.3f}"])
    return args, origin


def render_source_ranges_ffmpeg(
    video_path: Path,
    keep_ranges: List[Tuple[float, float]],
    output_path: Path,
) -> bool:
    """Render source ranges into one intermediate clip using ffmpeg only."""
    keep_ranges = normalize_source_ranges(keep_ranges)
    if not keep_ranges:
        return False

    audio_stream = select_audio_stream_index(video_path)
    has_audio = audio_stream is not None

    if len(keep_ranges) == 1:
        start, end = keep_ranges[0]
        command = [
            "ffmpeg",
            "-y",
            "-ss",
            f"{start:.3f}",
            "-i",
            str(video_path),
            *audio_stream_map_args(audio_stream),
            "-t",
            f"{end - start:.3f}",
            "-c:v",
            "libx264",
            "-preset",
            "veryfast",
            "-crf",
            str(INTERMEDIATE_CRF),
            "-pix_fmt",
            "yuv420p",
            "-c:a",
            "aac",
            "-b:a",
            "192k",
            "-movflags",
            "+faststart",
            str(output_path),
        ]
        return run_ffmpeg_command(command).returncode == 0

    # Smooth a handful of substantial internal cuts with crossfades; fall back to
    # a hard concat for many tiny fragments (heavy filler edits) or on failure.
    if crossfade_fade_for_ranges(keep_ranges) > 0:
        if render_ranges_crossfade_ffmpeg(
            video_path, keep_ranges, output_path, audio_stream
        ):
            return True
        logger.info("Crossfade stitch failed; falling back to hard concat")

    seek_args, origin = _input_window_for_ranges(keep_ranges)
    filter_parts: List[str] = []
    concat_inputs: List[str] = []
    for idx, (start, end) in enumerate(keep_ranges):
        rel_start, rel_end = start - origin, end - origin
        filter_parts.append(
            f"[0:v]trim=start={rel_start:.3f}:end={rel_end:.3f},setpts=PTS-STARTPTS[v{idx}]"
        )
        concat_inputs.append(f"[v{idx}]")
        if has_audio:
            filter_parts.append(
                f"[0:a:{audio_stream}]atrim=start={rel_start:.3f}:end={rel_end:.3f},asetpts=PTS-STARTPTS[a{idx}]"
            )
            concat_inputs.append(f"[a{idx}]")

    if has_audio:
        filter_parts.append(
            f"{''.join(concat_inputs)}concat=n={len(keep_ranges)}:v=1:a=1[v][a]"
        )
        map_args = ["-map", "[v]", "-map", "[a]"]
    else:
        filter_parts.append(
            f"{''.join(concat_inputs)}concat=n={len(keep_ranges)}:v=1:a=0[v]"
        )
        map_args = ["-map", "[v]"]

    command = [
        "ffmpeg",
        "-y",
        *seek_args,
        "-i",
        str(video_path),
        "-filter_complex",
        ";".join(filter_parts),
        *map_args,
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-crf",
        str(INTERMEDIATE_CRF),
        "-pix_fmt",
        "yuv420p",
    ]
    if has_audio:
        command.extend(["-c:a", "aac", "-b:a", "192k"])
    command.extend(["-movflags", "+faststart", str(output_path)])
    return run_ffmpeg_command(command, timeout=1800).returncode == 0
