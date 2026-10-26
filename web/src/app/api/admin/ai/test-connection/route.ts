import { z } from "zod";
import { testAnthropicConnection } from "@/server/ai";
import { ApiError, handle, json, readJsonObject } from "@/server/http";
import { requireAdmin } from "@/server/session";
import { getRuntimeSettings } from "@/server/settings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ConnectionTestSchema = z.object({
  provider: z.string().default("anthropic"),
  // A key pasted into the form but not saved yet; empty tests the saved key.
  api_key: z.string().max(512).nullish(),
  model: z.string().max(200).nullish(),
});

/** Check a Claude key and model through the Models API, which costs nothing. The key is never echoed. */
export const POST = handle(async (request: Request) => {
  await requireAdmin(request);
  const body = ConnectionTestSchema.parse(await readJsonObject(request));
  if (body.provider !== "anthropic") throw new ApiError(400, "Only the anthropic provider can be tested here.");
  const apiKey = body.api_key?.trim() || (await getRuntimeSettings()).anthropicApiKey;
  return json(await testAnthropicConnection(apiKey, body.model));
});
