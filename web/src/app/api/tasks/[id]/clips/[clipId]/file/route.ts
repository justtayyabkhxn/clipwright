import { handle, serveStorageFile } from "@/server/http";
import { requireUser } from "@/server/session";
import { findClip, getTaskForUser } from "@/server/tasks";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string; clipId: string }> };

/** The rendered clip with Range support; `?download=true` makes it an attachment. */
export const GET = handle(async (request: Request, { params }: Params) => {
  const { id, clipId } = await params;
  const user = await requireUser(request);
  const clip = findClip(await getTaskForUser(id, user.id), clipId);
  const download = /^(1|true|yes|on)$/i.test(new URL(request.url).searchParams.get("download") ?? "");
  return serveStorageFile(request, clip.storageKey, {
    filename: clip.filename,
    download,
    contentType: "video/mp4",
    notFound: "Clip file not found",
  });
});

export const HEAD = GET;
