import data from "../lib/caption-templates.json";
import type { ClipDoc, TaskDoc } from "./types";

export type CaptionTemplate = {
  name: string;
  description: string;
  font_family: string;
  font_size: number;
  font_color: string;
  highlight_color: string | null;
  emphasis_color: string | null;
  stroke_color: string | null;
  stroke_width: number | null;
  background: boolean;
  background_color: string | null;
  word_box: boolean;
  word_box_color: string | null;
  animation: string;
  word_pop: boolean;
  emoji: boolean;
  uppercase: boolean;
  shadow: boolean;
  glow: boolean;
  max_words_per_line: number;
  position_y: number;
};

const templates = data.templates as unknown as Record<string, Partial<CaptionTemplate>>;

/** `get_template`: the named template (or the default one) over TEMPLATE_DEFAULTS. */
export function getTemplate(id: string): CaptionTemplate {
  return { ...data.defaults, ...(templates[id] ?? templates.default) } as CaptionTemplate;
}

export function templateIds(): string[] {
  return Object.keys(templates);
}

/** Payload of `GET /api/caption-templates`. */
export function templateInfo() {
  return data.info;
}

export type CaptionLook = {
  animation: string;
  wordPop: boolean;
  wordBox: boolean;
  wordBoxColor: string | null;
  highlightColor: string | null;
  emphasisColor: string | null;
  strokeColor: string | null;
  strokeWidth: number;
  shadow: boolean;
  glow: boolean;
  backgroundColor: string | null;
};

let looks: Record<string, CaptionLook> | null = null;

/** Port of `editor_service.caption_looks`: template styling the editor preview draws. */
export function captionLooks(): Record<string, CaptionLook> {
  if (!looks) {
    looks = {};
    for (const id of templateIds()) {
      const t = getTemplate(id);
      looks[id] = {
        animation: t.animation ?? "karaoke",
        wordPop: Boolean(t.word_pop ?? true),
        wordBox: Boolean(t.word_box),
        wordBoxColor: t.word_box_color || t.highlight_color || null,
        highlightColor: t.highlight_color ?? null,
        emphasisColor: t.emphasis_color || t.highlight_color || null,
        strokeColor: t.stroke_color ?? null,
        strokeWidth: Math.trunc(Number(t.stroke_width ?? 3) || 0),
        shadow: Boolean(t.shadow),
        glow: Boolean(t.glow),
        backgroundColor: t.background_color ?? null,
      };
    }
  }
  return looks;
}

/**
 * Port of `editor_service.upgrade_document`: fill fields that drafts saved by older editor versions
 * lack, so they don't validate to defaults that drop the clip's animation and hook title.
 */
export function upgradeDocument<T extends Record<string, unknown>>(
  document: T,
  clip: Pick<ClipDoc, "hookTitle">,
  task: { settings: Pick<TaskDoc["settings"], "captionTemplate"> },
): T {
  const captions: Record<string, unknown> = { ...((document.captions as Record<string, unknown>) ?? {}) };
  if (!["template", "karaoke", "uppercase"].every((key) => key in captions)) {
    const templateId = (captions.template as string) || task.settings.captionTemplate || "default";
    const template = getTemplate(templateId);
    const setDefault = (key: string, value: unknown) => {
      if (!(key in captions)) captions[key] = value;
    };
    setDefault("template", templateId);
    setDefault("karaoke", template.animation === "karaoke");
    setDefault("uppercase", Boolean(template.uppercase));
  }
  return {
    ...document,
    captions,
    hookTitle: "hookTitle" in document ? document.hookTitle : Array.from(clip.hookTitle ?? "").slice(0, 200).join(""),
  };
}
