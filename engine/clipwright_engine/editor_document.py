"""The clip editor's EditDocument and its deterministic server render."""

from __future__ import annotations

from pathlib import Path
import tempfile
from typing import Callable, Literal, Optional

from pydantic import BaseModel, ConfigDict, Field, model_validator


class Model(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)


class Segment(Model):
    id: str = Field(min_length=1, max_length=100)
    start: float = Field(ge=0)
    end: float = Field(gt=0)

    @model_validator(mode="after")
    def ordered(self):
        if self.end - self.start < 0.04:
            raise ValueError("Each segment must be at least one frame long")
        return self


class Word(Model):
    id: str = Field(min_length=1, max_length=100)
    start: float = Field(ge=0)
    end: float = Field(gt=0)
    text: str = Field(max_length=120)
    highlight: bool = False

    @model_validator(mode="after")
    def ordered(self):
        if self.end <= self.start:
            raise ValueError("Caption end must follow its start")
        return self


class CaptionStyle(Model):
    enabled: bool = True
    font: Literal[
        "TikTokSans-Regular", "TikTokSans-Bold", "Poppins-ExtraBold", "THEBOLDFONT"
    ] = "Poppins-ExtraBold"
    # 1080-wide units; 132 matches the generation renderer's largest caption.
    size: int = Field(default=54, ge=20, le=132)
    color: str = Field(default="#FFFFFF", pattern=r"^#[0-9a-fA-F]{6}$")
    accent: str = Field(default="#FACC15", pattern=r"^#[0-9a-fA-F]{6}$")
    y: float = Field(default=0.78, ge=0.1, le=0.9)
    background: bool = True
    wordsPerLine: int = Field(default=4, ge=1, le=8)
    # Colour the word being spoken with the accent, as the generated clip does.
    karaoke: bool = False
    uppercase: bool = False
    # Caption template the clip was generated with; supplies the animation, outline,
    # word pill and emphasis styling that the fields above don't expose.
    template: str = Field(default="default", min_length=1, max_length=50)


class Framing(Model):
    aspect: Literal["vertical", "square", "original"] = "vertical"
    fit: Literal["contain", "cover"] = "cover"
    zoom: float = Field(default=1, ge=1, le=3)
    x: float = Field(default=0.5, ge=0, le=1)
    y: float = Field(default=0.5, ge=0, le=1)


class Effects(Model):
    brightness: float = Field(default=100, ge=40, le=180)
    contrast: float = Field(default=100, ge=40, le=180)
    saturation: float = Field(default=100, ge=0, le=220)
    blur: float = Field(default=0, ge=0, le=8)
    hue: float = Field(default=0, ge=-180, le=180)


class EditDocument(Model):
    version: Literal[1] = 1
    segments: list[Segment] = Field(min_length=1, max_length=100)
    words: list[Word] = Field(default_factory=list, max_length=5000)
    captions: CaptionStyle = Field(default_factory=CaptionStyle)
    framing: Framing = Field(default_factory=Framing)
    effects: Effects = Field(default_factory=Effects)
    volume: float = Field(default=1, ge=0, le=2)
    muted: bool = False
    # AI headline burned into the top safe area for the first seconds, as generated.
    hookTitle: str = Field(default="", max_length=200)

    def validate_duration(self, duration: float):
        if any(s.end > duration + 0.05 for s in self.segments):
            raise ValueError("An edit extends past the original clip")
        if any(w.end > duration + 0.05 for w in self.words):
            raise ValueError("A caption extends past the original clip")
        if len({s.id for s in self.segments}) != len(self.segments) or len(
            {w.id for w in self.words}
        ) != len(self.words):
            raise ValueError("Editor item IDs must be unique")
        return self


def output_size(document: EditDocument, width: int, height: int):
    if document.framing.aspect == "square":
        return 1080, 1080
    if document.framing.aspect == "vertical":
        return 1080, 1920
    scale = min(1, 1920 / max(width, height))
    return max(2, int(width * scale) // 2 * 2), max(2, int(height * scale) // 2 * 2)


def mapped_words(document: EditDocument):
    result = []
    cursor = 0.0
    ordered_words = sorted(document.words, key=lambda w: w.start)
    for segment in document.segments:
        for word in ordered_words:
            start, end = max(segment.start, word.start), min(segment.end, word.end)
            if end > start and word.text.strip():
                result.append(
                    {
                        **word.model_dump(),
                        "start": cursor + start - segment.start,
                        "end": cursor + end - segment.start,
                    }
                )
        cursor += segment.end - segment.start
    return result


def editor_caption_template(style: CaptionStyle) -> dict:
    """The generation template with the editor's own style choices applied on top."""
    from .caption_templates import get_template

    template = dict(get_template(style.template))
    # Templates that emphasise words in their highlight colour follow the editor's choice.
    if (template.get("emphasis_color") or template.get("highlight_color")) == template.get("highlight_color"):
        template["emphasis_color"] = style.accent
    template.update(
        font_color=style.color,
        highlight_color=style.accent,
        uppercase=style.uppercase,
        max_words_per_line=style.wordsPerLine,
    )
    if style.background:
        template["background"] = True
        template["background_color"] = template.get("background_color") or "#00000080"
    else:
        template["background"] = False
        template["background_color"] = None
    if style.karaoke:
        template["animation"] = "karaoke"
    elif template["animation"] == "karaoke":
        template["animation"] = "none"
    return template


def write_ass(path: Path, document: EditDocument, width: int, height: int):
    """Write captions with the generation renderer so edits keep the clip's animation."""
    from .media.captions import build_assemblyai_ass_subtitles

    style = document.captions
    words = mapped_words(document) if style.enabled else []
    font_px = max(1, round(style.size * width / 1080))
    written = build_assemblyai_ass_subtitles(
        path,
        0,
        sum(s.end - s.start for s in document.segments),
        width,
        height,
        path,
        font_family=style.font,
        caption_words=words,
        include_captions=style.enabled,
        template_override=editor_caption_template(style),
        font_px_override=font_px,
        # The editor's position is the caption centre, already kept in range.
        center_y_override=round(style.y * height),
        # Highlights are per occurrence and already include the generated emphasis.
        emphasis_indices=[i for i, w in enumerate(words) if w["highlight"]],
        wrap_lines=True,
        hook_title=document.hookTitle.strip() or None,
    )
    if not written:
        # Nothing to show (no captions or hook title): keep ffmpeg's ass filter valid.
        path.write_text(
            f"[Script Info]\nScriptType: v4.00+\nPlayResX: {width}\nPlayResY: {height}\n\n[Events]\n"
            "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n",
            encoding="utf-8",
        )


def render_document(
    source: Path,
    document: EditDocument,
    preset: str,
    output: Path,
    on_progress: Optional[Callable[[int], None]] = None,
) -> Path:
    """Render ``document`` over the uncaptioned ``source`` (clean.mp4) to ``output``.

    The preset only picks the bitrate cap; the frame size comes from the
    document's framing.
    """
    from .clip_editor import _ffprobe_size, partial_path, publish_render
    from .media.captions import ass_fonts_dir
    from .media.ffmpeg import ffmpeg_escape_filter_path, ffprobe_has_audio, run_ffmpeg_with_progress

    sw, sh = _ffprobe_size(source)
    width, height = output_size(document, sw, sh)
    framing, fx = document.framing, document.effects
    scale = (max if framing.fit == "cover" else min)(
        width / sw, height / sh
    ) * framing.zoom
    rw, rh = max(2, round(sw * scale / 2) * 2), max(2, round(sh * scale / 2) * 2)
    # Crop overflow and position letterboxing using the same normalized anchor.
    cw, ch = min(width, rw), min(height, rh)
    geometry = f"scale={rw}:{rh},crop={cw}:{ch}:{(rw - cw) * framing.x}:{(rh - ch) * framing.y},pad={width}:{height}:{(width - cw) * framing.x}:{(height - ch) * framing.y}:black,setsar=1"
    # CSS brightness/contrast use RGB multiplication followed by a midpoint shift.
    gain = fx.brightness / 100 * fx.contrast / 100
    offset = 128 * (1 - fx.contrast / 100)
    effects = f"lutrgb=r='clip(val*{gain}+{offset},0,255)':g='clip(val*{gain}+{offset},0,255)':b='clip(val*{gain}+{offset},0,255)',hue=h={fx.hue}:s={fx.saturation / 100}"
    if fx.blur:
        effects += f",gblur=sigma={fx.blur * width / 1080}"
    audio = ffprobe_has_audio(source)
    filters, joins = [], []
    for index, segment in enumerate(document.segments):
        filters.append(
            f"[0:v]trim=start={segment.start}:end={segment.end},setpts=PTS-STARTPTS[v{index}]"
        )
        joins.append(f"[v{index}]")
        if audio:
            filters.append(
                f"[0:a]atrim=start={segment.start}:end={segment.end},asetpts=PTS-STARTPTS[a{index}]"
            )
            joins.append(f"[a{index}]")
    filters.append(
        "".join(joins)
        + f"concat=n={len(document.segments)}:v=1:a={int(audio)}[video]"
        + ("[audio]" if audio else "")
    )
    temporary = partial_path(output)
    with tempfile.TemporaryDirectory(prefix="editor_", ignore_cleanup_errors=True) as work:
        ass = Path(work) / "captions.ass"
        write_ass(ass, document, width, height)
        fonts = ass_fonts_dir(document.captions.font)
        fonts_option = f":fontsdir={ffmpeg_escape_filter_path(fonts)}" if fonts else ""
        filters.append(
            f"[video]{geometry},{effects},ass={ffmpeg_escape_filter_path(ass)}{fonts_option}[outv]"
        )
        if audio:
            filters.append(
                f"[audio]volume={0 if document.muted else document.volume}[outa]"
            )
        command = [
            "ffmpeg",
            "-y",
            "-i",
            str(source),
            "-filter_complex",
            ";".join(filters),
            "-map",
            "[outv]",
        ]
        if audio:
            command += ["-map", "[outa]", "-c:a", "aac", "-b:a", "192k"]
        command += [
            "-c:v",
            "libx264",
            "-preset",
            "fast",
            "-crf",
            "18",
            "-maxrate",
            "12M" if preset == "reels" else "10M",
            "-bufsize",
            "24M",
            "-pix_fmt",
            "yuv420p",
            "-movflags",
            "+faststart",
            str(temporary),
        ]
        try:
            run_ffmpeg_with_progress(
                command, sum(s.end - s.start for s in document.segments), on_progress
            )
            publish_render(temporary, output)
        finally:
            temporary.unlink(missing_ok=True)
    return output
