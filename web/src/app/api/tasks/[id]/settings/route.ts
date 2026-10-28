import { resolveFontFile } from "@/server/fonts";
import { ApiError, handle, json, readJsonObject } from "@/server/http";
import { workerHealthy } from "@/server/jobs";
import { requireUser } from "@/server/session";
import { getStorage, uploadKeys } from "@/server/storage";
import {
  ACTIVE_STATUSES,
  casStatus,
  EDIT_LOCKED_MESSAGE,
  getTaskForUser,
  IDLE_STATUSES,
  RESTYLE_RUNNING_MESSAGE,
  serializeTask,
  settingsFromUpdateRequest,
  startTaskRun,
  truthy,
} from "@/server/tasks";
import type { TaskSettings } from "@/server/types";
import { hasWorkingPost, RESTYLE_UPLOADING_MESSAGE } from "@/server/youtube/posts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

const cleanupOf = (s: TaskSettings) => JSON.stringify([s.cutLongPauses, s.pauseThresholdMs, s.removeFillerWords, s.filteredWords]);

/**
 * Save caption style and cleanup. With `apply_to_existing` the clips re-render in a `restyle_task`
 * job: the task shows "Applying new style..." and keeps its old clips until the new ones replace them.
 */
export const POST = handle(async (request: Request, { params }: Params) => {
  const { id } = await params;
  const user = await requireUser(request);
  const body = await readJsonObject(request);
  const task = await getTaskForUser(id, user.id);
  const settings = settingsFromUpdateRequest(body, task.settings);
  if (settings.fontFamily && !(await resolveFontFile(settings.fontFamily, user.id))) {
    throw new ApiError(400, "Selected font is not available");
  }
  if (ACTIVE_STATUSES.includes(task.status)) throw new ApiError(400, EDIT_LOCKED_MESSAGE);

  const applyToExisting = truthy(body.apply_to_existing);
  // Like regenerate_all_clips_for_task, a task without clips only saves its settings.
  if (applyToExisting && task.clips.length) {
    if (await hasWorkingPost(id)) throw new ApiError(409, RESTYLE_UPLOADING_MESSAGE);
    const upload = task.source.type === "upload" ? uploadKeys(task.source.url) : null;
    if (task.source.type === "upload" && !(upload && (await getStorage().stat(upload.video)))) {
      throw new ApiError(400, "Source video file no longer exists");
    }
    const job = await startTaskRun({
      task,
      type: "restyle_task",
      expected: IDLE_STATUSES,
      status: "processing",
      set: { settings, progress: 0, progressMessage: RESTYLE_RUNNING_MESSAGE },
      // The clips were rendered with task.settings: a cancelled or failed restyle puts them back.
      payload: { cleanupChanged: cleanupOf(settings) !== cleanupOf(task.settings), previousSettings: task.settings },
      busyMessage: "The previous restyle is still stopping. Try again in a moment.",
    });
    if (!job) throw new ApiError(400, EDIT_LOCKED_MESSAGE);
  } else if (!(await casStatus(id, IDLE_STATUSES, { settings }))) {
    throw new ApiError(400, EDIT_LOCKED_MESSAGE);
  }

  return json({
    task: serializeTask(await getTaskForUser(id, user.id)),
    message: "Task settings updated",
    ...(applyToExisting && { worker_online: await workerHealthy() }),
  });
});
