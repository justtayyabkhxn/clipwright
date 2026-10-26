import { handle, json } from "@/server/http";
import { getRuntimeSettings } from "@/server/settings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The active Claude model and which keys are present. Public, and never includes a secret. */
export const GET = handle(async () => {
  const settings = await getRuntimeSettings();
  const llmConfigured = Boolean(settings.anthropicApiKey);
  const transcriptionConfigured = Boolean(settings.assemblyAiApiKey);
  return json({
    provider: "anthropic",
    model: settings.claudeModel,
    configured: llmConfigured && transcriptionConfigured,
    llm_configured: llmConfigured,
    transcription_configured: transcriptionConfigured,
  });
});
