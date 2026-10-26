// Output models of the clip-selection and rerank calls.
//
// The JSON schemas are exactly what pydantic-ai sent as `output_config.format.schema`
// (`anthropic.transform_schema` moves min/max/default into the descriptions, so only the
// listed `required` fields are guaranteed). The parsers apply every pydantic default and
// alias, and clamp out-of-range scores instead of rejecting them.
// ponytail: hand-written validators because zod is not a direct dependency of web/ (it only sits in
// the pnpm store); port them to zod schemas once package.json lists it.

export const HOOK_TYPES = ["question", "statement", "statistic", "story", "contrast", "none"] as const;
export type HookType = (typeof HOOK_TYPES)[number];

export type ViralityAnalysis = {
  hook_score: number;
  engagement_score: number;
  value_score: number;
  shareability_score: number;
  total_score: number;
  hook_type: HookType | null;
  virality_reasoning: string;
};

export type TranscriptSegment = {
  start_time: string;
  end_time: string;
  text: string;
  relevance_score: number;
  reasoning: string;
  virality: ViralityAnalysis;
  hook_title: string | null;
  hook_start_time: string | null;
  hook_end_time: string | null;
};

export type TranscriptAnalysis = {
  most_relevant_segments: TranscriptSegment[];
  summary: string;
  key_topics: string[];
};

/** What `selectClips` returns and the worker caches. */
export type SelectClipsResult = { segments: TranscriptSegment[]; summary: string; keyTopics: string[] };

export type RankedCandidate ={ candidate_id: number; score: number; reason: string };
export type CandidateRanking = { ranking: RankedCandidate[] };

const nullableString = (description: string) => ({
  anyOf: [{ type: "string" }, { type: "null" }],
  description,
});

export const TRANSCRIPT_ANALYSIS_SCHEMA = {
  $defs: {
    TranscriptSegment: {
      type: "object",
      description: "Represents a relevant segment of transcript with precise timing and virality analysis.",
      properties: {
        start_time: { type: "string", description: "Start timestamp in MM:SS format" },
        end_time: { type: "string", description: "End timestamp in MM:SS format" },
        text: {
          type: "string",
          description:
            "Transcript text taken only from the selected timestamp range. Keep it verbatim or near-verbatim, and do not paraphrase or merge non-contiguous lines.",
        },
        relevance_score: {
          type: "number",
          description: "Relevance score from 0.0 to 1.0\n\n{default: 0.75, maximum: 1.0, minimum: 0.0}",
        },
        reasoning: {
          type: "string",
          description:
            "Brief factual explanation of why this exact segment works as a clip. Base it only on the provided transcript content.\n\n{default: Selected by the AI model as a clip candidate.}",
        },
        virality: { $ref: "#/$defs/ViralityAnalysis" },
        hook_title: nullableString(
          "Short punchy on-screen title for the clip (3-9 words). Grounded in the segment content, no hashtags, no emojis, no surrounding quotes.\n\n{default: None}",
        ),
        hook_start_time: nullableString(
          "Optional MM:SS start of the single strongest 2-5 second line inside the segment, replayed as a cold-open teaser. Null when the segment already opens on its best line.\n\n{default: None}",
        ),
        hook_end_time: nullableString(
          "Optional MM:SS end of that hook line (null with hook_start_time).\n\n{default: None}",
        ),
      },
      additionalProperties: false,
      required: ["start_time", "end_time", "text"],
    },
    ViralityAnalysis: {
      type: "object",
      description: "Detailed virality breakdown for a segment.",
      properties: {
        hook_score: {
          type: "integer",
          description: "How strong is the opening hook (0-25)\n\n{default: 15, maximum: 25, minimum: 0}",
        },
        engagement_score: {
          type: "integer",
          description: "How engaging/entertaining is the content (0-25)\n\n{default: 15, maximum: 25, minimum: 0}",
        },
        value_score: {
          type: "integer",
          description: "Educational/informational value (0-25)\n\n{default: 15, maximum: 25, minimum: 0}",
        },
        shareability_score: {
          type: "integer",
          description: "Likelihood of being shared (0-25)\n\n{default: 15, maximum: 25, minimum: 0}",
        },
        total_score: {
          type: "integer",
          description: "Combined virality score (0-100)\n\n{default: 60, maximum: 100, minimum: 0}",
        },
        hook_type: {
          anyOf: [{ type: "string", enum: [...HOOK_TYPES] }, { type: "null" }],
          description: "Type of hook: question, statement, statistic, story, contrast, or none\n\n{default: none}",
        },
        virality_reasoning: {
          type: "string",
          description:
            "Explanation of the virality score\n\n{default: The model did not provide a detailed virality breakdown.}",
        },
      },
      additionalProperties: false,
    },
  },
  type: "object",
  properties: {
    most_relevant_segments: { type: "array", items: { $ref: "#/$defs/TranscriptSegment" } },
    summary: { type: "string", description: "Brief summary of the video content" },
    key_topics: { type: "array", description: "List of main topics discussed", items: { type: "string" } },
  },
  additionalProperties: false,
  required: ["most_relevant_segments", "summary", "key_topics"],
};

export const CANDIDATE_RANKING_SCHEMA = {
  $defs: {
    RankedCandidate: {
      type: "object",
      description: "One candidate's place in the comparative rerank.",
      properties: {
        candidate_id: { type: "integer", description: "The id of the candidate being ranked" },
        score: {
          type: "integer",
          description:
            "Comparative virality score (0-100) relative to the other candidates\n\n{maximum: 100, minimum: 0}",
        },
        reason: {
          type: "string",
          description: "One short sentence on why it ranks here versus the others\n\n{default: }",
        },
      },
      additionalProperties: false,
      required: ["candidate_id", "score"],
    },
  },
  type: "object",
  properties: {
    ranking: {
      type: "array",
      description: "Every candidate, ordered from strongest to weakest clip",
      items: { $ref: "#/$defs/RankedCandidate" },
    },
  },
  additionalProperties: false,
  required: ["ranking"],
};

export type ValidationIssue = { type: string; loc: (string | number)[]; msg: string; input?: unknown };

/** The model output did not match the schema; `issues` mirror pydantic's error list. */
export class OutputValidationError extends Error {
  constructor(readonly issues: ValidationIssue[]) {
    super(`${issues.length} validation error${issues.length === 1 ? "" : "s"}`);
  }
}

type Loc = (string | number)[];
type Check<T> = (value: unknown, loc: Loc, issues: ValidationIssue[]) => T;

// A failed check records an issue and returns a placeholder; the parse throws before it escapes.
function fail(issues: ValidationIssue[], type: string, loc: Loc, msg: string, input: unknown): never {
  issues.push({ type, loc, msg, input });
  return undefined as never;
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

const string: Check<string> = (value, loc, issues) =>
  typeof value === "string" ? value : fail(issues, "string_type", loc, "Input should be a valid string", value);

const nullable =
  <T>(check: Check<T>): Check<T | null> =>
  (value, loc, issues) =>
    value === null ? null : check(value, loc, issues);

const integer: Check<number> = (value, loc, issues) =>
  typeof value === "number" && Number.isInteger(value)
    ? value
    : fail(issues, "int_type", loc, "Input should be a valid integer", value);

const score =
  (max: number): Check<number> =>
  (value, loc, issues) =>
    clamp(integer(value, loc, issues), 0, max);

// Models sometimes answer on a 0-100 scale; values in (1, 100] are read as percentages.
const relevance: Check<number> = (value, loc, issues) => {
  if (typeof value !== "number") return fail(issues, "float_type", loc, "Input should be a valid number", value);
  return clamp(value > 1 && value <= 100 ? value / 100 : value, 0, 1);
};

const hookType: Check<HookType | null> = (value, loc, issues) =>
  value === null || HOOK_TYPES.includes(value as HookType)
    ? (value as HookType | null)
    : fail(
        issues,
        "literal_error",
        loc,
        "Input should be 'question', 'statement', 'statistic', 'story', 'contrast' or 'none'",
        value,
      );

const list =
  <T>(item: Check<T>): Check<T[]> =>
  (value, loc, issues) =>
    Array.isArray(value)
      ? value.map((entry, index) => item(entry, [...loc, index], issues))
      : fail(issues, "list_type", loc, "Input should be a valid list", value);

/** Read the first present key among `keys` (pydantic AliasChoices); a missing key uses `fallback`. */
function field<T>(
  obj: Record<string, unknown>,
  keys: string[],
  check: Check<T>,
  loc: Loc,
  issues: ValidationIssue[],
  fallback?: () => T,
): T {
  const key = keys.find((name) => Object.hasOwn(obj, name));
  if (key !== undefined) return check(obj[key], [...loc, key], issues);
  if (fallback) return fallback();
  return fail(issues, "missing", [...loc, keys[0]], "Field required", obj);
}

const model =
  <T>(read: (obj: Record<string, unknown>, loc: Loc, issues: ValidationIssue[]) => T): Check<T> =>
  (value, loc, issues) =>
    typeof value === "object" && value !== null && !Array.isArray(value)
      ? read(value as Record<string, unknown>, loc, issues)
      : fail(issues, "model_type", loc, "Input should be a valid dictionary or object to extract fields from", value);

export const defaultVirality = (): ViralityAnalysis => ({
  hook_score: 15,
  engagement_score: 15,
  value_score: 15,
  shareability_score: 15,
  total_score: 60,
  hook_type: "none",
  virality_reasoning: "The model did not provide a detailed virality breakdown.",
});

const virality = model<ViralityAnalysis>((obj, loc, issues) => {
  const defaults = defaultVirality();
  const subscore = (name: "hook_score" | "engagement_score" | "value_score" | "shareability_score") =>
    field(obj, [name], score(25), loc, issues, () => defaults[name]);
  return {
    hook_score: subscore("hook_score"),
    engagement_score: subscore("engagement_score"),
    value_score: subscore("value_score"),
    shareability_score: subscore("shareability_score"),
    total_score: field(obj, ["total_score"], score(100), loc, issues, () => defaults.total_score),
    hook_type: field(obj, ["hook_type"], hookType, loc, issues, () => defaults.hook_type),
    virality_reasoning: field(obj, ["virality_reasoning"], string, loc, issues, () => defaults.virality_reasoning),
  };
});

const segment = model<TranscriptSegment>((obj, loc, issues) => ({
  start_time: field(obj, ["start_time"], string, loc, issues),
  end_time: field(obj, ["end_time"], string, loc, issues),
  text: field(obj, ["text", "segment"], string, loc, issues),
  relevance_score: field(obj, ["relevance_score"], relevance, loc, issues, () => 0.75),
  reasoning: field(obj, ["reasoning"], string, loc, issues, () => "Selected by the AI model as a clip candidate."),
  virality: field(obj, ["virality"], virality, loc, issues, defaultVirality),
  hook_title: field(obj, ["hook_title", "title", "headline"], nullable(string), loc, issues, () => null),
  hook_start_time: field(obj, ["hook_start_time"], nullable(string), loc, issues, () => null),
  hook_end_time: field(obj, ["hook_end_time"], nullable(string), loc, issues, () => null),
}));

const analysis = model<TranscriptAnalysis>((obj, loc, issues) => ({
  most_relevant_segments: field(obj, ["most_relevant_segments"], list(segment), loc, issues),
  summary: field(obj, ["summary"], string, loc, issues),
  key_topics: field(obj, ["key_topics"], list(string), loc, issues),
}));

const ranking = model<CandidateRanking>((obj, loc, issues) => ({
  ranking: field(
    obj,
    ["ranking"],
    list(
      model<RankedCandidate>((item, itemLoc, itemIssues) => ({
        candidate_id: field(item, ["candidate_id"], integer, itemLoc, itemIssues),
        score: field(item, ["score"], score(100), itemLoc, itemIssues),
        reason: field(item, ["reason"], string, itemLoc, itemIssues, () => ""),
      })),
    ),
    loc,
    issues,
  ),
}));

function parseWith<T>(check: Check<T>, value: unknown): T {
  const issues: ValidationIssue[] = [];
  const result = check(value, [], issues);
  if (issues.length) throw new OutputValidationError(issues);
  return result;
}

const selectClipsResult = model<SelectClipsResult>((obj, loc, issues) => ({
  segments: field(obj, ["segments"], list(segment), loc, issues),
  summary: field(obj, ["summary"], string, loc, issues),
  keyTopics: field(obj, ["keyTopics"], list(string), loc, issues),
}));

/** Validate Claude's clip-selection output. Unknown keys are ignored. */
export const parseTranscriptAnalysis = (value: unknown) => parseWith(analysis, value);
/** Read back a cached `selectClips` result (its JSON); a valid result round-trips unchanged. */
export const parseSelectClipsResult = (value: unknown) => parseWith(selectClipsResult, value);
export const parseCandidateRanking = (value: unknown) => parseWith(ranking, value);
