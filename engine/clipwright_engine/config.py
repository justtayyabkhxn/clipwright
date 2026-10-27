"""Engine settings, filled from each request's JSON (never from env vars)."""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

# engine/clipwright_engine/config.py -> <repo>/web/fonts
BUNDLED_FONTS_DIR = Path(__file__).resolve().parents[2] / "web" / "fonts"


def normalize_transcription_language(value: Any) -> str:
    """Empty or "auto" means detect; otherwise an AssemblyAI code such as "es"."""
    normalized = str(value or "").strip().lower().replace("-", "_")
    return "" if normalized in ("", "auto") else normalized


@dataclass
class EngineConfig:
    speaker_framing: bool = True
    hook_first_teaser: bool = False
    transcription_language: str = ""
    max_video_duration: int = 5400
    youtube_max_height: int = 1080
    assembly_ai_http_timeout_seconds: int = 900
    assembly_ai_request_timeout_seconds: int = 60
    # AssemblyAI API host (e.g. https://api.eu.assemblyai.com). Empty uses the SDK default.
    assemblyai_base_url: str = ""
    # Bundled fonts first, then the user's upload dir. Lookup searches in order.
    fonts_dirs: list[Path] = field(default_factory=lambda: [BUNDLED_FONTS_DIR])

    @classmethod
    def from_request(cls, request: dict[str, Any]) -> "EngineConfig":
        raw = request.get("config") or {}
        if not isinstance(raw, dict):
            raise ValueError("config must be an object")
        config = cls()
        for name in ("speaker_framing", "hook_first_teaser"):
            if raw.get(name) is not None:
                setattr(config, name, bool(raw[name]))
        config.transcription_language = normalize_transcription_language(
            raw.get("transcription_language")
        )
        for name in ("max_video_duration", "youtube_max_height", "assembly_ai_http_timeout_seconds"):
            if raw.get(name) is not None:
                setattr(config, name, int(raw[name]))
        base_url = raw.get("assemblyai_base_url")
        if base_url is not None and not isinstance(base_url, str):
            raise ValueError("assemblyai_base_url must be a string")
        config.assemblyai_base_url = (base_url or "").strip().rstrip("/")
        config.youtube_max_height = max(144, min(1080, config.youtube_max_height))
        fonts_dirs = request.get("fonts_dirs")
        if fonts_dirs:
            if not isinstance(fonts_dirs, list) or not all(isinstance(d, str) for d in fonts_dirs):
                raise ValueError("fonts_dirs must be a list of paths")
            config.fonts_dirs = [Path(d).resolve() for d in fonts_dirs]
        return config


_config = EngineConfig()


def get_config() -> EngineConfig:
    return _config


def set_config(config: EngineConfig) -> None:
    global _config
    _config = config
