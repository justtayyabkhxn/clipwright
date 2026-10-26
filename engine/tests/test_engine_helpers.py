"""Engine-specific behaviour: presets, yt-dlp options, font dirs, long filter graphs."""

import json
import shutil
import sys
import tempfile
import threading
import time
from pathlib import Path

import pytest

from clipwright_engine import cli, clip_editor, video_utils, youtube_utils
from clipwright_engine.caption_templates import CAPTION_TEMPLATES, TEMPLATE_DEFAULTS, get_template_info
from clipwright_engine.config import BUNDLED_FONTS_DIR, EngineConfig, set_config
from clipwright_engine.font_registry import bundled_fonts_dir, find_font_path
from clipwright_engine.media import ffmpeg

REPO = Path(__file__).resolve().parents[2]


def test_web_caption_templates_json_matches_the_engine():
    shared = json.loads((REPO / "web" / "src" / "lib" / "caption-templates.json").read_text(encoding="utf-8"))
    assert shared == {
        "defaults": TEMPLATE_DEFAULTS,
        "templates": CAPTION_TEMPLATES,
        "info": get_template_info(),
    }


def _capture_export(monkeypatch, fps):
    commands = []
    monkeypatch.setattr(clip_editor, "probe_video_geometry", lambda _path: type("Geometry", (), {"fps": fps})())
    monkeypatch.setattr(clip_editor, "ffprobe_duration", lambda _path: 2.0)

    def fake_run(command, duration, on_progress=None):
        commands.append(command)
        Path(command[-1]).write_bytes(b"encoded")

    monkeypatch.setattr(clip_editor, "run_ffmpeg_with_progress", fake_run)
    return commands


def test_export_preset_drops_frame_rates_above_60(tmp_path, monkeypatch):
    scratch = tmp_path / "tmp"
    scratch.mkdir()
    monkeypatch.setattr(tempfile, "tempdir", str(scratch))
    commands = _capture_export(monkeypatch, 120)
    output = tmp_path / "exports" / "out.mp4"
    assert clip_editor.export_with_preset(tmp_path / "clip.mp4", output, "tiktok") == output
    video_filter = commands[0][commands[0].index("-vf") + 1]
    assert video_filter.startswith("fps=60,")
    assert "scale=1080:1920" in video_filter
    # Encoded in the work dir, then moved into place.
    assert Path(commands[0][-1]).parent == scratch
    assert output.read_bytes() == b"encoded" and list(scratch.iterdir()) == []
    assert [p.name for p in output.parent.iterdir()] == ["out.mp4"]


def test_export_preset_keeps_frame_rates_at_or_below_60(tmp_path, monkeypatch):
    commands = _capture_export(monkeypatch, 30)
    clip_editor.export_with_preset(tmp_path / "clip.mp4", tmp_path / "out.mp4", "reels")
    command = commands[0]
    assert "fps=" not in command[command.index("-vf") + 1]
    assert command[command.index("-maxrate") + 1] == "12M"


def test_ytdlp_uses_node_and_caps_height(tmp_path):
    options = youtube_utils.download_options("abcdefghijk", tmp_path)
    assert options["js_runtimes"] == {"node": {}}
    assert "nocheckcertificate" not in options  # TLS verification stays on
    assert options["format"] == "bv*[height<=1080]+ba/b[height<=1080]"
    assert youtube_utils.download_options("abcdefghijk", tmp_path, 720)["format"] == (
        "bv*[height<=720]+ba/b[height<=720]"
    )
    assert youtube_utils.download_options("abcdefghijk", tmp_path, 4320)["format"].endswith("[height<=1080]")
    set_config(EngineConfig(youtube_max_height=480))
    assert youtube_utils.download_options("abcdefghijk", tmp_path)["format"].endswith("[height<=480]")
    assert options["outtmpl"] == str(tmp_path / "abcdefghijk.%(ext)s")


def test_youtube_ids_from_common_url_shapes():
    for url in (
        "https://www.youtube.com/watch?v=jNQXAC9IVRw",
        "https://youtu.be/jNQXAC9IVRw?t=3",
        "https://www.youtube.com/shorts/jNQXAC9IVRw",
        "https://m.youtube.com/watch?feature=share&v=jNQXAC9IVRw",
    ):
        assert youtube_utils.get_youtube_video_id(url) == "jNQXAC9IVRw"
    assert youtube_utils.get_youtube_video_id("https://example.com/watch?v=x") is None


def test_fonts_resolve_across_dirs_in_order(tmp_path):
    user_dir = tmp_path / "user"
    user_dir.mkdir()
    shutil.copy(BUNDLED_FONTS_DIR / "Poppins-ExtraBold.ttf", user_dir / "usr-abc-brand.ttf")
    shutil.copy(BUNDLED_FONTS_DIR / "Poppins-ExtraBold.ttf", user_dir / "THEBOLDFONT.ttf")
    set_config(EngineConfig(fonts_dirs=[BUNDLED_FONTS_DIR, user_dir]))

    assert bundled_fonts_dir() == BUNDLED_FONTS_DIR
    assert find_font_path("THEBOLDFONT") == BUNDLED_FONTS_DIR / "THEBOLDFONT.ttf"
    assert find_font_path("usr-abc-brand") == user_dir / "usr-abc-brand.ttf"
    assert find_font_path("theboldfont") == BUNDLED_FONTS_DIR / "THEBOLDFONT.ttf"
    assert find_font_path("../THEBOLDFONT") is None
    assert find_font_path("missing") is None


def test_request_config_keeps_the_defaults():
    config = EngineConfig.from_request({"work_dir": "x"})
    assert (config.speaker_framing, config.hook_first_teaser, config.max_video_duration) == (True, False, 5400)
    assert config.fonts_dirs == [BUNDLED_FONTS_DIR]
    config = EngineConfig.from_request(
        {"config": {"speaker_framing": False, "youtube_max_height": 4000}, "fonts_dirs": [str(Path.cwd())]}
    )
    assert config.speaker_framing is False and config.youtube_max_height == 1080
    assert config.fonts_dirs == [Path.cwd().resolve()]


def test_long_filter_graphs_go_through_a_script_file():
    graph = ",".join(["null"] * 1000)
    command, scripts = ffmpeg.externalize_filter_graphs(["ffmpeg", "-i", "in.mp4", "-vf", graph, "out.mp4"])
    try:
        assert command[3] in ("-/vf", "-filter_script:v")
        assert Path(command[4]).read_text(encoding="utf-8") == graph
    finally:
        for script in scripts:
            script.unlink()
    short, none = ffmpeg.externalize_filter_graphs(["ffmpeg", "-vf", "null", "out.mp4"])
    assert short == ["ffmpeg", "-vf", "null", "out.mp4"] and none == []
    assert ffmpeg.externalize_filter_graphs(["ffprobe", "-vf", graph]) == (["ffprobe", "-vf", graph], [])


@pytest.mark.skipif(not shutil.which("ffmpeg"), reason="ffmpeg required")
def test_graph_longer_than_the_windows_command_line_still_renders(tmp_path, monkeypatch):
    scratch = tmp_path / "tmp"
    scratch.mkdir()
    monkeypatch.setattr(tempfile, "tempdir", str(scratch))
    # ~40 KB of filters would exceed CreateProcess's 32,767-character limit inline.
    graph = "[0:v]" + ",".join(["null"] * 8000) + "[v]"
    assert len(graph) > 32767
    output = tmp_path / "out.mp4"
    result = ffmpeg.run_ffmpeg_command(
        [
            "ffmpeg", "-y", "-v", "error",
            "-f", "lavfi", "-i", "color=c=red:s=64x64:d=0.2",
            "-filter_complex", graph, "-map", "[v]",
            "-c:v", "libx264", "-pix_fmt", "yuv420p", str(output),
        ],
        timeout=120,
    )
    assert result.returncode == 0, result.stderr
    assert output.stat().st_size > 0
    assert list(scratch.iterdir()) == []


def test_clip_filenames_keep_only_label_digits(tmp_path, monkeypatch):
    rendered = []
    monkeypatch.setattr(video_utils, "create_optimized_clip", lambda _video, _s, _e, path, *a, **k: rendered.append(path) or True)
    segment = {"start_time": "/../../escaped", "end_time": "00:03", "text": "x", "keep_ranges": [[0.0, 3.0]]}
    clip = video_utils.create_single_clip(tmp_path / "source.mp4", segment, 0, tmp_path / "out")
    assert clip["filename"].startswith("clip_1_-0003_")
    assert rendered == [tmp_path / "out" / clip["filename"]] and Path(clip["path"]) == rendered[0]


def test_cancel_sweep_kills_a_child_that_is_mid_spawn(monkeypatch):
    spawning = threading.Event()
    spawn = cli._BasePopen.__init__

    def slow_spawn(self, *args, **kwargs):
        spawning.set()
        time.sleep(0.3)  # the sweep starts inside this window
        spawn(self, *args, **kwargs)

    monkeypatch.setattr(cli._BasePopen, "__init__", slow_spawn)
    children = []
    spawner = threading.Thread(
        target=lambda: children.append(cli._TrackedPopen([sys.executable, "-c", "import time; time.sleep(30)"]))
    )
    try:
        spawner.start()
        assert spawning.wait(10)
        sweeper = threading.Thread(target=cli._kill_children)
        sweeper.start()
        spawner.join(10)
        sweeper.join(10)
        [child] = children
        assert child.wait(timeout=5) is not None
        with pytest.raises(OSError):
            cli._TrackedPopen([sys.executable, "-c", "pass"])
    finally:
        cli._cancelling.clear()
        for child in children:
            child.kill()
