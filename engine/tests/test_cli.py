"""The stdin/stdout protocol, end to end, against a synthetic ffmpeg source."""

import json
import os
import subprocess
import sys
import time
from pathlib import Path

import pytest

from clipwright_engine.config import BUNDLED_FONTS_DIR
from clipwright_engine.editor_document import EditDocument
from conftest import make_video, needs_ffmpeg

ENGINE_DIR = Path(__file__).resolve().parents[1]
pytestmark = needs_ffmpeg


def _argv(command):
    return [sys.executable, "-X", "utf8", "-m", "clipwright_engine", command]


def _env():
    return {**os.environ, "PYTHONUTF8": "1", "PYTHONIOENCODING": "utf-8"}


def engine(command, request, timeout=600):
    """Run one command; every stdout line must be a JSON event."""
    proc = subprocess.run(
        _argv(command),
        input=json.dumps(request).encode("utf-8"),
        capture_output=True,
        cwd=ENGINE_DIR,
        env=_env(),
        timeout=timeout,
    )
    events = [json.loads(line) for line in proc.stdout.decode("utf-8").splitlines()]
    assert events, proc.stderr.decode("utf-8", "replace")[-2000:]
    return proc.returncode, events


def ok(command, request, timeout=600):
    code, events = engine(command, request, timeout)
    assert code == 0 and events[-1]["type"] == "result", events[-1]
    return events[-1]["data"], events


def failure(command, request):
    code, events = engine(command, request)
    assert code == 1 and len(events) == 1 and events[0]["type"] == "error", events
    return events[0]


def probe(path):
    data, _ = ok("probe", {"work_dir": str(Path(path).parent / "probe-work"), "path": str(path)})
    return data


@pytest.fixture
def work(tmp_path):
    return {"work_dir": str(tmp_path / "work"), "fonts_dirs": [str(BUNDLED_FONTS_DIR)]}


def test_probe_reports_geometry(synthetic_source, work):
    data, events = ok("probe", {**work, "path": str(synthetic_source)})
    assert events == [{"type": "result", "data": data}]
    assert data == {"duration": pytest.approx(12, abs=0.1), "width": 1920, "height": 1080, "fps": 30.0, "has_audio": True}


def test_bad_requests_fail_with_codes(tmp_path, work):
    code, events = engine("nonsense", {})
    assert code == 1 and events[0]["code"] == "invalid_request"

    proc = subprocess.run(_argv("probe"), input=b"{not json", capture_output=True, cwd=ENGINE_DIR, env=_env())
    assert proc.returncode == 1 and json.loads(proc.stdout)["code"] == "invalid_request"

    assert failure("probe", {"path": str(tmp_path / "x.mp4")})["code"] == "invalid_request"  # no work_dir
    assert failure("probe", {**work, "path": "relative.mp4"})["code"] == "invalid_request"
    assert failure("probe", {**work, "path": str(tmp_path / "missing.mp4")})["code"] == "not_found"
    junk = tmp_path / "junk.mp4"
    junk.write_bytes(b"not a video")
    assert failure("probe", {**work, "path": str(junk)})["code"] == "invalid_request"
    assert failure("render-clips", {**work, "video_path": str(junk), "output_dir": str(tmp_path), "segments": [{}]})["code"] == "invalid_request"
    assert failure("youtube-info", {**work, "url": "https://example.com/video"})["code"] == "invalid_request"


def test_prepare_source_guards_duration_and_caps_resolution(tmp_path, work):
    source = make_video(tmp_path / "big.mp4", size="2560x1440", duration=1.5, rate=30)
    error = failure("prepare-source", {**work, "video_path": str(source), "max_duration_seconds": 60 - 59})
    assert error["code"] == "too_long"
    assert error["message"] == "Video is too long (0 min). Maximum allowed duration is 0 minutes."

    data, _ = ok("prepare-source", {**work, "video_path": str(source), "max_duration_seconds": 5400})
    assert data["normalized"] is True and (data["width"], data["height"]) == (1920, 1080)
    again, _ = ok("prepare-source", {**work, "video_path": str(source)})
    assert again["normalized"] is False
    assert not [p for p in tmp_path.iterdir() if p.name.startswith(".")]


def test_streamed_webm_without_a_container_duration_is_measured(tmp_path, work):
    # Browser (MediaRecorder) uploads are streamed WebM: ffprobe reports no duration.
    source = tmp_path / "recording.webm"
    with source.open("wb") as out:
        subprocess.run(
            ["ffmpeg", "-v", "error", "-f", "lavfi", "-i", "testsrc2=size=640x360:duration=4",
             "-f", "lavfi", "-i", "sine=duration=4", "-c:v", "libvpx", "-c:a", "libopus", "-f", "webm", "-"],
            stdout=out, check=True, timeout=120,
        )
    data, _ = ok("probe", {**work, "path": str(source)})
    assert data["duration"] == pytest.approx(4, abs=0.1) and (data["width"], data["height"]) == (640, 360)
    assert failure("prepare-source", {**work, "video_path": str(source), "max_duration_seconds": 1})["code"] == "too_long"
    prepared, _ = ok("prepare-source", {**work, "video_path": str(source)})
    assert prepared["duration"] == pytest.approx(4, abs=0.1) and prepared["normalized"] is False
    # Errors name the file, never its location on the server.
    junk = tmp_path / "junk.webm"
    junk.write_bytes(b"not a video")
    error = failure("prepare-source", {**work, "video_path": str(junk)})
    assert error["code"] == "invalid_request" and str(tmp_path) not in error["message"] and "junk.webm" in error["message"]


def test_transcribe_formats_an_existing_sidecar_without_a_key(synthetic_source, work):
    from clipwright_engine.media.transcription import format_transcript_for_analysis, load_cached_transcript_data

    data, _ = ok("transcribe", {**work, "video_path": str(synthetic_source)})
    sidecar = load_cached_transcript_data(synthetic_source)
    assert data == {
        "transcript_text": "\n".join(format_transcript_for_analysis(sidecar)),
        "language_code": "en",
        "word_count": len(sidecar["words"]),
    }
    assert data["transcript_text"].splitlines()[1].startswith("[00:06 - 00:11] Speaker B:")


def test_signals_rank_trigger_lines(synthetic_source, work):
    transcript = "\n".join([
        "[00:00 - 00:04] Speaker A: This is normal setup",
        "[00:05 - 00:08] Speaker B: Wait, this part is actually the secret?",
    ])
    data, _ = ok("signals", {**work, "video_path": str(synthetic_source), "transcript_text": transcript})
    assert "Wait, this part is actually the secret?" in data["clip_signals"]
    empty, _ = ok("signals", {**work, "video_path": str(synthetic_source), "transcript_text": ""})
    assert empty == {"clip_signals": None}


@pytest.fixture(scope="module")
def vertical_render(synthetic_source, tmp_path_factory):
    root = tmp_path_factory.mktemp("vertical")
    request = {
        "work_dir": str(root / "work"),
        "fonts_dirs": [str(BUNDLED_FONTS_DIR)],
        "video_path": str(synthetic_source),
        "output_dir": str(root / "clips"),
        "segments": [
            {"start_time": "00:02", "end_time": "00:05", "text": "AI text", "hook_title": "The secret engine test"},
            {"start_time": "00:05", "end_time": "00:05", "text": "empty"},
        ],
        "options": {
            "output_format": "vertical",
            "add_subtitles": True,
            "caption_template": "hormozi",
            "font_family": None,
            "font_size": None,
            "font_color": None,
            "cleanup": {"cut_long_pauses": True, "pause_threshold_ms": 1200, "remove_filler_words": True, "filtered_words": []},
            "max_clip_seconds": 60,
        },
    }
    return ok("render-clips", request)


def test_render_clips_vertical_with_subtitles(vertical_render):
    data, events = vertical_render
    assert [e["type"] for e in events] == ["clip_start", "clip", "clip_start", "clip_failed", "result"]
    assert events[0] == {"type": "clip_start", "index": 0, "total": 2}
    assert events[3]["index"] == 1 and events[3]["message"]
    assert data["failed"] == [1]
    [clip] = data["clips"]
    assert clip == events[1]["clip"] and events[1]["index"] == 0
    assert set(clip) == {
        "index", "filename", "path", "start_time", "end_time", "duration", "text",
        "keep_ranges", "source_ranges", "caption_settings",
    }
    assert clip["filename"].startswith("clip_1_0002-0005_") and Path(clip["path"]).name == clip["filename"]
    # Snapped to the sentence start and extended to the sentence end.
    assert clip["text"].startswith("This is a test of the clip engine.")
    assert clip["source_ranges"] == [{"start": s, "end": e} for s, e in clip["keep_ranges"]]
    assert clip["duration"] == pytest.approx(sum(e - s for s, e in clip["keep_ranges"]))
    assert clip["caption_settings"]["font_size"] == 32
    assert 0 < clip["caption_settings"]["position_y"] < 1  # the layout's caption row is kept
    info = probe(clip["path"])
    assert (info["width"], info["height"]) == (1080, 1920) and info["has_audio"]
    assert info["duration"] == pytest.approx(clip["duration"], abs=0.2)


def test_render_clips_original_without_subtitles_keeps_supplied_ranges(synthetic_source, tmp_path, work):
    def render(keep):
        data, _ = ok("render-clips", {
            **work,
            "video_path": str(synthetic_source),
            "output_dir": str(tmp_path / "clips"),
            "segments": [{"start_time": "00:01", "end_time": "00:07", "text": "Restyled text", "keep_ranges": keep}],
            "options": {"output_format": "original", "add_subtitles": False, "caption_template": "default", "font_size": 40},
        })
        [clip] = data["clips"]
        return clip

    keep = [[1.0, 3.0], [5.0, 7.5]]
    clip = render(keep)
    # A restyle with unchanged cleanup renders exactly the stored ranges.
    assert clip["keep_ranges"] == keep
    assert clip["text"] == "Restyled text"
    assert clip["caption_settings"] == {"font_size": 40}
    info = probe(clip["path"])
    assert (info["width"], info["height"]) == (1920, 1080)
    # Two ranges join with a short crossfade, so the clip is a little shorter than their sum.
    assert clip["duration"] - 0.2 < info["duration"] <= clip["duration"] + 0.05


def test_export_preset_pads_to_portrait(synthetic_source, tmp_path, work):
    output = tmp_path / "exports" / "export.mp4"
    data, events = ok("export-preset", {**work, "input": str(synthetic_source), "output": str(output), "preset": "shorts"})
    assert data == {"path": str(output)}
    progress = [e["pct"] for e in events if e["type"] == "progress"]
    assert progress and progress == sorted(progress) and progress[-1] <= 99
    info = probe(output)
    assert (info["width"], info["height"]) == (1080, 1920)
    assert failure("export-preset", {**work, "input": str(synthetic_source), "output": str(output), "preset": "vhs"})["code"] == "invalid_request"


@pytest.fixture(scope="module")
def prepared(synthetic_source, tmp_path_factory):
    root = tmp_path_factory.mktemp("editor")
    data, _ = ok("editor-prepare", {
        "work_dir": str(root / "work"),
        "fonts_dirs": [str(BUNDLED_FONTS_DIR)],
        "source_video_path": str(synthetic_source),
        "source_ranges": [{"start": 1.91, "end": 5.6}],
        "output_dir": str(root / "media"),
        "output_format": "vertical",
        "clip_text": "This is a test of the clip engine.",
        "hook_title": "The secret engine test",
        "add_subtitles": True,
        "caption_settings": {"position_y": 0.8, "font_size": 32},
        "task_style": {"caption_template": "hormozi", "font_family": None, "font_size": None, "font_color": None},
    })
    return root, data


def test_editor_prepare_builds_preview_media_and_a_draft(prepared):
    _root, data = prepared
    assert set(data) == {"asset", "clean_path", "thumbnails_path", "initial_document"}
    asset = data["asset"]
    assert set(asset) == {"width", "height", "fps", "duration", "hasAudio", "waveform"}
    assert (asset["width"], asset["height"]) == (1920, 1080) and asset["hasAudio"]
    assert len(asset["waveform"]) == 160 and max(asset["waveform"]) > 0.1
    assert Path(data["clean_path"]).is_file() and Path(data["thumbnails_path"]).is_file()
    document = EditDocument.model_validate(data["initial_document"]).validate_duration(asset["duration"])
    assert document.framing.aspect == "vertical" and document.captions.template == "hormozi"
    assert document.hookTitle == "The secret engine test"
    assert [w.text for w in document.words] == "This is a test of the clip engine.".split()


def test_editor_render_draws_the_document(prepared, work, tmp_path):
    _root, data = prepared
    document = data["initial_document"]
    document["segments"] = [{"id": "a", "start": 0, "end": 1.5}, {"id": "b", "start": 2.0, "end": 3.0}]
    output = tmp_path / "editor-exports" / "job.mp4"
    result, events = ok("editor-render", {**work, "clean_path": data["clean_path"], "document": document, "preset": "reels", "output": str(output)})
    assert result == {"path": str(output)}
    assert any(e["type"] == "progress" for e in events)
    info = probe(output)
    assert (info["width"], info["height"]) == (1080, 1920)
    assert info["duration"] == pytest.approx(2.5, abs=0.15)
    bad = {**document, "segments": []}
    assert failure("editor-render", {**work, "clean_path": data["clean_path"], "document": bad, "output": str(output)})["code"] == "invalid_request"


def test_editor_combine_joins_drafts(prepared, work, tmp_path):
    _root, data = prepared
    first = {**data["initial_document"], "segments": [{"id": "a", "start": 0.0, "end": 1.0}]}
    second = {**data["initial_document"], "segments": [{"id": "b", "start": 2.0, "end": 3.0}], "framing": {"aspect": "original"}}
    inputs = [
        {"clean_path": data["clean_path"], "document": doc, "has_audio": True, "width": 1920, "height": 1080,
         "source_ranges": [{"start": 1.91, "end": 5.6}]}
        for doc in (first, second)
    ]
    result, _ = ok("editor-combine", {**work, "inputs": inputs, "output_dir": str(tmp_path / "combined")})
    assert set(result) == {"clean_path", "export_path", "thumbnails_path", "document", "asset", "source_ranges"}
    assert result["source_ranges"] == [
        {"start": 1.91, "end": 2.91},
        {"start": 3.91, "end": 4.91},
    ]
    document = EditDocument.model_validate(result["document"])
    assert document.hookTitle == "" and document.segments[0].id == "combined"
    assert result["asset"]["duration"] == pytest.approx(2.0, abs=0.15)
    assert len({w.id for w in document.words}) == len(document.words) > 0
    clean, export = probe(result["clean_path"]), probe(result["export_path"])
    assert (clean["width"], clean["height"]) == (1920, 1080)
    assert (export["width"], export["height"]) == (1080, 1920)


def test_cancel_file_stops_a_render_quickly(synthetic_source, tmp_path, work):
    cancel = tmp_path / "cancel"
    request = {
        **work,
        "cancel_file": str(cancel),
        "video_path": str(synthetic_source),
        "output_dir": str(tmp_path / "clips"),
        "segments": [{"start_time": "00:00", "end_time": "00:11", "text": "x"}] * 3,
        "options": {"output_format": "vertical", "add_subtitles": True},
    }
    proc = subprocess.Popen(_argv("render-clips"), stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, cwd=ENGINE_DIR, env=_env())
    proc.stdin.write(json.dumps(request).encode("utf-8"))
    proc.stdin.close()
    first = json.loads(proc.stdout.readline())
    assert first["type"] == "clip_start"
    time.sleep(1.0)  # let ffmpeg get going
    cancel.touch()
    started = time.monotonic()
    proc.wait(timeout=15)
    elapsed = time.monotonic() - started
    rest = [json.loads(line) for line in proc.stdout.read().decode("utf-8").splitlines()]
    assert proc.returncode == 2
    assert rest[-1] == {"type": "error", "code": "cancelled", "message": "Cancelled"}
    assert elapsed < 3, elapsed
    assert not list((tmp_path / "clips").glob("*.mp4"))

    # A cancel file that already exists stops the job before any work.
    code, events = engine("render-clips", request)
    assert code == 2 and events == [{"type": "error", "code": "cancelled", "message": "Cancelled"}]


def test_child_output_never_reaches_the_event_stream(tmp_path, work):
    # A subprocess that inherits fd 1 must write to stderr, not into the NDJSON.
    script = "import subprocess, sys; subprocess.run([sys.executable, '-c', 'print(\"stray\")']); print('also stray')"
    proc = subprocess.run(
        [sys.executable, "-X", "utf8", "-c",
         "import sys; sys.argv=['x','probe']; from clipwright_engine import cli; "
         "cli.COMMANDS['probe'] = lambda request, events: exec(" + repr(script) + ") or {'ok': True}; "
         "sys.exit(cli.main())"],
        input=json.dumps(work).encode(), capture_output=True, cwd=ENGINE_DIR, env=_env(), timeout=60,
    )
    assert proc.returncode == 0
    assert [json.loads(line) for line in proc.stdout.decode().splitlines()] == [{"type": "result", "data": {"ok": True}}]
    assert b"stray" in proc.stderr and b"also stray" in proc.stderr
