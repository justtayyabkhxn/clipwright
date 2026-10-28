// Fake Google behind GOOGLE_BASE_URL_OVERRIDE: the consent screen (an instant redirect back with a
// code), the token endpoint (PKCE-checked code exchange, refresh), revoke, channels.list, the
// resumable videos.insert session (initiate, PUT, status query) and videos.list. Every session
// initiation's query and JSON body is kept; the spec runs in another process, so it reads them
// from GET /__fake/initiations.
import { createHash, randomBytes } from "node:crypto";
import { startJsonServer, type FakeServer, type Handler } from "./http";

export const FAKE_GOOGLE_CLIENT = { id: "clipwright-e2e.apps.googleusercontent.com", secret: "e2e-google-client-secret" };
export const FAKE_CHANNEL = { id: "UCe2eClipwrightFakeChannel", title: "Clipwright E2E Channel", handle: "@clipwright-e2e" };
const SCOPE = "https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.readonly";

type Video = { id: string; status: { privacyStatus: string; uploadStatus: string } };
type Session = { size: number; received: number; privacyStatus: string; video?: Video };
export type Initiation = {
  query: Record<string, string>;
  body: { snippet: Record<string, unknown> & { title: string }; status: Record<string, unknown> };
};

const newId = () => randomBytes(12).toString("base64url");
/** The Data API's error shape: the app classifies by `error.errors[0].reason`. */
const error = (status: number, reason: string) => ({ status, json: { error: { code: status, errors: [{ reason }] } } });

export function startFakeGoogle(): Promise<FakeServer> {
  const codes = new Map<string, { challenge: string; redirectUri: string }>();
  const accessTokens = new Set<string>();
  const sessions = new Map<string, Session>();
  const videos = new Map<string, Video>();
  const initiations: Initiation[] = [];
  let base = "";

  const fake = startJsonServer("google", (request, body, url): ReturnType<Handler> => {
    const { method } = request;
    const path = url.pathname;
    const query = url.searchParams;
    if (method === "GET" && path === "/__fake/initiations") return { json: initiations };

    if (method === "GET" && path === "/o/oauth2/v2/auth") {
      if (query.get("client_id") !== FAKE_GOOGLE_CLIENT.id || query.get("code_challenge_method") !== "S256") return error(400, "invalid_request");
      const code = newId();
      codes.set(code, { challenge: query.get("code_challenge")!, redirectUri: query.get("redirect_uri")! });
      const back = new URL(query.get("redirect_uri")!);
      back.search = new URLSearchParams({ code, state: query.get("state")! }).toString();
      return { status: 302, json: {}, headers: { location: back.toString() } };
    }

    if (method === "POST" && path === "/revoke") return { json: {} };

    if (method === "POST" && path === "/token") {
      const form = new URLSearchParams(body.toString("utf8"));
      if (form.get("client_id") !== FAKE_GOOGLE_CLIENT.id || form.get("client_secret") !== FAKE_GOOGLE_CLIENT.secret) {
        return { status: 401, json: { error: "invalid_client" } };
      }
      const accessToken = `ya29.fake-${newId()}`;
      if (form.get("grant_type") === "refresh_token") {
        accessTokens.add(accessToken);
        return { json: { access_token: accessToken, expires_in: 3599, scope: SCOPE, token_type: "Bearer" } };
      }
      const code = form.get("code") ?? "";
      const issued = codes.get(code);
      codes.delete(code);
      const challenge = createHash("sha256").update(form.get("code_verifier") ?? "").digest("base64url");
      if (!issued || issued.challenge !== challenge || issued.redirectUri !== form.get("redirect_uri")) {
        return { status: 400, json: { error: "invalid_grant" } };
      }
      accessTokens.add(accessToken);
      return { json: { access_token: accessToken, refresh_token: `1//fake-${newId()}`, expires_in: 3599, scope: SCOPE, token_type: "Bearer" } };
    }

    const upload = path === "/upload/youtube/v3/videos";
    // The session URI is the capability: upload PUTs carry no token.
    if (!(upload && method === "PUT") && !accessTokens.has(request.headers.authorization?.replace(/^Bearer /, "") ?? "")) {
      return error(401, "authError");
    }

    if (method === "GET" && path === "/youtube/v3/channels" && query.get("mine") === "true") {
      return { json: { items: [{ id: FAKE_CHANNEL.id, snippet: { title: FAKE_CHANNEL.title, customUrl: FAKE_CHANNEL.handle } }] } };
    }

    if (method === "GET" && path === "/youtube/v3/videos") {
      const found = (query.get("id") ?? "").split(",").flatMap((id) => videos.get(id) ?? []);
      return { json: { items: found.map((video) => ({ id: video.id, status: { ...video.status, uploadStatus: "processed" } })) } };
    }

    if (method === "POST" && upload && query.get("uploadType") === "resumable") {
      const insert = JSON.parse(body.toString("utf8")) as Initiation["body"];
      initiations.push({ query: Object.fromEntries(query), body: insert });
      const sessionId = newId();
      const size = Number(request.headers["x-upload-content-length"]);
      sessions.set(sessionId, { size, received: 0, privacyStatus: String(insert.status.privacyStatus) });
      return { json: {}, headers: { location: `${base}${path}?uploadType=resumable&upload_id=${sessionId}` } };
    }

    if (method === "PUT" && upload) {
      const session = sessions.get(query.get("upload_id") ?? "");
      if (!session) return error(404, "notFound");
      // A status query ("bytes */size") has no body; any other PUT appends its bytes.
      if (!String(request.headers["content-range"] ?? "").startsWith("bytes */")) session.received += body.length;
      if (!session.video && session.received >= session.size) {
        session.video = { id: newId().slice(0, 11), status: { privacyStatus: session.privacyStatus, uploadStatus: "uploaded" } };
        videos.set(session.video.id, session.video);
      }
      if (session.video) return { json: session.video };
      return { status: 308, json: {}, headers: session.received ? { range: `bytes=0-${session.received - 1}` } : {} };
    }

    return error(404, "notFound");
  });
  return fake.then((server) => ((base = server.url), server));
}
