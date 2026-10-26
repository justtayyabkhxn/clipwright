import { randomUUID } from "node:crypto";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import busboy from "busboy";

import { env } from "@/server/env";
import { ApiError, handle, json } from "@/server/http";
import { requireUser } from "@/server/session";
import { getStorage, MaxBytesExceededError } from "@/server/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The declared length may exceed the file by this much and still carry a file on the cap (upload_limits.py).
const MULTIPART_FRAMING_BYTES = 1024 * 1024;
const VIDEO_EXTENSIONS = [".mp4", ".mov", ".avi", ".mkv", ".webm", ".m4v"];
const MULTIPART_REQUIRED = "A multipart upload is required";

/**
 * Stream the multipart field `video` into `uploads/{uuid}{ext}` without buffering it. Returns the
 * `upload://` reference `POST /api/tasks/create` takes. Nothing is left behind on failure.
 */
export const POST = handle(async (request: Request) => {
  await requireUser(request);
  const maxBytes = env.MAX_VIDEO_UPLOAD_BYTES;
  const declared = request.headers.get("content-length");
  if (!declared || !/^\d+$/.test(declared)) {
    throw new ApiError(411, "A Content-Length is required for this upload.");
  }
  if (Number(declared) > maxBytes + MULTIPART_FRAMING_BYTES) throw new MaxBytesExceededError(maxBytes);
  const contentType = request.headers.get("content-type") ?? "";
  if (!/^multipart\/form-data/i.test(contentType) || !request.body) throw new ApiError(400, MULTIPART_REQUIRED);

  let parser: busboy.Busboy;
  try {
    parser = busboy({
      headers: { "content-type": contentType },
      limits: { files: 1, fields: 8, fieldSize: 1024 * 1024, parts: 10 },
    });
  } catch {
    // e.g. no boundary in the content type
    throw new ApiError(400, MULTIPART_REQUIRED);
  }
  // Assigned in the "file" callback, so keep TS from narrowing it to null.
  let saved = null as Promise<string> | null;
  parser.on("file", (field, file, info) => {
    // busboy destroys the part with the form's error, possibly before writeStream has piped it;
    // the failure still reaches `saved` and the pipeline below.
    file.on("error", () => {});
    if (field !== "video" || saved) {
      file.resume();
      return;
    }
    const ext = path.extname(info.filename ?? "").toLowerCase();
    if (!VIDEO_EXTENSIONS.includes(ext)) {
      saved = Promise.reject(
        new ApiError(400, `Unsupported video format. Upload one of: ${VIDEO_EXTENSIONS.join(", ")}.`),
      );
    } else {
      const name = `${randomUUID()}${ext}`;
      saved = getStorage()
        .writeStream(`uploads/${name}`, file, { maxBytes })
        .then(() => name);
    }
    // Stop parsing at the first failure; the rest of the body is not read.
    saved.catch((error) => parser.destroy(error));
  });

  try {
    await pipeline(Readable.fromWeb(request.body as WebReadableStream<Uint8Array>), parser);
  } catch (error) {
    // writeStream drops its temp file on failure; a file that did land is removed here.
    const name = await saved?.catch(() => null);
    if (name) await getStorage().delete(`uploads/${name}`);
    // A file-system failure (ENOSPC, EPERM...) is ours: let handle() answer 500.
    if (error instanceof ApiError || error instanceof MaxBytesExceededError || (error as NodeJS.ErrnoException).syscall) {
      throw error;
    }
    throw new ApiError(400, MULTIPART_REQUIRED);
  }
  if (!saved) throw new ApiError(400, "No video file provided");
  return json({ message: "Video uploaded successfully", video_path: `upload://${await saved}` });
});
