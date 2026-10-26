/** @vitest-environment node */
// Port of backend/tests/unit/test_ai_windowed_selection.py.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  errorResponse,
  fakeFetch,
  firstTranscriptLine,
  isRerankRequest,
  messageResponse,
  type CapturedRequest,
} from "./__fixtures__/fake-anthropic";
import { selectClips } from "./index";
import { applyCandidateRanking, rerankCandidates } from "./rerank";
import { createClaudeClient } from "./client";
import type { TranscriptSegment } from "./schemas";
import { parseTranscriptLines, parseTranscriptSpans, parseTranscriptTimestampSeconds } from "./transcript";
import { extractTranscriptTextForSegment, snapBoundsToTranscriptLines, validateSegments } from "./validate";
import {
  dedupeOverlappingSegments,
  filterClipSignalsForWindow,
  maxFinalClipsForDuration,
  splitTranscriptIntoWindows,
} from "./windows";

const label = (seconds: number) =>
  `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;

function transcript(totalSeconds: number, lineSeconds = 10): string {
  const lines: string[] = [];
  for (let start = 0; start < totalSeconds; start += lineSeconds) {
    lines.push(`[${label(start)} - ${label(start + lineSeconds)}] Speaker A: Line at ${start} seconds is here.`);
  }
  return lines.join("\n");
}

function segment(start: string, end: string, total = 60, text = "Some useful words here."): TranscriptSegment {
  const quarter = Math.floor(total / 4);
  return {
    start_time: start,
    end_time: end,
    text,
    relevance_score: 0.75,
    reasoning: "Selected by the AI model as a clip candidate.",
    virality: {
      hook_score: quarter,
      engagement_score: quarter,
      value_score: quarter,
      shareability_score: total - 3 * quarter,
      total_score: total,
      hook_type: "none",
      virality_reasoning: "The model did not provide a detailed virality breakdown.",
    },
    hook_title: null,
    hook_start_time: null,
    hook_end_time: null,
  };
}

const analysis = (segments: TranscriptSegment[], summary = "ok", keyTopics: string[] = []) =>
  messageResponse({ most_relevant_segments: segments, summary, key_topics: keyTopics });

const ranking = (items: [number, number][]) =>
  messageResponse({ ranking: items.map(([candidate_id, score]) => ({ candidate_id, score })) });

const run = (text: string, handler: (request: CapturedRequest) => Response | Promise<Response>) => {
  const fake = fakeFetch(handler);
  return { fake, result: selectClips({ transcript: text, apiKey: "sk-ant-test", model: "claude-opus-5", fetch: fake.fetch }) };
};

afterEach(() => vi.restoreAllMocks());

describe("windowing", () => {
  it("keeps a short transcript as a single unchanged window", () => {
    const text = transcript(10 * 60);
    const windows = splitTranscriptIntoWindows(text);
    expect(windows).toHaveLength(1);
    expect(windows[0].transcript).toBe(text);
  });

  it("splits a long transcript into overlapping windows", () => {
    const windows = splitTranscriptIntoWindows(transcript(60 * 60));
    expect(windows.map((w) => [w.start, w.end])).toEqual([
      [0, 720], [600, 1320], [1200, 1920], [1800, 2520], [2400, 3120], [3000, 3600],
    ]);
    const firstLines = windows[0].transcript.split("\n");
    expect(firstLines[0].startsWith("[00:00 - 00:10]")).toBe(true);
    expect(firstLines.at(-1)!.startsWith("[11:50 - 12:00]")).toBe(true);
    // The overlap repeats the last two minutes of each window in the next one.
    expect(windows[1].transcript.split("\n")[0].startsWith("[10:00 - 10:10]")).toBe(true);
    expect(windows.at(-1)!.transcript.split("\n").at(-1)!.startsWith("[59:50 - 60:00]")).toBe(true);
  });

  it("folds a short trailing window into the previous one", () => {
    expect(splitTranscriptIntoWindows(transcript(23 * 60)).map((w) => [w.start, w.end])).toEqual([
      [0, 720], [600, 1380],
    ]);
  });

  it("handles three-digit minutes", () => {
    const windows = splitTranscriptIntoWindows(transcript(110 * 60));
    expect(windows.at(-1)!.end).toBe(110 * 60);
    expect(windows.at(-1)!.transcript.split("\n").at(-1)!.startsWith("[109:50 - 110:00]")).toBe(true);
  });

  it("only includes signal lines inside the window", () => {
    const signals = [
      "Deterministic clip-worthiness signals to consider before ranking:",
      "- [00:30 - 00:40] score=2.0: trigger phrase; Wait what",
      "- [15:00 - 15:10] score=1.5: question/hook; Why?",
      "- [101:00 - 101:10] score=1.0: pause before line; Late",
    ].join("\n");
    const lines = signals.split("\n");
    expect(filterClipSignalsForWindow(signals, 0, 720)!.split("\n")).toEqual([lines[0], lines[1]]);
    expect(filterClipSignalsForWindow(signals, 6000, 6720)!.split("\n").at(-1)!.startsWith("- [101:00")).toBe(true);
    expect(filterClipSignalsForWindow(signals, 1000, 1100)).toBeNull();
  });
});

describe("grounding and validation", () => {
  it("parses and grounds three-digit minute lines", () => {
    const text = [
      "[100:00 - 100:20] Speaker A: First long sentence past the hundred minute mark.",
      "[100:20 - 100:40] Speaker A: Second sentence with the payoff.",
    ].join("\n");
    const lines = parseTranscriptLines(text);
    const spans = parseTranscriptSpans(text);
    expect(lines[0].start_seconds).toBe(6000);
    expect(lines[1].end_seconds).toBe(6040);
    expect(spans[1].end).toBe(6040);
    expect(extractTranscriptTextForSegment(lines, "100:00", "100:40")).toBe(
      "First long sentence past the hundred minute mark. Second sentence with the payoff.",
    );
  });

  it("snaps near-miss timestamps instead of dropping them", () => {
    const text = transcript(120);
    const validated = validateSegments([segment("00:12", "00:47")], parseTranscriptLines(text), parseTranscriptSpans(text));
    expect(validated).toHaveLength(1);
    expect([validated[0].start_time, validated[0].end_time]).toEqual(["00:10", "00:50"]);
    expect(validated[0].text.startsWith("Line at 10 seconds")).toBe(true);
  });

  it("still drops timestamps far from any line", () => {
    const lines = [
      { start_time: "00:00", end_time: "00:40", start_seconds: 0, end_seconds: 40, text: "a b c" },
      { start_time: "00:40", end_time: "01:20", start_seconds: 40, end_seconds: 80, text: "d e f" },
    ];
    expect(snapBoundsToTranscriptLines(lines, 20, 60)).toBeNull();
  });

  it("snaps repaired bounds past an hour back to transcript labels", () => {
    const text = transcript(70 * 60);
    // 90 seconds is too long; repair trims it and must keep MM:SS labels.
    const validated = validateSegments([segment("65:00", "66:30")], parseTranscriptLines(text), parseTranscriptSpans(text));
    expect(validated).toHaveLength(1);
    expect(validated[0].start_time).toBe("65:00");
    expect(parseTranscriptTimestampSeconds(validated[0].end_time)).toBeLessThanOrEqual(65 * 60 + 60);
    expect(validated[0].end_time.split(":")).toHaveLength(2);
  });
});

describe("dedupe and final count", () => {
  it("keeps the higher scored of overlapping candidates", () => {
    const weaker = segment("01:00", "01:40", 60);
    const stronger = segment("01:10", "01:50", 80);
    const separate = segment("05:00", "05:40", 50);
    expect(dedupeOverlappingSegments([weaker, separate, stronger])).toEqual([stronger, separate]);
  });

  it("keeps lightly overlapping candidates", () => {
    const first = segment("01:00", "01:40", 70);
    const second = segment("01:30", "02:10", 60);
    expect(dedupeOverlappingSegments([first, second])).toEqual([first, second]);
  });

  it.each([
    [5 * 60, 5], [20 * 60, 5], [45 * 60, 9], [90 * 60, 18], [200 * 60, 20],
  ])("scales the cap with source length (%is → %i)", (seconds, expected) => {
    expect(maxFinalClipsForDuration(seconds)).toBe(expected);
  });

  it.each([
    [5 * 60, 10, 5], [45 * 60, 10, 9], [90 * 60, 10, 10], [200 * 60, 10, 10], [90 * 60, 3, 3],
  ])("respects MAX_CLIPS (%is, max %i → %i)", (seconds, maxClips, expected) => {
    expect(maxFinalClipsForDuration(seconds, maxClips)).toBe(expected);
  });
});

describe("rerank", () => {
  it("reorders and calibrates scores", () => {
    const candidates = [segment("00:00", "00:30", 90), segment("01:00", "01:30", 80), segment("02:00", "02:30", 70)];
    const reranked = applyCandidateRanking(candidates, {
      ranking: [
        { candidate_id: 2, score: 88, reason: "" },
        { candidate_id: 0, score: 91, reason: "" }, // clamped to keep order monotonic
        { candidate_id: 7, score: 50, reason: "" }, // unknown id ignored
      ],
    });
    expect(reranked.map((s) => s.start_time)).toEqual(["02:00", "00:00", "01:00"]);
    expect(reranked.map((s) => s.virality.total_score)).toEqual([88, 88, 80]);
    for (const { virality: v } of reranked) {
      expect(v.total_score).toBe(v.hook_score + v.engagement_score + v.value_score + v.shareability_score);
      for (const score of [v.hook_score, v.engagement_score, v.value_score, v.shareability_score]) {
        expect(score).toBeGreaterThanOrEqual(0);
        expect(score).toBeLessThanOrEqual(25);
      }
    }
  });

  it("keeps the first-pass order when the rerank fails", async () => {
    const candidates = [segment("00:00", "00:30", 90), segment("01:00", "01:30", 80)];
    const fake = fakeFetch(() => errorResponse(400, "bad output"));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = await rerankCandidates(candidates, { client: createClaudeClient("sk-ant-test", fake.fetch), model: "claude-opus-5" });
    expect(result).toBe(candidates);
    expect(result.map((s) => s.virality.total_score)).toEqual([90, 80]);
    expect(fake.requests).toHaveLength(1);
  });
});

describe("selectClips", () => {
  it("runs windows then reranks", async () => {
    let rerankPrompt = "";
    const { fake, result } = run(transcript(30 * 60), (request) => {
      if (isRerankRequest(request)) {
        rerankPrompt = request.body.messages[0].content;
        const count = rerankPrompt.split("candidate_id:").length - 1;
        return ranking([...Array(count).keys()].reverse().map((i) => [i, 90 - i]));
      }
      // Each window returns a clip at its own start plus one shared moment inside the first
      // overlap, which must be deduplicated.
      const first = firstTranscriptLine(request);
      const start = first.includes("[10:00 - 10:10]") ? 600 : first.includes("[20:00 - 20:10]") ? 1200 : 0;
      const segments = [segment(label(start + 30), label(start + 60), 60 + start / 60)];
      if (start === 0 || start === 600) segments.push(segment("10:30", "11:00", 40));
      return analysis(segments, `Window ${start}.`, ["topic", `t${start}`]);
    });
    const { segments, keyTopics, summary } = await result;

    const windowRequests = fake.requests.filter((r) => !isRerankRequest(r));
    expect(windowRequests).toHaveLength(3);
    for (const request of windowRequests) {
      expect(request.body.messages[0].content).toContain("one window");
      expect(request.body.messages[0].content).toContain("Choose 3-5 segments total.");
    }
    expect(fake.requests.filter(isRerankRequest)).toHaveLength(1);
    const starts = segments.map((s) => s.start_time);
    expect([...starts].sort()).toEqual(["00:30", "10:30", "20:30"]);
    expect(new Set(starts).size).toBe(starts.length);
    expect(keyTopics).toEqual(["topic", "t0", "t600", "t1200"]);
    expect(summary).toBe("Window 0. Window 600. Window 1200.");
    const scores = segments.map((s) => s.virality.total_score);
    expect(scores).toEqual([...scores].sort((a, b) => b - a));
    expect(rerankPrompt).not.toContain("Creator performance history");
  });

  it("tolerates window failures when another window succeeds", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { fake, result } = run(transcript(30 * 60), (request) =>
      request.body.messages[0].content.includes("[00:00 - 00:10]")
        ? analysis([segment("00:30", "01:00")])
        : errorResponse(400, "schema failure"),
    );
    const { segments } = await result;
    expect(fake.requests).toHaveLength(3);
    expect(segments.map((s) => s.start_time)).toEqual(["00:30"]);
  });

  it("raises the first window error when every window fails", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { result } = run(transcript(30 * 60), () => errorResponse(401, "invalid x-api-key"));
    await expect(result).rejects.toThrow(/^Transcript analysis failed: 401 /);
  });

  it("keeps hook times through windowing, snapping and rerank", async () => {
    const withHook = (s: TranscriptSegment, start: string, end: string) => ({ ...s, hook_start_time: start, hook_end_time: end });
    const { fake, result } = run(transcript(30 * 60), (request) => {
      if (isRerankRequest(request)) return ranking([[2, 95], [1, 85], [0, 75]]);
      const first = firstTranscriptLine(request);
      if (first.startsWith("[00:00")) {
        // Near-miss bounds snap to 00:30-01:00; the hook stays inside.
        return analysis([withHook(segment("00:31", "00:58", 60), "00:45", "00:49")], "s");
      }
      if (first.startsWith("[10:00")) {
        // The hook falls outside the final span, so it must be cleared.
        return analysis([withHook(segment("12:00", "12:30", 70), "12:40", "12:44")], "s");
      }
      return analysis([withHook(segment("20:30", "21:00", 80), "20:50", "20:54")], "s");
    });
    const { segments } = await result;

    for (const request of fake.requests.filter((r) => !isRerankRequest(r))) {
      expect(request.body.messages[0].content).toContain("hook_start_time");
    }
    expect(fake.requests.filter(isRerankRequest)).toHaveLength(1);
    const byStart = Object.fromEntries(segments.map((s) => [s.start_time, s]));
    expect([byStart["00:30"].hook_start_time, byStart["00:30"].hook_end_time]).toEqual(["00:45", "00:49"]);
    expect([byStart["12:00"].hook_start_time, byStart["12:00"].hook_end_time]).toEqual([null, null]);
    expect([byStart["20:30"].hook_start_time, byStart["20:30"].hook_end_time]).toEqual(["20:50", "20:54"]);
  });

  it("analyses at most three windows at once", async () => {
    let active = 0;
    let peak = 0;
    const { fake, result } = run(transcript(60 * 60), async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active--;
      return analysis([]);
    });
    await result;
    expect(fake.requests).toHaveLength(6);
    expect(peak).toBe(3);
  });

  it("passes cancellation straight through", async () => {
    const controller = new AbortController();
    const fake = fakeFetch(() => {
      controller.abort();
      return new Promise<Response>(() => {});
    });
    const result = selectClips({
      transcript: transcript(30 * 60),
      apiKey: "sk-ant-test",
      model: "claude-opus-5",
      signal: controller.signal,
      fetch: fake.fetch,
    });
    const error = await result.catch((reason: unknown) => reason);
    expect(error).toBe(controller.signal.reason);
    expect((error as Error).name).toBe("AbortError");
    expect(fake.requests.length).toBeLessThanOrEqual(3);
  });
});
