/** @vitest-environment node */
// Ports of backend/tests/unit/test_ai_grounding.py, test_ai_models.py and the transcript helper
// tests in test_ai_prompt.py.
import { describe, expect, it } from "vitest";
import { parseTranscriptAnalysis } from "./schemas";
import {
  formatTranscriptTimestamp,
  parseTranscriptLines,
  parseTranscriptSpans,
  parseTranscriptTimestampSeconds,
  pySplit,
  splitLines,
  TimestampError,
} from "./transcript";
import {
  chooseRepairedBounds,
  extractTranscriptText,
  extractTranscriptTextForSegment,
  sanitizeHookTitle,
} from "./validate";

describe("grounding", () => {
  it("strips speaker labels and joins lines", () => {
    const lines = parseTranscriptLines(
      ["[00:00 - 00:10] Speaker A: First sentence.", "[00:10 - 00:20] Speaker A: Second sentence."].join("\n"),
    );
    expect(extractTranscriptTextForSegment(lines, "00:00", "00:20")).toBe("First sentence. Second sentence.");
  });

  it("rejects a non-boundary timestamp", () => {
    const lines = parseTranscriptLines("[00:00 - 00:10] Speaker A: First sentence.");
    expect(extractTranscriptTextForSegment(lines, "00:05", "00:10")).toBeNull();
  });

  it("splits lines like Python str.splitlines", () => {
    expect(splitLines("a\r\nb\rc d\n")).toEqual(["a", "b", "c", "d"]);
    expect(parseTranscriptLines("[00:00 - 00:10] one\r\n[00:10 - 00:20] two")).toHaveLength(2);
  });
});

describe("transcript helpers", () => {
  it("uses Python's whitespace set", () => {
    // Expected values come from the original ai.py.
    const BOM = String.fromCharCode(0xfeff);
    expect(sanitizeHookTitle("Big claim\x1c")).toBe("Big claim");
    expect(sanitizeHookTitle(`${BOM}Big claim`)).toBe(`${BOM}Big claim`);
    expect(sanitizeHookTitle("one\x85two three")).toBe("one two three");
    expect(pySplit(" one\x1ftwo\x85 ")).toEqual(["one", "two"]);
    expect(parseTranscriptLines("[00:00 - 00:10]\x1fSpeaker A:\x1fhi there\x1f")[0].text).toBe("hi there");
    expect(parseTranscriptLines(`[00:00 - 00:10] hi there${BOM}`)[0].text).toBe(`hi there${BOM}`);
    // int() skips U+0085 but not U+001C-U+001F or U+FEFF.
    expect(parseTranscriptTimestampSeconds("00:05\x85")).toBe(5);
    expect(() => parseTranscriptTimestampSeconds("00:05\x1f")).toThrow(TimestampError);
    expect(() => parseTranscriptTimestampSeconds(`${BOM}00:05`)).toThrow(TimestampError);
  });

  it("parses minute and hour timestamps", () => {
    expect(parseTranscriptTimestampSeconds("02:35")).toBe(155);
    expect(parseTranscriptTimestampSeconds("01:02:35")).toBe(3755);
    expect(formatTranscriptTimestamp(155)).toBe("02:35");
    expect(formatTranscriptTimestamp(3755)).toBe("01:02:35");
  });

  it("repairs near-miss durations from spans", () => {
    const spans = parseTranscriptSpans(
      [
        "[00:00 - 00:10] Setup",
        "[00:10 - 00:24] Short highlight",
        "[00:24 - 00:36] Payoff",
        "[00:36 - 01:20] Too much background",
      ].join("\n"),
    );
    expect(extractTranscriptText(spans, 10, 36)).toBe("Short highlight Payoff");
    expect(chooseRepairedBounds(spans, 10, 24)).toEqual([10, 36]);
    expect(chooseRepairedBounds(spans, 0, 80)).toEqual([0, 36]);
  });
});

describe("output models", () => {
  const parseSegment = (segment: Record<string, unknown>) =>
    parseTranscriptAnalysis({ most_relevant_segments: [segment], summary: "s", key_topics: [] }).most_relevant_segments[0];

  it("normalizes a percent relevance score", () => {
    expect(parseSegment({ start_time: "00:00", end_time: "00:30", text: "t", relevance_score: 100 }).relevance_score).toBe(1);
  });

  it("accepts the minimal local-model shape", () => {
    const segment = parseSegment({
      start_time: "00:00",
      end_time: "00:15",
      segment: "This is a standalone clip candidate from a local model.",
    });
    expect(segment.text).toBe("This is a standalone clip candidate from a local model.");
    expect(segment.relevance_score).toBe(0.75);
    expect(segment.reasoning).toBe("Selected by the AI model as a clip candidate.");
    expect(segment.virality.total_score).toBe(60);
  });

  it("ignores legacy broll_opportunities", () => {
    const analysis = parseTranscriptAnalysis({
      most_relevant_segments: [
        { start_time: "00:00", end_time: "00:15", text: "This clip has enough words to pass the text validation." },
      ],
      summary: "A short summary.",
      key_topics: ["local model output"],
      broll_opportunities: [{ broll: ["programming tutorial channels"] }],
    });
    expect(analysis.most_relevant_segments).toHaveLength(1);
    expect(analysis).not.toHaveProperty("broll_opportunities");
  });
});
