// YouTube auto-post (design §4.2): a post belongs to a clip's lineage, not its id, so a restyle
// can never re-post a clip that already went out.

import type { ClipDoc } from "../types";

export function lineageOf(clip: Pick<ClipDoc, "id" | "lineageId">): string {
  return clip.lineageId ?? clip.id;
}
