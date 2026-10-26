import { ApiError, handle, json } from "@/server/http";
import { workerHealthy } from "@/server/jobs";
import { requireUser } from "@/server/session";
import { exportPreset, findClip, getTaskForUser, serializePresetExport, startPresetExport } from "@/server/tasks";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string; clipId: string }> };

// `?preset=` (default tiktok), overridden by a JSON body's `preset` (clip_exports._preset_from_request).
async function requestedPreset(request: Request) {
  let selected: unknown = new URL(request.url).searchParams.get("preset") ?? "tiktok";
  if ((request.headers.get("content-type") ?? "").toLowerCase().includes("application/json")) {
    const raw = await request.text();
    if (raw.trim()) {
      let payload: unknown;
      try {
        payload = JSON.parse(raw);
      } catch {
        throw new ApiError(400, "Invalid JSON body");
      }
      if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
        throw new ApiError(400, "Request body must be an object");
      }
      const preset = (payload as Record<string, unknown>).preset;
      if (preset !== undefined && preset !== null) {
        if (typeof preset !== "string") throw new ApiError(400, "preset must be a string");
        selected = preset;
      }
    }
  }
  return exportPreset(selected);
}

/** 202 with the export job; the same clip file and preset reuse a live or finished export. */
export const POST = handle(async (request: Request, { params }: Params) => {
  const { id, clipId } = await params;
  const user = await requireUser(request);
  const task = await getTaskForUser(id, user.id);
  const clip = findClip(task, clipId);
  const job = await startPresetExport(task, clip, await requestedPreset(request));
  return json({ ...serializePresetExport(job), worker_online: await workerHealthy() }, { status: 202 });
});
