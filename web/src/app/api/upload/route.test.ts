/** @vitest-environment node */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { MongoMemoryServer } from "mongodb-memory-server";

import { getAuth } from "@/server/auth";
import { closeDb } from "@/server/db";
import { resetEnv } from "@/server/env";
import { getStorage } from "@/server/storage";

import { POST } from "./route";

let mongod: MongoMemoryServer;
let dataDir: string;
let cookie: string;
const baseEnv = { ...process.env };
const MAX_BYTES = 1000;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "cw-upload-"));
  process.env = {
    ...baseEnv,
    MONGODB_URI: mongod.getUri(),
    MONGODB_DB: "upload_route",
    MONGODB_TRANSACTIONS: "false",
    BETTER_AUTH_SECRET: "a-very-long-test-secret-for-upload-route-1",
    BETTER_AUTH_URL: "http://localhost:3000",
    DATA_DIR: dataDir,
    MAX_VIDEO_UPLOAD_BYTES: String(MAX_BYTES),
  };
  resetEnv();
  const response = await getAuth().api.signUpEmail({
    body: { email: "up@example.com", password: "correct horse battery", name: "up" },
    asResponse: true,
  });
  cookie = response.headers.get("set-cookie")!.split(";")[0];
}, 60_000);

afterAll(async () => {
  await closeDb();
  await mongod.stop();
  await fs.rm(dataDir, { recursive: true, force: true });
  process.env = baseEnv;
});

beforeEach(async () => {
  await fs.rm(path.join(dataDir, "storage", "uploads"), { recursive: true, force: true });
});

/** Every file under uploads/, temp files included. */
const uploadDirFiles = () => fs.readdir(path.join(dataDir, "storage", "uploads")).catch(() => [] as string[]);

async function multipart(parts: { field: string; content: string | Uint8Array<ArrayBuffer>; filename?: string }[]) {
  const form = new FormData();
  for (const part of parts) {
    if (part.filename) form.append(part.field, new Blob([part.content]), part.filename);
    else form.append(part.field, String(part.content));
  }
  const encoded = new Response(form);
  return { body: new Uint8Array(await encoded.arrayBuffer()), contentType: encoded.headers.get("content-type")! };
}

function upload(
  body: Uint8Array | ReadableStream<Uint8Array>,
  headers: Record<string, string>,
  withCookie = true,
) {
  return POST(
    new Request("http://localhost:3000/api/upload", {
      method: "POST",
      headers: { ...(withCookie && { cookie }), ...headers },
      body,
      duplex: "half",
    } as RequestInit),
  );
}

const sized = async (parts: Parameters<typeof multipart>[0]) => {
  const { body, contentType } = await multipart(parts);
  return { body, headers: { "content-type": contentType, "content-length": String(body.length) } };
};

describe("POST /api/upload", () => {
  it("streams the video field into storage", async () => {
    const { body, headers } = await sized([
      { field: "note", content: "hello" },
      { field: "video", content: "fake video bytes", filename: "My Talk.MP4" },
    ]);
    const response = await upload(body, headers);
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result).toEqual({ message: "Video uploaded successfully", video_path: expect.stringMatching(/^upload:\/\/[0-9a-f-]{36}\.mp4$/) });
    const key = `uploads/${result.video_path.slice("upload://".length)}`;
    expect(await fs.readFile(await getStorage().localPath(key), "utf8")).toBe("fake video bytes");
  });

  it("needs a session and a Content-Length", async () => {
    const { body, headers } = await sized([{ field: "video", content: "x", filename: "a.mp4" }]);
    expect((await upload(body, headers, false)).status).toBe(401);
    const chunked = await upload(body, { "content-type": headers["content-type"] });
    expect([chunked.status, await chunked.json()]).toEqual([411, { detail: "A Content-Length is required for this upload." }]);
  });

  it("refuses a declared length over the cap before reading", async () => {
    const { body, headers } = await sized([{ field: "video", content: "x", filename: "a.mp4" }]);
    const response = await upload(body, { ...headers, "content-length": String(MAX_BYTES + 1024 * 1024 + 1) });
    expect([response.status, await response.json()]).toEqual([413, { detail: "Uploaded file is too large. The upload limit is 1 MB." }]);
  });

  it("stops a file that grows past the cap and keeps nothing", async () => {
    const { body, headers } = await sized([{ field: "video", content: new Uint8Array(MAX_BYTES + 1), filename: "big.mp4" }]);
    const response = await upload(body, headers);
    expect([response.status, await response.json()]).toEqual([413, { detail: "Uploaded file is too large. The upload limit is 1 MB." }]);
    expect(await uploadDirFiles()).toEqual([]);
  });

  it("accepts a file exactly on the cap", async () => {
    const { body, headers } = await sized([{ field: "video", content: new Uint8Array(MAX_BYTES), filename: "edge.webm" }]);
    expect((await upload(body, headers)).status).toBe(200);
  });

  it.each([
    ["an unsupported extension", [{ field: "video", content: "x", filename: "notes.txt" }], "Unsupported video format. Upload one of: .mp4, .mov, .avi, .mkv, .webm, .m4v."],
    ["no extension", [{ field: "video", content: "x", filename: "video" }], "Unsupported video format. Upload one of: .mp4, .mov, .avi, .mkv, .webm, .m4v."],
    ["no video field", [{ field: "file", content: "x", filename: "a.mp4" }], "No video file provided"],
  ])("rejects %s", async (_name, parts, detail) => {
    const { body, headers } = await sized(parts);
    const response = await upload(body, headers);
    expect([response.status, await response.json()]).toEqual([400, { detail }]);
    expect(await uploadDirFiles()).toEqual([]);
  });

  it("rejects a body that is not multipart", async () => {
    const response = await upload(new TextEncoder().encode("{}"), { "content-type": "application/json", "content-length": "2" });
    expect([response.status, await response.json()]).toEqual([400, { detail: "A multipart upload is required" }]);
  });

  it("rejects a multipart content type without a boundary", async () => {
    const response = await upload(new TextEncoder().encode("abcd"), { "content-type": "multipart/form-data", "content-length": "4" });
    expect([response.status, await response.json()]).toEqual([400, { detail: "A multipart upload is required" }]);
  });

  it("answers 500, not 400, when storage cannot write", async () => {
    // A file where the uploads directory should be: mkdir fails with ENOTDIR/EEXIST.
    await fs.mkdir(path.join(dataDir, "storage"), { recursive: true });
    await fs.writeFile(path.join(dataDir, "storage", "uploads"), "");
    const { body, headers } = await sized([{ field: "video", content: "bytes", filename: "a.mp4" }]);
    const response = await upload(body, headers);
    expect([response.status, await response.json()]).toEqual([500, { detail: "An internal server error occurred." }]);
  });

  it("removes a stored file when the form is cut off after it", async () => {
    const { body, headers } = await sized([{ field: "video", content: "complete", filename: "a.mp4" }]);
    // The video part is whole; the body then ends inside the next part's headers.
    const boundary = headers["content-type"].split("boundary=")[1];
    const text = Buffer.from(body).toString("latin1").replace(`--${boundary}--`, `--${boundary}\r\nContent-Disposition: form-data; name="x"`);
    const cut = Buffer.from(text, "latin1");
    const response = await upload(cut, { "content-type": headers["content-type"], "content-length": String(cut.length) });
    expect(response.status).toBe(400);
    expect(await uploadDirFiles()).toEqual([]);
  });

  it("deletes the partial file when the client goes away mid-upload", async () => {
    const { body, headers } = await sized([{ field: "video", content: new Uint8Array(800).fill(65), filename: "cut.mp4" }]);
    let sent = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent) return controller.error(new Error("client aborted"));
        sent = true;
        controller.enqueue(body.slice(0, 600));
      },
    });
    const response = await upload(stream, headers);
    expect(response.status).toBe(400);
    expect(await uploadDirFiles()).toEqual([]);
  });
});
