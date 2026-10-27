import { Readable } from "node:stream";
import { ZodError } from "zod";
import { getStorage, MaxBytesExceededError } from "./storage";

export type ErrorDetail = string | ({ message: string; code?: string } & Record<string, unknown>);

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly detail: ErrorDetail,
  ) {
    super(typeof detail === "string" ? detail : detail.message);
  }
}

export function json(data: unknown, init?: ResponseInit): Response {
  return Response.json(data, init);
}

/** Far above the largest valid body (an EditDocument: 100 segments, 5000 words of at most 120 characters). */
export const MAX_JSON_BODY_BYTES = 8 * 1024 * 1024;
const BODY_TOO_LARGE = "Request body is too large";

/** The body as text, 413 past MAX_JSON_BODY_BYTES (declared or streamed); route handlers have no limit of their own. */
export async function readLimitedText(request: Request): Promise<string> {
  if (Number(request.headers.get("content-length")) > MAX_JSON_BODY_BYTES) throw new ApiError(413, BODY_TOO_LARGE);
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
    size += chunk.value.byteLength;
    if (size > MAX_JSON_BODY_BYTES) {
      await reader.cancel().catch(() => {});
      throw new ApiError(413, BODY_TOO_LARGE);
    }
    chunks.push(chunk.value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks)); // strips a BOM, like request.json()
}

/** A JSON object body (`_read_json_object`): 400 for invalid JSON or anything that is not an object, 413 when too large. */
export async function readJsonObject(request: Request): Promise<Record<string, unknown>> {
  let payload: unknown;
  try {
    payload = JSON.parse(await readLimitedText(request));
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(400, "Invalid JSON body");
  }
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    throw new ApiError(400, "Request body must be an object");
  }
  return payload as Record<string, unknown>;
}

export function zodDetail(error: ZodError): string {
  return error.issues
    .map((issue) => (issue.path.length ? `${issue.path.join(".")}: ${issue.message}` : issue.message))
    .join("; ");
}

/** Wrap a route handler: ApiError → {detail}, ZodError → 400, oversized upload → 413, else 500. */
export function handle<A extends unknown[]>(fn: (...args: A) => Promise<Response>) {
  return async (...args: A): Promise<Response> => {
    try {
      return await fn(...args);
    } catch (error) {
      if (error instanceof ApiError) return json({ detail: error.detail }, { status: error.status });
      if (error instanceof ZodError) return json({ detail: zodDetail(error) }, { status: 400 });
      if (error instanceof MaxBytesExceededError) return json({ detail: error.message }, { status: 413 });
      console.error("[api] Unhandled error", error);
      return json({ detail: "An internal server error occurred." }, { status: 500 });
    }
  };
}

/** RFC 6266 Content-Disposition with an ASCII fallback and an RFC 5987 `filename*` for the rest. */
export function contentDisposition(filename: string, download: boolean): string {
  const type = download ? "attachment" : "inline";
  const fallback = filename.replace(/[^\x20-\x7e]|["\\]/g, "_");
  if (fallback === filename) return `${type}; filename="${filename}"`;
  const encoded = encodeURIComponent(filename).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${type}; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

type ByteRange = { start: number; end: number } | "unsatisfiable" | null;

// Only single ranges are honoured; anything else is served whole, which RFC 9110 allows.
function parseRange(header: string | null, size: number): ByteRange {
  const match = header ? /^bytes=(\d*)-(\d*)$/.exec(header.trim()) : null;
  if (!match || (!match[1] && !match[2])) return null;
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (suffix === 0 || size === 0) return "unsatisfiable";
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(match[1]);
  const end = match[2] ? Number(match[2]) : size - 1;
  if (match[2] && end < start) return null;
  if (start >= size) return "unsatisfiable";
  return { start, end: Math.min(end, size - 1) };
}

export async function serveStorageFile(
  request: Request,
  key: string,
  opts: {
    filename?: string;
    download?: boolean;
    contentType?: string;
    cacheControl?: string;
    notFound?: string;
  } = {},
): Promise<Response> {
  const storage = getStorage();
  const info = await storage.stat(key);
  if (!info) throw new ApiError(404, opts.notFound ?? "File not found");

  const etag = `"${info.size.toString(16)}-${Math.floor(info.mtimeMs).toString(16)}"`;
  const lastModified = new Date(info.mtimeMs).toUTCString();
  const headers = new Headers({
    "Accept-Ranges": "bytes",
    "Content-Type": opts.contentType ?? "application/octet-stream",
    "Cache-Control": opts.cacheControl ?? "private, no-store",
    ETag: etag,
    "Last-Modified": lastModified,
  });
  if (opts.filename) headers.set("Content-Disposition", contentDisposition(opts.filename, Boolean(opts.download)));

  const ifRange = request.headers.get("if-range");
  const rangeAllowed = !ifRange || ifRange === etag || ifRange === lastModified;
  const range = rangeAllowed ? parseRange(request.headers.get("range"), info.size) : null;

  if (range === "unsatisfiable") {
    headers.set("Content-Range", `bytes */${info.size}`);
    return new Response(null, { status: 416, headers });
  }

  const status = range ? 206 : 200;
  const { start, end } = range ?? { start: 0, end: info.size - 1 };
  headers.set("Content-Length", String(info.size === 0 ? 0 : end - start + 1));
  if (range) headers.set("Content-Range", `bytes ${start}-${end}/${info.size}`);
  if (request.method === "HEAD" || info.size === 0) return new Response(null, { status, headers });

  const stream = storage.createReadStream(key, { start, end }) as Readable;
  return new Response(pullStream(stream), { status, headers });
}

/**
 * A web stream that reads from `stream` only when the consumer pulls. Readable.toWeb pushes data
 * events into the controller, which throws "Controller is already closed" (uncaught) when a browser
 * cancels a video Range request mid-flight.
 */
export function pullStream(stream: Readable): ReadableStream<Uint8Array> {
  const chunks = stream[Symbol.asyncIterator]();
  let cancelled = false;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { value, done } = await chunks.next();
        if (cancelled) return;
        if (done) controller.close();
        else controller.enqueue(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
      } catch (error) {
        if (!cancelled) controller.error(error);
      }
    },
    cancel() {
      cancelled = true;
      stream.destroy();
    },
  });
}
