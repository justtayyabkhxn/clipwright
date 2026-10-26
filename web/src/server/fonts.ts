import fs from "node:fs/promises";
import path from "node:path";
import { paths } from "./env";
import { ApiError } from "./http";
import { getStorage, storageKeys } from "./storage";

export const MAX_FONT_UPLOAD_BYTES = 10 * 1024 * 1024;
const EXTENSIONS = [".ttf", ".otf"];

export type FontInfo = {
  name: string;
  display_name: string;
  filename: string;
  format: "ttf" | "otf";
  scope: "system" | "user";
  supported_languages: string[] | null;
};

export type ResolvedFont = Omit<FontInfo, "display_name" | "supported_languages"> & { filePath: string };

// --- TTF/OTF name table (port of font_registry.get_font_family_name) ---

const NAME_ID_FAMILY = 1;
const NAME_ID_FULL = 4;
const ASS_UNSAFE = /[(){}\\]/;

function decodeName(raw: Buffer, platformId: number): string {
  const clean = (value: string) => value.replace(/^\0+|\0+$/g, "").trim();
  if (platformId === 0 || platformId === 3) {
    const swapped = Buffer.from(raw.subarray(0, raw.length - (raw.length % 2)));
    swapped.swap16();
    return clean(swapped.toString("utf16le"));
  }
  return clean(raw.toString("latin1"));
}

/** The family name renderers match on, preferring names safe in ASS `\fn` tags; null if unreadable. */
export function fontFamilyName(data: Buffer): string | null {
  try {
    if (data.length < 12) return null;
    const tableCount = data.readUInt16BE(4);
    let nameOffset: number | null = null;
    let nameLength = 0;
    for (let i = 0; i < tableCount; i++) {
      const record = 12 + i * 16;
      if (record + 16 > data.length) return null;
      if (data.toString("latin1", record, record + 4) === "name") {
        nameOffset = data.readUInt32BE(record + 8);
        nameLength = data.readUInt32BE(record + 12);
        break;
      }
    }
    if (nameOffset === null || nameOffset + Math.min(nameLength, 6) > data.length) return null;
    const count = data.readUInt16BE(nameOffset + 2);
    const storageStart = nameOffset + data.readUInt16BE(nameOffset + 4);
    const candidates: Record<number, string[]> = { [NAME_ID_FAMILY]: [], [NAME_ID_FULL]: [] };
    for (let i = 0; i < count; i++) {
      const record = nameOffset + 6 + i * 12;
      if (record + 12 > data.length) break;
      const platformId = data.readUInt16BE(record);
      const languageId = data.readUInt16BE(record + 4);
      const nameId = data.readUInt16BE(record + 6);
      const length = data.readUInt16BE(record + 8);
      const start = storageStart + data.readUInt16BE(record + 10);
      if (!(nameId in candidates) || start + length > data.length) continue;
      const decoded = decodeName(data.subarray(start, start + length), platformId);
      if (!decoded) continue;
      // English records first, every valid name kept as a fallback.
      if (languageId === 0x0409 || languageId === 0) candidates[nameId].unshift(decoded);
      else candidates[nameId].push(decoded);
    }
    const families = [...new Set(candidates[NAME_ID_FAMILY])];
    const fullNames = candidates[NAME_ID_FULL];
    const shortest = (names: string[]) => names.reduce((a, b) => (b.length < a.length ? b : a));
    for (const names of [families, fullNames]) {
      const safe = names.filter((name) => !ASS_UNSAFE.test(name));
      if (safe.length) return shortest(safe);
    }
    if (families.length) return shortest(families);
    return fullNames[0] ?? null;
  } catch {
    return null;
  }
}

const titleCase = (stem: string) =>
  stem
    .replace(/[-_]/g, " ")
    .trim()
    .toLowerCase()
    .replace(/(^|[^a-z])([a-z])/g, (_match, before: string, letter: string) => before + letter.toUpperCase());

const displayNames = new Map<string, string>();

async function displayName(filePath: string, stem: string, stat: { size: number; mtimeMs: number }) {
  const cacheKey = `${filePath}:${stat.size}:${stat.mtimeMs}`;
  let name = displayNames.get(cacheKey);
  if (!name) {
    const data = await fs.readFile(filePath).catch(() => null);
    name = (data && fontFamilyName(data)) || titleCase(stem);
    displayNames.set(cacheKey, name);
  }
  return name;
}

const splitName = (filename: string) => {
  const ext = path.extname(filename).toLowerCase();
  return { stem: filename.slice(0, filename.length - ext.length), ext };
};

type FontFile = { filename: string; filePath: string; scope: "system" | "user"; size: number; mtimeMs: number };

async function bundledFiles(): Promise<FontFile[]> {
  const dir = paths.bundledFontsDir;
  const names = await fs.readdir(dir).catch(() => [] as string[]);
  const files: FontFile[] = [];
  for (const filename of names.sort()) {
    if (!EXTENSIONS.includes(splitName(filename).ext)) continue;
    const filePath = path.join(dir, filename);
    const stat = await fs.stat(filePath).catch(() => null);
    if (stat?.isFile()) files.push({ filename, filePath, scope: "system", size: stat.size, mtimeMs: stat.mtimeMs });
  }
  return files;
}

async function userFiles(userId: string): Promise<FontFile[]> {
  const storage = getStorage();
  const files: FontFile[] = [];
  for (const item of await storage.list(storageKeys.userFontsDir(userId))) {
    const filename = item.key.slice(item.key.lastIndexOf("/") + 1);
    if (!EXTENSIONS.includes(splitName(filename).ext)) continue;
    files.push({ filename, filePath: await storage.localPath(item.key), scope: "user", size: item.size, mtimeMs: item.mtimeMs });
  }
  return files;
}

// Python collected .ttf before .otf in each directory; the sort below is stable.
const byExtension = (a: FontFile, b: FontFile) =>
  EXTENSIONS.indexOf(splitName(a.filename).ext) - EXTENSIONS.indexOf(splitName(b.filename).ext);

/** Bundled fonts plus the user's uploads, sorted by display name. */
export async function listFonts(userId: string | null): Promise<FontInfo[]> {
  const files = [
    ...(await bundledFiles()).sort(byExtension),
    ...(userId ? (await userFiles(userId)).sort(byExtension) : []),
  ];
  const fonts = await Promise.all(
    files.map(async (file): Promise<FontInfo> => {
      const { stem, ext } = splitName(file.filename);
      return {
        name: stem,
        display_name: await displayName(file.filePath, stem, file),
        filename: file.filename,
        format: ext.slice(1) as FontInfo["format"],
        scope: file.scope,
        // Python asked fontconfig (fc-query), which is not available here.
        supported_languages: null,
      };
    }),
  );
  return fonts.sort((a, b) => (a.display_name < b.display_name ? -1 : a.display_name > b.display_name ? 1 : 0));
}

const resolved = (file: FontFile): ResolvedFont => {
  const { stem, ext } = splitName(file.filename);
  return { name: stem, filename: file.filename, format: ext.slice(1) as FontInfo["format"], scope: file.scope, filePath: file.filePath };
};

const isPlainName = (name: string) => Boolean(name) && !/[\\/]/.test(name) && !name.includes("..");

/** Exact file name, then stem + extension (user fonts first), then a normalized-name match. */
export async function resolveFontFile(fontName: string, userId: string | null): Promise<ResolvedFont | null> {
  const requested = fontName.trim();
  if (!isPlainName(requested)) return null;
  const groups = [userId ? await userFiles(userId) : [], await bundledFiles()];
  for (const files of groups) {
    const exact = files.find((file) => file.filename === requested);
    if (exact) return resolved(exact);
    for (const ext of EXTENSIONS) {
      const match = files.find((file) => file.filename === `${requested}${ext}`);
      if (match) return resolved(match);
    }
  }
  const normalize = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, "");
  const target = normalize(requested);
  const font = (await listFonts(userId)).find((candidate) => normalize(candidate.name) === target);
  if (!font) return null;
  return resolved(groups.flat().find((file) => file.filename === font.filename && file.scope === font.scope)!);
}

/** Directories the engine searches for fonts, bundled first. */
export async function fontDirs(userId: string): Promise<string[]> {
  const userDir = path.dirname(await getStorage().localPath(`${storageKeys.userFontsDir(userId)}x.ttf`));
  return [paths.bundledFontsDir, userDir];
}

export async function saveUserFont(
  userId: string,
  file: { filename: string; body: ReadableStream<Uint8Array> | NodeJS.ReadableStream },
): Promise<Omit<FontInfo, "supported_languages">> {
  if (!file.filename) throw new ApiError(400, "Missing file name");
  const { stem: originalStem, ext } = splitName(path.basename(file.filename));
  if (!EXTENSIONS.includes(ext)) throw new ApiError(400, "Only .ttf and .otf fonts are supported");
  const safeStem = originalStem.replace(/[^A-Za-z0-9_-]/g, "-").replace(/^-+|-+$/g, "");
  if (!safeStem) throw new ApiError(400, "Invalid font file name");

  const storage = getStorage();
  const dir = storageKeys.userFontsDir(userId);
  const stem = `${storageKeys.userFontPrefix(userId)}-${safeStem}`.toLowerCase();
  let filename = `${stem}${ext}`;
  for (let suffix = 2; await storage.stat(`${dir}${filename}`); suffix++) filename = `${stem}-${suffix}${ext}`;

  const key = `${dir}${filename}`;
  await storage.writeStream(key, file.body, { maxBytes: MAX_FONT_UPLOAD_BYTES });
  const stat = (await storage.stat(key))!;
  const { stem: storedStem } = splitName(filename);
  return {
    name: storedStem,
    display_name: await displayName(await storage.localPath(key), safeStem, stat),
    filename,
    format: ext.slice(1) as FontInfo["format"],
    scope: "user",
  };
}

/** Delete one of the user's fonts; returns its name. Bundled fonts are refused with 403. */
export async function deleteUserFont(userId: string, fontName: string): Promise<string> {
  const requested = fontName.trim();
  const files = isPlainName(requested) ? await userFiles(userId) : [];
  const match =
    files.find((file) => file.filename === requested) ??
    (path.extname(requested) ? undefined : files.find((file) => EXTENSIONS.some((ext) => file.filename === `${requested}${ext}`)));
  if (!match) {
    if (await resolveFontFile(requested, null)) throw new ApiError(403, "Bundled system fonts cannot be deleted");
    throw new ApiError(404, "Custom font not found");
  }
  await getStorage().delete(`${storageKeys.userFontsDir(userId)}${match.filename}`);
  return splitName(match.filename).stem;
}
