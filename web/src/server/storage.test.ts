/** @vitest-environment node */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  assertValidKey,
  basisHash,
  formatUploadLimit,
  LocalStorage,
  MaxBytesExceededError,
  storageKeys,
  uploadKeys,
} from "./storage";

let root: string;
let storage: LocalStorage;

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "cw-storage-"));
  storage = new LocalStorage(root);
});

afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

const text = async (stream: NodeJS.ReadableStream) => {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk as Buffer));
  return Buffer.concat(chunks).toString("utf8");
};

describe("keys", () => {
  it.each(["uploads/0b0e7f3a-0000-4000-8000-000000000000.mp4", "clips/t/clip_1_00-30_abc.mp4", "a"])("accepts %s", (key) => {
    expect(assertValidKey(key)).toBe(key);
  });

  it.each(["", "/abs.mp4", "a/../b", "..", "a\\b", "a//b", "a/", "C:/x", "a/b c", "a\u0000b", ".", "clips/.", "./x", "a/./b", "x.", "CON", "a/nul.txt", "lpt1"])("rejects %j", (key) => {
    expect(() => assertValidKey(key)).toThrow("Invalid storage key");
  });

  it("refuses invalid keys in every operation", async () => {
    await expect(storage.localPath("../escape")).rejects.toThrow("Invalid storage key");
    await expect(storage.stat("/etc/passwd")).rejects.toThrow("Invalid storage key");
    expect(() => storage.createReadStream("a\\..\\b")).toThrow("Invalid storage key");
    for (const prefix of ["", "/", "clips/", "c", "clips/./"]) {
      await expect(storage.deletePrefix(prefix)).rejects.toThrow(/Refusing|Invalid storage key/);
    }
  });

  it("maps upload URLs and lays out keys", () => {
    expect(uploadKeys("upload://0b0e7f3a-1111-4000-8000-000000000000.mov")).toEqual({
      video: "uploads/0b0e7f3a-1111-4000-8000-000000000000.mov",
      transcript: "uploads/0b0e7f3a-1111-4000-8000-000000000000.transcript_cache.json",
    });
    expect(uploadKeys("upload://../x.mp4")).toBeNull();
    expect(uploadKeys("upload://0b0e7f3a-1111-4000-8000-000000000000.exe")).toBeNull();
    expect(basisHash("clip.mp4")).toMatch(/^[0-9a-f]{16}$/);
    expect(storageKeys.editorMedia("c1", "clip.mp4").cleanKey).toBe(`editor/c1/${basisHash("clip.mp4")}/clean.mp4`);
    expect(storageKeys.userFontsDir("../evil id")).toBe("fonts/evil-id/");
    expect(storageKeys.userFontPrefix("65f0c0ffee1234567890abcd")).toBe("usr-65f0c0ff");
  });
});

describe("LocalStorage", () => {
  it("writes streams atomically and reads byte ranges", async () => {
    const result = await storage.writeStream("clips/t1/a.mp4", Readable.from([Buffer.from("hello "), Buffer.from("world")]));
    expect(result).toEqual({ size: 11 });
    expect(await storage.stat("clips/t1/a.mp4")).toMatchObject({ size: 11 });
    expect(await text(storage.createReadStream("clips/t1/a.mp4"))).toBe("hello world");
    expect(await text(storage.createReadStream("clips/t1/a.mp4", { start: 6, end: 10 }))).toBe("world");
    expect(await fs.readdir(path.join(root, "clips", "t1"))).toEqual(["a.mp4"]);
  });

  it("accepts web streams", async () => {
    const body = new Blob(["web body"]).stream();
    await storage.writeStream("uploads/web.mp4", body);
    expect(await text(storage.createReadStream("uploads/web.mp4"))).toBe("web body");
  });

  it("aborts past maxBytes and leaves nothing behind", async () => {
    const chunks = Array.from({ length: 10 }, () => Buffer.alloc(1000, 1));
    await expect(storage.writeStream("uploads/big.mp4", Readable.from(chunks), { maxBytes: 4500 })).rejects.toBeInstanceOf(
      MaxBytesExceededError,
    );
    expect(await storage.stat("uploads/big.mp4")).toBeNull();
    const leftovers = (await fs.readdir(path.join(root, "uploads"))).filter((name) => name.includes("big"));
    expect(leftovers).toEqual([]);
    expect(new MaxBytesExceededError(10 * 1024 * 1024).message).toBe("Uploaded file is too large. The upload limit is 10 MB.");
  });

  it("keeps the previous file when a replacement write fails", async () => {
    await storage.writeStream("fonts/u/x.ttf", Readable.from([Buffer.from("old")]));
    await expect(storage.writeStream("fonts/u/x.ttf", Readable.from([Buffer.alloc(50)]), { maxBytes: 10 })).rejects.toThrow();
    expect(await text(storage.createReadStream("fonts/u/x.ttf"))).toBe("old");
  });

  it("moves local files into place", async () => {
    const work = path.join(root, "..", `cw-work-${Date.now()}.mp4`);
    await fs.writeFile(work, "rendered");
    await storage.putFile("clips/t2/b.mp4", work);
    expect(await text(storage.createReadStream("clips/t2/b.mp4"))).toBe("rendered");
    await expect(fs.stat(work)).rejects.toThrow();
    const inPlace = await storage.localPath("clips/t2/c.mp4");
    await fs.writeFile(inPlace, "same");
    await storage.putFile("clips/t2/c.mp4", inPlace);
    expect(await storage.stat("clips/t2/c.mp4")).toMatchObject({ size: 4 });
  });

  it("lists and deletes by prefix", async () => {
    for (const key of ["editor/c9/h/clean.mp4", "editor/c9/h/thumbnails.jpg", "editor/c10/h/clean.mp4", "exports/c9.mp4"]) {
      await storage.writeStream(key, Readable.from([Buffer.from(key)]));
    }
    expect((await storage.list("editor/c9/")).map((item) => item.key)).toEqual([
      "editor/c9/h/clean.mp4",
      "editor/c9/h/thumbnails.jpg",
    ]);
    expect((await storage.list("editor/c9")).map((item) => item.key)).toEqual([
      "editor/c9/h/clean.mp4",
      "editor/c9/h/thumbnails.jpg",
    ]);
    expect((await storage.list("editor/c1")).map((item) => item.key)).toEqual(["editor/c10/h/clean.mp4"]);
    expect(await storage.list("missing/")).toEqual([]);

    await storage.deletePrefix("editor/c9/");
    expect(await storage.list("editor/")).toHaveLength(1);
    await storage.deletePrefix("exports/c9");
    expect(await storage.stat("exports/c9.mp4")).toBeNull();
    await storage.delete("exports/never-existed.mp4");
  });

  it("formats upload limits like the client", () => {
    expect(formatUploadLimit(4_000_000_000)).toBe("4 GB");
    expect(formatUploadLimit(2_500_000_000)).toBe("2.5 GB");
    expect(formatUploadLimit(10_485_760)).toBe("10 MB");
    expect(formatUploadLimit(100)).toBe("1 MB");
  });
});
