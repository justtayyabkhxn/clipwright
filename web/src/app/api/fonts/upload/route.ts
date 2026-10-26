import { Readable } from "node:stream";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import busboy from "busboy";
import { MAX_FONT_UPLOAD_BYTES, saveUserFont } from "@/server/fonts";
import { ApiError, handle, json } from "@/server/http";
import { requireUser } from "@/server/session";
import { MaxBytesExceededError } from "@/server/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MULTIPART_FRAMING_BYTES = 1024 * 1024;

/** Multipart field `file` (.ttf/.otf, at most 10 MB), streamed to the user's font directory. */
export const POST = handle(async (request: Request) => {
  const user = await requireUser(request);
  const contentType = request.headers.get("content-type") ?? "";
  if (!/^multipart\/form-data/i.test(contentType) || !request.body) {
    throw new ApiError(400, "A multipart upload is required");
  }
  if (Number(request.headers.get("content-length")) > MAX_FONT_UPLOAD_BYTES + MULTIPART_FRAMING_BYTES) {
    throw new MaxBytesExceededError(MAX_FONT_UPLOAD_BYTES);
  }

  const source = Readable.fromWeb(request.body as WebReadableStream<Uint8Array>);
  try {
    const font = await new Promise<Awaited<ReturnType<typeof saveUserFont>>>((resolve, reject) => {
      let parser: busboy.Busboy;
      try {
        parser = busboy({
          headers: { "content-type": contentType },
          limits: { files: 1, fields: 8, fieldSize: MULTIPART_FRAMING_BYTES },
        });
      } catch {
        return reject(new ApiError(400, "A multipart upload is required"));
      }
      let received = false;
      parser.on("file", (field, stream, info) => {
        if (field !== "file" || received) return void stream.resume();
        received = true;
        saveUserFont(user.id, { filename: info.filename ?? "", body: stream }).then(resolve, reject);
      });
      parser.on("error", () => reject(new ApiError(400, "A multipart upload is required")));
      parser.on("close", () => received || reject(new ApiError(400, "No font file provided")));
      source.on("error", reject);
      source.pipe(parser);
    });
    return json({ font, message: "Font uploaded successfully" });
  } finally {
    source.destroy();
  }
});
