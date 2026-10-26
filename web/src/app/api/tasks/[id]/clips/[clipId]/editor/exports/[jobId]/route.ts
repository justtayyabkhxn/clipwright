import { cancelEditorJob, editorClip, editorJobView, getEditorJob } from "@/server/drafts";
import { handle, json } from "@/server/http";
import { requireUser } from "@/server/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string; clipId: string; jobId: string }> };

/** `{id, status, progress, error?, clip_id?}` in the editor's status vocabulary. */
export const GET = handle(async (request: Request, { params }: Params) => {
  const { id, clipId, jobId } = await params;
  const user = await requireUser(request);
  const { task, clip } = await editorClip(id, clipId, user.id);
  return json(editorJobView(await getEditorJob(task, clip, jobId)));
});

/** `{status: "cancelled" | "cancelling" | <current>}`. */
export const DELETE = handle(async (request: Request, { params }: Params) => {
  const { id, clipId, jobId } = await params;
  const user = await requireUser(request);
  const { task, clip } = await editorClip(id, clipId, user.id);
  return json(await cancelEditorJob(await getEditorJob(task, clip, jobId)));
});
