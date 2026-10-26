/** @vitest-environment node */
// Port of the AI parts of backend/tests/unit/test_claude_provider.py: request shape, output
// validation and the connection check. The real SDK runs against a fake fetch; nothing is paid for.
import { APIConnectionError, APIError } from "@anthropic-ai/sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import golden from "./__fixtures__/python-golden.json";
import { errorResponse, fakeFetch, jsonResponse, messageResponse } from "./__fixtures__/fake-anthropic";
import { createClaudeClient, isTransientError, requestStructured } from "./client";
import { maskSecret, testAnthropicConnection } from "./connection";
import { selectClips } from "./index";
import { buildTranscriptAnalysisPrompt, buildTranscriptSystemPrompt } from "./prompts";
import {
  CANDIDATE_RANKING_SCHEMA,
  OutputValidationError,
  parseCandidateRanking,
  parseSelectClipsResult,
  parseTranscriptAnalysis,
  TRANSCRIPT_ANALYSIS_SCHEMA,
} from "./schemas";

const TEST_KEY = "sk-ant-api03-test-secret-value-a1b2";
const TRANSCRIPT = "[00:05 - 00:40] Speaker A: Here is the one habit that doubled my output in a month.";
const ANALYSIS = {
  most_relevant_segments: [
    {
      start_time: "00:05",
      end_time: "00:40",
      text: "Here is the one habit that doubled my output in a month.",
      hook_title: "The habit that doubled my output",
    },
  ],
  summary: "Productivity advice",
  key_topics: ["productivity"],
};

afterEach(() => vi.restoreAllMocks());

const select = (fetch: typeof globalThis.fetch, model = "claude-opus-5") =>
  selectClips({ transcript: TRANSCRIPT, apiKey: TEST_KEY, model, fetch });

describe("clip selection request", () => {
  it("sends structured output with server-side fallback for Opus 5", async () => {
    const fake = fakeFetch(() => messageResponse(ANALYSIS));
    const result = await select(fake.fetch);

    expect(result.segments.map((s) => [s.start_time, s.end_time, s.hook_title])).toEqual([
      ["00:05", "00:40", "The habit that doubled my output"],
    ]);
    expect(result.summary).toBe("Productivity advice");
    expect(result.keyTopics).toEqual(["productivity"]);

    const [request] = fake.requests;
    expect(request.url.host).toBe("api.anthropic.com");
    expect(request.url.pathname).toBe("/v1/messages");
    expect(request.method).toBe("POST");
    expect(`${request.headers.get("x-api-key")} ${request.headers.get("authorization")}`).toContain(TEST_KEY);
    expect(request.headers.get("anthropic-beta")).toBe("server-side-fallback-2026-07-01");
    expect(request.body).toEqual({
      model: "claude-opus-5",
      max_tokens: 16000,
      system: buildTranscriptSystemPrompt("auto"),
      messages: [{ role: "user", content: buildTranscriptAnalysisPrompt({ transcript: TRANSCRIPT }) }],
      output_config: { format: { type: "json_schema", schema: TRANSCRIPT_ANALYSIS_SCHEMA } },
      fallbacks: "default",
    });
    expect(request.body).not.toHaveProperty("tools");
    expect(request.body).not.toHaveProperty("tool_choice");
  });

  it("matches the request pydantic-ai sent", async () => {
    for (const model of ["claude-opus-5", "claude-sonnet-5"] as const) {
      const sent = golden.requests[model];
      const fake = fakeFetch((request) =>
        messageResponse(request.body.output_config.format.schema.properties.ranking ? { ranking: [] } : ANALYSIS),
      );
      const client = createClaudeClient(TEST_KEY, fake.fetch);
      for (const [schema, parse] of [
        [TRANSCRIPT_ANALYSIS_SCHEMA, parseTranscriptAnalysis],
        [CANDIDATE_RANKING_SCHEMA, parseCandidateRanking],
      ] as const) {
        await requestStructured({ client, model, system: "SYSTEM", prompt: "PROMPT", schema, parse: parse as (v: unknown) => unknown });
      }
      const [analysis, ranking] = fake.requests;
      for (const [body, python] of [[analysis.body, sent.analysis], [ranking.body, sent.ranking]] as const) {
        const { messages, stream, ...rest } = python;
        expect(stream).toBe(false);
        expect(messages).toEqual([{ role: "user", content: [{ text: "PROMPT", type: "text" }] }]);
        expect(body).toEqual({ ...rest, messages: [{ role: "user", content: "PROMPT" }] });
      }
      expect(analysis.headers.get("anthropic-beta")).toBe(sent.beta);
    }
  });

  it("sends no fallback or beta for other models", async () => {
    const fake = fakeFetch(() => messageResponse(ANALYSIS, { model: "claude-sonnet-5" }));
    await select(fake.fetch, "claude-sonnet-5");
    expect(fake.requests[0].body).not.toHaveProperty("fallbacks");
    expect(fake.requests[0].headers.get("anthropic-beta")).toBeNull();
    expect(fake.requests[0].body.model).toBe("claude-sonnet-5");
  });

  it("reads the JSON from text blocks only", async () => {
    const text = JSON.stringify(ANALYSIS);
    const fake = fakeFetch(() =>
      messageResponse(null, {
        content: [
          { type: "thinking", thinking: "Weighing the habit line.", signature: "sig" },
          { type: "text", text: text.slice(0, 40) },
          { type: "text", text: text.slice(40) },
        ],
      }),
    );
    const result = await select(fake.fetch);
    expect(result.segments).toHaveLength(1);
    expect(fake.requests).toHaveLength(1);
  });
});

describe("output repair", () => {
  it("retries malformed output with the validation errors, then rejects", async () => {
    const bad = '{"most_relevant_segments": "not a list"}';
    const fake = fakeFetch(() => messageResponse(bad));
    await expect(select(fake.fetch)).rejects.toThrow(
      "Transcript analysis failed: Exceeded maximum output retries (2)",
    );
    expect(fake.requests).toHaveLength(3);

    const messages = fake.requests[1].body.messages;
    expect(messages).toHaveLength(3);
    expect(messages[1]).toEqual({ role: "assistant", content: bad });
    expect(messages[2].role).toBe("user");
    const feedback: string = messages[2].content;
    expect(feedback.startsWith("3 validation errors:\n```json\n")).toBe(true);
    expect(feedback.endsWith("\n```\n\nFix the errors and try again.")).toBe(true);
    expect(JSON.parse(feedback.split("```json\n")[1].split("\n```")[0])).toEqual([
      { type: "list_type", loc: ["most_relevant_segments"], msg: "Input should be a valid list" },
      { type: "missing", loc: ["summary"], msg: "Field required" },
      { type: "missing", loc: ["key_topics"], msg: "Field required" },
    ]);
    expect(fake.requests[2].body.messages).toHaveLength(5);
  });

  it("repairs invalid JSON on the next attempt", async () => {
    const fake = fakeFetch((_, index) => messageResponse(index === 0 ? "{not json" : ANALYSIS));
    const result = await select(fake.fetch);
    expect(result.segments).toHaveLength(1);
    const feedback = JSON.parse(fake.requests[1].body.messages[2].content.split("```json\n")[1].split("\n```")[0]);
    expect(feedback).toHaveLength(1);
    expect(feedback[0].type).toBe("json_invalid");
    expect(feedback[0].loc).toEqual([]);
  });

  it("includes the input of nested errors", async () => {
    const output = { ...ANALYSIS, most_relevant_segments: [{ start_time: "00:05", end_time: 40, text: "x" }] };
    const fake = fakeFetch((_, index) => messageResponse(index === 0 ? output : ANALYSIS));
    await select(fake.fetch);
    const feedback = JSON.parse(fake.requests[1].body.messages[2].content.split("```json\n")[1].split("\n```")[0]);
    expect(feedback).toEqual([
      { type: "string_type", loc: ["most_relevant_segments", 0, "end_time"], msg: "Input should be a valid string", input: 40 },
    ]);
  });

  it.each(["refusal", "max_tokens"])("resubmits after a %s stop", async (stopReason) => {
    const fake = fakeFetch((_, index) => messageResponse(index === 0 ? "{" : ANALYSIS, { stopReason: index === 0 ? stopReason : "end_turn" }));
    const result = await select(fake.fetch);
    expect(result.segments).toHaveLength(1);
    expect(fake.requests).toHaveLength(2);
    expect(fake.requests[1].body).toEqual(fake.requests[0].body);
  });

  // pydantic-ai's messages: ContentFilterError and "don't retry if the token limit was exceeded".
  const TOKEN_LIMIT =
    "Claude reached its output limit (16000 tokens) before returning any clips. Try again, or choose a shorter clip length.";
  it.each([
    ["refusal", [], "Content filter triggered. Finish reason: 'refusal'"],
    ["max_tokens", [{ type: "thinking", thinking: "Weighing the candidates", signature: "sig" }], TOKEN_LIMIT],
    ["model_context_window_exceeded", [], TOKEN_LIMIT],
  ])("fails at once on a %s stop without text", async (stopReason, content, message) => {
    const fake = fakeFetch(() => messageResponse("", { stopReason, content }));
    await expect(select(fake.fetch)).rejects.toThrow(`Transcript analysis failed: ${message}`);
    expect(fake.requests).toHaveLength(1);
  });

  it("resubmits an empty answer unchanged", async () => {
    const fake = fakeFetch((_, index) => messageResponse(ANALYSIS, index === 0 ? { content: [] } : {}));
    const result = await select(fake.fetch);
    expect(result.segments).toHaveLength(1);
    expect(fake.requests).toHaveLength(2);
    expect(fake.requests[1].body).toEqual(fake.requests[0].body);
  });
});

describe("error classification and output parsing", () => {
  it.each([408, 409, 429, 500, 503, 529])("treats HTTP %i as transient", (status) => {
    expect(isTransientError(APIError.generate(status, undefined, "busy", new Headers()))).toBe(true);
  });

  it.each([400, 401, 403, 404, 422])("never retries HTTP %i", (status) => {
    expect(isTransientError(APIError.generate(status, undefined, "no", new Headers()))).toBe(false);
  });

  it("treats connection failures as transient", () => {
    expect(isTransientError(new APIConnectionError({ message: "reset" }))).toBe(true);
    expect(isTransientError(new Error("bug"))).toBe(false);
  });

  it("rejects a segment without text", () => {
    expect(() =>
      parseTranscriptAnalysis({ most_relevant_segments: [{ start_time: "00:00", end_time: "00:20" }], summary: "x", key_topics: [] }),
    ).toThrow(OutputValidationError);
  });

  it("clamps out-of-range scores instead of rejecting them", () => {
    const [segment] = parseTranscriptAnalysis({
      most_relevant_segments: [
        {
          start_time: "00:00",
          end_time: "00:20",
          text: "t",
          relevance_score: 150,
          virality: { hook_score: 27, engagement_score: -3, value_score: 25, shareability_score: 0, total_score: 120 },
        },
      ],
      summary: "x",
      key_topics: [],
    }).most_relevant_segments;
    expect(segment.relevance_score).toBe(1);
    expect(segment.virality).toMatchObject({ hook_score: 25, engagement_score: 0, value_score: 25, total_score: 100 });
    expect(parseTranscriptAnalysis({ most_relevant_segments: [{ ...segment, relevance_score: -0.2 }], summary: "", key_topics: [] })
      .most_relevant_segments[0].relevance_score).toBe(0);
    expect(parseCandidateRanking({ ranking: [{ candidate_id: -1, score: 140 }, { candidate_id: 2, score: -5 }] })).toEqual({
      ranking: [
        { candidate_id: -1, score: 100, reason: "" },
        { candidate_id: 2, score: 0, reason: "" },
      ],
    });
  });

  it("rejects an unknown hook type", () => {
    expect(() =>
      parseTranscriptAnalysis({
        most_relevant_segments: [{ start_time: "0:00", end_time: "0:20", text: "t", virality: { hook_type: "meme" } }],
        summary: "",
        key_topics: [],
      }),
    ).toThrow(OutputValidationError);
  });

  it("round-trips a cached selectClips result", async () => {
    const output = {
      ...ANALYSIS,
      most_relevant_segments: [
        { ...ANALYSIS.most_relevant_segments[0], relevance_score: 0.9, virality: { hook_score: 25, engagement_score: 22, value_score: 20, shareability_score: 23 } },
      ],
    };
    const result = await select(fakeFetch(() => messageResponse(output)).fetch);
    expect(result.segments[0].virality.total_score).toBe(90);
    expect(parseSelectClipsResult(JSON.parse(JSON.stringify(result)))).toEqual(result);
    expect(() => parseSelectClipsResult(output)).toThrow(OutputValidationError);
  });
});

describe("maskSecret", () => {
  it("never returns the key", () => {
    expect(maskSecret(TEST_KEY)).toBe("sk-ant-…a1b2");
    expect(maskSecret(null)).toBeNull();
    expect(maskSecret("short-secret")).not.toContain("secret");
    expect(maskSecret("short-secret")).toBe("…et");
    expect(maskSecret("abcd")).toBe("…");
    expect(maskSecret("   ")).toBe("…");
    expect(maskSecret("AIzaSyExampleKey123456")).toBe("AIz…3456");
  });
});

const modelsPage = {
  data: [{ type: "model", id: "claude-opus-5", display_name: "Claude Opus 5", created_at: "2026-01-01T00:00:00Z" }],
  has_more: false,
  first_id: "claude-opus-5",
  last_id: "claude-opus-5",
};

describe("testAnthropicConnection", () => {
  it("reports a missing key without a request", async () => {
    const fake = fakeFetch(() => jsonResponse(200, modelsPage));
    const result = await testAnthropicConnection("  ", null, { fetch: fake.fetch });
    expect(result).toEqual({ ok: false, status: "missing_key", message: "No Anthropic API key is configured.", models: [] });
    expect(fake.requests).toHaveLength(0);
  });

  it("lists the models", async () => {
    const fake = fakeFetch(() => jsonResponse(200, modelsPage));
    const result = await testAnthropicConnection(TEST_KEY, "claude-opus-5", { fetch: fake.fetch });
    expect(result).toEqual({
      ok: true,
      status: "ok",
      message: "Connected to Anthropic.",
      models: [{ id: "claude-opus-5", display_name: "Claude Opus 5" }],
    });
    expect(fake.requests).toHaveLength(1);
    expect(fake.requests[0].url.pathname).toBe("/v1/models");
    expect(fake.requests[0].url.searchParams.get("limit")).toBe("100");
  });

  it.each([
    [401, "invalid_key", "Anthropic rejected this API key. Check that it was copied in full and is still active."],
    [403, "permission_denied", "This API key does not have permission to use the Models API."],
    [429, "rate_limited", "Anthropic is rate limiting this key. Wait a moment and try again."],
    [500, "api_error", "Anthropic returned HTTP 500. Try again shortly."],
    [404, "api_error", "Anthropic returned HTTP 404. Try again shortly."],
  ])("maps HTTP %i to %s", async (status, expected, message) => {
    const fake = fakeFetch(() => errorResponse(status, "nope"));
    const result = await testAnthropicConnection(TEST_KEY, null, { fetch: fake.fetch });
    expect(result).toEqual({ ok: false, status: expected, message, models: [] });
    expect(result.message).not.toContain(TEST_KEY);
    expect(fake.requests).toHaveLength(1);
  });

  it("reports an unreachable API", async () => {
    const fake = fakeFetch(() => {
      throw new TypeError("no route");
    });
    const result = await testAnthropicConnection(TEST_KEY, null, { fetch: fake.fetch });
    expect(result.status).toBe("connection_failed");
    expect(result.message).toBe("Could not reach api.anthropic.com from the server. Check its network access.");
  });

  it("reports an unknown model", async () => {
    const fake = fakeFetch((request) =>
      request.url.pathname.endsWith("/models")
        ? jsonResponse(200, modelsPage)
        : jsonResponse(404, { type: "error", error: { type: "not_found_error", message: "model" } }),
    );
    const result = await testAnthropicConnection(TEST_KEY, "claude-nonexistent", { fetch: fake.fetch });
    expect(result).toMatchObject({
      ok: false,
      status: "model_not_found",
      message: "The key works, but model 'claude-nonexistent' is not available to it.",
      models: [{ id: "claude-opus-5", display_name: "Claude Opus 5" }],
    });
    expect(fake.requests[1].url.pathname).toBe("/v1/models/claude-nonexistent");
  });

  it("accepts an alias the list does not show", async () => {
    const fake = fakeFetch((request) =>
      request.url.pathname.endsWith("/models")
        ? jsonResponse(200, modelsPage)
        : jsonResponse(200, { type: "model", id: "claude-opus-5-20260101", display_name: "Claude Opus 5", created_at: "2026-01-01T00:00:00Z" }),
    );
    const result = await testAnthropicConnection(TEST_KEY, "claude-opus-5-latest", { fetch: fake.fetch });
    expect(result.status).toBe("ok");
    expect(fake.requests).toHaveLength(2);
  });
});
