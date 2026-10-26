// Long transcripts are analysed in overlapping windows so every part of the source gets the
// model's full attention; candidates are then deduplicated and reranked together.

import type { TranscriptSegment } from "./schemas";
import {
  parseTranscriptTimestampSeconds,
  pyStrip,
  SIGNAL_LINE_RE,
  splitLines,
  TimestampError,
  TRANSCRIPT_SPAN_RE,
} from "./transcript";

export const ANALYSIS_WINDOW_SECONDS = 12 * 60;
export const ANALYSIS_WINDOW_OVERLAP_SECONDS = 2 * 60;
export const ANALYSIS_SINGLE_WINDOW_MAX_SECONDS = 15 * 60;
export const CANDIDATE_DEDUPE_OVERLAP_RATIO = 0.5;
// Final clip count scales with source length: one clip per five minutes, never fewer than
// the single-pass prompt's old maximum and never more than 20.
export const MIN_FINAL_CLIPS = 5;
export const MAX_FINAL_CLIPS = 20;
export const SECONDS_PER_FINAL_CLIP = 5 * 60;

export type TranscriptWindow = { start: number; end: number; transcript: string };

/**
 * Split a formatted transcript into overlapping time windows. Transcripts up to
 * `singleWindowMaxSeconds` stay one window holding the original text unchanged. A short
 * trailing window is folded into the one before it. Lines are assigned by start time only.
 */
export function splitTranscriptIntoWindows(
  transcript: string,
  windowSeconds = ANALYSIS_WINDOW_SECONDS,
  overlapSeconds = ANALYSIS_WINDOW_OVERLAP_SECONDS,
  singleWindowMaxSeconds = ANALYSIS_SINGLE_WINDOW_MAX_SECONDS,
): TranscriptWindow[] {
  const timedLines: [number, string][] = [];
  let totalSeconds = 0;
  for (const raw of splitLines(transcript)) {
    const line = pyStrip(raw);
    const match = TRANSCRIPT_SPAN_RE.exec(line);
    if (!match) continue;
    const start = parseTranscriptTimestampSeconds(match[1]);
    const end = parseTranscriptTimestampSeconds(match[2]);
    timedLines.push([start, line]);
    totalSeconds = Math.max(totalSeconds, end, start);
  }

  if (!timedLines.length || totalSeconds <= singleWindowMaxSeconds) {
    return [{ start: 0, end: totalSeconds, transcript }];
  }

  const step = Math.max(1, windowSeconds - overlapSeconds);
  const bounds: [number, number][] = [];
  for (let windowStart = 0; ; windowStart += step) {
    const windowEnd = windowStart + windowSeconds;
    if (windowEnd >= totalSeconds) {
      bounds.push([windowStart, totalSeconds]);
      break;
    }
    bounds.push([windowStart, windowEnd]);
  }
  const last = bounds[bounds.length - 1];
  if (bounds.length > 1 && last[1] - last[0] < Math.floor(windowSeconds / 2)) {
    bounds.pop();
    bounds[bounds.length - 1][1] = totalSeconds;
  }

  const windows: TranscriptWindow[] = [];
  bounds.forEach(([windowStart, windowEnd], index) => {
    const isLast = index === bounds.length - 1;
    const lines = timedLines
      .filter(([start]) => windowStart <= start && (start < windowEnd || (isLast && start <= windowEnd)))
      .map(([, line]) => line);
    if (lines.length) windows.push({ start: windowStart, end: windowEnd, transcript: lines.join("\n") });
  });
  return windows;
}

/** Keep only the signal lines (and the header) that fall inside one analysis window. */
export function filterClipSignalsForWindow(
  clipSignals: string | null | undefined,
  windowStart: number,
  windowEnd: number,
): string | null {
  if (!clipSignals) return null;
  const header: string[] = [];
  const kept: string[] = [];
  for (const line of splitLines(clipSignals)) {
    const match = SIGNAL_LINE_RE.exec(pyStrip(line));
    if (!match) {
      if (!kept.length) header.push(line);
      continue;
    }
    let signalStart: number;
    try {
      signalStart = parseTranscriptTimestampSeconds(match[1]);
    } catch (error) {
      if (error instanceof TimestampError) continue;
      throw error;
    }
    if (windowStart <= signalStart && signalStart < windowEnd) kept.push(line);
  }
  return kept.length ? [...header, ...kept].join("\n") : null;
}

export function segmentBoundsSeconds(segment: TranscriptSegment): [number, number] {
  return [parseTranscriptTimestampSeconds(segment.start_time), parseTranscriptTimestampSeconds(segment.end_time)];
}

/** Overlap as a share of the shorter range (1.0 = one contains the other). */
function overlapRatio(first: [number, number], second: [number, number]): number {
  const shorter = Math.min(first[1] - first[0], second[1] - second[0]);
  if (shorter <= 0) return 0;
  return Math.max(0, Math.min(first[1], second[1]) - Math.max(first[0], second[0])) / shorter;
}

/**
 * Sort candidates best-first (virality total, then relevance; stable) and drop ones that mostly
 * repeat a stronger pick. Overlapping windows can surface the same moment twice.
 */
export function dedupeOverlappingSegments(
  segments: TranscriptSegment[],
  maxOverlapRatio = CANDIDATE_DEDUPE_OVERLAP_RATIO,
): TranscriptSegment[] {
  const ranked = [...segments].sort(
    (a, b) => b.virality.total_score - a.virality.total_score || b.relevance_score - a.relevance_score,
  );
  const kept: [TranscriptSegment, [number, number]][] = [];
  for (const segment of ranked) {
    const bounds = segmentBoundsSeconds(segment);
    if (kept.some(([, keptBounds]) => overlapRatio(bounds, keptBounds) > maxOverlapRatio)) continue;
    kept.push([segment, bounds]);
  }
  return kept.map(([segment]) => segment);
}

/** Scale the clip budget with source length (about one clip per 5 minutes), never above `maxClips`. */
export function maxFinalClipsForDuration(sourceSeconds: number, maxClips = MAX_FINAL_CLIPS): number {
  const ceiling = Math.max(1, Math.min(MAX_FINAL_CLIPS, maxClips));
  return Math.max(
    Math.min(MIN_FINAL_CLIPS, ceiling),
    Math.min(ceiling, Math.ceil(Math.max(0, sourceSeconds) / SECONDS_PER_FINAL_CLIP)),
  );
}
