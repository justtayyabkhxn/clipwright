// A fetch stand-in for the Anthropic SDK in tests: records every request and answers from a handler.

export type CapturedRequest = {
  url: URL;
  method: string;
  headers: Headers;
  // Parsed JSON request body.
  body: any; // eslint-disable-line @typescript-eslint/no-explicit-any
  signal: AbortSignal | undefined;
};

type Handler = (request: CapturedRequest, index: number) => Response | Promise<Response>;

export function fakeFetch(handler: Handler) {
  const requests: CapturedRequest[] = [];
  const fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const signal = init?.signal ?? undefined;
    const request: CapturedRequest = {
      url: new URL(String(input instanceof Request ? input.url : input)),
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers),
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
      signal,
    };
    const index = requests.push(request) - 1;
    return new Promise<Response>((resolve, reject) => {
      if (signal?.aborted) return reject(signal.reason);
      signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      Promise.resolve()
        .then(() => handler(request, index))
        .then(resolve, reject);
    });
  }) as typeof globalThis.fetch;
  return { fetch, requests };
}

export const jsonResponse = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

export const errorResponse = (status: number, message = "error") =>
  jsonResponse(status, { type: "error", error: { type: "api_error", message } });

/** A Messages API response whose text block is `output` (JSON-encoded unless already a string). */
export function messageResponse(
  output: unknown,
  { model = "claude-opus-5", stopReason = "end_turn", content }: { model?: string; stopReason?: string; content?: unknown[] } = {},
) {
  const text = typeof output === "string" ? output : JSON.stringify(output);
  return jsonResponse(200, {
    id: "msg_test",
    type: "message",
    role: "assistant",
    model,
    content: content ?? [{ type: "text", text }],
    stop_reason: stopReason,
    stop_sequence: null,
    usage: { input_tokens: 100, output_tokens: 100 },
  });
}

/** Never answers; rejects only when the request is aborted. */
export const hang = () => new Promise<Response>(() => {});

export const isRerankRequest = (request: CapturedRequest) =>
  Boolean(request.body?.output_config?.format?.schema?.properties?.ranking);

/** The first transcript line of an analysis prompt. */
export const firstTranscriptLine = (request: CapturedRequest) =>
  String(request.body.messages[0].content).split("Transcript:")[1].split("\n")[1];
