/** @vitest-environment node */
import { MongoMemoryServer } from "mongodb-memory-server";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { captionLooks, templateInfo, upgradeDocument } from "./caption-templates";
import { closeDb, collections, ensureIndexes } from "./db";
import {
  completePrepare,
  failPrepare,
  getDraft,
  PREPARE_FAILED_MESSAGE,
  readEditorState,
  saveDraft,
  startPrepare,
} from "./drafts";
import { resetEnv } from "./env";
import { claimJob, enqueueJob, finishJob } from "./jobs";
import { basisHash } from "./storage";
import { createTask, settingsFromCreateRequest } from "./tasks";
import { documentDurationError, EditDocumentSchema, type ClipDoc, type EditDocument, type TaskDoc } from "./types";

let mongod: MongoMemoryServer;
const baseEnv = { ...process.env };

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  process.env = { ...baseEnv, MONGODB_URI: mongod.getUri(), MONGODB_DB: "drafts", BETTER_AUTH_SECRET: "s".repeat(32) };
  resetEnv();
  await ensureIndexes();
});

afterAll(async () => {
  await closeDb();
  await mongod.stop();
  process.env = baseEnv;
});

beforeEach(async () => {
  const { tasks, jobs, clipDrafts } = collections();
  await Promise.all([tasks.deleteMany({}), jobs.deleteMany({}), clipDrafts.deleteMany({})]);
});

const DEFAULT_DOCUMENT: EditDocument = {
  version: 1,
  segments: [{ id: "a", start: 0, end: 1 }],
  words: [],
  captions: {
    enabled: true,
    font: "Poppins-ExtraBold",
    size: 54,
    color: "#FFFFFF",
    accent: "#FACC15",
    y: 0.78,
    background: true,
    wordsPerLine: 4,
    karaoke: false,
    uppercase: false,
    template: "default",
  },
  framing: { aspect: "vertical", fit: "cover", zoom: 1, x: 0.5, y: 0.5 },
  effects: { brightness: 100, contrast: 100, saturation: 100, blur: 0, hue: 0 },
  volume: 1,
  muted: false,
  hookTitle: "",
};

const ASSET = { width: 1080, height: 1920, fps: 30, duration: 12, hasAudio: true, waveform: [0.1, 0.5] };

describe("EditDocument schema (editor_document.py)", () => {
  it("fills every default like model_dump", () => {
    expect(EditDocumentSchema.parse({ segments: [{ id: "a", start: 0, end: 1 }] })).toEqual(DEFAULT_DOCUMENT);
  });

  it.each([
    ["no segments", { segments: [] }],
    ["a segment shorter than a frame", { segments: [{ id: "a", start: 0, end: 0.03 }] }],
    ["unknown keys", { segments: [{ id: "a", start: 0, end: 1 }], extra: 1 }],
    ["a nested unknown key", { segments: [{ id: "a", start: 0, end: 1 }], framing: { rotate: 90 } }],
    ["a word ending at its start", { segments: [{ id: "a", start: 0, end: 1 }], words: [{ id: "w", start: 1, end: 1, text: "x" }] }],
    ["a caption size out of range", { segments: [{ id: "a", start: 0, end: 1 }], captions: { size: 19 } }],
    ["an unknown font", { segments: [{ id: "a", start: 0, end: 1 }], captions: { font: "Arial" } }],
    ["another version", { segments: [{ id: "a", start: 0, end: 1 }], version: 2 }],
    ["a short colour", { segments: [{ id: "a", start: 0, end: 1 }], captions: { color: "#FFF" } }],
    ["a fractional size", { segments: [{ id: "a", start: 0, end: 1 }], captions: { size: 54.5 } }],
    ["a non-finite number", { segments: [{ id: "a", start: 0, end: Number.POSITIVE_INFINITY }] }],
    ["a long hook title", { segments: [{ id: "a", start: 0, end: 1 }], hookTitle: "x".repeat(201) }],
    ["a long emoji hook title", { segments: [{ id: "a", start: 0, end: 1 }], hookTitle: "🔥".repeat(201) }],
    ["an empty id", { segments: [{ id: "", start: 0, end: 1 }] }],
  ])("rejects %s", (_name, document) => {
    expect(EditDocumentSchema.safeParse(document).success).toBe(false);
  });

  it("counts string limits in code points, like pydantic", () => {
    const doc = EditDocumentSchema.parse({ segments: [{ id: "a", start: 0, end: 1 }], hookTitle: "🔥".repeat(200) });
    expect(doc.hookTitle).toBe("🔥".repeat(200));
    const tooLong = EditDocumentSchema.safeParse({ segments: [{ id: "a", start: 0, end: 1 }], hookTitle: "x".repeat(201) });
    expect(tooLong.error?.issues[0]).toMatchObject({ path: ["hookTitle"], message: "String should have at most 200 characters" });
    expect(upgradeDocument({}, { hookTitle: "🔥".repeat(250) }, { settings: { captionTemplate: "default" } })).toMatchObject({
      hookTitle: "🔥".repeat(200),
    });
  });

  it("explains refinement failures in plain words", () => {
    const result = EditDocumentSchema.safeParse({ segments: [{ id: "a", start: 0, end: 0.03 }] });
    expect(result.error?.issues[0].message).toBe("Each segment must be at least one frame long");
  });

  it("validates against the clip duration", () => {
    const doc = EditDocumentSchema.parse({ segments: [{ id: "a", start: 0, end: 10.04 }, { id: "a", start: 1, end: 2 }] });
    expect(documentDurationError(doc, 10)).toBe("Editor item IDs must be unique");
    expect(documentDurationError(doc, 9.9)).toBe("An edit extends past the original clip");
    const words = EditDocumentSchema.parse({ segments: [{ id: "a", start: 0, end: 1 }], words: [{ id: "w", start: 0, end: 3, text: "hi" }] });
    expect(documentDurationError(words, 2)).toBe("A caption extends past the original clip");
    expect(documentDurationError(DEFAULT_DOCUMENT, 1)).toBeNull();
  });
});

describe("caption templates", () => {
  it("builds caption looks like editor_service.caption_looks", () => {
    const looks = captionLooks();
    expect(Object.keys(looks)).toEqual(["default", "hormozi", "mrbeast", "minimal", "tiktok", "neon", "podcast"]);
    expect(looks.hormozi).toEqual({
      animation: "karaoke",
      wordPop: true,
      wordBox: true,
      wordBoxColor: "#00BF49",
      highlightColor: "#00FF66",
      emphasisColor: "#FFE000",
      strokeColor: "#000000",
      strokeWidth: 4,
      shadow: true,
      glow: false,
      backgroundColor: null,
    });
    expect(looks.minimal).toEqual({
      animation: "fade",
      wordPop: false,
      wordBox: false,
      wordBoxColor: "#FFFFFF",
      highlightColor: "#FFFFFF",
      emphasisColor: "#FFFFFF",
      strokeColor: null,
      strokeWidth: 0,
      shadow: false,
      glow: false,
      backgroundColor: "#00000080",
    });
    expect(looks.neon).toMatchObject({ strokeColor: "#002A6B", strokeWidth: 2, glow: true, shadow: false });
  });

  it("upgrades old drafts like editor_service.upgrade_document", () => {
    const task = { settings: { captionTemplate: "hormozi" } };
    expect(upgradeDocument({ segments: [], captions: { size: 50 } }, { hookTitle: "x".repeat(250) }, task)).toEqual({
      segments: [],
      captions: { size: 50, template: "hormozi", karaoke: true, uppercase: true },
      hookTitle: "x".repeat(200),
    });
    const current = { captions: { template: "minimal", karaoke: true, uppercase: false }, hookTitle: "" };
    expect(upgradeDocument(current, { hookTitle: "T" }, task)).toEqual(current);
    expect(upgradeDocument({ captions: { template: "neon" } }, { hookTitle: null }, { settings: { captionTemplate: "tiktok" } })).toEqual({
      captions: { template: "neon", karaoke: true, uppercase: false },
      hookTitle: "",
    });
  });

  it("lists template info for the API", () => {
    expect(templateInfo()[1]).toEqual({
      id: "hormozi",
      name: "Hormozi",
      description: "Bold green highlight with a pill behind the active word",
      animation: "karaoke",
      font_family: "THEBOLDFONT",
      font_size: 32,
      font_color: "#FFFFFF",
      highlight_color: "#00FF66",
    });
  });
});

describe("drafts", () => {
  let task: TaskDoc;
  let clip: ClipDoc;

  beforeEach(async () => {
    task = await createTask({
      userId: "u1",
      source: { type: "youtube", url: "https://youtu.be/x", title: "T" },
      settings: settingsFromCreateRequest({ caption_template: "tiktok" }),
    });
    const now = new Date();
    clip = {
      id: "clip-1",
      filename: "clip_1.mp4",
      storageKey: `clips/${task._id}/clip_1.mp4`,
      startTime: "00:00",
      endTime: "00:12",
      duration: 12,
      text: "hi",
      relevanceScore: 1,
      reasoning: "",
      viralityScore: 50,
      hookScore: 10,
      engagementScore: 10,
      valueScore: 10,
      shareabilityScore: 10,
      hookType: null,
      hookTitle: "Hook!",
      sourceRanges: [{ start: 0, end: 12 }],
      createdAt: now,
      updatedAt: now,
    };
  });

  async function prepared(document = DEFAULT_DOCUMENT) {
    await startPrepare(task, clip);
    await completePrepare(clip.id, clip.filename, { asset: ASSET, document });
  }

  it("prepares once and reports progress through the editor state", async () => {
    expect(await readEditorState(task, clip)).toEqual({ status: "unprepared", basis: "clip_1.mp4", jobs: [] });
    expect(await startPrepare(task, clip)).toEqual({ status: "preparing" });
    expect(await startPrepare(task, clip)).toEqual({ status: "preparing" });
    const jobs = await collections().jobs.find({ type: "prepare_editor" }).toArray();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ activeKey: "prepare:clip-1", clipId: "clip-1", payload: { filename: "clip_1.mp4" } });
    expect((await getDraft(clip.id))?.jobId).toBe(jobs[0]._id);
    expect(await readEditorState(task, clip)).toMatchObject({ status: "preparing" });

    expect(await completePrepare(clip.id, clip.filename, { asset: ASSET, document: DEFAULT_DOCUMENT })).toBe(true);
    expect(await startPrepare(task, clip)).toEqual({ status: "ready" });
    const draft = await getDraft(clip.id);
    expect(draft).toMatchObject({ status: "ready", revision: 0, asset: ASSET, document: DEFAULT_DOCUMENT, original: DEFAULT_DOCUMENT });
    expect(draft?.media?.cleanKey).toBe(`editor/clip-1/${basisHash("clip_1.mp4")}/clean.mp4`);
  });

  it("never overwrites an existing draft with the same basis", async () => {
    await prepared();
    const edited = { ...DEFAULT_DOCUMENT, muted: true };
    await saveDraft(clip, { basis: clip.filename, revision: 0, document: edited });
    expect(await completePrepare(clip.id, clip.filename, { asset: { ...ASSET, fps: 25 }, document: DEFAULT_DOCUMENT })).toBe(true);
    const draft = await getDraft(clip.id);
    expect(draft).toMatchObject({ revision: 1, document: { muted: true }, asset: { fps: 25 } });
    expect(await completePrepare(clip.id, "other.mp4", { asset: ASSET, document: DEFAULT_DOCUMENT })).toBe(false);
  });

  it("follows a prepare job that is already queued", async () => {
    const existing = await enqueueJob({ type: "prepare_editor", taskId: task._id, clipId: clip.id, userId: "u1", activeKey: "prepare:clip-1" });
    await startPrepare(task, clip);
    expect((await getDraft(clip.id))?.jobId).toBe(existing.job._id);
  });

  it("marks a failed prepare and lets it be retried", async () => {
    await startPrepare(task, clip);
    const { jobId } = (await getDraft(clip.id))!;
    await failPrepare(clip.id, "some-other-job");
    expect((await getDraft(clip.id))?.status).toBe("preparing");
    await failPrepare(clip.id, jobId!);
    expect(await readEditorState(task, clip)).toEqual({ status: "failed", error: PREPARE_FAILED_MESSAGE, basis: "clip_1.mp4", jobs: [] });

    const job = await claimJob("w1");
    await finishJob(job!, { status: "failed" });
    expect(await startPrepare(task, clip)).toEqual({ status: "preparing" });
    expect((await getDraft(clip.id))?.status).toBe("preparing");
  });

  it("treats a draft for an older clip file as unprepared and resets it", async () => {
    await prepared();
    const rewritten = { ...clip, filename: "clip_1_v2.mp4" };
    expect(await readEditorState(task, rewritten)).toMatchObject({ status: "unprepared", basis: "clip_1_v2.mp4" });
    await finishJob((await claimJob("w1"))!, { status: "succeeded" });
    await startPrepare(task, rewritten);
    const draft = await getDraft(clip.id);
    expect(draft).toMatchObject({ basis: "clip_1_v2.mp4", status: "preparing", revision: 0 });
    expect(draft).not.toHaveProperty("document");
  });

  it("saves with a revision compare-and-set", async () => {
    await prepared();
    const next = { ...DEFAULT_DOCUMENT, volume: 1.5 };
    expect(await saveDraft(clip, { basis: clip.filename, revision: 0, document: next })).toEqual({ revision: 1, document: next });
    await expect(saveDraft(clip, { basis: clip.filename, revision: 0, document: next })).rejects.toMatchObject({
      status: 409,
      detail: "This clip was edited in another tab. Reload the saved draft before continuing.",
    });
    expect((await saveDraft(clip, { basis: clip.filename, revision: 1, document: next })).revision).toBe(2);
  });

  it("rejects a changed basis, an unready preview and invalid payloads", async () => {
    await expect(saveDraft(clip, { basis: clip.filename, revision: 0, document: DEFAULT_DOCUMENT })).rejects.toMatchObject({
      status: 409,
      detail: "Wait for the editor preview to finish preparing",
    });
    await prepared();
    await expect(saveDraft(clip, { basis: "old.mp4", revision: 0, document: DEFAULT_DOCUMENT })).rejects.toMatchObject({
      status: 409,
      detail: "The original clip changed. Reopen the editor.",
    });
    for (const revision of [true, -1, 1.5, "0", undefined]) {
      await expect(saveDraft(clip, { basis: clip.filename, revision, document: DEFAULT_DOCUMENT })).rejects.toMatchObject({
        status: 400,
        detail: "Invalid draft revision",
      });
    }
    await expect(saveDraft(clip, { basis: clip.filename, revision: 0, document: { segments: [] } })).rejects.toMatchObject({ status: 400 });
    const tooLong = { ...DEFAULT_DOCUMENT, segments: [{ id: "a", start: 0, end: 13 }] };
    await expect(saveDraft(clip, { basis: clip.filename, revision: 0, document: tooLong })).rejects.toMatchObject({
      status: 400,
      detail: "An edit extends past the original clip",
    });
  });

  it("returns the ready EditorState with upgraded documents, looks and editor jobs", async () => {
    const legacy = { ...DEFAULT_DOCUMENT, captions: { ...DEFAULT_DOCUMENT.captions } } as Record<string, unknown>;
    delete legacy.hookTitle;
    delete (legacy.captions as Record<string, unknown>).karaoke;
    await prepared(legacy as EditDocument);

    const queued = await enqueueJob({ type: "export_editor", taskId: task._id, clipId: clip.id, userId: "u1" });
    const combine = await enqueueJob({ type: "combine_editor", taskId: task._id, clipId: clip.id, userId: "u1" });
    await enqueueJob({ type: "export_clip", taskId: task._id, clipId: clip.id, userId: "u1" });
    await collections().jobs.updateOne(
      { _id: combine.job._id },
      { $set: { status: "succeeded", progress: 100, result: { clip_id: "new-clip", fileKey: "editor-exports/x.mp4" } } },
    );
    await collections().jobs.updateOne(
      { _id: queued.job._id },
      { $set: { createdAt: new Date(Date.now() - 60_000), status: "running", progress: 40 } },
    );

    const state = await readEditorState(task, clip);
    expect(state).toMatchObject({ status: "ready", basis: "clip_1.mp4", ...ASSET, draft: { revision: 0 } });
    if (state.status !== "ready") throw new Error("not ready");
    expect(state.draft.document.hookTitle).toBe("Hook!");
    expect(state.draft.document.captions).toMatchObject({ template: "default", karaoke: true });
    expect(state.original.hookTitle).toBe("Hook!");
    expect(Object.keys(state.captionLooks)).toContain("podcast");
    expect(state.jobs).toEqual([
      { id: combine.job._id, status: "completed", progress: 100, clip_id: "new-clip" },
      { id: queued.job._id, status: "rendering", progress: 40 },
    ]);
  });
});
