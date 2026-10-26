/** @vitest-environment node */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { z } from "zod";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { resetEnv } from "./env";
import { ApiError, contentDisposition, handle, MAX_JSON_BODY_BYTES, readJsonObject, serveStorageFile } from "./http";
import { getStorage, MaxBytesExceededError } from "./storage";

let dataDir: string;
const baseEnv = { ...process.env };
const KEY = "clips/t1/clip.mp4";
const BODY = "0123456789abcdefghij"; // 20 bytes

beforeAll(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "cw-http-"));
  process.env = { ...baseEnv, MONGODB_URI: "mongodb://unused", BETTER_AUTH_SECRET: "s".repeat(32), DATA_DIR: dataDir };
  resetEnv();
  await getStorage().writeStream(KEY, Readable.from([Buffer.from(BODY)]));
});

afterAll(async () => {
  process.env = baseEnv;
  await fs.rm(dataDir, { recursive: true, force: true });
});

const get = (headers: Record<string, string> = {}, method = "GET") =>
  new Request("http://localhost/file", { method, headers });

describe("serveStorageFile", () => {
  it("serves the whole file with range support advertised", async () => {
    const response = await serveStorageFile(get(), KEY, { contentType: "video/mp4", filename: "clip.mp4" });
    expect(response.status).toBe(200);
    expect(response.headers.get("accept-ranges")).toBe("bytes");
    expect(response.headers.get("content-length")).toBe("20");
    expect(response.headers.get("content-type")).toBe("video/mp4");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("content-disposition")).toBe('inline; filename="clip.mp4"');
    expect(await response.text()).toBe(BODY);
  });

  it.each([
    ["bytes=0-4", "bytes 0-4/20", "01234"],
    ["bytes=15-", "bytes 15-19/20", "fghij"],
    ["bytes=-3", "bytes 17-19/20", "hij"],
    ["bytes=18-99", "bytes 18-19/20", "ij"],
    ["bytes=-50", "bytes 0-19/20", BODY],
  ])("answers %s with 206", async (range, contentRange, body) => {
    const response = await serveStorageFile(get({ range }), KEY);
    expect(response.status).toBe(206);
    expect(response.headers.get("content-range")).toBe(contentRange);
    expect(response.headers.get("content-length")).toBe(String(body.length));
    expect(await response.text()).toBe(body);
  });

  it("answers an unsatisfiable range with 416", async () => {
    const response = await serveStorageFile(get({ range: "bytes=20-" }), KEY);
    expect(response.status).toBe(416);
    expect(response.headers.get("content-range")).toBe("bytes */20");
  });

  it.each(["bytes=5-2", "bytes=0-1,4-5", "items=0-1", "bytes=-"])("ignores the malformed or multi range %s", async (range) => {
    const response = await serveStorageFile(get({ range }), KEY);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(BODY);
  });

  it("honours If-Range only while the validator matches", async () => {
    const first = await serveStorageFile(get(), KEY);
    const etag = first.headers.get("etag")!;
    const lastModified = first.headers.get("last-modified")!;
    expect((await serveStorageFile(get({ range: "bytes=0-1", "if-range": etag }), KEY)).status).toBe(206);
    expect((await serveStorageFile(get({ range: "bytes=0-1", "if-range": lastModified }), KEY)).status).toBe(206);
    const stale = await serveStorageFile(get({ range: "bytes=0-1", "if-range": '"other"' }), KEY);
    expect(stale.status).toBe(200);
    expect(await stale.text()).toBe(BODY);
  });

  it("supports HEAD, downloads and missing files", async () => {
    const head = await serveStorageFile(get({ range: "bytes=0-9" }, "HEAD"), KEY);
    expect(head.status).toBe(206);
    expect(head.headers.get("content-length")).toBe("10");
    expect(await head.text()).toBe("");
    const download = await serveStorageFile(get(), KEY, { filename: "Clip 1.mp4", download: true, cacheControl: "private, no-cache" });
    expect(download.headers.get("content-disposition")).toBe('attachment; filename="Clip 1.mp4"');
    expect(download.headers.get("cache-control")).toBe("private, no-cache");
    await expect(serveStorageFile(get(), "clips/t1/missing.mp4", { notFound: "Clip file not found" })).rejects.toMatchObject({
      status: 404,
      detail: "Clip file not found",
    });
  });
});

describe("contentDisposition", () => {
  it("adds an RFC 5987 filename for non-ASCII names", () => {
    expect(contentDisposition("café “clip” (1).mp4", true)).toBe(
      `attachment; filename="caf_ _clip_ (1).mp4"; filename*=UTF-8''caf%C3%A9%20%E2%80%9Cclip%E2%80%9D%20%281%29.mp4`,
    );
    expect(contentDisposition('say "hi".mp4', false)).toBe(
      `inline; filename="say _hi_.mp4"; filename*=UTF-8''say%20%22hi%22.mp4`,
    );
  });
});

describe("handle", () => {
  it("maps errors to {detail}", async () => {
    const run = (error: unknown) => handle(async () => Promise.reject(error))();
    const api = await run(new ApiError(409, "Conflict here"));
    expect(api.status).toBe(409);
    expect(await api.json()).toEqual({ detail: "Conflict here" });

    const structured = await run(new ApiError(422, { code: "VIDEO_TOO_LONG", message: "Too long" }));
    expect(await structured.json()).toEqual({ detail: { code: "VIDEO_TOO_LONG", message: "Too long" } });

    const parsed = z.object({ title: z.string() }).safeParse({});
    const zod = await run(parsed.error);
    expect(zod.status).toBe(400);
    expect((await zod.json()).detail).toMatch(/^title: /);

    expect((await run(new MaxBytesExceededError(1_000_000))).status).toBe(413);

    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const crash = await run(new Error("secret internals"));
    expect(crash.status).toBe(500);
    expect(await crash.json()).toEqual({ detail: "An internal server error occurred." });
    spy.mockRestore();
  });

  it("passes through successful responses and arguments", async () => {
    const route = handle(async (request: Request, context: { params: Promise<{ id: string }> }) =>
      Response.json({ id: (await context.params).id, method: request.method }),
    );
    const response = await route(new Request("http://x", { method: "POST" }), { params: Promise.resolve({ id: "t1" }) });
    expect(await response.json()).toEqual({ id: "t1", method: "POST" });
  });
});

describe("readJsonObject", () => {
  const post = (body: BodyInit | null, headers: Record<string, string> = {}) =>
    new Request("http://x", { method: "POST", body, headers, ...(body instanceof ReadableStream && { duplex: "half" }) });

  it("parses an object and rejects anything else with 400", async () => {
    expect(await readJsonObject(post('﻿{"a":1}'))).toEqual({ a: 1 });
    for (const [body, detail] of [
      ["{", "Invalid JSON body"],
      [null, "Invalid JSON body"],
      ["[1]", "Request body must be an object"],
      ["null", "Request body must be an object"],
    ] as const) {
      await expect(readJsonObject(post(body))).rejects.toMatchObject({ status: 400, detail });
    }
  });

  it("answers 413 past the limit, declared or streamed", async () => {
    const big = `{"a":"${"x".repeat(MAX_JSON_BODY_BYTES)}"}`;
    await expect(readJsonObject(post(big))).rejects.toMatchObject({ status: 413, detail: "Request body is too large" });
    const declared = post("{}", { "content-length": String(MAX_JSON_BODY_BYTES + 1) });
    await expect(readJsonObject(declared)).rejects.toMatchObject({ status: 413 });
    expect(declared.bodyUsed).toBe(false); // refused before reading
    let pulled = 0;
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        controller.enqueue(new Uint8Array(1024 * 1024).fill(32));
      },
    });
    await expect(readJsonObject(post(endless))).rejects.toMatchObject({ status: 413 });
    expect(pulled).toBeLessThan(12);
    const fits = `{"a":"${"x".repeat(MAX_JSON_BODY_BYTES - 16)}"}`;
    expect((await readJsonObject(post(fits))).a).toHaveLength(MAX_JSON_BODY_BYTES - 16);
  });
});
