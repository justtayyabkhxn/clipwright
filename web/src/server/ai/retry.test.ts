/** @vitest-environment node */
// Port of backend/tests/unit/test_ai_retry.py.
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { errorResponse, fakeFetch, hang, messageResponse } from "./__fixtures__/fake-anthropic";
import { createClaudeClient, requestStructured, retryTiming, runWithRetry } from "./client";
import { selectClips } from "./index";
import { parseTranscriptAnalysis, TRANSCRIPT_ANALYSIS_SCHEMA } from "./schemas";

const TRANSCRIPT = "[00:00 - 00:30] A useful standalone explanation of a common mistake.";
const ANALYSIS = {
  most_relevant_segments: [
    { start_time: "00:00", end_time: "00:30", text: "A useful standalone explanation of a common mistake." },
  ],
  summary: "A common mistake.",
  key_topics: ["mistakes"],
};

let sleep: MockInstance<typeof retryTiming.sleep>;

beforeEach(() => {
  sleep = vi.spyOn(retryTiming, "sleep").mockResolvedValue(undefined);
  vi.spyOn(retryTiming, "jitter").mockReturnValue(0);
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

/** One analysis call (the agent.run equivalent) behind the retry budget. */
function analyse(fetch: typeof globalThis.fetch, { timeoutMs = 600_000, signal }: { timeoutMs?: number; signal?: AbortSignal } = {}) {
  const client = createClaudeClient("sk-ant-test", fetch);
  return runWithRetry(
    (budget) =>
      requestStructured({
        client,
        model: "claude-sonnet-5",
        system: "system",
        prompt: "prompt",
        schema: TRANSCRIPT_ANALYSIS_SCHEMA,
        parse: parseTranscriptAnalysis,
        signal: budget,
      }),
    { timeoutMs, signal },
  );
}

describe("transient retries", () => {
  it("recovers from an overload without changing the request", async () => {
    const fake = fakeFetch((_, index) => (index === 0 ? errorResponse(503, "High demand") : messageResponse(ANALYSIS)));
    const result = await selectClips({ transcript: TRANSCRIPT, apiKey: "sk-ant-test", model: "claude-opus-5", fetch: fake.fetch });

    expect(result.segments).toHaveLength(1);
    expect(fake.requests).toHaveLength(2);
    expect(fake.requests[1].body).toEqual(fake.requests[0].body);
    expect(sleep).toHaveBeenCalledOnce();
    expect(sleep.mock.calls[0][0]).toBe(5000);
  });

  it("bounds an exhausted overload and keeps provider bodies out of the error and logs", async () => {
    const fake = fakeFetch(() => errorResponse(503, "sensitive transcript"));
    const error = (await selectClips({ transcript: "transcript", apiKey: "sk-ant-test", model: "claude-opus-5", fetch: fake.fetch }).catch(
      (reason: unknown) => reason,
    )) as Error;

    expect(error.message).toBe(
      "Transcript analysis failed: The AI analysis service is temporarily unavailable after several attempts. Please try again shortly.",
    );
    expect(fake.requests).toHaveLength(3);
    expect(sleep.mock.calls.map((call) => call[0])).toEqual([5000, 10000]);
    let chain: unknown = error;
    while (chain instanceof Error) {
      expect(`${chain.message} ${chain.stack}`).not.toContain("sensitive transcript");
      chain = chain.cause;
    }
    const logged = [console.warn, console.error].flatMap((spy) => vi.mocked(spy).mock.calls.flat()).join(" ");
    expect(logged).not.toContain("sensitive transcript");
  });

  it.each([408, 409, 429, 500, 502, 503, 504, 529])("recovers from HTTP %i", async (status) => {
    const fake = fakeFetch((_, index) => (index === 0 ? errorResponse(status) : messageResponse(ANALYSIS)));
    await expect(analyse(fake.fetch)).resolves.toEqual(parseTranscriptAnalysis(ANALYSIS));
    expect(fake.requests).toHaveLength(2);
  });

  it("recovers from a transport failure", async () => {
    const fake = fakeFetch((_, index) => {
      if (index === 0) throw new TypeError("fetch failed");
      return messageResponse(ANALYSIS);
    });
    await expect(analyse(fake.fetch)).resolves.toEqual(parseTranscriptAnalysis(ANALYSIS));
    expect(fake.requests).toHaveLength(2);
  });
});

describe("permanent failures", () => {
  it.each([400, 401, 403, 404])("does not retry HTTP %i", async (status) => {
    const fake = fakeFetch(() => errorResponse(status));
    await expect(analyse(fake.fetch)).rejects.toMatchObject({ status });
    expect(fake.requests).toHaveLength(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("does not retry invalid output beyond the repair attempts", async () => {
    const fake = fakeFetch(() => messageResponse("not json"));
    await expect(analyse(fake.fetch)).rejects.toThrow("Exceeded maximum output retries (2)");
    expect(fake.requests).toHaveLength(3);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("passes other errors through unchanged", async () => {
    const error = new Error("Invalid configuration");
    const run = vi.fn().mockRejectedValue(error);
    await expect(runWithRetry(run, { timeoutMs: 1000 })).rejects.toBe(error);
    expect(run).toHaveBeenCalledOnce();
    expect(sleep).not.toHaveBeenCalled();
  });
});

describe("cancellation and deadline", () => {
  it("passes cancellation during a request straight through", async () => {
    const controller = new AbortController();
    const fake = fakeFetch(() => {
      controller.abort();
      return hang();
    });
    const error = await analyse(fake.fetch, { signal: controller.signal }).catch((reason: unknown) => reason);
    expect(error).toBe(controller.signal.reason);
    expect(fake.requests).toHaveLength(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("passes cancellation during the backoff straight through", async () => {
    const controller = new AbortController();
    sleep.mockImplementation(async () => {
      controller.abort();
      throw new DOMException("The operation was aborted", "AbortError");
    });
    const fake = fakeFetch(() => errorResponse(503));
    const error = await analyse(fake.fetch, { signal: controller.signal }).catch((reason: unknown) => reason);
    expect(error).toBe(controller.signal.reason);
    expect(fake.requests).toHaveLength(1);
  });

  it("gives the entire run one deadline", async () => {
    const fake = fakeFetch(hang);
    await expect(analyse(fake.fetch, { timeoutMs: 20 })).rejects.toThrow(
      "The AI analysis service took too long to respond. Please try again shortly.",
    );
    expect(fake.requests).toHaveLength(1);
    expect(fake.requests[0].signal?.aborted).toBe(true);
  });

  it("counts the backoff against the deadline", async () => {
    sleep.mockRestore();
    const fake = fakeFetch(() => errorResponse(503));
    const started = Date.now();
    await expect(analyse(fake.fetch, { timeoutMs: 50 })).rejects.toThrow(/took too long/);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(fake.requests).toHaveLength(1);
  });
});
