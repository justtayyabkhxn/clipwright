import json
import shutil
import subprocess
from pathlib import Path

import pytest

from clipwright_engine.config import EngineConfig, set_config

needs_ffmpeg = pytest.mark.skipif(
    not (shutil.which("ffmpeg") and shutil.which("ffprobe")), reason="ffmpeg and ffprobe required"
)

# Hand-written AssemblyAI-style timings (ms) for the 12 s synthetic source.
SPOKEN = (
    "Hello everyone and welcome. This is a test of the clip engine. "
    "It renders captions for every word. Wait, this part is actually the secret. "
    "Thanks for watching."
)


def sidecar_payload(text: str = SPOKEN, start_ms: int = 300, step_ms: int = 420) -> dict:
    words = []
    position = start_ms
    for token in text.split():
        speaker = "A" if position < 6000 else "B"
        words.append({"text": token, "start": position, "end": position + 350, "confidence": 0.99, "speaker": speaker})
        position += step_ms
    utterances = []
    for speaker in ("A", "B"):
        own = [word for word in words if word["speaker"] == speaker]
        utterances.append({
            "text": " ".join(word["text"] for word in own),
            "start": own[0]["start"],
            "end": own[-1]["end"],
            "speaker": speaker,
            "words": own,
        })
    return {"version": 2, "words": words, "utterances": utterances, "text": text, "language_code": "en"}


def make_video(path: Path, size: str = "1920x1080", duration: float = 12, rate: int = 30, audio: bool = True) -> Path:
    command = ["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", f"testsrc2=size={size}:rate={rate}:duration={duration}"]
    if audio:
        command += ["-f", "lavfi", "-i", f"sine=frequency=440:sample_rate=48000:duration={duration}"]
    command += ["-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p"]
    if audio:
        command += ["-c:a", "aac", "-shortest"]
    subprocess.run(command + [str(path)], check=True, capture_output=True, timeout=120)
    return path


@pytest.fixture(scope="session")
def synthetic_source(tmp_path_factory) -> Path:
    """A 12 s 1920x1080 testsrc2 + sine source with a v2 transcript sidecar."""
    if not (shutil.which("ffmpeg") and shutil.which("ffprobe")):
        pytest.skip("ffmpeg and ffprobe required")
    source = make_video(tmp_path_factory.mktemp("source") / "source.mp4")
    source.with_suffix(".transcript_cache.json").write_text(json.dumps(sidecar_payload()), encoding="utf-8")
    return source


@pytest.fixture(autouse=True)
def default_engine_config():
    """Each test starts from the request defaults (bundled web/fonts, speaker framing on)."""
    set_config(EngineConfig())
    yield
    set_config(EngineConfig())
