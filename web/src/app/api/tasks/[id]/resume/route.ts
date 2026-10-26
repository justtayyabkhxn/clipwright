import { ApiError, handle, json } from "@/server/http";
import { workerHealthy } from "@/server/jobs";
import { requireUser } from "@/server/session";
import { getTaskForUser, startTaskRun } from "@/server/tasks";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

/** Re-runs the whole pipeline; the processing cache spares the download, transcript and analysis. */
export const POST = handle(async (request: Request, { params }: Params) => {
  const { id } = await params;
  const user = await requireUser(request);
  const task = await getTaskForUser(id, user.id);
  if (task.status === "queued") return json({ message: "Task already queued", worker_online: await workerHealthy() });
  if (task.status !== "cancelled" && task.status !== "error") {
    throw new ApiError(400, "Only cancelled/error/queued tasks can be resumed");
  }
  const job = await startTaskRun({
    task,
    type: "process_task",
    expected: ["cancelled", "error"],
    status: "queued",
    set: { progress: 0, progressMessage: "Re-queued by user" },
    busyMessage: "The previous worker is still stopping. Retry resume in a moment.",
  });
  if (!job) throw new ApiError(409, "The task changed while resuming. Refresh and try again.");
  return json({ message: "Task resumed", job_id: job._id, worker_online: await workerHealthy() });
});
