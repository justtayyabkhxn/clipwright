"use client";

import { useEffect, useState } from "react";

/** `GET /api/ai/provider`. `configured` = `llm_configured` (Claude key) && `transcription_configured` (AssemblyAI key). */
export type AiProvider = {
  provider: string;
  model: string | null;
  configured: boolean;
  llm_configured: boolean;
  transcription_configured: boolean;
};

const CLAUDE_NAMES: Record<string, string> = {
  "claude-opus-5": "Claude Opus 5",
  "claude-sonnet-5": "Claude Sonnet 5",
  "claude-haiku-4-5": "Claude Haiku 4.5",
  "claude-fable-5-1": "Claude Fable 5.1",
};

/** Suggested models before a connection test returns the live list. */
export const SUGGESTED_CLAUDE_MODELS = Object.entries(CLAUDE_NAMES)
  .filter(([id]) => id !== "claude-fable-5-1")
  .map(([id, display_name]) => ({ id, display_name }));

export function modelLabel(provider: AiProvider | null): string | null {
  if (!provider?.model) return null;
  if (provider.provider === "anthropic") return CLAUDE_NAMES[provider.model] ?? provider.model;
  return provider.model;
}

let cached: Promise<AiProvider | null> | null = null;

export function fetchAiProvider(refresh = false): Promise<AiProvider | null> {
  if (!cached || refresh) {
    cached = fetch("/api/ai/provider", { cache: "no-store" })
      .then((response) => (response.ok ? (response.json() as Promise<AiProvider>) : null))
      .catch(() => null);
  }
  return cached;
}

/** Active LLM provider (no secrets), shared across the shell and pages. */
export function useAiProvider(enabled = true): AiProvider | null {
  const [provider, setProvider] = useState<AiProvider | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    void fetchAiProvider().then((value) => alive && setProvider(value));
    const onChange = () => void fetchAiProvider(true).then((value) => alive && setProvider(value));
    window.addEventListener("ai-provider-changed", onChange);
    return () => { alive = false; window.removeEventListener("ai-provider-changed", onChange); };
  }, [enabled]);
  return provider;
}
