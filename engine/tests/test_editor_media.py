import tempfile

import pytest

from clipwright_engine import editor_media, video_utils
from clipwright_engine.editor_document import EditDocument
from clipwright_engine.editor_media import caption_looks, generated_emphasis, initial_caption_style
from clipwright_engine.media.captions import get_safe_vertical_position


def test_editor_starts_from_the_generated_caption_template():
    style = initial_caption_style(
        {"caption_template": "hormozi", "font_family": None, "font_color": None},
        {},
        True,
        1080,
        1920,
    )
    assert style["karaoke"] is True
    assert style["template"] == "hormozi"
    assert style["uppercase"] is True
    assert style["accent"] == "#00FF66"
    assert style["background"] is False
    assert style["wordsPerLine"] == 3
    assert style["font"] == "THEBOLDFONT"
    # Same pixel size and centre row as the generated 1080x1920 clip.
    assert style["size"] == round(32 * 1080 / 560)
    assert style["y"] * 1920 == get_safe_vertical_position(1920, int(62 * 1.5), 0.74)
    EditDocument.model_validate(
        {"segments": [{"id": "s", "start": 0, "end": 1}], "captions": style}
    )

    minimal = initial_caption_style(
        {"caption_template": "minimal", "font_size": 24}, {"position_y": 0.5}, False, 1080, 1920
    )
    assert minimal["karaoke"] is False
    assert minimal["background"] is True
    assert minimal["enabled"] is False
    assert minimal["y"] < 0.5  # centred, not top-aligned, like the generated clip


def test_editor_keeps_generated_font_and_size_extremes():
    tiktok = initial_caption_style({"caption_template": "tiktok"}, {}, True, 1080, 1920)
    assert tiktok["font"] == "TikTokSans-Bold"

    largest = initial_caption_style({"font_size": 72}, {}, True, 1080, 1920)
    assert largest["size"] == 132

    # "original" clips keep the source size; the editor re-expresses it per 1080 px.
    landscape = initial_caption_style({"font_size": 24}, {}, True, 1920, 1080)
    assert landscape["size"] == round(round(24 * 1920 / 560) * 1080 / 1920)
    for style in (tiktok, largest, landscape):
        EditDocument.model_validate(
            {"segments": [{"id": "s", "start": 0, "end": 1}], "captions": style}
        )


def test_rendered_caption_settings_win_over_task_defaults():
    # render-clips reports the size it burned in and the layout's caption row.
    style = initial_caption_style({"font_size": 24}, {"font_size": 40, "position_y": 0.5}, True, 1080, 1920)
    assert style["size"] == round(40 * 1080 / 560)
    assert style["y"] < 0.5


def test_editor_seeds_the_generated_emphasis_as_highlights():
    words = [{"text": t, "start": i, "end": i + 0.5} for i, t in enumerate("this changed everything for 90% of people".split())]
    emphasis = generated_emphasis(words, {"caption_template": "default"})
    assert {words[i]["text"] for i in emphasis} >= {"90%"}
    assert "of" not in {words[i]["text"] for i in emphasis}


def test_caption_looks_cover_every_template():
    looks = caption_looks()
    assert looks["hormozi"]["wordBox"] is True
    assert looks["minimal"]["animation"] == "fade"
    assert looks["podcast"]["backgroundColor"] == "#1A1A1ACC"


def test_prepare_only_publishes_finished_media(tmp_path, monkeypatch):
    work = tmp_path / "work"
    work.mkdir()
    monkeypatch.setattr(tempfile, "tempdir", str(work))
    monkeypatch.setattr(video_utils, "create_optimized_clip", lambda _s, _a, _b, clean, **_k: clean.write_bytes(b"clean") or True)
    output_dir = tmp_path / "media"

    def prepare():
        return editor_media.prepare_editor_media(
            tmp_path / "source.mp4", [{"start": 0, "end": 2}], output_dir, "original", "", None, False, {}, {}
        )

    def interrupted(_clean, _thumbnails):
        raise RuntimeError("killed mid-encode")

    monkeypatch.setattr(editor_media, "make_assets", interrupted)
    with pytest.raises(RuntimeError):
        prepare()
    assert not output_dir.exists() and list(work.iterdir()) == []

    def assets(_clean, thumbnails):
        thumbnails.write_bytes(b"thumbs")
        return {"width": 1920, "height": 1080, "fps": 30, "duration": 2.0, "hasAudio": False, "waveform": []}

    monkeypatch.setattr(editor_media, "make_assets", assets)
    result = prepare()
    assert result["clean_path"] == str(output_dir / "clean.mp4")
    assert result["thumbnails_path"] == str(output_dir / "thumbnails.jpg")
    assert sorted(p.name for p in output_dir.iterdir()) == ["clean.mp4", "thumbnails.jpg"]
    assert list(work.iterdir()) == []
