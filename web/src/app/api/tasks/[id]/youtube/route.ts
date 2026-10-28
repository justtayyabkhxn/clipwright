import { collections } from "@/server/db";
import { handle, json } from "@/server/http";
import { requireUser } from "@/server/session";
import { getTaskForUser } from "@/server/tasks";
import { serializePosts } from "@/server/youtube/posts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

/** The task's YouTube posts, owner-only (design §4.8). */
export const GET = handle(async (request: Request, { params }: Params) => {
  const { id } = await params;
  const user = await requireUser(request);
  const task = await getTaskForUser(id, user.id);
  const posts = await collections().youtubePosts.find({ taskId: id }).sort({ createdAt: 1 }).toArray();
  // createPostsForTask hasn't inserted yet while this is true — the page keeps polling through it
  // instead of reading an empty `posts` array as "nothing to post" (finding: task-12 review round 2).
  return json({ ...serializePosts(task, posts), autopost_pending: task.autopost === "pending" });
});
