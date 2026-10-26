import { templateInfo } from "@/server/caption-templates";
import { handle, json } from "@/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** `{templates: [{id, name, description, animation, font_family, font_size, font_color, highlight_color}]}`. */
export const GET = handle(async () => json({ templates: templateInfo() }));
