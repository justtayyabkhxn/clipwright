"""Font lookup across the request's font dirs, plus TTF name and cmap parsing."""

from functools import lru_cache
from pathlib import Path
import re
import struct

from .config import get_config

SUPPORTED_FONT_EXTENSIONS = (".ttf", ".otf")
TTF_NAME_ID_FONT_FAMILY = 1
TTF_NAME_ID_FULL_NAME = 4
ASS_UNSAFE_NAME_CHARS = frozenset("(){}\\")


def font_dirs() -> list[Path]:
    return list(get_config().fonts_dirs)


def bundled_fonts_dir() -> Path | None:
    """The first configured dir (the bundled fonts), when it exists."""
    dirs = font_dirs()
    return dirs[0] if dirs and dirs[0].is_dir() else None


def find_font_path(font_name: str) -> Path | None:
    """Resolve a font by file name or stem, first dir wins; names also match loosely."""
    requested = (font_name or "").strip()
    if not requested or Path(requested).name != requested:
        return None

    for search_dir in font_dirs():
        exact_file = search_dir / requested
        if exact_file.is_file() and exact_file.suffix.lower() in SUPPORTED_FONT_EXTENSIONS:
            return exact_file
        for extension in SUPPORTED_FONT_EXTENSIONS:
            candidate = search_dir / f"{requested}{extension}"
            if candidate.is_file():
                return candidate

    normalized_requested = re.sub(r"[^a-z0-9]", "", requested.lower())
    for search_dir in font_dirs():
        if not search_dir.is_dir():
            continue
        for candidate in sorted(search_dir.iterdir()):
            if (
                candidate.suffix.lower() in SUPPORTED_FONT_EXTENSIONS
                and re.sub(r"[^a-z0-9]", "", candidate.stem.lower()) == normalized_requested
            ):
                return candidate
    return None


def _decode_ttf_name(raw_value: bytes, platform_id: int) -> str:
    encodings = ["utf-16-be"] if platform_id in {0, 3} else ["mac_roman", "utf-8"]
    for encoding in encodings:
        try:
            decoded = raw_value.decode(encoding).strip("\x00").strip()
        except UnicodeDecodeError:
            continue
        if decoded:
            return decoded
    return ""


def get_font_family_name(font_path: Path) -> str | None:
    """Read a font's internal family name for renderers that match by metadata."""
    try:
        data = Path(font_path).read_bytes()
        if len(data) < 12:
            return None

        num_tables = struct.unpack_from(">H", data, 4)[0]
        name_table_offset = None
        name_table_length = None
        table_record_offset = 12
        for table_index in range(num_tables):
            record_offset = table_record_offset + table_index * 16
            if record_offset + 16 > len(data):
                return None
            tag, _checksum, table_offset, table_length = struct.unpack_from(
                ">4sIII", data, record_offset
            )
            if tag == b"name":
                name_table_offset = table_offset
                name_table_length = table_length
                break

        if name_table_offset is None or name_table_length is None:
            return None
        if name_table_offset + min(name_table_length, 6) > len(data):
            return None

        _format_selector, record_count, string_offset = struct.unpack_from(
            ">HHH", data, name_table_offset
        )
        storage_start = name_table_offset + string_offset
        candidates: dict[int, list[str]] = {
            TTF_NAME_ID_FONT_FAMILY: [],
            TTF_NAME_ID_FULL_NAME: [],
        }

        for record_index in range(record_count):
            record_offset = name_table_offset + 6 + record_index * 12
            if record_offset + 12 > len(data):
                break
            (
                platform_id,
                _encoding_id,
                language_id,
                name_id,
                value_length,
                value_offset,
            ) = struct.unpack_from(">HHHHHH", data, record_offset)
            if name_id not in candidates:
                continue
            value_start = storage_start + value_offset
            value_end = value_start + value_length
            if value_start < storage_start or value_end > len(data):
                continue
            decoded = _decode_ttf_name(data[value_start:value_end], platform_id)
            if not decoded:
                continue
            # Prefer English records when present, but keep every valid name as fallback.
            if language_id in {0x0409, 0x0000}:
                candidates[name_id].insert(0, decoded)
            else:
                candidates[name_id].append(decoded)

        family_names = list(dict.fromkeys(candidates[TTF_NAME_ID_FONT_FAMILY]))
        full_names = [name for name in candidates[TTF_NAME_ID_FULL_NAME] if name]
        # ASS override tags (\fn<name>) end at "(", "{" or "\", so a family like
        # "THE BOLD FONT (FREE VERSION)" silently falls back to another font.
        # libass also matches full names, so prefer any tag-safe candidate.
        for names in (family_names, full_names):
            safe_names = [name for name in names if not ASS_UNSAFE_NAME_CHARS & set(name)]
            if safe_names:
                return min(safe_names, key=len)

        if family_names:
            return min(family_names, key=len)
        if full_names:
            return full_names[0]
    except Exception:
        return None

    return None


def _parse_cmap_codepoints(data: bytes) -> frozenset[int] | None:
    num_tables = struct.unpack_from(">H", data, 4)[0]
    cmap_offset = None
    for table_index in range(num_tables):
        tag, _checksum, table_offset, _length = struct.unpack_from(
            ">4sIII", data, 12 + table_index * 16
        )
        if tag == b"cmap":
            cmap_offset = table_offset
            break
    if cmap_offset is None:
        return None

    subtables: dict[int, int] = {}
    _version, subtable_count = struct.unpack_from(">HH", data, cmap_offset)
    for index in range(subtable_count):
        platform_id, encoding_id, offset = struct.unpack_from(
            ">HHI", data, cmap_offset + 4 + index * 8
        )
        # Only Unicode subtables: Windows BMP/full or the Unicode platform.
        if platform_id == 0 or (platform_id == 3 and encoding_id in {1, 10}):
            fmt = struct.unpack_from(">H", data, cmap_offset + offset)[0]
            subtables.setdefault(fmt, cmap_offset + offset)

    codepoints: set[int] = set()
    if 12 in subtables:
        start = subtables[12]
        group_count = struct.unpack_from(">I", data, start + 12)[0]
        for group in range(group_count):
            first, last, first_glyph = struct.unpack_from(
                ">III", data, start + 16 + group * 12
            )
            if first_glyph:
                codepoints.update(range(first, last + 1))
        return frozenset(codepoints)

    if 4 not in subtables:
        return None
    start = subtables[4]
    seg_count = struct.unpack_from(">H", data, start + 6)[0] // 2
    ends_at = start + 14
    starts_at = ends_at + seg_count * 2 + 2
    deltas_at = starts_at + seg_count * 2
    range_offsets_at = deltas_at + seg_count * 2
    for seg in range(seg_count):
        end_code = struct.unpack_from(">H", data, ends_at + seg * 2)[0]
        start_code = struct.unpack_from(">H", data, starts_at + seg * 2)[0]
        delta = struct.unpack_from(">h", data, deltas_at + seg * 2)[0]
        range_offset = struct.unpack_from(">H", data, range_offsets_at + seg * 2)[0]
        for code in range(start_code, min(end_code, 0xFFFE) + 1):
            if range_offset == 0:
                glyph = (code + delta) & 0xFFFF
            else:
                glyph_at = (
                    range_offsets_at + seg * 2 + range_offset + (code - start_code) * 2
                )
                glyph = struct.unpack_from(">H", data, glyph_at)[0]
                if glyph:
                    glyph = (glyph + delta) & 0xFFFF
            if glyph:
                codepoints.add(code)
    return frozenset(codepoints)


@lru_cache(maxsize=128)
def _cached_font_codepoints(
    path: str, modified_ns: int, size: int
) -> frozenset[int] | None:
    try:
        return _parse_cmap_codepoints(Path(path).read_bytes())
    except Exception:
        return None


def get_font_codepoints(font_path: Path) -> frozenset[int] | None:
    """Unicode codepoints the font actually has glyphs for (None if unreadable).

    Renderers silently substitute another font for missing glyphs, so callers
    check coverage before committing to a font for a given text.
    """
    try:
        stat = Path(font_path).stat()
    except OSError:
        return None
    return _cached_font_codepoints(str(font_path), stat.st_mtime_ns, stat.st_size)
