import { env } from "@/server/env";
import { ApiError, handle, json } from "@/server/http";
import { requireUser } from "@/server/session";
import { createOAuthState } from "@/server/youtube/accounts";
import { callbackRedirectUri, googleUrls, SCOPES } from "@/server/youtube/google";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Starts the OAuth flow (design §4.3). POST only, so another site cannot kick it off with a plain
 * navigation. The browser does the actual redirect to Google's consent screen.
 */
export const POST = handle(async (request: Request) => {
  const user = await requireUser(request);
  if (!env.GOOGLE_OAUTH_CLIENT_ID || !env.GOOGLE_OAUTH_CLIENT_SECRET) {
    throw new ApiError(409, { message: "YouTube auto-post is not configured.", code: "not_configured" });
  }

  const { state, codeChallenge } = await createOAuthState(user.id);
  const params = new URLSearchParams({
    client_id: env.GOOGLE_OAUTH_CLIENT_ID,
    redirect_uri: callbackRedirectUri(),
    response_type: "code",
    scope: SCOPES.join(" "),
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
    state,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
  });
  return json({ authorize_url: `${googleUrls().authorize}?${params.toString()}` });
});
