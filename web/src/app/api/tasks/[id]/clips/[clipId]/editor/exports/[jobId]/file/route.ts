import { editorClip, editorExportKey, getEditorJob } from "@/server/drafts";
import { handle, serveStorageFile } from "@/server/http";
import { requireUser } from "@/server/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string; clipId: string; jobId: string }> };

/** The finished export as `clipwright-{clip8}-{job6}.mp4`; 409 "Export is not ready" until then. */
export const GET = handle(async (request: Request, { params }: Params) => {
  const { id, clipId, jobId } = await params;
  const user = await requireUser(request);
  const { task, clip } = await editorClip(id, clipId, user.id);
  const key = await editorExportKey(await getEditorJob(task, clip, jobId));
  return serveStorageFile(request, key, {
    filename: `clipwright-${clip.id.slice(0, 8)}-${jobId.slice(0, 6)}.mp4`,
    download: true,
    contentType: "video/mp4",
    cacheControl: "private, no-store",
  });
});
