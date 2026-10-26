import fs from "node:fs/promises";
import { deleteUserFont, resolveFontFile } from "@/server/fonts";
import { ApiError, handle, json } from "@/server/http";
import { requireUser } from "@/server/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ fontName: string }> };

/** The font file (user fonts first, then bundled), for `@font-face` and the editor's FontFace. */
export const GET = handle(async (request: Request, { params }: Params) => {
  const { fontName } = await params;
  const user = await requireUser(request);
  const font = await resolveFontFile(fontName, user.id);
  const data = font && (await fs.readFile(font.filePath).catch(() => null));
  if (!font || !data) throw new ApiError(404, "Font not found");
  return new Response(new Uint8Array(data), {
    headers: {
      "Content-Type": font.format === "otf" ? "font/otf" : "font/ttf",
      "Content-Length": String(data.length),
      // Revalidate so a deleted upload cannot stay cached.
      "Cache-Control": "private, no-cache",
    },
  });
});

/** Delete one of the user's own fonts; bundled fonts are refused with 403. */
export const DELETE = handle(async (request: Request, { params }: Params) => {
  const { fontName } = await params;
  const user = await requireUser(request);
  const deleted = await deleteUserFont(user.id, fontName);
  return json({ font_name: deleted, message: "Font deleted successfully" });
});
