/** @vitest-environment node */
// Port of the selection parts of backend/tests/unit/test_clip_duration.py (rendering caps and
// cache keys live with the engine and the worker).
import { describe, expect, it } from "vitest";
import { fakeFetch, isRerankRequest, messageResponse } from "./__fixtures__/fake-anthropic";
import { CLIP_DURATIONS, clipDuration, normalizeClipLength, validateClipLength, type ClipLength } from "./clip-duration";
import { selectClips } from "./index";
import { buildTranscriptAnalysisPrompt, buildTranscriptSystemPrompt } from "./prompts";
import { parseTranscriptAnalysis } from "./schemas";
import { parseTranscriptLines, parseTranscriptSpans } from "./transcript";
import { validateSegments } from "./validate";
import { segmentBoundsSeconds } from "./windows";

function transcript(seconds = 1800): string {
  const label = (value: number) => `${String(Math.floor(value / 60)).padStart(2, "0")}:${String(value % 60).padStart(2, "0")}`;
  const lines: string[] = [];
  for (let start = 0; start < seconds; start += 10) {
    lines.push(`[${label(start)} - ${label(start + 10)}] Useful context and a complete thought.`);
  }
  return lines.join("\n");
}

const segment = (start: string, end: string, text = "Useful context and thought.") =>
  parseTranscriptAnalysis({ most_relevant_segments: [{ start_time: start, end_time: end, text }], summary: "", key_topics: [] })
    .most_relevant_segments[0];

const INVALID = [null, true, 30, "", "LONG", "custom", [], {}, "toString", "constructor"];

describe("clip length presets", () => {
  it.each([
    ["auto", 15, 60],
    ["short", 15, 30],
    ["medium", 30, 60],
    ["long", 60, 120],
  ] as const)("prompts agree on the %s range", (preset, minimum, maximum) => {
    const system = buildTranscriptSystemPrompt(preset);
    const prompt = buildTranscriptAnalysisPrompt({ transcript: "transcript", clipLength: preset });
    expect(system).toContain(`must be ${minimum}-${maximum} seconds`);
    expect(prompt).toContain(`shorter than ${minimum} seconds or longer than ${maximum} seconds`);
    expect(system).not.toContain("{minimum}");
    expect(system).not.toContain("${");
    if (preset === "long") {
      expect(system).not.toContain("15-60 seconds");
      expect(prompt).not.toContain("25-50 seconds");
    }
  });

  it.each(INVALID.map((value) => [JSON.stringify(value), value]))("rejects %s", (_, value) => {
    expect(() => validateClipLength(value)).toThrow("clip_length must be auto, short, medium, or long");
  });

  it.each(INVALID.map((value) => [JSON.stringify(value), value]))("falls back to auto for stored %s", (_, value) => {
    expect(normalizeClipLength(value)).toBe("auto");
  });

  it("keeps a valid stored preset", () => {
    expect(normalizeClipLength("long")).toBe("long");
  });

  it.each(Object.keys(CLIP_DURATIONS) as ClipLength[])("%s leaves room to finish a sentence", (preset) => {
    const bounds = clipDuration(preset);
    expect(bounds.idealMaximum).toBeLessThanOrEqual(bounds.maximum - 5);
  });

  it.each([
    ["short", "00:00", "01:30"], // repair an overlong model result
    ["medium", "00:30", "00:40"], // expand surrounding context
    ["long", "00:30", "01:00"],
    ["long", "00:00", "01:30"], // keep a 90s pick rather than truncating to 60s
  ] as const)("validation and repair use the %s bounds (%s-%s)", (preset, start, end) => {
    const text = transcript(180);
    const result = validateSegments([segment(start, end)], parseTranscriptLines(text), parseTranscriptSpans(text), preset);
    expect(result).toHaveLength(1);
    const [startSeconds, endSeconds] = segmentBoundsSeconds(result[0]);
    const bounds = clipDuration(preset);
    expect(endSeconds - startSeconds).toBeGreaterThanOrEqual(bounds.minimum);
    expect(endSeconds - startSeconds).toBeLessThanOrEqual(bounds.maximum);
    if (start === "00:00" && preset === "long") expect(endSeconds - startSeconds).toBe(90);
  });

  it.each([180, 1800])("single and windowed analysis keep long clips (%is)", async (seconds) => {
    const fake = fakeFetch((request) => {
      expect(isRerankRequest(request)).toBe(false);
      expect(request.body.messages[0].content).toContain("longer than 120 seconds");
      expect(request.body.system).toContain("must be 60-120 seconds");
      return messageResponse({
        most_relevant_segments: [{ start_time: "00:00", end_time: "01:30", text: "Useful context and a complete thought." }],
        summary: "Summary",
        key_topics: [],
      });
    });
    const result = await selectClips({
      transcript: transcript(seconds),
      clipLength: "long",
      apiKey: "sk-ant-test",
      model: "claude-opus-5",
      fetch: fake.fetch,
    });
    expect(result.segments).toHaveLength(1);
    expect(segmentBoundsSeconds(result.segments[0])).toEqual([0, 90]);
  });
});
