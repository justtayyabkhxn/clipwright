import { collections } from "@/server/db";
import { ApiError, handle, json, readJsonObject } from "@/server/http";
import { requireUser } from "@/server/session";
import {
  ACTIVE_STATUSES,
  deleteTaskCompletely,
  EDIT_LOCKED_MESSAGE,
  getTaskForUser,
  serializeTask,
} from "@/server/tasks";
import { cancelPostsForTask, POST_UPLOADING_MESSAGE } from "@/server/youtube/posts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

export const GET = handle(async (request: Request, { params }: Params) => {
  const { id } = await params;
  const user = await requireUser(request);
  return json(serializeTask(await getTaskForUser(id, user.id)));
});

/** Rename. This is not edit-locked: a title can change mid-run. */
export const PATCH = handle(async (request: Request, { params }: Params) => {
  const { id } = await params;
  const user = await requireUser(request);
  const { title } = await readJsonObject(request);
  if (typeof title !== "string" || !title.trim()) throw new ApiError(400, "Title is required");
  await getTaskForUser(id, user.id);
  await collections().tasks.updateOne({ _id: id }, { $set: { "source.title": title, updatedAt: new Date() } });
  return json({ message: "Task updated successfully", task_id: id });
});

/**
 * First cancels the task's YouTube posts, and refuses (409) while one is mid-upload (design §4.7);
 * only then deletes the task, and finally its posts.
 */
export const DELETE = handle(async (request: Request, { params }: Params) => {
  const { id } = await params;
  const user = await requireUser(request);
  const task = await getTaskForUser(id, user.id);
  if (ACTIVE_STATUSES.includes(task.status)) throw new ApiError(400, EDIT_LOCKED_MESSAGE);
  // Cancel first (§4.7), so no post can be claimed after the check. A 409 leaves the other posts
  // cancelled on purpose: the delete was asked for, and its retry in a minute must not find the
  // next post mid-upload. Nothing after this refuses: deleteTaskCompletely stops a run that started.
  if ((await cancelPostsForTask(id)).working) throw new ApiError(409, POST_UPLOADING_MESSAGE);
  await deleteTaskCompletely(id);
  await collections().youtubePosts.deleteMany({ taskId: id });
  return json({ message: "Task deleted successfully" });
});
