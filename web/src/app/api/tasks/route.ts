import { handle, json } from "@/server/http";
import { requireUser } from "@/server/session";
import { listTasks, serializeTaskSummary } from "@/server/tasks";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = handle(async (request: Request) => {
  const user = await requireUser(request);
  const tasks = (await listTasks(user.id)).map(serializeTaskSummary);
  return json({ tasks, total: tasks.length });
});
