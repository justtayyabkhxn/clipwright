/** @vitest-environment node */
// Golden vectors computed by the original Python code (__fixtures__/generate.py): grounding and
// repair, hook titles, timestamps, rescaling, windowing, signal filtering, clip counts and parsing.
import { describe, expect, it } from "vitest";
import golden from "./__fixtures__/python-golden.json";
import type { ClipLength } from "./clip-duration";
import { rescaleVirality } from "./rerank";
import { defaultVirality, parseTranscriptAnalysis } from "./schemas";
import {
  formatMinutesLabel,
  formatTranscriptTimestamp,
  parseTranscriptLines,
  parseTranscriptSpans,
  parseTranscriptTimestampSeconds,
  TimestampError,
} from "./transcript";
import { sanitizeHookTitle, validateSegments } from "./validate";
import { filterClipSignalsForWindow, maxFinalClipsForDuration, splitTranscriptIntoWindows } from "./windows";

const transcripts: Record<string, string> = golden.transcripts;

const evenTranscript = (totalSeconds: number, lineSeconds: number) => {
  const label = (s: number) => `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
  const lines: string[] = [];
  for (let start = 0; start < totalSeconds; start += lineSeconds) {
    lines.push(`[${label(start)} - ${label(start + lineSeconds)}] Speaker A: Line at ${start} seconds is here.`);
  }
  return lines.join("\n");
};

describe("validateSegments", () => {
  it.each(golden.validation.map((c) => [`${c.transcript}/${c.clip_length}`, c] as const))("%s", (_, c) => {
    const text = transcripts[c.transcript];
    const { most_relevant_segments: segments } = parseTranscriptAnalysis({
      most_relevant_segments: c.segments,
      summary: "",
      key_topics: [],
    });
    const result = validateSegments(segments, parseTranscriptLines(text), parseTranscriptSpans(text), c.clip_length as ClipLength);
    expect(result).toEqual(c.result);
  });
});

describe("sanitizeHookTitle", () => {
  it.each(golden.hook_titles as [string | null, string | null][])("%j", (raw, expected) => {
    expect(sanitizeHookTitle(raw)).toBe(expected);
  });
});

describe("timestamps", () => {
  it.each(golden.timestamps.parse as [string, number | null][])("parses %j", (value, expected) => {
    if (expected === null) expect(() => parseTranscriptTimestampSeconds(value)).toThrow(TimestampError);
    else expect(parseTranscriptTimestampSeconds(value)).toBe(expected);
  });

  it.each(golden.timestamps.format as [number, string][])("formats %i", (seconds, expected) => {
    expect(formatTranscriptTimestamp(seconds)).toBe(expected);
  });

  it.each(golden.timestamps.minutes as [number, string][])("labels %i", (seconds, expected) => {
    expect(formatMinutesLabel(seconds)).toBe(expected);
  });
});

describe("rescaleVirality", () => {
  it.each(golden.rescale.map((c) => [c.subscores, c.new_total, c] as const))("%j to %i", (subscores, newTotal, c) => {
    const [hook, engagement, value, share] = subscores;
    const virality = {
      ...defaultVirality(),
      hook_score: hook,
      engagement_score: engagement,
      value_score: value,
      shareability_score: share,
      total_score: hook + engagement + value + share,
    };
    rescaleVirality(virality, newTotal);
    expect(virality).toEqual(c.result);
  });
});

describe("windows", () => {
  it.each(golden.windows.map((c) => [c.minutes, c.line_seconds, c] as const))("%i minutes of %is lines", (minutes, lineSeconds, c) => {
    const windows = splitTranscriptIntoWindows(evenTranscript(minutes * 60, lineSeconds));
    expect(
      windows.map((w) => {
        const lines = w.transcript.split("\n");
        return { start: w.start, end: w.end, lines: lines.length, first: lines[0].slice(0, 16), last: lines.at(-1)!.slice(0, 18) };
      }),
    ).toEqual(c.windows);
  });

  it.each(golden.signal_filters as [number, number, string | null][])("filters signals for %i-%i", (start, end, expected) => {
    expect(filterClipSignalsForWindow(golden.signals, start, end)).toBe(expected);
  });

  it("final clip counts", () => {
    for (const [seconds, maxClips, expected] of golden.final_clips) {
      expect([seconds, maxClips, maxFinalClipsForDuration(seconds, maxClips)]).toEqual([seconds, maxClips, expected]);
    }
  });
});

describe("parseTranscriptAnalysis", () => {
  it.each(golden.models.map((c, i) => [i, c] as const))("case %i applies pydantic defaults and aliases", (_, c) => {
    expect(parseTranscriptAnalysis(c.input)).toEqual(c.output);
  });
});
