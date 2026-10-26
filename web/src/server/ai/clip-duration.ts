// Clip length presets shared by selection and rendering (port of clip_duration.py).

export type ClipDuration = {
  minimum: number;
  maximum: number;
  idealMinimum: number;
  idealMaximum: number;
};

export const CLIP_DURATIONS = {
  auto: { minimum: 15, maximum: 60, idealMinimum: 25, idealMaximum: 50 },
  // Ideal maxima leave room for the sentence rewind/extension before the cap.
  short: { minimum: 15, maximum: 30, idealMinimum: 18, idealMaximum: 25 },
  medium: { minimum: 30, maximum: 60, idealMinimum: 35, idealMaximum: 55 },
  long: { minimum: 60, maximum: 120, idealMinimum: 75, idealMaximum: 110 },
} as const satisfies Record<string, ClipDuration>;

export type ClipLength = keyof typeof CLIP_DURATIONS;

function isClipLength(value: unknown): value is ClipLength {
  return typeof value === "string" && Object.hasOwn(CLIP_DURATIONS, value);
}

export function validateClipLength(value: unknown): ClipLength {
  if (!isClipLength(value)) throw new Error("clip_length must be auto, short, medium, or long");
  return value;
}

/** Stored task settings fall back to Auto instead of failing the job. */
export function normalizeClipLength(value: unknown): ClipLength {
  return isClipLength(value) ? value : "auto";
}

export function clipDuration(value: ClipLength = "auto"): ClipDuration {
  return CLIP_DURATIONS[validateClipLength(value)];
}
