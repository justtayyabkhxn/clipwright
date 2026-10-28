import { ApiError, handle, json } from "@/server/http";
import { requireUser } from "@/server/session";
import { ACTIVE_STATUSES, EDIT_LOCKED_MESSAGE, getTaskForUser, removeClip } from "@/server/tasks";
import { cancelPostForLineage, lineageOf, POST_UPLOADING_MESSAGE } from "@/server/youtube/posts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string; clipId: string }> };

/**
 * Edit-locked while the task runs; removes the clip's file, draft and editor media. First cancels
 * the clip lineage's YouTube post, and refuses (409) while it is mid-upload (design §4.7) — checked
 * only once the task is actually editable, so a blocked delete never cancels a post for nothing.
 */
export const DELETE = handle(async (request: Request, { params }: Params) => {
  const { id, clipId } = await params;
  const user = await requireUser(request);
  const task = await getTaskForUser(id, user.id);
  if (ACTIVE_STATUSES.includes(task.status)) throw new ApiError(400, EDIT_LOCKED_MESSAGE);
  const clip = task.clips.find((candidate) => candidate.id === clipId);
  if (clip && (await cancelPostForLineage(id, lineageOf(clip))) === "working") {
    throw new ApiError(409, POST_UPLOADING_MESSAGE);
  }
  await removeClip(id, clipId);
  return json({ message: "Clip deleted successfully" });
});
