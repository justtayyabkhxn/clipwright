from unittest.mock import patch
from pathlib import Path
import tempfile

import pytest

from clipwright_engine.media import captions, timeline, transcription


def test_get_scaled_font_size_preserves_visible_ui_range():
    sizes = [
        captions.get_scaled_font_size(size, 1080)
        for size in (12, 24, 32, 48, 72)
    ]

    assert sizes == [26, 46, 62, 93, 132]
    assert sizes == sorted(sizes)


def test_build_ass_subtitles_preserves_background_template(tmp_path):
    video_path = tmp_path / "source.mp4"
    video_path.with_suffix(".transcript_cache.json").write_text(
        """
        {
          "version": 2,
          "words": [
            {"text": "quiet", "start": 0, "end": 400, "confidence": 0.99},
            {"text": "caption", "start": 400, "end": 900, "confidence": 0.99}
          ],
          "utterances": [],
          "text": "quiet caption"
        }
        """,
        encoding="utf-8",
    )
    ass_path = tmp_path / "captions.ass"

    success = captions.build_assemblyai_ass_subtitles(
        video_path,
        clip_start=0.0,
        clip_end=1.0,
        video_width=1080,
        video_height=1920,
        output_ass_path=ass_path,
        caption_template="minimal",
        keep_ranges=[(0.0, 1.0)],
    )

    content = ass_path.read_text(encoding="utf-8")
    assert success is True
    assert "Style: Default" in content
    assert ",3," in content
    assert "\\fad(120,120)" in content


def test_prepare_audio_for_transcription_extracts_compact_mp3(tmp_path, monkeypatch):
    work = tmp_path / "work"
    work.mkdir()
    monkeypatch.setattr(tempfile, "tempdir", str(work))
    video_path = tmp_path / "source.mp4"
    video_path.write_bytes(b"video")
    commands = []

    class Result:
        returncode = 0
        stdout = ""
        stderr = ""

    def fake_run(command, timeout=900):
        commands.append(command)
        Path(command[-1]).write_bytes(b"audio")
        return Result()

    other_video = tmp_path / "other" / "source.mp4"
    with patch("clipwright_engine.media.transcription.run_ffmpeg_command", side_effect=fake_run), patch(
        "clipwright_engine.media.transcription.select_audio_stream_index", return_value=1
    ):
        audio_path = transcription._prepare_audio_for_transcription(video_path)
        other_audio = transcription._prepare_audio_for_transcription(other_video)

    # The extract is job scratch: it lands in the work dir, never beside the source.
    assert audio_path.parent == work and audio_path.name.endswith(".transcription.mp3")
    assert audio_path.read_bytes() == b"audio"
    assert commands[0][0] == "ffmpeg"
    assert commands[0][commands[0].index("-map") + 1] == "0:a:1"
    assert "-vn" in commands[0]
    assert "64k" in commands[0]
    # Every source is source.mp4: another video never reuses this extract.
    assert other_audio != audio_path and len(commands) == 2
    assert commands[1][commands[1].index("-i") + 1] == str(other_video)


def test_failed_audio_extract_is_removed(tmp_path, monkeypatch):
    monkeypatch.setattr(tempfile, "tempdir", str(tmp_path))
    video_path = tmp_path / "source.mp4"

    class Failed:
        returncode = 1

    def fake_run(command, timeout=900):
        Path(command[-1]).write_bytes(b"trunc")  # a partial left by the failing ffmpeg
        return Failed()

    with patch("clipwright_engine.media.transcription.run_ffmpeg_command", side_effect=fake_run), patch(
        "clipwright_engine.media.transcription.select_audio_stream_index", return_value=None
    ):
        assert transcription._prepare_audio_for_transcription(video_path) == video_path
    assert not list(tmp_path.glob("*.mp3"))


def test_build_assemblyai_ass_subtitles_uses_cached_word_timings(tmp_path):
    video_path = tmp_path / "source.mp4"
    cache_path = video_path.with_suffix(".transcript_cache.json")
    cache_path.write_text(
        """
        {
          "version": 2,
          "words": [
            {"text": "hello", "start": 1000, "end": 1300, "confidence": 0.99},
            {"text": "world", "start": 1300, "end": 1800, "confidence": 0.99}
          ],
          "utterances": [],
          "text": "hello world"
        }
        """,
        encoding="utf-8",
    )

    ass_path = tmp_path / "captions.ass"
    success = captions.build_assemblyai_ass_subtitles(
        video_path,
        clip_start=1.0,
        clip_end=2.0,
        video_width=1080,
        video_height=1920,
        output_ass_path=ass_path,
        font_family="TikTokSans-Regular",
        font_size=32,
        font_color="#FFFFFF",
        caption_template="default",
        keep_ranges=[(1.0, 2.0)],
    )

    content = ass_path.read_text(encoding="utf-8")
    assert success is True
    assert "PlayResX: 1080" in content
    # Words are now each wrapped in their own font/colour span for per-word
    # karaoke highlighting, so check the cached words are rendered individually.
    assert "hello" in content
    assert "world" in content
    assert "Dialogue:" in content


def test_ass_font_name_uses_internal_font_family():
    assert captions.ass_font_name("THEBOLDFONT") == "THE BOLD FONT FREE VERSION"


def test_extend_keep_ranges_finishes_nearby_sentence(tmp_path):
    video_path = tmp_path / "source.mp4"
    video_path.with_suffix(".transcript_cache.json").write_text(
        """
        {
          "version": 2,
          "words": [
            {"text": "One", "start": 15440, "end": 15760, "confidence": 0.99},
            {"text": "has", "start": 15760, "end": 16040, "confidence": 0.99},
            {"text": "depression", "start": 16040, "end": 16520, "confidence": 0.99},
            {"text": "and", "start": 16520, "end": 16680, "confidence": 0.99},
            {"text": "the", "start": 16680, "end": 16840, "confidence": 0.99},
            {"text": "other", "start": 16840, "end": 17080, "confidence": 0.99},
            {"text": "has", "start": 17080, "end": 17320, "confidence": 0.99},
            {"text": "anger", "start": 17320, "end": 17680, "confidence": 0.99},
            {"text": "issues.", "start": 17680, "end": 18000, "confidence": 0.99}
          ],
          "utterances": [],
          "text": "One has depression and the other has anger issues."
        }
        """,
        encoding="utf-8",
    )

    with patch("clipwright_engine.media.timeline.ffprobe_duration", return_value=60.0):
        ranges = timeline.extend_keep_ranges_to_sentence_boundary(
            video_path,
            [(0.0, 16.0)],
        )

    assert ranges[0][0] == 0.0
    assert ranges[0][1] == pytest.approx(18.35)


def test_build_clip_signal_summary_surfaces_hook_and_audio_peak(monkeypatch, tmp_path):
    transcript = "\n".join(
        [
            "[00:00 - 00:04] Speaker A: This is normal setup",
            "[00:05 - 00:08] Speaker B: Wait what happened?",
            "[00:08 - 00:12] Speaker A: Nobody expected the result!",
        ]
    )
    monkeypatch.setattr(timeline, "detect_audio_peak_times", lambda _path: [6.0])

    summary = timeline.build_clip_signal_summary(tmp_path / "source.mp4", transcript)

    assert "Wait what happened?" in summary
    assert "audio energy peak" in summary
    assert "question/hook" in summary
