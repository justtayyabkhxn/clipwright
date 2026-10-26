/** @vitest-environment node */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resetEnv } from "./env";
import { deleteUserFont, fontDirs, fontFamilyName, listFonts, resolveFontFile, saveUserFont } from "./fonts";
import { getStorage } from "./storage";

// Output of font_registry.get_font_family_name for the bundled fonts at 1dbb178.
const PYTHON_FAMILY_NAMES: Record<string, string> = {
  "Anton-Regular.ttf": "Anton",
  "ArchivoBlack-Regular.ttf": "Archivo Black",
  "Bangers-Regular.ttf": "Bangers",
  "BarlowCondensed-Bold.ttf": "Barlow Condensed",
  "BebasNeue-Regular.ttf": "Bebas Neue",
  "DMSans.ttf": "DM Sans 9pt",
  "Inter.ttf": "Inter",
  "LeagueSpartan.ttf": "League Spartan Thin",
  "Montserrat-Variable-wght.ttf": "Montserrat Thin",
  "NunitoSans.ttf": "Nunito Sans 12pt ExtraLight",
  "OpenSans.ttf": "Open Sans",
  "Oswald-Variable-wght.ttf": "Oswald",
  "Poppins-ExtraBold.ttf": "Poppins ExtraBold",
  "Raleway-Variable-wght.ttf": "Raleway Thin",
  "Roboto.ttf": "Roboto",
  "Rubik.ttf": "Rubik Light",
  "Sora.ttf": "Sora",
  "THEBOLDFONT.ttf": "THE BOLD FONT FREE VERSION",
  "TikTokSans-Bold.ttf": "TikTok Sans",
  "TikTokSans-Regular.ttf": "TikTok Sans Light",
  "Urbanist.ttf": "Urbanist",
  "WorkSans.ttf": "Work Sans",
};

const USER = "65f0c0ffee1234567890abcd";
const bundledDir = path.join(process.cwd(), "fonts");
let dataDir: string;
const baseEnv = { ...process.env };

beforeAll(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "cw-fonts-"));
  process.env = { ...baseEnv, MONGODB_URI: "mongodb://unused", BETTER_AUTH_SECRET: "s".repeat(32), DATA_DIR: dataDir };
  resetEnv();
});

afterAll(async () => {
  process.env = baseEnv;
  await fs.rm(dataDir, { recursive: true, force: true });
});

const bundled = (name: string) => fs.readFile(path.join(bundledDir, name));
const upload = async (filename: string, source = "Poppins-ExtraBold.ttf") =>
  saveUserFont(USER, { filename, body: Readable.from([await bundled(source)]) });

describe("name table", () => {
  it("reads the same family names as font_registry.py", async () => {
    for (const [file, name] of Object.entries(PYTHON_FAMILY_NAMES)) {
      expect([file, fontFamilyName(await bundled(file))]).toEqual([file, name]);
    }
  });

  it("returns null for data that is not a font", () => {
    expect(fontFamilyName(Buffer.from("not a font at all"))).toBeNull();
    expect(fontFamilyName(Buffer.alloc(4))).toBeNull();
  });
});

describe("fonts", () => {
  it("lists bundled fonts sorted by display name", async () => {
    const fonts = await listFonts(USER);
    expect(fonts.length).toBe(Object.keys(PYTHON_FAMILY_NAMES).length);
    expect(fonts.find((font) => font.name === "THEBOLDFONT")).toEqual({
      name: "THEBOLDFONT",
      display_name: "THE BOLD FONT FREE VERSION",
      filename: "THEBOLDFONT.ttf",
      format: "ttf",
      scope: "system",
      supported_languages: null,
    });
    const names = fonts.map((font) => font.display_name);
    expect(names).toEqual([...names].sort());
  });

  it("stores uploads under the user's prefix with collision suffixes", async () => {
    const first = await upload("My Font!.TTF");
    expect(first).toEqual({
      name: "usr-65f0c0ff-my-font",
      display_name: "Poppins ExtraBold",
      filename: "usr-65f0c0ff-my-font.ttf",
      format: "ttf",
      scope: "user",
    });
    expect((await upload("my-font.ttf")).filename).toBe("usr-65f0c0ff-my-font-2.ttf");
    expect((await upload("my-font.ttf")).filename).toBe("usr-65f0c0ff-my-font-3.ttf");
    expect(await getStorage().stat(`fonts/${USER}/usr-65f0c0ff-my-font.ttf`)).toMatchObject({ size: (await bundled("Poppins-ExtraBold.ttf")).length });

    // Same display name, so file order decides, as with Python's sorted(glob): "-" sorts before ".".
    const fonts = await listFonts(USER);
    expect(fonts.filter((font) => font.scope === "user").map((font) => font.name)).toEqual([
      "usr-65f0c0ff-my-font-2",
      "usr-65f0c0ff-my-font-3",
      "usr-65f0c0ff-my-font",
    ]);
    expect((await listFonts("someone-else")).some((font) => font.scope === "user")).toBe(false);
  });

  it("validates uploads", async () => {
    await expect(upload("")).rejects.toMatchObject({ status: 400, detail: "Missing file name" });
    await expect(upload("font.woff2")).rejects.toMatchObject({ status: 400, detail: "Only .ttf and .otf fonts are supported" });
    await expect(upload("!!!.otf")).rejects.toMatchObject({ status: 400, detail: "Invalid font file name" });
    const big = Readable.from([Buffer.alloc(10 * 1024 * 1024 + 1)]);
    await expect(saveUserFont(USER, { filename: "big.ttf", body: big })).rejects.toThrow("The upload limit is 10 MB");
    expect(await getStorage().stat(`fonts/${USER}/usr-65f0c0ff-big.ttf`)).toBeNull();
  });

  it("resolves exact names, stems and normalized names, user fonts first", async () => {
    expect(await resolveFontFile("Inter.ttf", null)).toMatchObject({ name: "Inter", scope: "system", filePath: path.join(bundledDir, "Inter.ttf") });
    expect(await resolveFontFile("TikTokSans-Bold", USER)).toMatchObject({ filename: "TikTokSans-Bold.ttf", format: "ttf" });
    expect(await resolveFontFile("tiktok sans bold", USER)).toMatchObject({ filename: "TikTokSans-Bold.ttf" });
    const user = await resolveFontFile("usr-65f0c0ff-my-font", USER);
    expect(user).toMatchObject({ scope: "user", filename: "usr-65f0c0ff-my-font.ttf" });
    expect(await fs.stat(user!.filePath)).toBeTruthy();
    expect(await resolveFontFile("usr-65f0c0ff-my-font", "someone-else")).toBeNull();
    expect(await resolveFontFile("../fonts/Inter.ttf", USER)).toBeNull();
    expect(await resolveFontFile("   ", USER)).toBeNull();
    expect(await resolveFontFile("Missing", USER)).toBeNull();
  });

  it("deletes only the user's own fonts", async () => {
    await expect(deleteUserFont(USER, "Inter")).rejects.toMatchObject({ status: 403, detail: "Bundled system fonts cannot be deleted" });
    await expect(deleteUserFont(USER, "nope")).rejects.toMatchObject({ status: 404, detail: "Custom font not found" });
    await expect(deleteUserFont("someone-else", "usr-65f0c0ff-my-font")).rejects.toMatchObject({ status: 404 });
    expect(await deleteUserFont(USER, "usr-65f0c0ff-my-font-2")).toBe("usr-65f0c0ff-my-font-2");
    expect(await deleteUserFont(USER, "usr-65f0c0ff-my-font-3.ttf")).toBe("usr-65f0c0ff-my-font-3");
    expect(await resolveFontFile("usr-65f0c0ff-my-font-2", USER)).toBeNull();
  });

  it("gives the engine the bundled directory first", async () => {
    const dirs = await fontDirs(USER);
    expect(dirs[0]).toBe(bundledDir);
    expect(dirs[1]).toBe(path.join(dataDir, "storage", "fonts", USER));
  });
});
