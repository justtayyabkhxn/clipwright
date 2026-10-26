import { ApiError, handle, serveStorageFile } from "@/server/http";
import { requireUser } from "@/server/session";
import {
  EXPORT_FILE_MISSING_MESSAGE,
  exportDownloadFilename,
  findClip,
  getPresetExport,
  getTaskForUser,
  jobFileKey,
} from "@/server/tasks";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string; clipId: string; exportId: string }> };

/** The finished export as `{clip stem}_{preset}.mp4`. */
export const GET = handle(async (request: Request, { params }: Params) => {
  const { id, clipId, exportId } = await params;
  const user = await requireUser(request);
  const task = await getTaskForUser(id, user.id);
  const job = await getPresetExport(task, findClip(task, clipId), exportId);
  if (job.status !== "succeeded") {
    if (job.error === EXPORT_FILE_MISSING_MESSAGE) throw new ApiError(404, EXPORT_FILE_MISSING_MESSAGE);
    throw new ApiError(409, "Export is not ready");
  }
  const { filename, preset } = job.payload as { filename?: string; preset?: string };
  return serveStorageFile(request, jobFileKey(job)!, {
    filename: exportDownloadFilename(filename ?? "clip", preset ?? "export"),
    download: true,
    contentType: "video/mp4",
    notFound: EXPORT_FILE_MISSING_MESSAGE,
  });
});

export const HEAD = GET;
