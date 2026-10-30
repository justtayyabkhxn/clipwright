import { handle, json } from "@/server/http";
import { workerHealthy } from "@/server/jobs";
import { requireUser } from "@/server/session";
import { releaseChannelLimit } from "@/server/youtube/posts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * "Post all": queue every post held by YouTube's channel upload limit, 10 minutes apart. 409
 * `{code: "channel_limit", available_at}` while the 12-hour hold is still running.
 */
export const POST = handle(async (request: Request) => {
  const user = await requireUser(request);
  const released = await releaseChannelLimit(user.id);
  return json({ released, worker_online: await workerHealthy() });
});
