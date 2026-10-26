import { editorClip, readEditorState, saveDraft } from "@/server/drafts";
import { handle, json, readJsonObject } from "@/server/http";
import { requireUser } from "@/server/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string; clipId: string }> };

/** The EditorState the clip editor loads. */
export const GET = handle(async (request: Request, { params }: Params) => {
  const { id, clipId } = await params;
  const user = await requireUser(request);
  const { task, clip } = await editorClip(id, clipId, user.id);
  return json(await readEditorState(task, clip));
});

/** Autosave `{basis, revision, document}` → `{revision, document}`. */
export const PATCH = handle(async (request: Request, { params }: Params) => {
  const { id, clipId } = await params;
  const user = await requireUser(request);
  const { clip } = await editorClip(id, clipId, user.id);
  return json(await saveDraft(clip, await readJsonObject(request)));
});
