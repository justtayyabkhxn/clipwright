import { editorClip, startPrepare } from "@/server/drafts";
import { handle, json } from "@/server/http";
import { workerHealthy } from "@/server/jobs";
import { requireUser } from "@/server/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string; clipId: string }> };

/** 202 `{status: "preparing" | "ready", worker_online}`; queues `prepare_editor` unless already ready or preparing. */
export const POST = handle(async (request: Request, { params }: Params) => {
  const { id, clipId } = await params;
  const user = await requireUser(request);
  const { task, clip } = await editorClip(id, clipId, user.id);
  const { status } = await startPrepare(task, clip);
  return json({ status, worker_online: await workerHealthy() }, { status: 202 });
});
