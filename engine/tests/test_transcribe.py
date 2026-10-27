"""transcribe: AssemblyAI over a mocked HTTP layer, and the sidecar-only path."""

import json
from types import SimpleNamespace
import shutil
import subprocess
import tempfile

import assemblyai as aai
import httpx
import pytest

from clipwright_engine import cli
from clipwright_engine.media import transcription
from conftest import SPOKEN, needs_ffmpeg, sidecar_payload


def _response_json(payload: dict) -> dict:
    return {
        "id": "job-1",
        "status": "completed",
        "audio_url": "https://cdn.assemblyai.com/upload/test",
        "text": payload["text"],
        "words": payload["words"],
        "utterances": [{**u, "confidence": 0.99} for u in payload["utterances"]],
        "language_code": "en",
        "language_confidence": 0.97,
    }


def _sdk_transcript(payload: dict):
    response = aai.types.TranscriptResponse(**_response_json(payload))
    client = aai.Client(settings=aai.Settings(api_key="test"))
    try:
        return aai.Transcript.from_response(client=client, response=response)
    finally:
        client.http_client.close()


@pytest.mark.parametrize(
    "payload",
    [
        sidecar_payload(),
        # Over 80 words in one utterance: split into 24-word / 20 s analysis lines.
        sidecar_payload(" ".join([SPOKEN] * 4), step_ms=600),
    ],
)
def test_sidecar_formats_exactly_like_the_sdk_transcript(tmp_path, payload):
    if len(payload["words"]) > 80:
        payload = {**payload, "utterances": [{
            "text": payload["text"], "start": payload["words"][0]["start"],
            "end": payload["words"][-1]["end"], "speaker": "A", "words": payload["words"],
        }]}
    transcript = _sdk_transcript(payload)
    video = tmp_path / "video.mp4"
    transcription.cache_transcript_data(video, transcript)
    sidecar = transcription.load_cached_transcript_data(video)

    from_sdk = transcription.format_transcript_for_analysis(transcript)
    assert from_sdk and from_sdk == transcription.format_transcript_for_analysis(sidecar)
    assert sidecar["version"] == 2 and sidecar["language_code"] == "en"
    assert [w["text"] for w in sidecar["words"]] == [w["text"] for w in payload["words"]]
    # Words-only transcripts (no utterances) take the same path either way.
    no_utterances = {**sidecar, "utterances": []}
    words_only = _sdk_transcript({**payload, "utterances": []})
    assert transcription.format_transcript_for_analysis(words_only) == transcription.format_transcript_for_analysis(no_utterances)


class _Events:
    def __init__(self):
        self.items = []

    def emit(self, type, **fields):
        self.items.append({"type": type, **fields})


def _start(monkeypatch, request):
    # _start points tempfile at the work dir and wraps Popen; undo both afterwards.
    monkeypatch.setattr(tempfile, "tempdir", tempfile.tempdir)
    monkeypatch.setattr(subprocess, "Popen", subprocess.Popen)
    cli._start(request, _Events())


@needs_ffmpeg
def test_transcribe_calls_assemblyai_once_then_reuses_the_sidecar(synthetic_source, tmp_path, monkeypatch):
    video = tmp_path / "upload.mp4"
    shutil.copy(synthetic_source, video)  # the copy has no sidecar yet
    payload = sidecar_payload()
    calls = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append((request.method, request.url.path))
        assert request.headers["authorization"] == "job-key"
        if request.url.path == "/v2/upload":
            assert len(request.content) > 1000  # the extracted mp3
            return httpx.Response(200, json={"upload_url": "https://cdn.assemblyai.com/upload/test"})
        if request.method == "POST":
            body = json.loads(request.content)
            assert body["speech_models"] == ["universal-3-5-pro", "universal-2"]
            assert body["speaker_labels"] is True
            assert body["language_code"] == "es" and not body.get("language_detection")
            return httpx.Response(200, json={"id": "job-1", "status": "queued", "audio_url": body["audio_url"]})
        return httpx.Response(200, json=_response_json(payload))

    real_client = aai.Client

    def mocked_client(**kwargs):
        client = real_client(**kwargs)
        client.http_client.close()
        client._http_client = httpx.Client(
            base_url="https://api.assemblyai.com",
            headers={"authorization": kwargs["settings"].api_key},
            transport=httpx.MockTransport(handler),
        )
        return client

    monkeypatch.setattr(aai, "Client", mocked_client)
    monkeypatch.setattr(transcription.time, "sleep", lambda _seconds: None)
    work = tmp_path / "work"
    request = {"work_dir": str(work), "video_path": str(video), "assemblyai_api_key": "job-key", "language": "es"}
    _start(monkeypatch, request)

    first = cli.cmd_transcribe(request, _Events())
    assert sum(method == "POST" and path == "/v2/transcript" for method, path in calls) == 1
    assert first["word_count"] == len(payload["words"]) and first["language_code"] == "en"
    assert first["transcript_text"].startswith("[00:00 - 00:06] Speaker A: Hello everyone and welcome. This is")
    sidecar = json.loads(video.with_suffix(".transcript_cache.json").read_text(encoding="utf-8"))
    assert sidecar["version"] == 2 and len(sidecar["words"]) == len(payload["words"])
    # The audio extract (uploaded above) is job scratch: never beside the
    # source, and deleted once the job is done so no later run can reuse it.
    assert not list(tmp_path.rglob("*.transcription.mp3"))

    calls.clear()
    again = cli.cmd_transcribe({**request, "assemblyai_api_key": None}, _Events())
    assert calls == []
    assert again == first


def test_missing_key_without_words_is_a_transcription_error(tmp_path, monkeypatch):
    video = tmp_path / "video.mp4"
    video.write_bytes(b"x")
    request = {"work_dir": str(tmp_path / "work"), "video_path": str(video)}
    _start(monkeypatch, request)
    with pytest.raises(cli.EngineError) as error:
        cli.cmd_transcribe(request, _Events())
    assert error.value.code == "transcription_failed"


def test_config_assemblyai_base_url_reaches_the_sdk_client(tmp_path, monkeypatch):
    from clipwright_engine.config import EngineConfig

    assert EngineConfig.from_request({}).assemblyai_base_url == ""
    with pytest.raises(ValueError):
        EngineConfig.from_request({"config": {"assemblyai_base_url": 5}})

    video = tmp_path / "video.mp4"
    video.write_bytes(b"x")
    seen = []

    def fake_transcribe(video_path, speech_model, runtime):
        seen.append(runtime.assemblyai_base_url)
        return ""

    monkeypatch.setattr(transcription, "_get_transcript_with_assemblyai", fake_transcribe)
    request = {
        "work_dir": str(tmp_path / "work"),
        "video_path": str(video),
        "assemblyai_api_key": "k",
        "config": {"assemblyai_base_url": "https://api.eu.assemblyai.com/"},
    }
    _start(monkeypatch, request)
    cli.cmd_transcribe(request, _Events())
    assert seen == ["https://api.eu.assemblyai.com"]


def test_assemblyai_client_uses_the_runtime_base_url(tmp_path, monkeypatch):
    built = []

    def capture(**kwargs):
        built.append(kwargs["settings"].base_url)
        raise RuntimeError("stop")

    monkeypatch.setattr(aai, "Client", capture)
    runtime = SimpleNamespace(assembly_ai_api_key="k", assemblyai_base_url="http://127.0.0.1:9", transcription_language="")
    with pytest.raises(RuntimeError):
        transcription._get_transcript_with_assemblyai(tmp_path / "v.mp4", "universal-3-5-pro", runtime)
    runtime.assemblyai_base_url = ""
    with pytest.raises(RuntimeError):
        transcription._get_transcript_with_assemblyai(tmp_path / "v.mp4", "universal-3-5-pro", runtime)
    assert built == ["http://127.0.0.1:9", aai.settings.base_url]
