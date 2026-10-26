import { editorClip, startEditorExport } from "@/server/drafts";
import { handle, json, readJsonObject } from "@/server/http";
import { workerHealthy } from "@/server/jobs";
import { requireUser } from "@/server/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string; clipId: string }> };

/** `{basis, preset?, document}` → 202 `{id, status: "queued", progress: 0, worker_online}`. */
export const POST = handle(async (request: Request, { params }: Params) => {
  const { id, clipId } = await params;
  const user = await requireUser(request);
  const { task, clip } = await editorClip(id, clipId, user.id);
  const job = await startEditorExport(task, clip, await readJsonObject(request));
  return json({ ...job, worker_online: await workerHealthy() }, { status: 202 });
});
