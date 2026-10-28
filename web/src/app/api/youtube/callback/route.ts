import { env } from "@/server/env";
import { handle } from "@/server/http";
import { getSessionUser } from "@/server/session";
import { consumeOAuthState, MissingRefreshTokenError, saveConnectedAccount } from "@/server/youtube/accounts";
import { callbackRedirectUri, exchangeCode, fetchMyChannel, SCOPES } from "@/server/youtube/google";
import { cancelPostsForUser, CHANNEL_CHANGED_ERROR, unblockAfterReconnect } from "@/server/youtube/posts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function redirectTo(query: string): Response {
  return Response.redirect(`${env.BETTER_AUTH_URL.replace(/\/+$/, "")}/settings?${query}`, 302);
}

/**
 * Google lands the browser here after the consent screen (design §4.3). The session cookie arrives
 * because this is a top-level Lax navigation. Every failure — expected (Google's own `?error=`, a
 * missing/foreign/reused state, a rejected scope, no channel) or not (a DB error, any other
 * exception) — redirects with one of our own `youtube_error` codes instead of falling through to
 * handle()'s JSON 500 on a plain browser navigation. Google's own error text is never echoed back,
 * and an unexpected error logs only its `.message`, never a code or a token.
 */
export const GET = handle(async (request: Request) => {
  if (!env.GOOGLE_OAUTH_CLIENT_ID || !env.GOOGLE_OAUTH_CLIENT_SECRET) return redirectTo("youtube_error=not_configured");

  const params = new URL(request.url).searchParams;
  if (params.get("error")) return redirectTo("youtube_error=denied");

  try {
    const user = await getSessionUser(request);
    const code = params.get("code");
    const state = params.get("state");
    if (!user || !code || !state) return redirectTo("youtube_error=expired");

    const consumed = await consumeOAuthState(state, user.id);
    if (!consumed) return redirectTo("youtube_error=expired");

    let tokens;
    try {
      tokens = await exchangeCode(code, consumed.codeVerifier, callbackRedirectUri());
    } catch (error) {
      console.warn("[youtube] OAuth callback: code exchange failed:", (error as Error).message);
      return redirectTo("youtube_error=exchange_failed");
    }

    if (!SCOPES.every((scope) => tokens.scopes.includes(scope))) return redirectTo("youtube_error=missing_scope");

    let channel;
    try {
      channel = await fetchMyChannel(tokens.accessToken);
    } catch (error) {
      console.warn("[youtube] OAuth callback: channel lookup failed:", (error as Error).message);
      return redirectTo("youtube_error=exchange_failed");
    }
    if (!channel) return redirectTo("youtube_error=no_channel");

    let channelChanged: boolean;
    try {
      ({ channelChanged } = await saveConnectedAccount(user.id, tokens, channel));
    } catch (error) {
      if (error instanceof MissingRefreshTokenError) return redirectTo("youtube_error=exchange_failed");
      throw error;
    }

    // A different channel: posts still waiting for the old one are never silently moved to the new
    // channel (design §4.3 step 6), but a post the autopost trigger already created for the *new*
    // channel (a race with saveConnectedAccount above) must survive. Otherwise the private-lock
    // pause (§4.6) survives the reconnect; unblockAfterReconnect already respects it.
    if (channelChanged) await cancelPostsForUser(user.id, CHANNEL_CHANGED_ERROR, { exceptChannelId: channel.channelId });
    else await unblockAfterReconnect(user.id);

    return redirectTo("youtube=connected");
  } catch (error) {
    console.warn("[youtube] OAuth callback: unexpected error:", (error as Error).message);
    return redirectTo("youtube_error=exchange_failed");
  }
});
