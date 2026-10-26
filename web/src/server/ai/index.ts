// Claude clip selection: a port of ai.get_most_relevant_parts_by_transcript (DESIGN §8).

import type { ClipLength } from "./clip-duration";
import { createClaudeClient, linkedController, requestStructured, runWithRetry } from "./client";
import { buildTranscriptAnalysisPrompt, buildTranscriptSystemPrompt } from "./prompts";
import { rerankCandidates } from "./rerank";
import {
  parseTranscriptAnalysis,
  TRANSCRIPT_ANALYSIS_SCHEMA,
  type SelectClipsResult,
  type TranscriptAnalysis,
} from "./schemas";
import { parseTranscriptLines, parseTranscriptSpans, pyStrip } from "./transcript";
import { validateSegments } from "./validate";
import {
  dedupeOverlappingSegments,
  filterClipSignalsForWindow,
  maxFinalClipsForDuration,
  splitTranscriptIntoWindows,
  type TranscriptWindow,
} from "./windows";

export { CLIP_DURATIONS, clipDuration, normalizeClipLength, validateClipLength, type ClipLength } from "./clip-duration";
export { maskSecret, testAnthropicConnection, type ConnectionResult } from "./connection";
export {
  parseSelectClipsResult,
  parseTranscriptAnalysis,
  type SelectClipsResult,
  type TranscriptAnalysis,
  type TranscriptSegment,
  type ViralityAnalysis,
} from "./schemas";

export const TRANSCRIPT_ANALYSIS_TIMEOUT_SECONDS = 600;
export const ANALYSIS_TOTAL_TIMEOUT_SECONDS = 1800;
export const ANALYSIS_WINDOW_CONCURRENCY = 3;

type Analyze = (prompt: string, signal: AbortSignal | undefined) => Promise<TranscriptAnalysis>;

/** Analyse windows with bounded concurrency. Raises the first window error only when no window succeeded. */
async function analyzeWindows(
  analyze: Analyze,
  windows: TranscriptWindow[],
  clipSignals: string | null | undefined,
  clipLength: ClipLength,
  signal: AbortSignal | undefined,
): Promise<TranscriptAnalysis[]> {
  const expired = new Error("analysis windows exceeded the total budget");
  const total = linkedController(signal, ANALYSIS_TOTAL_TIMEOUT_SECONDS * 1000, expired);
  // undefined = never started or still running when the total budget ran out.
  const outcomes: ({ analysis: TranscriptAnalysis } | { error: unknown } | undefined)[] = [];
  let next = 0;
  const worker = async () => {
    while (next < windows.length && !total.signal.aborted) {
      const index = next++;
      const window = windows[index];
      const prompt = buildTranscriptAnalysisPrompt({
        transcript: window.transcript,
        clipSignals: filterClipSignalsForWindow(clipSignals, window.start, window.end),
        window: [window.start, window.end],
        clipLength,
      });
      try {
        outcomes[index] = { analysis: await analyze(prompt, total.signal) };
      } catch (error) {
        if (error === expired || signal?.aborted) continue;
        console.warn(`Analysis window ${index + 1}/${windows.length} failed (${(error as Error)?.name})`);
        outcomes[index] = { error };
      }
    }
  };
  try {
    await Promise.all(Array.from({ length: Math.min(ANALYSIS_WINDOW_CONCURRENCY, windows.length) }, worker));
  } finally {
    total.dispose();
  }
  if (signal?.aborted) throw signal.reason;

  const analyses: TranscriptAnalysis[] = [];
  const errors: unknown[] = [];
  for (let index = 0; index < windows.length; index++) {
    const outcome = outcomes[index];
    if (!outcome) continue;
    if ("analysis" in outcome) analyses.push(outcome.analysis);
    else errors.push(outcome.error);
  }
  if (analyses.length < windows.length - errors.length) {
    console.warn(
      `${windows.length - analyses.length - errors.length} of ${windows.length} analysis windows exceeded the ${ANALYSIS_TOTAL_TIMEOUT_SECONDS}s budget`,
    );
  }
  if (!analyses.length) {
    if (errors.length) throw errors[0];
    throw new Error("The AI analysis service took too long to respond. Please try again shortly.");
  }
  return analyses;
}

function mergeKeyTopics(analyses: TranscriptAnalysis[], limit = 12): string[] {
  const topics: string[] = [];
  const seen = new Set<string>();
  for (const analysis of analyses) {
    for (const topic of analysis.key_topics) {
      const key = pyStrip(topic).toLowerCase();
      if (key && !seen.has(key)) {
        seen.add(key);
        topics.push(pyStrip(topic));
      }
    }
  }
  return topics.slice(0, limit);
}

/**
 * Pick the best clips in a formatted transcript. Short transcripts are analysed in one call;
 * long ones in overlapping windows, then deduplicated and reranked in one comparative call.
 * Failures become `Error("Transcript analysis failed: ...")`; aborting `signal` rejects with its reason.
 */
export async function selectClips({
  transcript,
  clipSignals = null,
  clipLength = "auto",
  apiKey,
  model,
  rerankModel,
  maxClips = 10,
  signal,
  fetch,
}: {
  transcript: string;
  clipSignals?: string | null;
  clipLength?: ClipLength;
  apiKey: string;
  model: string;
  /** Defaults to `model`. */
  rerankModel?: string | null;
  /** MAX_CLIPS. */
  maxClips?: number;
  signal?: AbortSignal;
  /** Custom fetch for the Anthropic client (tests). */
  fetch?: typeof globalThis.fetch;
}): Promise<SelectClipsResult> {
  try {
    if (!apiKey?.trim()) throw new Error("Add your Anthropic API key in Settings → AI before generating clips.");
    const client = createClaudeClient(apiKey.trim(), fetch);
    const system = buildTranscriptSystemPrompt(clipLength);
    const analyze: Analyze = (prompt, analyzeSignal) =>
      runWithRetry(
        (budget) =>
          requestStructured({
            client,
            model,
            system,
            prompt,
            schema: TRANSCRIPT_ANALYSIS_SCHEMA,
            parse: parseTranscriptAnalysis,
            signal: budget,
          }),
        { timeoutMs: TRANSCRIPT_ANALYSIS_TIMEOUT_SECONDS * 1000, signal: analyzeSignal },
      );

    const lines = parseTranscriptLines(transcript);
    const spans = parseTranscriptSpans(transcript);
    const windows = splitTranscriptIntoWindows(transcript);
    const analyses =
      windows.length === 1
        ? [await analyze(buildTranscriptAnalysisPrompt({ transcript, clipSignals, clipLength }), signal)]
        : await analyzeWindows(analyze, windows, clipSignals, clipLength, signal);

    // Best-first by virality then relevance, without near-duplicates; then compare across windows.
    let candidates = dedupeOverlappingSegments(
      analyses.flatMap((analysis) => validateSegments(analysis.most_relevant_segments, lines, spans, clipLength)),
    );
    if (windows.length > 1) candidates = await rerankCandidates(candidates, { client, model: rerankModel || model, signal });

    const sourceSeconds = lines.reduce((max, line) => Math.max(max, line.end_seconds), 0);
    return {
      segments: candidates.slice(0, maxFinalClipsForDuration(sourceSeconds, maxClips)),
      summary: analyses
        .filter((analysis) => analysis.summary)
        .map((analysis) => pyStrip(analysis.summary))
        .join(" "),
      keyTopics: mergeKeyTopics(analyses),
    };
  } catch (error) {
    if (signal?.aborted) throw signal.reason;
    throw new Error(`Transcript analysis failed: ${(error as Error)?.message ?? String(error)}`, { cause: error });
  }
}
