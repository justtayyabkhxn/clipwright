import { ObjectId } from "mongodb";
import { collections } from "@/server/db";
import { ApiError, handle, json, readJsonObject } from "@/server/http";
import { requireUser } from "@/server/session";
import { isClipLength } from "@/server/tasks";
import type { UserDoc } from "@/server/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Stored values; a caption field never saved is null (the caption template's own value applies), so
 * saving only a clip length does not look like saved fonts. `saved` = the user has ever saved preferences.
 */
function serialize(user: Pick<UserDoc, "preferences"> | null) {
  if (!user) throw new ApiError(404, "User not found");
  const preferences = user.preferences;
  return {
    fontFamily: preferences?.fontFamily ?? null,
    fontSize: preferences?.fontSize ?? null,
    fontColor: preferences?.fontColor ?? null,
    clipLength: preferences?.clipLength || "auto",
    saved: Boolean(preferences),
  };
}

export const GET = handle(async (request: Request) => {
  const user = await requireUser(request);
  return json(serialize(await collections().users.findOne({ _id: new ObjectId(user.id) }, { projection: { preferences: 1 } })));
});

/** Partial update of `{fontFamily, fontSize, fontColor, clipLength}`; other keys are ignored. */
export const PATCH = handle(async (request: Request) => {
  const user = await requireUser(request);
  const body = await readJsonObject(request).catch((error: ApiError) => {
    throw error.status === 413 ? error : new ApiError(400, "Expected a preferences object");
  });
  const { fontFamily, fontSize, fontColor, clipLength } = body;
  if (clipLength !== undefined && !isClipLength(clipLength)) throw new ApiError(400, "Invalid clipLength");
  if (fontFamily !== undefined && (typeof fontFamily !== "string" || !fontFamily.trim())) {
    throw new ApiError(400, "Invalid fontFamily");
  }
  if (fontSize !== undefined && (typeof fontSize !== "number" || !Number.isInteger(fontSize) || fontSize < 12 || fontSize > 48)) {
    throw new ApiError(400, "Invalid fontSize (must be between 12 and 48)");
  }
  if (fontColor !== undefined && (typeof fontColor !== "string" || !/^#[0-9A-Fa-f]{6}$/.test(fontColor))) {
    throw new ApiError(400, "Invalid fontColor (must be hex format like #FFFFFF)");
  }

  const set: Record<string, unknown> = {};
  for (const [key, value] of Object.entries({ fontFamily, fontSize, fontColor, clipLength })) {
    if (value !== undefined) set[`preferences.${key}`] = value;
  }
  const { users } = collections();
  const filter = { _id: new ObjectId(user.id) };
  const options = { projection: { preferences: 1 }, returnDocument: "after" as const };
  const updated = Object.keys(set).length
    ? await users.findOneAndUpdate(filter, { $set: { ...set, updatedAt: new Date() } }, options)
    : await users.findOne(filter, { projection: options.projection });
  return json(serialize(updated));
});
