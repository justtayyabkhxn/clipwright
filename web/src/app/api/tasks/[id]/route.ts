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

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

export const GET = handle(async (request: Request, { params }: Params) => {
  const { id } = await params;
  const user = await requireUser(request);
  return json(serializeTask(await getTaskForUser(id, user.id)));
});

/** Rename. Like SupoClip this is not edit-locked: a title can change mid-run. */
export const PATCH = handle(async (request: Request, { params }: Params) => {
  const { id } = await params;
  const user = await requireUser(request);
  const { title } = await readJsonObject(request);
  if (typeof title !== "string" || !title.trim()) throw new ApiError(400, "Title is required");
  await getTaskForUser(id, user.id);
  await collections().tasks.updateOne({ _id: id }, { $set: { "source.title": title, updatedAt: new Date() } });
  return json({ message: "Task updated successfully", task_id: id });
});

export const DELETE = handle(async (request: Request, { params }: Params) => {
  const { id } = await params;
  const user = await requireUser(request);
  const task = await getTaskForUser(id, user.id);
  if (ACTIVE_STATUSES.includes(task.status)) throw new ApiError(400, EDIT_LOCKED_MESSAGE);
  await deleteTaskCompletely(id);
  return json({ message: "Task deleted successfully" });
});
