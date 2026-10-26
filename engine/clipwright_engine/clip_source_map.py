"""Source-range maths: a clip's play-order list of (start, end) source seconds.

The ranges themselves are stored on the clip document by the web app; the
engine only receives and returns them.
"""

from __future__ import annotations

from typing import Iterable, List, Tuple

SourceRange = Tuple[float, float]
MIN_RANGE_SECONDS = 0.05


def normalize_source_ranges(
    ranges: Iterable | None,
) -> List[SourceRange]:
    """Float (start, end) pairs, dropping malformed and sub-50 ms ranges.

    Accepts [[s, e], ...] or [{"start": s, "end": e}, ...].
    """
    normalized: List[SourceRange] = []
    for item in ranges or []:
        try:
            if isinstance(item, dict):
                start, end = item["start"], item["end"]
            else:
                start, end = item
            start_value = float(start)
            end_value = float(end)
        except (KeyError, TypeError, ValueError):
            continue
        if end_value - start_value <= MIN_RANGE_SECONDS:
            continue
        normalized.append((start_value, end_value))
    return normalized


def ranges_as_dicts(ranges: Iterable | None) -> list[dict]:
    return [
        {"start": round(start, 6), "end": round(end, 6)}
        for start, end in normalize_source_ranges(ranges)
    ]


def total_source_duration(ranges: Iterable | None) -> float:
    return sum(end - start for start, end in normalize_source_ranges(ranges))


def source_range_bounds(
    ranges: Iterable | None,
) -> SourceRange | None:
    normalized = normalize_source_ranges(ranges)
    if not normalized:
        return None
    # Ranges play in list order and may be non-monotonic (a hook teaser is
    # played before the clip body), so the bounds are the extremes.
    return (
        min(start for start, _ in normalized),
        max(end for _, end in normalized),
    )


def slice_source_ranges(
    ranges: Iterable | None,
    output_start: float,
    output_end: float,
) -> List[SourceRange]:
    """Source ranges behind the [output_start, output_end] window of the clip."""
    normalized = normalize_source_ranges(ranges)
    if not normalized:
        return []

    total_duration = total_source_duration(normalized)
    window_start = max(0.0, min(float(output_start), total_duration))
    window_end = max(window_start, min(float(output_end), total_duration))

    sliced: List[SourceRange] = []
    timeline_cursor = 0.0
    for source_start, source_end in normalized:
        segment_duration = source_end - source_start
        timeline_start = timeline_cursor
        timeline_end = timeline_cursor + segment_duration

        overlap_start = max(window_start, timeline_start)
        overlap_end = min(window_end, timeline_end)
        if overlap_end - overlap_start > MIN_RANGE_SECONDS:
            relative_start = overlap_start - timeline_start
            relative_end = overlap_end - timeline_start
            sliced.append(
                (source_start + relative_start, source_start + relative_end)
            )

        timeline_cursor = timeline_end

    return normalize_source_ranges(sliced)
