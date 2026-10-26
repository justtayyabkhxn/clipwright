// Parsers for the "[MM:SS - MM:SS] Speaker X: text" transcript format the engine produces.
// The formatter never wraps minutes into hours, so 100+ minute sources yield labels like "100:05".

// Python's whitespace (str.isspace, strip, split, re \s): JS \s without U+FEFF, plus U+001C-U+001F and U+0085.
// int() skips the same characters except U+001C-U+001F.
const INT_SPACE = String.raw`\t-\r \x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000`;
const S = String.raw`[${INT_SPACE}\x1c-\x1f]`;
const EDGE_SPACE_RE = new RegExp(`^${S}+|${S}+$`, "g");
const INT_EDGE_SPACE_RE = new RegExp(`^[${INT_SPACE}]+|[${INT_SPACE}]+$`, "g");
export const SPACE_RUN_RE = new RegExp(`${S}+`, "g");

/** Python str.strip(). */
export const pyStrip = (value: string) => value.replace(EDGE_SPACE_RE, "");
/** Python str.split() without a separator. */
export function pySplit(value: string): string[] {
  const stripped = pyStrip(value);
  return stripped ? stripped.split(SPACE_RUN_RE) : [];
}

const STAMP = String.raw`(\d{1,3}:\d{2}(?::\d{2})?)`;
export const TRANSCRIPT_SPAN_RE = new RegExp(String.raw`^\[${STAMP}${S}*-${S}*${STAMP}\]${S}*(.*)$`);
export const SIGNAL_LINE_RE = new RegExp(String.raw`^- \[${STAMP}${S}*-`);
const SPEAKER_PREFIX_RE = new RegExp(`^Speaker [^:]+:${S}*`);

export type TranscriptLine = {
  start_time: string;
  end_time: string;
  start_seconds: number;
  end_seconds: number;
  text: string;
};

export type TranscriptSpan = { start: number; end: number; text: string };

/** Thrown where Python raised ValueError for an unparseable timestamp. */
export class TimestampError extends Error {}

/** Python str.splitlines(): every Unicode line boundary, no trailing empty line. */
export function splitLines(value: string): string[] {
  const lines = value.split(/\r\n|[\n\v\f\r\x1c-\x1e\x85\u2028\u2029]/);
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/**
 * Python int() on a string: surrounding whitespace, a sign and digit underscores are allowed.
 * ASCII digits only (Python also takes other Unicode digits; the transcript formatter never emits them).
 */
function pyInt(part: string): number {
  const trimmed = part.replace(INT_EDGE_SPACE_RE, "");
  if (!/^[+-]?\d+(?:_\d+)*$/.test(trimmed)) throw new TimestampError(`invalid literal for int(): '${part}'`);
  return Number.parseInt(trimmed.replaceAll("_", ""), 10);
}

/** Parse MM:SS or HH:MM:SS transcript timestamps into seconds. */
export function parseTranscriptTimestampSeconds(timestamp: string): number {
  const parts = timestamp.split(":").map(pyInt);
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  throw new TimestampError(`Unsupported timestamp format: ${timestamp}`);
}

const pad2 = (value: number) => String(value).padStart(2, "0");

/** Format seconds as a transcript timestamp (HH:MM:SS once hours are present). */
export function formatTranscriptTimestamp(seconds: number): string {
  const total = Math.max(0, Math.trunc(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  return hours ? `${pad2(hours)}:${pad2(minutes)}:${pad2(secs)}` : `${pad2(minutes)}:${pad2(secs)}`;
}

/** Format seconds the way transcript lines do: MM:SS with unbounded minutes. */
export function formatMinutesLabel(seconds: number): string {
  const total = Math.max(0, Math.trunc(seconds));
  return `${pad2(Math.floor(total / 60))}:${pad2(total % 60)}`;
}

export function normalizeTranscriptText(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9']+/g, " ").replace(/\s+/g, " ").trim();
}

/** Lines with their labels, for snapping and exact-label grounding. Speaker prefixes are removed. */
export function parseTranscriptLines(transcript: string): TranscriptLine[] {
  const lines: TranscriptLine[] = [];
  for (const raw of splitLines(transcript)) {
    const match = TRANSCRIPT_SPAN_RE.exec(pyStrip(raw));
    if (!match) continue;
    lines.push({
      start_time: match[1],
      end_time: match[2],
      start_seconds: parseTranscriptTimestampSeconds(match[1]),
      end_seconds: parseTranscriptTimestampSeconds(match[2]),
      text: pyStrip(match[3]).replace(SPEAKER_PREFIX_RE, ""),
    });
  }
  return lines;
}

/** Spans for bounds repair. Speaker prefixes are kept; empty or reversed spans are dropped. */
export function parseTranscriptSpans(transcript: string): TranscriptSpan[] {
  const spans: TranscriptSpan[] = [];
  for (const raw of splitLines(transcript)) {
    const match = TRANSCRIPT_SPAN_RE.exec(pyStrip(raw));
    if (!match) continue;
    const start = parseTranscriptTimestampSeconds(match[1]);
    const end = parseTranscriptTimestampSeconds(match[2]);
    if (end <= start) continue;
    spans.push({ start, end, text: pyStrip(match[3]) });
  }
  return spans;
}
