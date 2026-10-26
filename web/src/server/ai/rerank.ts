// One comparative call over every candidate so scores from different windows are comparable.

import type Anthropic from "@anthropic-ai/sdk";
import { requestStructured, runWithRetry } from "./client";
import { buildCandidateRerankPrompt, CANDIDATE_RERANK_SYSTEM_PROMPT } from "./prompts";
import {
  CANDIDATE_RANKING_SCHEMA,
  parseCandidateRanking,
  type CandidateRanking,
  type TranscriptSegment,
  type ViralityAnalysis,
} from "./schemas";

export const RERANK_TIMEOUT_SECONDS = 240;

/** Set a new total while keeping the subscores' proportions and 0-25 bounds. */
export function rescaleVirality(virality: ViralityAnalysis, newTotal: number): void {
  const total = Math.max(0, Math.min(100, Math.trunc(newTotal)));
  const subscores = [virality.hook_score, virality.engagement_score, virality.value_score, virality.shareability_score];
  const oldTotal = subscores.reduce((sum, value) => sum + value, 0);
  const scaled = oldTotal <= 0 ? subscores.map(() => total / 4) : subscores.map((score) => (score * total) / oldTotal);
  const rounded = scaled.map((value) => Math.min(25, Math.max(0, Math.trunc(value))));
  let remainder = total - rounded.reduce((sum, value) => sum + value, 0);
  const fraction = (i: number) => scaled[i] - Math.trunc(scaled[i]);
  const byFraction = [0, 1, 2, 3].sort((a, b) => fraction(b) - fraction(a));
  while (remainder > 0) {
    let progressed = false;
    for (const index of byFraction) {
      if (remainder <= 0) break;
      if (rounded[index] < 25) {
        rounded[index] += 1;
        remainder -= 1;
        progressed = true;
      }
    }
    if (!progressed) break;
  }
  [virality.hook_score, virality.engagement_score, virality.value_score, virality.shareability_score] = rounded;
  virality.total_score = rounded.reduce((sum, value) => sum + value, 0);
}

/**
 * Reorder candidates by the rerank and give them its calibrated scores, clamped to be
 * non-increasing down the list. Candidates the reranker skipped follow in first-pass order.
 */
export function applyCandidateRanking(candidates: TranscriptSegment[], ranking: CandidateRanking): TranscriptSegment[] {
  const ordered: [TranscriptSegment, number][] = [];
  const seen = new Set<number>();
  for (const { candidate_id: id, score } of ranking.ranking) {
    if (seen.has(id) || id < 0 || id >= candidates.length) continue;
    seen.add(id);
    ordered.push([candidates[id], score]);
  }
  if (!ordered.length) throw new Error("Rerank returned no usable candidate ids");

  const reranked: TranscriptSegment[] = [];
  let ceiling = 100;
  for (const [segment, score] of ordered) {
    ceiling = Math.min(score, ceiling);
    rescaleVirality(segment.virality, ceiling);
    reranked.push(segment);
  }
  candidates.forEach((segment, index) => {
    if (seen.has(index)) return;
    ceiling = Math.min(segment.virality.total_score, ceiling);
    rescaleVirality(segment.virality, ceiling);
    reranked.push(segment);
  });
  return reranked;
}

/** Compare all candidates in one call; keep the first-pass order if that fails (never throws, except on cancellation). */
export async function rerankCandidates(
  candidates: TranscriptSegment[],
  { client, model, signal }: { client: Anthropic; model: string; signal?: AbortSignal },
): Promise<TranscriptSegment[]> {
  if (candidates.length < 2) return candidates;
  try {
    const ranking = await runWithRetry(
      (budget) =>
        requestStructured({
          client,
          model,
          system: CANDIDATE_RERANK_SYSTEM_PROMPT,
          prompt: buildCandidateRerankPrompt(candidates),
          schema: CANDIDATE_RANKING_SCHEMA,
          parse: parseCandidateRanking,
          signal: budget,
        }),
      { timeoutMs: RERANK_TIMEOUT_SECONDS * 1000, signal },
    );
    return applyCandidateRanking(candidates, ranking);
  } catch (error) {
    if (signal?.aborted) throw signal.reason;
    // Do not log the error text: provider bodies may contain transcript data.
    console.warn(`Candidate rerank failed (${(error as Error)?.name}); keeping first-pass order`);
    return candidates;
  }
}
