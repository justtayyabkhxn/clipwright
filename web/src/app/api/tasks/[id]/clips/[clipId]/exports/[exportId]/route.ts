import { handle, json } from "@/server/http";
import { requireUser } from "@/server/session";
import { findClip, getPresetExport, getTaskForUser, serializePresetExport } from "@/server/tasks";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string; clipId: string; exportId: string }> };

export const GET = handle(async (request: Request, { params }: Params) => {
  const { id, clipId, exportId } = await params;
  const user = await requireUser(request);
  const task = await getTaskForUser(id, user.id);
  return json(serializePresetExport(await getPresetExport(task, findClip(task, clipId), exportId)));
});
