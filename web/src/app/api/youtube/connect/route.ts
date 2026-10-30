import { env } from "@/server/env";
import { ApiError, handle, json } from "@/server/http";
import { requireUser } from "@/server/session";
import { createOAuthState } from "@/server/youtube/accounts";
import { callbackRedirectUri, googleUrls, PLAYLIST_SCOPE, SCOPES } from "@/server/youtube/google";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Starts the OAuth flow (design §4.3). POST only, so another site cannot kick it off with a plain
 * navigation. The browser does the actual redirect to Google's consent screen. `{playlists: true}`
 * also asks for PLAYLIST_SCOPE (incremental: earlier grants are kept).
 */
export const POST = handle(async (request: Request) => {
  const user = await requireUser(request);
  if (!env.GOOGLE_OAUTH_CLIENT_ID || !env.GOOGLE_OAUTH_CLIENT_SECRET) {
    throw new ApiError(409, { message: "YouTube auto-post is not configured.", code: "not_configured" });
  }

  const body = (await request.json().catch(() => null)) as { playlists?: unknown } | null;
  const scopes = body?.playlists === true ? [...SCOPES, PLAYLIST_SCOPE] : SCOPES;
  const { state, codeChallenge } = await createOAuthState(user.id);
  const params = new URLSearchParams({
    client_id: env.GOOGLE_OAUTH_CLIENT_ID,
    redirect_uri: callbackRedirectUri(),
    response_type: "code",
    scope: scopes.join(" "),
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
    state,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
  });
  return json({ authorize_url: `${googleUrls().authorize}?${params.toString()}` });
});
