import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { env, paths } from "./env";

export interface Storage {
  /** Absolute local path for a key, for the engine (parent dirs are created). */
  localPath(key: string): Promise<string>;
  /** Make a local file available at `key` (renamed into place when it is not already there). */
  putFile(key: string, localFile: string): Promise<void>;
  writeStream(
    key: string,
    body: ReadableStream<Uint8Array> | NodeJS.ReadableStream,
    opts?: { maxBytes?: number },
  ): Promise<{ size: number }>;
  stat(key: string): Promise<{ size: number; mtimeMs: number } | null>;
  /** `end` is inclusive, as in HTTP ranges. */
  createReadStream(key: string, range?: { start: number; end: number }): NodeJS.ReadableStream;
  /** Missing is fine. */
  delete(key: string): Promise<void>;
  /** "dir/" removes a whole directory; anything else removes keys starting with it. */
  deletePrefix(prefix: string): Promise<void>;
  list(prefix: string): Promise<{ key: string; size: number; mtimeMs: number }[]>;
}

/** Human size for an upload cap, decimal units like the client (`format_upload_limit`). */
export function formatUploadLimit(maxBytes: number): string {
  if (maxBytes >= 1_000_000_000) {
    const rounded = Math.round((maxBytes / 1_000_000_000) * 10) / 10;
    return Math.abs(rounded - Math.round(rounded)) < 0.05 ? `${Math.round(rounded)} GB` : `${rounded.toFixed(1)} GB`;
  }
  return `${Math.max(1, Math.round(maxBytes / 1_000_000))} MB`;
}

export class MaxBytesExceededError extends Error {
  constructor(readonly maxBytes: number) {
    super(`Uploaded file is too large. The upload limit is ${formatUploadLimit(maxBytes)}.`);
  }
}

const KEY_PATTERN = /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/;
// "." collapses into its parent; Windows strips trailing dots and maps device names (CON, nul.txt…).
const BAD_SEGMENT = /^\.$|\.$|^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i;

export function assertValidKey(key: string): string {
  if (
    typeof key !== "string" ||
    !KEY_PATTERN.test(key) ||
    key.includes("..") ||
    key.split("/").some((segment) => BAD_SEGMENT.test(segment))
  ) {
    throw new Error(`Invalid storage key: ${JSON.stringify(key)}`);
  }
  return key;
}

const TEMP_SUFFIX = ".partial";

export class LocalStorage implements Storage {
  constructor(readonly root: string) {}

  private resolve(key: string) {
    return path.join(this.root, ...assertValidKey(key).split("/"));
  }

  async localPath(key: string) {
    const file = this.resolve(key);
    await fs.mkdir(path.dirname(file), { recursive: true });
    return file;
  }

  async putFile(key: string, localFile: string) {
    const target = await this.localPath(key);
    if (path.resolve(localFile) === target) return;
    await fs.rename(localFile, target);
  }

  async writeStream(
    key: string,
    body: ReadableStream<Uint8Array> | NodeJS.ReadableStream,
    opts: { maxBytes?: number } = {},
  ) {
    const target = await this.localPath(key);
    const temp = path.join(path.dirname(target), `.${path.basename(target)}.${randomUUID()}${TEMP_SUFFIX}`);
    const source = "getReader" in body ? Readable.fromWeb(body as WebReadableStream<Uint8Array>) : body;
    let size = 0;
    const counter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        size += chunk.length;
        if (opts.maxBytes !== undefined && size > opts.maxBytes) {
          callback(new MaxBytesExceededError(opts.maxBytes));
        } else {
          callback(null, chunk);
        }
      },
    });
    try {
      await pipeline(source, counter, createWriteStream(temp));
      await fs.rename(temp, target);
    } catch (error) {
      await fs.rm(temp, { force: true });
      throw error;
    }
    return { size };
  }

  async stat(key: string) {
    try {
      const info = await fs.stat(this.resolve(key));
      return info.isFile() ? { size: info.size, mtimeMs: info.mtimeMs } : null;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  createReadStream(key: string, range?: { start: number; end: number }) {
    return createReadStream(this.resolve(key), range);
  }

  async delete(key: string) {
    await fs.rm(this.resolve(key), { force: true });
  }

  async deletePrefix(prefix: string) {
    // Always below an owner (clips/{taskId}/, fonts/{userId}/), never the root or a whole namespace.
    if (!prefix.replace(/\/$/, "").includes("/")) {
      throw new Error(`Refusing to delete a whole storage namespace: ${JSON.stringify(prefix)}`);
    }
    if (prefix.endsWith("/")) {
      await fs.rm(this.resolve(prefix.slice(0, -1)), { recursive: true, force: true });
      return;
    }
    for (const item of await this.list(prefix)) await this.delete(item.key);
  }

  async list(prefix: string) {
    const trimmed = prefix.endsWith("/") ? prefix.slice(0, -1) : prefix;
    if (trimmed) assertValidKey(trimmed);
    const directory = prefix.endsWith("/") || !trimmed ? trimmed : path.posix.dirname(trimmed);
    const base = directory && directory !== "." ? this.resolve(directory) : this.root;
    let entries;
    try {
      entries = await fs.readdir(base, { recursive: true, withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const results: { key: string; size: number; mtimeMs: number }[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || entry.name.endsWith(TEMP_SUFFIX)) continue;
      const absolute = path.join(entry.parentPath, entry.name);
      const key = path.relative(this.root, absolute).split(path.sep).join("/");
      if (!key.startsWith(prefix)) continue;
      const info = await fs.stat(absolute).catch(() => null);
      if (info) results.push({ key, size: info.size, mtimeMs: info.mtimeMs });
    }
    return results.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  }
}

let storage: Storage | null = null;

export function getStorage(): Storage {
  if (!storage) {
    if (env.STORAGE_DRIVER !== "local") throw new Error(`Unsupported STORAGE_DRIVER ${env.STORAGE_DRIVER}`);
    storage = new LocalStorage(paths.storageRoot);
  }
  return storage;
}

/** First 16 hex characters of sha256(clip filename): a new clip file gets fresh editor media. */
export function basisHash(filename: string): string {
  return createHash("sha256").update(filename, "utf8").digest("hex").slice(0, 16);
}

function safeUserSegment(userId: string): string {
  return userId.replace(/[^A-Za-z0-9_-]/g, "-").replace(/^-+|-+$/g, "") || "user";
}

/** The storage layout (DESIGN §4). */
export const storageKeys = {
  clip: (taskId: string, filename: string) => `clips/${taskId}/${filename}`,
  taskClipsDir: (taskId: string) => `clips/${taskId}/`,
  editorDir: (clipId: string) => `editor/${clipId}/`,
  editorMedia: (clipId: string, filename: string) => {
    const dir = `editor/${clipId}/${basisHash(filename)}`;
    return { cleanKey: `${dir}/clean.mp4`, thumbnailsKey: `${dir}/thumbnails.jpg` };
  },
  editorExport: (jobId: string) => `editor-exports/${jobId}.mp4`,
  presetExport: (exportId: string) => `exports/${exportId}.mp4`,
  youtubeSource: (videoId: string) => `sources/youtube/${videoId}/source.mp4`,
  youtubeTranscript: (videoId: string) => `sources/youtube/${videoId}/source.transcript_cache.json`,
  userFontsDir: (userId: string) => `fonts/${safeUserSegment(userId)}/`,
  userFontPrefix: (userId: string) => `usr-${safeUserSegment(userId).slice(0, 8)}`,
};

const UPLOAD_URL = /^upload:\/\/([0-9a-f-]{36})\.(mp4|mov|avi|mkv|webm|m4v)$/;

/** Storage keys of an `upload://{uuid}{ext}` source and its word-timing sidecar; null if malformed. */
export function uploadKeys(url: string): { video: string; transcript: string } | null {
  const match = UPLOAD_URL.exec(url);
  if (!match) return null;
  return { video: `uploads/${match[1]}.${match[2]}`, transcript: `uploads/${match[1]}.transcript_cache.json` };
}
