import { handle, json } from "@/server/http";
import { requireUser } from "@/server/session";
import { getTaskForUser, serializeClips } from "@/server/tasks";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

export const GET = handle(async (request: Request, { params }: Params) => {
  const { id } = await params;
  const user = await requireUser(request);
  const clips = serializeClips(await getTaskForUser(id, user.id));
  return json({ task_id: id, clips, total_clips: clips.length });
});
