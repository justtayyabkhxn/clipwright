import type { ObjectId } from "mongodb";
import { z } from "zod";

export type TaskStatus = "queued" | "processing" | "completed" | "error" | "cancelled";
export type OutputFormat = "vertical" | "vertical_fit" | "vertical_pan" | "vertical_split" | "original";
export type ClipLength = "auto" | "short" | "medium" | "long";

export type SourceRange = { start: number; end: number };

export type CaptionSettings = {
  position_y?: number;
  font_size?: number;
  position?: string;
  highlight_words?: string[];
};

export type TaskSettings = {
  // null = use the caption template's value
  fontFamily: string | null;
  fontSize: number | null;
  fontColor: string | null;
  captionTemplate: string;
  outputFormat: OutputFormat;
  addSubtitles: boolean;
  clipLength: ClipLength;
  cutLongPauses: boolean;
  pauseThresholdMs: number;
  removeFillerWords: boolean;
  filteredWords: string[];
};

export type ClipDoc = {
  id: string;
  filename: string;
  storageKey: string;
  startTime: string;
  endTime: string;
  duration: number;
  text: string;
  relevanceScore: number;
  reasoning: string;
  viralityScore: number;
  hookScore: number;
  engagementScore: number;
  valueScore: number;
  shareabilityScore: number;
  hookType: string | null;
  hookTitle: string | null;
  sourceRanges: SourceRange[];
  keepRanges?: [number, number][];
  captionSettings?: CaptionSettings;
  createdAt: Date;
  updatedAt: Date;
};

export type TaskDoc = {
  _id: string;
  userId: string;
  status: TaskStatus;
  progress: number;
  progressMessage: string;
  source: {
    type: "youtube" | "upload";
    url: string;
    title: string;
    videoId?: string;
    durationSeconds?: number;
  };
  settings: TaskSettings;
  clips: ClipDoc[];
  /** The run the enqueuing route started: the worker's start CAS must match `jobId`. */
  run?: {
    jobId: string;
    type?: "process_task" | "restyle_task";
    startedAt?: Date;
    completedAt?: Date;
    cacheHit?: boolean;
    errorCode?: string;
  };
  editLock?: { jobId: string; until: Date } | null;
  createdAt: Date;
  updatedAt: Date;
};

export type EditorAsset = {
  width: number;
  height: number;
  fps: number;
  duration: number;
  hasAudio: boolean;
  waveform: number[];
};

export type DraftDoc = {
  _id: string;
  taskId: string;
  userId: string;
  basis: string;
  status: "preparing" | "ready" | "failed";
  error?: string;
  jobId?: string;
  asset?: EditorAsset;
  media?: { cleanKey: string; thumbnailsKey: string };
  revision: number;
  document?: EditDocument;
  original?: EditDocument;
  createdAt: Date;
  updatedAt: Date;
};

export type JobType =
  | "process_task"
  | "restyle_task"
  | "prepare_editor"
  | "export_editor"
  | "combine_editor"
  | "export_clip";

export type JobStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";

export type JobDoc = {
  _id: string;
  type: JobType;
  taskId: string;
  clipId?: string;
  userId: string;
  payload: Record<string, unknown>;
  status: JobStatus;
  activeKey?: string;
  liveKey?: string;
  runAt: Date;
  attempts: number;
  maxAttempts: number;
  lockedBy?: string;
  lockedUntil?: Date;
  cancelRequested?: boolean;
  progress: number;
  message?: string;
  error?: string;
  result?: Record<string, unknown>;
  expiresAt?: Date;
  startedAt?: Date;
  finishedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
};

export type ProcessingCacheDoc = {
  _id: string;
  sourceUrl: string;
  sourceType: string;
  transcriptText?: string;
  analyses?: Partial<Record<ClipLength, string>>;
  createdAt: Date;
  updatedAt: Date;
};

export type RuntimeSettingKey = "ANTHROPIC_API_KEY" | "ASSEMBLY_AI_API_KEY" | "CLAUDE_MODEL";

export type AppSettingDoc = {
  _id: RuntimeSettingKey;
  encryptedValue: string;
  preferAdminValue: boolean;
  updatedBy: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export type WorkerStatusDoc = {
  _id: "worker";
  workerId: string;
  pid: number;
  heartbeatAt: Date;
  startedAt: Date;
  version: string;
};

/** Better Auth's `user` collection plus the fields only the app writes. */
export type UserDoc = {
  _id: ObjectId;
  name: string;
  email: string;
  emailVerified: boolean;
  image?: string | null;
  is_admin?: boolean;
  preferences?: { fontFamily?: string; fontSize?: number; fontColor?: string; clipLength?: ClipLength };
  createdAt: Date;
  updatedAt: Date;
};

// --- EditDocument: port of backend/src/editor_document.py (extra="forbid", finite numbers) ---

const hexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/);

// Lengths in code points, as pydantic counts them; zod's min/max count UTF-16 units (an emoji is 2).
function text(max: number, min = 0) {
  const length = (value: string) => [...value].length;
  const schema = z.string().refine((value) => length(value) <= max, `String should have at most ${max} characters`);
  return min ? schema.refine((value) => length(value) >= min, `String should have at least ${min} character`) : schema;
}

const itemId = text(100, 1);

export const SegmentSchema = z
  .strictObject({ id: itemId, start: z.number().min(0), end: z.number().gt(0) })
  .refine((s) => s.end - s.start >= 0.04, "Each segment must be at least one frame long");

export const WordSchema = z
  .strictObject({
    id: itemId,
    start: z.number().min(0),
    end: z.number().gt(0),
    text: text(120),
    highlight: z.boolean().default(false),
  })
  .refine((w) => w.end > w.start, "Caption end must follow its start");

export const EDITOR_FONTS = ["TikTokSans-Regular", "TikTokSans-Bold", "Poppins-ExtraBold", "THEBOLDFONT"] as const;

export const CaptionStyleSchema = z.strictObject({
  enabled: z.boolean().default(true),
  font: z.enum(EDITOR_FONTS).default("Poppins-ExtraBold"),
  size: z.number().int().min(20).max(132).default(54),
  color: hexColor.default("#FFFFFF"),
  accent: hexColor.default("#FACC15"),
  y: z.number().min(0.1).max(0.9).default(0.78),
  background: z.boolean().default(true),
  wordsPerLine: z.number().int().min(1).max(8).default(4),
  karaoke: z.boolean().default(false),
  uppercase: z.boolean().default(false),
  template: text(50, 1).default("default"),
});

export const FramingSchema = z.strictObject({
  aspect: z.enum(["vertical", "square", "original"]).default("vertical"),
  fit: z.enum(["contain", "cover"]).default("cover"),
  zoom: z.number().min(1).max(3).default(1),
  x: z.number().min(0).max(1).default(0.5),
  y: z.number().min(0).max(1).default(0.5),
});

export const EffectsSchema = z.strictObject({
  brightness: z.number().min(40).max(180).default(100),
  contrast: z.number().min(40).max(180).default(100),
  saturation: z.number().min(0).max(220).default(100),
  blur: z.number().min(0).max(8).default(0),
  hue: z.number().min(-180).max(180).default(0),
});

export const EditDocumentSchema = z.strictObject({
  version: z.literal(1).default(1),
  segments: z.array(SegmentSchema).min(1).max(100),
  words: z.array(WordSchema).max(5000).default([]),
  captions: CaptionStyleSchema.prefault({}),
  framing: FramingSchema.prefault({}),
  effects: EffectsSchema.prefault({}),
  volume: z.number().min(0).max(2).default(1),
  muted: z.boolean().default(false),
  hookTitle: text(200).default(""),
});

export type EditDocument = z.infer<typeof EditDocumentSchema>;

/** `EditDocument.validate_duration`: the error message, or null when the document fits the clip. */
export function documentDurationError(document: EditDocument, duration: number): string | null {
  if (document.segments.some((s) => s.end > duration + 0.05)) return "An edit extends past the original clip";
  if (document.words.some((w) => w.end > duration + 0.05)) return "A caption extends past the original clip";
  const unique = (ids: string[]) => new Set(ids).size === ids.length;
  if (!unique(document.segments.map((s) => s.id)) || !unique(document.words.map((w) => w.id))) {
    return "Editor item IDs must be unique";
  }
  return null;
}
