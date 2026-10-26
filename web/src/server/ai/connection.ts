// Claude connection check for the settings UI (port of llm_connection.py). It uses the Models API,
// which validates the key and the model id without generating tokens, so a test never costs anything.

import Anthropic, {
  APIConnectionError,
  APIError,
  AuthenticationError,
  NotFoundError,
  PermissionDeniedError,
  RateLimitError,
} from "@anthropic-ai/sdk";

export const DEFAULT_CLAUDE_MODEL = "claude-opus-5";
const CONNECTION_TIMEOUT_MS = 15_000;

export type ConnectionStatus =
  | "ok"
  | "missing_key"
  | "invalid_key"
  | "permission_denied"
  | "model_not_found"
  | "rate_limited"
  | "connection_failed"
  | "api_error";

export type ConnectionResult = {
  ok: boolean;
  status: ConnectionStatus;
  message: string;
  models: { id: string; display_name: string }[];
};

/** A display hint such as `sk-ant-…a1b2`; never the full value. */
export function maskSecret(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (trimmed.length <= 12) return trimmed.length > 4 ? `…${trimmed.slice(-2)}` : "…";
  const prefix = trimmed.startsWith("sk-ant-") ? "sk-ant-" : trimmed.slice(0, 3);
  return `${prefix}…${trimmed.slice(-4)}`;
}

const result = (status: ConnectionStatus, message: string, models: ConnectionResult["models"] = []): ConnectionResult => ({
  ok: status === "ok",
  status,
  message,
  models,
});

/** Validate an Anthropic API key (and optionally a model id). Messages never include the key. */
export async function testAnthropicConnection(
  apiKey: string | null | undefined,
  model?: string | null,
  { fetch }: { fetch?: typeof globalThis.fetch } = {},
): Promise<ConnectionResult> {
  const key = (apiKey ?? "").trim();
  if (!key) return result("missing_key", "No Anthropic API key is configured.");

  const client = new Anthropic({ apiKey: key, maxRetries: 0, timeout: CONNECTION_TIMEOUT_MS, fetch });
  const wanted = (model ?? "").trim();
  try {
    const page = await client.models.list({ limit: 100 });
    const models = page.data.map((item) => ({ id: item.id, display_name: item.display_name || item.id }));
    if (wanted && !models.some((item) => item.id === wanted)) {
      // Aliases are not always listed; ask for the model directly.
      try {
        await client.models.retrieve(wanted);
      } catch (error) {
        if (error instanceof NotFoundError) {
          return result("model_not_found", `The key works, but model '${wanted}' is not available to it.`, models);
        }
        throw error;
      }
    }
    return result("ok", "Connected to Anthropic.", models);
  } catch (error) {
    if (error instanceof AuthenticationError) {
      return result("invalid_key", "Anthropic rejected this API key. Check that it was copied in full and is still active.");
    }
    if (error instanceof PermissionDeniedError) {
      return result("permission_denied", "This API key does not have permission to use the Models API.");
    }
    if (error instanceof RateLimitError) {
      return result("rate_limited", "Anthropic is rate limiting this key. Wait a moment and try again.");
    }
    if (error instanceof APIConnectionError) {
      return result("connection_failed", "Could not reach api.anthropic.com from the server. Check its network access.");
    }
    if (error instanceof APIError && typeof error.status === "number") {
      return result("api_error", `Anthropic returned HTTP ${error.status}. Try again shortly.`);
    }
    throw error;
  }
}
