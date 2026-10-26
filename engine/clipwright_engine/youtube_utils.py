"""YouTube metadata and full-file downloads through yt-dlp, with Node as its JS runtime."""

import logging
import re
import time
from pathlib import Path
from typing import Any, Callable, Dict, Optional
from urllib.parse import parse_qs, urlparse

from .config import get_config
from .media.ffmpeg import ffprobe_video_size

logger = logging.getLogger(__name__)

VIDEO_EXTENSIONS = (".mp4", ".mkv", ".webm", ".mov", ".m4v")

_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    "Connection": "keep-alive",
}


def common_options() -> Dict[str, Any]:
    """Fresh options per call: yt-dlp updates the header dict it is given."""
    return {
        # yt-dlp defaults to deno; the worker already runs on Node (>= 22).
        "js_runtimes": {"node": {}},
        "noplaylist": True,
        "socket_timeout": 30,
        "http_headers": dict(_HEADERS),
    }


def capped_height(value: Optional[int] = None) -> int:
    """Never request above 1080p. Lower configured or requested values are honored."""
    raw = get_config().youtube_max_height if value is None else value
    try:
        height = int(raw)
    except (TypeError, ValueError):
        height = 1080
    return max(144, min(height, 1080))


def video_format_selector(height: Optional[int] = None) -> str:
    limit = capped_height(height)
    return f"bv*[height<={limit}]+ba/b[height<={limit}]"


def get_youtube_video_id(url: str) -> Optional[str]:
    """
    Extract YouTube video ID from various URL formats.
    Supports standard, short, embed, and mobile URLs.
    """
    if not isinstance(url, str) or not url.strip():
        return None

    url = url.strip()

    patterns = [
        r"(?:youtube\.com/(?:.*v=|v/|embed/|shorts/)|youtu\.be/)([A-Za-z0-9_-]{11})",
        r"youtube\.com/watch\?v=([A-Za-z0-9_-]{11})",
        r"youtube\.com/embed/([A-Za-z0-9_-]{11})",
        r"youtube\.com/v/([A-Za-z0-9_-]{11})",
        r"youtu\.be/([A-Za-z0-9_-]{11})",
        r"youtube\.com/shorts/([A-Za-z0-9_-]{11})",
        r"m\.youtube\.com/watch\?v=([A-Za-z0-9_-]{11})",
    ]

    for pattern in patterns:
        match = re.search(pattern, url, re.IGNORECASE)
        if match:
            video_id = match.group(1)
            if len(video_id) == 11:
                return video_id

    try:
        parsed_url = urlparse(url)
        if "youtube.com" in parsed_url.netloc.lower():
            video_ids = parse_qs(parsed_url.query).get("v")
            if video_ids and len(video_ids[0]) == 11:
                return video_ids[0]
    except Exception as e:
        logger.warning(f"Error parsing URL query parameters: {e}")

    return None


def get_youtube_video_info(url: str) -> Dict[str, Any]:
    """Title, duration and thumbnail from yt-dlp. Raises on any failure."""
    import yt_dlp

    if not get_youtube_video_id(url):
        raise ValueError(f"Invalid YouTube URL: {url}")
    options = {**common_options(), "quiet": True, "no_warnings": True, "skip_download": True}
    with yt_dlp.YoutubeDL(options) as ydl:
        info = ydl.extract_info(url, download=False)
    return {
        "id": info.get("id"),
        "title": info.get("title"),
        "duration": info.get("duration"),
        "uploader": info.get("uploader"),
        "thumbnail": info.get("thumbnail"),
    }


def _download_rank(path: Path) -> tuple[int, int, int]:
    """(height, width, bytes); an unreadable file still ranks by size."""
    try:
        width, height = ffprobe_video_size(path)
    except Exception:
        width, height = 0, 0
    return height, width, path.stat().st_size


def download_options(video_id: str, work_dir: Path, max_height: Optional[int] = None) -> Dict[str, Any]:
    return {
        **common_options(),
        "outtmpl": str(work_dir / f"{video_id}.%(ext)s"),
        # Vertical clips are 1080x1920; a 4K source only costs bandwidth.
        "format": video_format_selector(max_height),
        "format_sort": ["res", "fps"],
        "merge_output_format": "mp4",
        "writesubtitles": False,
        "writeautomaticsub": False,
        "overwrites": True,
        "retries": 5,
        "fragment_retries": 5,
        "http_chunk_size": 10485760,
        "quiet": True,
        "no_warnings": False,
        "noprogress": True,
    }


def download_youtube_video(
    url: str,
    video_id: str,
    work_dir: Path,
    max_height: Optional[int] = None,
    on_progress: Optional[Callable[[int], None]] = None,
    max_retries: int = 3,
) -> Path:
    """Download the full video into ``work_dir``. Raises RuntimeError when every attempt fails."""
    import yt_dlp

    work_dir.mkdir(parents=True, exist_ok=True)
    last_error = "no file was produced"

    reported = -1

    def hook(status: Dict[str, Any]) -> None:
        nonlocal reported
        total = status.get("total_bytes") or status.get("total_bytes_estimate")
        if on_progress is None or status.get("status") != "downloading" or not total:
            return
        # Video and audio download one after the other; report each pass once per percent.
        percent = min(99, int(status.get("downloaded_bytes", 0) * 100 / total))
        if percent != reported:
            reported = percent
            on_progress(percent)

    for attempt in range(max_retries):
        for stale in work_dir.glob(f"{video_id}.*"):
            stale.unlink(missing_ok=True)
        try:
            options = {**download_options(video_id, work_dir, max_height), "progress_hooks": [hook]}
            with yt_dlp.YoutubeDL(options) as ydl:
                ydl.download([url])
            downloaded = [
                path for path in work_dir.glob(f"{video_id}.*")
                if path.is_file() and path.suffix.lower() in VIDEO_EXTENSIONS
            ]
            if downloaded:
                # A failed merge can leave both the streams and the output; keep the biggest picture.
                best = max(downloaded, key=_download_rank)
                logger.info("Downloaded %s (%d MB)", best.name, best.stat().st_size // 1024 // 1024)
                return best
            logger.warning("No video file found after download attempt %s", attempt + 1)
        except Exception as exc:
            last_error = str(exc)
            logger.warning("Download attempt %s/%s failed: %s", attempt + 1, max_retries, exc)
        if attempt < max_retries - 1:
            time.sleep(2**attempt)
    raise RuntimeError(f"YouTube download failed: {last_error}")
