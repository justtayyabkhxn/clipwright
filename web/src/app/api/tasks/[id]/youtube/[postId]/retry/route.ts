import { handle, json } from "@/server/http";
import { workerHealthy } from "@/server/jobs";
import { requireUser } from "@/server/session";
import { getTaskForUser } from "@/server/tasks";
import { retryPost, serializePosts } from "@/server/youtube/posts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string; postId: string }> };

/** "Try again" on a failed or blocked post (design §4.8): 409 for `uploaded`, owner-only. */
export const POST = handle(async (request: Request, { params }: Params) => {
  const { id, postId } = await params;
  const user = await requireUser(request);
  const task = await getTaskForUser(id, user.id);
  const { post } = await retryPost(postId, user.id, task._id);
  return json({ ...serializePosts(task, [post]).posts[0], worker_online: await workerHealthy() });
});
