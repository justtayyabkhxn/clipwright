import { handle, json } from "@/server/http";
import { requireUser } from "@/server/session";
import { getTaskForUser, removeClip } from "@/server/tasks";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string; clipId: string }> };

/** Edit-locked while the task runs; removes the clip's file, draft and editor media. */
export const DELETE = handle(async (request: Request, { params }: Params) => {
  const { id, clipId } = await params;
  const user = await requireUser(request);
  await getTaskForUser(id, user.id);
  await removeClip(id, clipId);
  return json({ message: "Clip deleted successfully" });
});
