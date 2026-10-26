import { editorClip, getCurrentDraft } from "@/server/drafts";
import { ApiError, handle, serveStorageFile } from "@/server/http";
import { requireUser } from "@/server/session";
import { storageKeys } from "@/server/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string; clipId: string; asset: string }> };

const NOT_READY = "Preview not ready";
const ASSETS: Record<string, { kind: "cleanKey" | "thumbnailsKey"; contentType: string }> = {
  "clean.mp4": { kind: "cleanKey", contentType: "video/mp4" },
  "thumbnails.jpg": { kind: "thumbnailsKey", contentType: "image/jpeg" },
};

/** The editor's uncaptioned preview video or thumbnail strip, with Range support. */
export const GET = handle(async (request: Request, { params }: Params) => {
  const { id, clipId, asset } = await params;
  const user = await requireUser(request);
  const { clip } = await editorClip(id, clipId, user.id);
  const entry = Object.hasOwn(ASSETS, asset) ? ASSETS[asset] : null;
  if (!entry) throw new ApiError(404, NOT_READY);
  const media = (await getCurrentDraft(clip))?.media ?? storageKeys.editorMedia(clip.id, clip.filename);
  return serveStorageFile(request, media[entry.kind], {
    contentType: entry.contentType,
    cacheControl: "private, no-cache",
    notFound: NOT_READY,
  });
});
