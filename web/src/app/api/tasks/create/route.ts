import { ApiError, handle, json, readJsonObject } from "@/server/http";
import { workerHealthy } from "@/server/jobs";
import { requireUser } from "@/server/session";
import { getStorage, uploadKeys } from "@/server/storage";
import { createQueuedTask, settingsFromCreateRequest, youtubeVideoId, youtubeWatchUrl } from "@/server/tasks";
import type { TaskDoc } from "@/server/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UPLOAD_MISSING = {
  code: "VIDEO_METADATA_UNAVAILABLE",
  message: "We couldn't find this uploaded video. Upload it again.",
};

/** Port of `POST /tasks/` (tasks.py:419-598) without the network preflight: the worker probes the source. */
export const POST = handle(async (request: Request) => {
  const user = await requireUser(request);
  const data = await readJsonObject(request);
  const raw = data.source;
  const rawUrl = raw && typeof raw === "object" ? (raw as Record<string, unknown>).url : undefined;
  if (typeof rawUrl !== "string" || !rawUrl.trim()) throw new ApiError(400, "Source URL is required");
  const settings = settingsFromCreateRequest(data);

  const url = rawUrl.trim();
  const rawTitle = (raw as Record<string, unknown>).title;
  const title = typeof rawTitle === "string" ? rawTitle : "";
  let source: TaskDoc["source"];
  const videoId = youtubeVideoId(url);
  if (videoId) {
    // The worker hands source.url to yt-dlp, so it only ever sees YouTube's own URL for this id.
    source = { type: "youtube", url: youtubeWatchUrl(videoId), title, videoId };
  } else if (url.startsWith("upload://")) {
    const keys = uploadKeys(url);
    if (!keys || !(await getStorage().stat(keys.video))) throw new ApiError(422, UPLOAD_MISSING);
    source = { type: "upload", url, title };
  } else if (!/^https?:\/\//i.test(url)) {
    throw new ApiError(404, "Only YouTube URLs or upload:// references are supported");
  } else {
    throw new ApiError(422, "Only YouTube URLs or uploaded video files are supported");
  }

  const { task, job } = await createQueuedTask({ userId: user.id, source, settings });
  return json({
    task_id: task._id,
    job_id: job._id,
    message: "Task created and queued for processing",
    worker_online: await workerHealthy(),
  });
});
