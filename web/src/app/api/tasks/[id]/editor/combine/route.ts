import { startCombine } from "@/server/drafts";
import { handle, json, readJsonObject } from "@/server/http";
import { workerHealthy } from "@/server/jobs";
import { requireUser } from "@/server/session";
import { getTaskForUser } from "@/server/tasks";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

/** `{clip_ids}` (2-20 distinct, each prepared) → 202 `{id, anchor_clip_id, worker_online}`. */
export const POST = handle(async (request: Request, { params }: Params) => {
  const { id } = await params;
  const user = await requireUser(request);
  const task = await getTaskForUser(id, user.id);
  const job = await startCombine(task, await readJsonObject(request));
  return json({ ...job, worker_online: await workerHealthy() }, { status: 202 });
});
