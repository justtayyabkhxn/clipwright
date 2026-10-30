import { ApiError, handle, json, readJsonObject } from "@/server/http";
import { requireUser } from "@/server/session";
import type { YoutubeAccountDoc } from "@/server/types";
import { disconnectAccount, getAccount, serializeAccount, updateAccountPrefs } from "@/server/youtube/accounts";
import { AUTO_POST_OFF_ERROR, cancelPostsForUser, DISCONNECTED_ERROR } from "@/server/youtube/posts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PRIVACIES: YoutubeAccountDoc["privacy"][] = ["public", "unlisted", "private"];

export const GET = handle(async (request: Request) => {
  const user = await requireUser(request);
  return json(serializeAccount(await getAccount(user.id)));
});

/** Partial update of `{auto_post, privacy, made_for_kids, add_to_playlist, link_full_video}`. Turning auto-post off cancels posts that are queued, blocked or failed (design §4.3). */
export const PATCH = handle(async (request: Request) => {
  const user = await requireUser(request);
  const { auto_post, privacy, made_for_kids, add_to_playlist, link_full_video } = await readJsonObject(request);
  if (auto_post !== undefined && typeof auto_post !== "boolean") throw new ApiError(400, "Invalid auto_post");
  if (privacy !== undefined && !PRIVACIES.includes(privacy as never)) throw new ApiError(400, "Invalid privacy");
  if (made_for_kids !== undefined && typeof made_for_kids !== "boolean") throw new ApiError(400, "Invalid made_for_kids");
  if (add_to_playlist !== undefined && typeof add_to_playlist !== "boolean") throw new ApiError(400, "Invalid add_to_playlist");
  if (link_full_video !== undefined && typeof link_full_video !== "boolean") throw new ApiError(400, "Invalid link_full_video");

  const account = await updateAccountPrefs(user.id, {
    autoPost: auto_post as boolean | undefined,
    privacy: privacy as YoutubeAccountDoc["privacy"] | undefined,
    madeForKids: made_for_kids as boolean | undefined,
    addToPlaylist: add_to_playlist as boolean | undefined,
    linkFullVideo: link_full_video as boolean | undefined,
  });
  if (!account) throw new ApiError(404, "YouTube account is not connected.");
  if (auto_post === false) await cancelPostsForUser(user.id, AUTO_POST_OFF_ERROR);
  return json(serializeAccount(account));
});

/** Disconnects the channel: the account doc goes first, then queued/blocked/failed posts are cancelled, then a best-effort revoke (design §4.3). */
export const DELETE = handle(async (request: Request) => {
  const user = await requireUser(request);
  const revoke = await disconnectAccount(user.id);
  await cancelPostsForUser(user.id, DISCONNECTED_ERROR);
  if (revoke) await revoke();
  return json({ message: "YouTube account disconnected" });
});
