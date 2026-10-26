import { listFonts } from "@/server/fonts";
import { handle, json } from "@/server/http";
import { requireUser } from "@/server/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Bundled fonts plus the user's uploads, sorted by display name. */
export const GET = handle(async (request: Request) => {
  const user = await requireUser(request);
  return json({ fonts: await listFonts(user.id) });
});
