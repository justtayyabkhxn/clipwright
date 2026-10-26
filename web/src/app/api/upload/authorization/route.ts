import { handle, json } from "@/server/http";
import { requireUser } from "@/server/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Local storage has no direct upload: the browser streams the file to `/api/upload`. */
export const POST = handle(async (request: Request) => {
  await requireUser(request);
  return json({ directUpload: false }, { headers: { "Cache-Control": "no-store" } });
});
