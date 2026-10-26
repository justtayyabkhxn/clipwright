"""Real YouTube access through yt-dlp + Node. Opt in with CLIPWRIGHT_NETWORK_TESTS=1."""

import os

import pytest

from test_cli import ok, probe

URL = "https://www.youtube.com/watch?v=jNQXAC9IVRw"  # "Me at the zoo", 19 s

pytestmark = [
    pytest.mark.network,
    pytest.mark.skipif(os.environ.get("CLIPWRIGHT_NETWORK_TESTS") != "1", reason="set CLIPWRIGHT_NETWORK_TESTS=1"),
]


def test_youtube_info_and_fetch(tmp_path):
    work = {"work_dir": str(tmp_path / "work")}
    info, _ = ok("youtube-info", {**work, "url": URL}, timeout=180)
    assert info["video_id"] == "jNQXAC9IVRw"
    assert info["title"] and 15 <= info["duration"] <= 25

    output = tmp_path / "sources" / "youtube" / "jNQXAC9IVRw" / "source.mp4"
    fetched, events = ok(
        "fetch-youtube",
        {**work, "url": URL, "video_id": "jNQXAC9IVRw", "output_path": str(output), "max_height": 1080},
        timeout=600,
    )
    assert fetched["video_path"] == str(output) and fetched["from_cache"] is False
    assert fetched["duration"] == pytest.approx(info["duration"], abs=1.5)
    assert any(e["type"] == "progress" for e in events)
    assert probe(output)["has_audio"]

    again, _ = ok(
        "fetch-youtube",
        {**work, "url": URL, "video_id": "jNQXAC9IVRw", "output_path": str(output), "max_height": 1080},
    )
    assert again["from_cache"] is True
