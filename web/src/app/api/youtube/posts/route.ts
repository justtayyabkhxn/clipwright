import { handle, json } from "@/server/http";
import { requireUser } from "@/server/session";
import { listPostsForUser } from "@/server/youtube/posts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Every task's posts in one place, for the /youtube page: the newest 200, owner-only. */
export const GET = handle(async (request: Request) => {
  const user = await requireUser(request);
  return json(await listPostsForUser(user.id, 200));
});
