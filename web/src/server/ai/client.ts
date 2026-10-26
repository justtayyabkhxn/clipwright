// One structured Claude call (pydantic-ai NativeOutput equivalent) plus the transient-retry budget
// of ai.py _run_transcript_analysis.

import { setTimeout as sleep } from "node:timers/promises";
import Anthropic, { APIConnectionError, APIError } from "@anthropic-ai/sdk";
import { OutputValidationError, type ValidationIssue } from "./schemas";

export const CLAUDE_SERVER_FALLBACK_MODELS = new Set(["claude-opus-5", "claude-fable-5-1"]);
export const SERVER_FALLBACK_BETA = "server-side-fallback-2026-07-01";
// Thinking tokens count against max_tokens; 16k leaves room for adaptive thinking plus a full segment list.
export const MAX_TOKENS = 16000;
export const MAX_OUTPUT_RETRIES = 2;
export const TRANSCRIPT_ANALYSIS_MAX_ATTEMPTS = 3;

export const UNAVAILABLE_MESSAGE =
  "The AI analysis service is temporarily unavailable after several attempts. Please try again shortly.";
export const TOO_LONG_MESSAGE = "The AI analysis service took too long to respond. Please try again shortly.";
// Failures for an answer with no text (pydantic-ai fails these without retrying).
export const TOKEN_LIMIT_MESSAGE = `Claude reached its output limit (${MAX_TOKENS} tokens) before returning any clips. Try again, or choose a shorter clip length.`;
export const REFUSAL_MESSAGE = "Content filter triggered. Finish reason: 'refusal'";

/** Backoff seams, replaced in tests. */
export const retryTiming = {
  sleep: (ms: number, signal: AbortSignal) => sleep(ms, undefined, { signal }),
  jitter: () => Math.random(),
};

export function createClaudeClient(apiKey: string, fetch?: typeof globalThis.fetch): Anthropic {
  // Retries are ours (runWithRetry), so they stay inside the wall-clock budget.
  return new Anthropic({ apiKey, maxRetries: 0, fetch });
}

/** Provider overload and transport failures. Never 400/401/403 or invalid output. */
export function isTransientError(error: unknown): boolean {
  if (error instanceof APIConnectionError) return true;
  if (!(error instanceof APIError) || typeof error.status !== "number") return false;
  return error.status === 408 || error.status === 409 || error.status === 429 || error.status >= 500;
}

/** An abort controller that follows `signal` and fires `timeoutReason` after `timeoutMs`. */
export function linkedController(signal: AbortSignal | undefined, timeoutMs: number, timeoutReason: unknown) {
  const controller = new AbortController();
  const follow = () => controller.abort(signal?.reason);
  if (signal?.aborted) follow();
  signal?.addEventListener("abort", follow, { once: true });
  const timer = setTimeout(() => controller.abort(timeoutReason), timeoutMs);
  return {
    signal: controller.signal,
    dispose() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", follow);
    },
  };
}

/**
 * Retry temporary failures within one overall budget. Cancellation of `signal` passes straight
 * through; errors never chain provider bodies, which may contain transcript data.
 */
export async function runWithRetry<T>(
  run: (signal: AbortSignal) => Promise<T>,
  { timeoutMs, signal }: { timeoutMs: number; signal?: AbortSignal },
): Promise<T> {
  const budget = linkedController(signal, timeoutMs, new Error(TOO_LONG_MESSAGE));
  const throwIfStopped = () => {
    if (signal?.aborted) throw signal.reason;
    if (budget.signal.aborted) {
      console.error(`AI analysis exceeded the ${timeoutMs / 1000}s time budget`);
      throw new Error(TOO_LONG_MESSAGE);
    }
  };
  try {
    for (let attempt = 1; ; attempt++) {
      try {
        return await run(budget.signal);
      } catch (error) {
        throwIfStopped();
        if (!isTransientError(error)) throw error;
        const status = error instanceof APIError ? error.status : undefined;
        if (attempt === TRANSCRIPT_ANALYSIS_MAX_ATTEMPTS) {
          console.error(`AI analysis unavailable after ${attempt} attempts (${(error as Error).name}, HTTP status ${status})`);
          throw new Error(UNAVAILABLE_MESSAGE);
        }
        const delay = 5000 * 2 ** (attempt - 1) + retryTiming.jitter() * 1000;
        console.warn(
          `Temporary AI analysis failure (${(error as Error).name}, HTTP status ${status}); retrying attempt ${attempt + 1}/${TRANSCRIPT_ANALYSIS_MAX_ATTEMPTS} in ${(delay / 1000).toFixed(1)}s`,
        );
        try {
          await retryTiming.sleep(delay, budget.signal);
        } catch (sleepError) {
          throwIfStopped();
          throw sleepError;
        }
      }
    }
  } finally {
    budget.dispose();
  }
}

/** The output failed after every repair attempt (pydantic-ai UnexpectedModelBehavior). */
export class OutputRetriesExceededError extends Error {
  constructor() {
    super(`Exceeded maximum output retries (${MAX_OUTPUT_RETRIES})`);
  }
}

type Message = { role: "user" | "assistant"; content: string };

/** pydantic-ai's NativeOutput retry prompt: the error list, then a request to fix it. */
function repairPrompt(issues: ValidationIssue[]): string {
  const details = issues.map(({ input, ...issue }) => (issue.loc.length > 1 ? { ...issue, input } : issue));
  const plural = issues.length === 1 ? "" : "s";
  return `${issues.length} validation error${plural}:\n\`\`\`json\n${JSON.stringify(details, null, 2)}\n\`\`\`\n\nFix the errors and try again.`;
}

/**
 * Ask Claude for JSON matching `schema` and parse it with `parse`. Invalid JSON or a schema
 * failure is sent back as a user turn, at most MAX_OUTPUT_RETRIES times. A refusal or a
 * token-limit stop with no text fails at once (resending would hit it again); with partial
 * text, or an empty answer, the request is resubmitted unchanged and uses the same budget.
 */
export async function requestStructured<T>({
  client,
  model,
  system,
  prompt,
  schema,
  parse,
  signal,
}: {
  client: Anthropic;
  model: string;
  system: string;
  prompt: string;
  schema: Record<string, unknown>;
  parse: (value: unknown) => T;
  signal?: AbortSignal;
}): Promise<T> {
  const messages: Message[] = [{ role: "user", content: prompt }];
  for (let retries = 0; ; retries++) {
    const params = {
      model,
      max_tokens: MAX_TOKENS,
      system,
      messages: [...messages],
      output_config: { format: { type: "json_schema" as const, schema } },
    };
    // A safety-classifier refusal is retried server-side on a fallback model instead of failing the task.
    const response = CLAUDE_SERVER_FALLBACK_MODELS.has(model)
      ? await client.beta.messages.create(
          { ...params, betas: [SERVER_FALLBACK_BETA], fallbacks: "default" },
          { signal },
        )
      : await client.messages.create(params, { signal });

    const text = response.content
      .flatMap((block) => (block.type === "text" ? [block.text] : []))
      .join("");
    const stop = response.stop_reason;
    if (!text.trim()) {
      if (stop === "max_tokens" || stop === "model_context_window_exceeded") throw new Error(TOKEN_LIMIT_MESSAGE);
      if (stop === "refusal") throw new Error(REFUSAL_MESSAGE);
    }
    let issues: ValidationIssue[] | null = null;
    if (stop !== "refusal" && stop !== "max_tokens" && text.trim()) {
      try {
        return parse(JSON.parse(text));
      } catch (error) {
        if (error instanceof SyntaxError) issues = [{ type: "json_invalid", loc: [], msg: `Invalid JSON: ${error.message}` }];
        else if (error instanceof OutputValidationError) issues = error.issues;
        else throw error;
      }
    }
    if (retries >= MAX_OUTPUT_RETRIES) throw new OutputRetriesExceededError();
    if (issues) messages.push({ role: "assistant", content: text }, { role: "user", content: repairPrompt(issues) });
  }
}
