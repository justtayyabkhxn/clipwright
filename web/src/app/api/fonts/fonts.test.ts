/** @vitest-environment node */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { MongoMemoryServer } from "mongodb-memory-server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getAuth } from "@/server/auth";
import { closeDb, ensureIndexes } from "@/server/db";
import { resetEnv } from "@/server/env";
import { MAX_FONT_UPLOAD_BYTES } from "@/server/fonts";
import { DELETE as deleteFont, GET as getFont } from "./[fontName]/route";
import { GET as listFonts } from "./route";
import { POST as uploadFont } from "./upload/route";

let mongod: MongoMemoryServer;
let dataDir: string;
const baseEnv = { ...process.env };
const SAMPLE = path.join(process.cwd(), "fonts", "Bangers-Regular.ttf");

type User = { id: string; cookie: string };
let owner: User;
let stranger: User;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "cw-font-routes-"));
  process.env = {
    ...baseEnv,
    MONGODB_URI: mongod.getUri(),
    MONGODB_DB: "font_routes",
    MONGODB_TRANSACTIONS: "false",
    BETTER_AUTH_SECRET: "a-very-long-test-secret-for-font-routes-0001",
    BETTER_AUTH_URL: "http://localhost:3000",
    DATA_DIR: dataDir,
  };
  resetEnv();
  await ensureIndexes();
  owner = await signUp("owner@example.com");
  stranger = await signUp("stranger@example.com");
}, 60_000);

afterAll(async () => {
  await closeDb();
  await mongod.stop();
  await fs.rm(dataDir, { recursive: true, force: true });
  process.env = baseEnv;
});

async function signUp(email: string): Promise<User> {
  const response = await getAuth().api.signUpEmail({
    body: { email, password: "correct horse battery", name: email.split("@")[0] },
    asResponse: true,
  });
  const { user } = (await response.json()) as { user: { id: string } };
  return { id: user.id, cookie: response.headers.get("set-cookie")!.split(";")[0] };
}

const request = (user: User | null, init: RequestInit = {}) =>
  new Request("http://localhost:3000/api/fonts", { ...init, headers: { ...(user && { cookie: user.cookie }), ...init.headers } });
const fontParams = (fontName: string) => ({ params: Promise.resolve({ fontName }) });

// Encoded through Response: a Request built on this test environment's FormData drops the cookie header.
async function upload(user: User | null, file: { name: string; data: Uint8Array<ArrayBuffer> } | null, field = "file") {
  const form = new FormData();
  form.append("note", "hello");
  if (file) form.append(field, new Blob([file.data]), file.name);
  const encoded = new Response(form);
  const body = await encoded.arrayBuffer();
  return uploadFont(request(user, { method: "POST", body, headers: { "content-type": encoded.headers.get("content-type")! } }));
}

describe("font routes", () => {
  it("lists bundled fonts without server paths", async () => {
    expect((await listFonts(request(null))).status).toBe(401);
    const { fonts } = await (await listFonts(request(owner))).json();
    const regular = fonts.find((font: { name: string }) => font.name === "TikTokSans-Regular");
    expect(regular).toEqual({
      name: "TikTokSans-Regular",
      display_name: "TikTok Sans Light",
      filename: "TikTokSans-Regular.ttf",
      format: "ttf",
      scope: "system",
      supported_languages: null,
    });
    expect(fonts.some((font: object) => "file_path" in font)).toBe(false);
  });

  it("serves bundled fonts by stem or file name", async () => {
    const data = await fs.readFile(SAMPLE);
    for (const name of ["Bangers-Regular", "Bangers-Regular.ttf", "bangersregular"]) {
      const response = await getFont(request(owner), fontParams(name));
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("font/ttf");
      expect(response.headers.get("cache-control")).toBe("private, no-cache");
      expect(Buffer.from(await response.arrayBuffer()).equals(data)).toBe(true);
    }
    expect((await getFont(request(null), fontParams("Bangers-Regular"))).status).toBe(401);
  });

  it.each(["../package.json", "..\\package.json", "../../web/package.json", "..", "fonts/Inter.ttf", "%2e%2e%2fpackage.json", "C:\\Windows\\win.ini"])(
    "refuses path traversal: %s",
    async (name) => {
      const response = await getFont(request(owner), fontParams(name));
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ detail: "Font not found" });
      expect((await deleteFont(request(owner, { method: "DELETE" }), fontParams(name))).status).toBe(404);
    },
  );

  it("uploads, serves and deletes a user font", async () => {
    const data = new Uint8Array(await fs.readFile(SAMPLE));
    const created = await upload(owner, { name: "My Brand!.ttf", data });
    expect(created.status).toBe(200);
    const { font, message } = await created.json();
    expect(message).toBe("Font uploaded successfully");
    expect(font).toEqual({
      name: expect.stringMatching(/^usr-[0-9a-f]{8}-my-brand$/),
      display_name: "Bangers",
      filename: expect.stringMatching(/^usr-[0-9a-f]{8}-my-brand\.ttf$/),
      format: "ttf",
      scope: "user",
    });

    const second = await (await upload(owner, { name: "My Brand!.ttf", data })).json();
    expect(second.font.name).toBe(`${font.name}-2`);

    const { fonts } = await (await listFonts(request(owner))).json();
    expect(fonts.filter((item: { scope: string }) => item.scope === "user").map((item: { name: string }) => item.name).sort()).toEqual(
      [font.name, `${font.name}-2`].sort(),
    );
    const others = await (await listFonts(request(stranger))).json();
    expect(others.fonts.some((item: { scope: string }) => item.scope === "user")).toBe(false);

    const served = await getFont(request(owner), fontParams(font.name));
    expect(served.status).toBe(200);
    expect(new Uint8Array(await served.arrayBuffer())).toEqual(data);
    expect((await getFont(request(stranger), fontParams(font.name))).status).toBe(404);
    expect((await deleteFont(request(stranger, { method: "DELETE" }), fontParams(font.name))).status).toBe(404);

    const deleted = await deleteFont(request(owner, { method: "DELETE" }), fontParams(font.filename));
    expect(await deleted.json()).toEqual({ font_name: font.name, message: "Font deleted successfully" });
    expect((await getFont(request(owner), fontParams(font.name))).status).toBe(404);
  });

  it("refuses to delete bundled fonts", async () => {
    const response = await deleteFont(request(owner, { method: "DELETE" }), fontParams("Inter"));
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ detail: "Bundled system fonts cannot be deleted" });
    const missing = await deleteFont(request(owner, { method: "DELETE" }), fontParams("Nope"));
    expect(await missing.json()).toEqual({ detail: "Custom font not found" });
  });

  it("validates uploads", async () => {
    const tiny = new Uint8Array([0, 1, 0, 0]);
    expect((await upload(null, { name: "a.ttf", data: tiny })).status).toBe(401);

    const woff = await upload(owner, { name: "brand.woff", data: tiny });
    expect(woff.status).toBe(400);
    expect(await woff.json()).toEqual({ detail: "Only .ttf and .otf fonts are supported" });

    const symbols = await upload(owner, { name: "!!!.otf", data: tiny });
    expect(await symbols.json()).toEqual({ detail: "Invalid font file name" });

    const noFile = await upload(owner, null);
    expect(noFile.status).toBe(400);
    expect(await noFile.json()).toEqual({ detail: "No font file provided" });
    expect(await (await upload(owner, { name: "a.ttf", data: tiny }, "video")).json()).toEqual({ detail: "No font file provided" });

    const json = await uploadFont(request(owner, { method: "POST", body: "{}", headers: { "content-type": "application/json" } }));
    expect(await json.json()).toEqual({ detail: "A multipart upload is required" });
    const broken = await uploadFont(
      request(owner, { method: "POST", body: "garbage", headers: { "content-type": "multipart/form-data" } }),
    );
    expect(broken.status).toBe(400);

    const big = await upload(owner, { name: "big.ttf", data: new Uint8Array(MAX_FONT_UPLOAD_BYTES + 1) });
    expect(big.status).toBe(413);
    expect(await big.json()).toEqual({ detail: "Uploaded file is too large. The upload limit is 10 MB." });
    const { fonts } = await (await listFonts(request(owner))).json();
    expect(fonts.some((item: { name: string }) => item.name.endsWith("-big"))).toBe(false);
  });
});
