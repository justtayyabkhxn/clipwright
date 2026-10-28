import { ApiError, handle, json } from "@/server/http";
import { workerHealthy } from "@/server/jobs";
import { requireUser } from "@/server/session";
import { serializeAccount } from "@/server/youtube/accounts";
import { resumePosting } from "@/server/youtube/posts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** "Resume posting" (design §4.6): clears the private-lock pause and requeues the posts it held. */
export const POST = handle(async (request: Request) => {
  const user = await requireUser(request);
  const account = await resumePosting(user.id);
  if (!account) throw new ApiError(404, "YouTube account is not connected.");
  return json({ ...serializeAccount(account), worker_online: await workerHealthy() });
});
