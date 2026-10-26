// Grounding of model segments onto real transcript lines (port of ai.py _validate_segments and helpers).

import { clipDuration, type ClipLength } from "./clip-duration";
import type { TranscriptSegment } from "./schemas";
import {
  formatTranscriptTimestamp,
  normalizeTranscriptText,
  parseTranscriptTimestampSeconds,
  pySplit,
  pyStrip,
  SPACE_RUN_RE,
  TimestampError,
  type TranscriptLine,
  type TranscriptSpan,
} from "./transcript";

/** How far a model timestamp may sit from a line boundary and still be snapped onto it. */
export const SEGMENT_SNAP_TOLERANCE_SECONDS = 8;
export const HOOK_TITLE_MAX_CHARS = 64;
export const HOOK_TITLE_MAX_WORDS = 10;

/** Python min(items, key=...) with a tuple key: the first item with the smallest key. */
function minBy<T>(items: T[], key: (item: T) => number[]): T {
  let best = items[0];
  let bestKey = key(best);
  for (const item of items.slice(1)) {
    const itemKey = key(item);
    const index = itemKey.findIndex((value, i) => value !== bestKey[i]);
    if (index !== -1 && itemKey[index] < bestKey[index]) {
      best = item;
      bestKey = itemKey;
    }
  }
  return best;
}

/**
 * Snap model timestamps onto the nearest transcript line start and end. Models often pick a second
 * inside a line; grounding needs exact line labels.
 */
export function snapBoundsToTranscriptLines(
  lines: TranscriptLine[],
  startSeconds: number,
  endSeconds: number,
  tolerance = SEGMENT_SNAP_TOLERANCE_SECONDS,
): [TranscriptLine, TranscriptLine] | null {
  if (!lines.length) return null;
  const startLine = minBy(lines, (line) => [Math.abs(line.start_seconds - startSeconds), line.start_seconds]);
  if (Math.abs(startLine.start_seconds - startSeconds) > tolerance) return null;
  const endCandidates = lines.filter((line) => line.end_seconds > startLine.start_seconds);
  if (!endCandidates.length) return null;
  const endLine = minBy(endCandidates, (line) => [Math.abs(line.end_seconds - endSeconds), -line.end_seconds]);
  if (Math.abs(endLine.end_seconds - endSeconds) > tolerance) return null;
  return [startLine, endLine];
}

function snapSegmentBounds(
  segment: TranscriptSegment,
  lines: TranscriptLine[],
  startSeconds: number,
  endSeconds: number,
): [number, number] {
  const snapped = snapBoundsToTranscriptLines(lines, startSeconds, endSeconds);
  if (!snapped) return [startSeconds, endSeconds];
  const [startLine, endLine] = snapped;
  segment.start_time = startLine.start_time;
  segment.end_time = endLine.end_time;
  return [startLine.start_seconds, endLine.end_seconds];
}

/** Text of the lines from an exact start label to an exact end label, or null when unaligned. */
export function extractTranscriptTextForSegment(
  lines: TranscriptLine[],
  startTime: string,
  endTime: string,
): string | null {
  const startIndex = lines.findIndex((line) => line.start_time === startTime);
  if (startIndex === -1) return null;
  const parts: string[] = [];
  for (const line of lines.slice(startIndex)) {
    if (line.text) parts.push(line.text);
    if (line.end_time === endTime) return pyStrip(parts.join(" "));
  }
  return null;
}

/** Transcript text overlapping a selected time range. */
export function extractTranscriptText(spans: TranscriptSpan[], startSeconds: number, endSeconds: number): string {
  return pyStrip(
    spans
      .filter((span) => span.text && span.end > startSeconds && span.start < endSeconds)
      .map((span) => span.text)
      .join(" "),
  );
}

/** Repair model-selected bounds to the nearest acceptable contiguous range. */
export function chooseRepairedBounds(
  spans: TranscriptSpan[],
  startSeconds: number,
  endSeconds: number,
  clipLength: ClipLength = "auto",
): [number, number] | null {
  const bounds = clipDuration(clipLength);
  if (!spans.length) return null;
  const sortedUnique = (values: number[]) => [...new Set(values)].sort((a, b) => a - b);
  const starts = sortedUnique(spans.map((span) => span.start));
  const ends = sortedUnique(spans.map((span) => span.end));
  const currentDuration = endSeconds - startSeconds;

  if (currentDuration > bounds.maximum) {
    const targetEnd = startSeconds + bounds.idealMaximum;
    const candidateEnds = ends.filter(
      (end) => startSeconds + bounds.minimum <= end && end <= Math.min(targetEnd, endSeconds),
    );
    if (candidateEnds.length) return [startSeconds, Math.max(...candidateEnds)];
    if (startSeconds + bounds.minimum <= targetEnd) return [startSeconds, targetEnd];
    return null;
  }

  if (currentDuration < bounds.minimum) {
    const candidates: [number, number, number][] = [];
    for (const start of starts) {
      if (start > startSeconds) continue;
      for (const end of ends) {
        if (end < endSeconds) continue;
        const duration = end - start;
        if (duration < bounds.minimum || duration > bounds.maximum) continue;
        const extraContext = startSeconds - start + (end - endSeconds);
        let idealPenalty = 0;
        if (duration < bounds.idealMinimum) idealPenalty = bounds.idealMinimum - duration;
        else if (duration > bounds.idealMaximum) idealPenalty = duration - bounds.idealMaximum;
        candidates.push([idealPenalty * 1000 + extraContext, start, end]);
      }
    }
    if (candidates.length) {
      const [, start, end] = minBy(candidates, (candidate) => candidate);
      return [start, end];
    }
  }
  return null;
}

function repairSegmentBounds(
  segment: TranscriptSegment,
  spans: TranscriptSpan[],
  startSeconds: number,
  endSeconds: number,
  clipLength: ClipLength,
): [number, number] | null {
  const repaired = chooseRepairedBounds(spans, startSeconds, endSeconds, clipLength);
  if (!repaired) return null;
  segment.start_time = formatTranscriptTimestamp(repaired[0]);
  segment.end_time = formatTranscriptTimestamp(repaired[1]);
  const text = extractTranscriptText(spans, repaired[0], repaired[1]);
  if (text) segment.text = text;
  return repaired;
}

const QUOTE_CHARS = "\"'`“”‘’";
const TRAILING_PUNCTUATION = ".,;:-–— ";
const stripStart = (value: string, chars: string) => {
  let i = 0;
  while (i < value.length && chars.includes(value[i])) i++;
  return value.slice(i);
};
const stripEnd = (value: string, chars: string) => {
  let i = value.length;
  while (i > 0 && chars.includes(value[i - 1])) i--;
  return value.slice(0, i);
};
// Python's \w is Unicode-aware: letters, numbers and underscore (combining marks are not word characters).
const HASHTAG_RE = /#[\p{L}\p{N}_]+/gu;

/**
 * Normalize an AI-provided hook title for on-screen rendering: strip wrapping quotes, drop hashtags,
 * collapse whitespace and trim to a word-boundary length cap. Null when nothing usable is left.
 */
export function sanitizeHookTitle(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let title = pyStrip(stripEnd(stripStart(pyStrip(raw), QUOTE_CHARS), QUOTE_CHARS));
  title = title.replace(HASHTAG_RE, "");
  title = pyStrip(title.replace(SPACE_RUN_RE, " "));
  // Drop trailing sentence punctuation but keep ?/! (they carry the hook).
  title = pyStrip(stripEnd(title, TRAILING_PUNCTUATION));
  if (!title) return null;

  const titleWords = pySplit(title);
  if (titleWords.length > HOOK_TITLE_MAX_WORDS) title = titleWords.slice(0, HOOK_TITLE_MAX_WORDS).join(" ");
  // Lengths count code points, as Python str does.
  const chars = Array.from(title);
  if (chars.length > HOOK_TITLE_MAX_CHARS) {
    const clipped = chars.slice(0, HOOK_TITLE_MAX_CHARS + 1);
    const cut = clipped.lastIndexOf(" ");
    title = stripEnd((cut > 20 ? clipped.slice(0, cut) : chars.slice(0, HOOK_TITLE_MAX_CHARS)).join(""), TRAILING_PUNCTUATION);
  }
  return title || null;
}

function parseOrNull(timestamp: string | null): number | null {
  try {
    return parseTranscriptTimestampSeconds(timestamp ?? "");
  } catch (error) {
    if (error instanceof TimestampError) return null;
    throw error;
  }
}

/** Drop a cold-open hook range that is malformed or outside the segment. */
function sanitizeHookSpan(segment: TranscriptSegment, startSeconds: number, endSeconds: number): void {
  const hookStart = parseOrNull(segment.hook_start_time);
  const hookEnd = parseOrNull(segment.hook_end_time);
  if (
    hookStart === null ||
    hookEnd === null ||
    !(startSeconds < hookStart && hookStart < hookEnd && hookEnd <= endSeconds) ||
    hookEnd - hookStart > 8
  ) {
    segment.hook_start_time = null;
    segment.hook_end_time = null;
  }
}

/** Ground model segments onto real transcript lines and drop unusable ones. Segments are updated in place. */
export function validateSegments(
  segments: TranscriptSegment[],
  lines: TranscriptLine[],
  spans: TranscriptSpan[],
  clipLength: ClipLength = "auto",
): TranscriptSegment[] {
  const bounds = clipDuration(clipLength);
  const validated: TranscriptSegment[] = [];
  for (const segment of segments) {
    if (!pyStrip(segment.text) || pySplit(segment.text).length < 3) continue;
    if (segment.start_time === segment.end_time) continue;
    try {
      let [startSeconds, endSeconds] = snapSegmentBounds(
        segment,
        lines,
        parseTranscriptTimestampSeconds(segment.start_time),
        parseTranscriptTimestampSeconds(segment.end_time),
      );
      let duration = endSeconds - startSeconds;
      if (duration < bounds.minimum || duration > bounds.maximum) {
        const repaired = repairSegmentBounds(segment, spans, startSeconds, endSeconds, clipLength);
        if (repaired) {
          // Repairs format hours as HH:MM:SS; snap back onto line labels.
          [startSeconds, endSeconds] = snapSegmentBounds(segment, lines, ...repaired);
          duration = endSeconds - startSeconds;
        }
      }
      if (duration <= 0 || duration < bounds.minimum || duration > bounds.maximum) continue;

      const grounded = extractTranscriptTextForSegment(lines, segment.start_time, segment.end_time);
      if (grounded === null) continue;
      if (normalizeTranscriptText(segment.text) !== normalizeTranscriptText(grounded)) segment.text = grounded;

      const v = segment.virality;
      v.total_score = v.hook_score + v.engagement_score + v.value_score + v.shareability_score;
      segment.hook_title = sanitizeHookTitle(segment.hook_title);
      // Bounds are final here: keep the teaser only when it still sits inside the clip.
      sanitizeHookSpan(segment, startSeconds, endSeconds);
      validated.push(segment);
    } catch (error) {
      if (!(error instanceof TimestampError)) throw error;
    }
  }
  return validated;
}
