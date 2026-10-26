/** @vitest-environment node */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { MongoMemoryServer } from "mongodb-memory-server";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getAuth } from "@/server/auth";
import { closeDb, collections, ensureIndexes } from "@/server/db";
import {
  CLIP_CHANGED_MESSAGE,
  completePrepare,
  failPrepare,
  NOT_READY_MESSAGE,
  PREPARE_FAILED_MESSAGE,
  REVISION_CONFLICT_MESSAGE,
} from "@/server/drafts";
import { resetEnv } from "@/server/env";
import { claimJob, finishJob, writeWorkerHeartbeat } from "@/server/jobs";
import { getStorage, storageKeys } from "@/server/storage";
import { createTask, settingsFromCreateRequest } from "@/server/tasks";
import { EditDocumentSchema, type ClipDoc, type TaskDoc } from "@/server/types";
import { POST as combine } from "@/app/api/tasks/[id]/editor/combine/route";
import { GET as exportFile } from "./exports/[jobId]/file/route";
import { DELETE as cancelExport, GET as exportStatus } from "./exports/[jobId]/route";
import { POST as startExport } from "./exports/route";
import { GET as media } from "./media/[asset]/route";
import { POST as prepare } from "./prepare/route";
import { GET as getEditor, PATCH as saveEditor } from "./route";

let mongod: MongoMemoryServer;
let dataDir: string;
const baseEnv = { ...process.env };

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "cw-editor-"));
  process.env = {
    ...baseEnv,
    MONGODB_URI: mongod.getUri(),
    MONGODB_DB: "editor_routes",
    MONGODB_TRANSACTIONS: "false",
    BETTER_AUTH_SECRET: "a-very-long-test-secret-for-editor-routes-01",
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

type User = { id: string; cookie: string };
let owner: User;
let stranger: User;

async function signUp(email: string): Promise<User> {
  const response = await getAuth().api.signUpEmail({
    body: { email, password: "correct horse battery", name: email.split("@")[0] },
    asResponse: true,
  });
  const { user } = (await response.json()) as { user: { id: string } };
  return { id: user.id, cookie: response.headers.get("set-cookie")!.split(";")[0] };
}

type Handler = (request: Request, context: { params: Promise<never> }) => Promise<Response>;

function call(
  handler: unknown,
  params: Record<string, string>,
  { method = "GET", user = owner as User | null, body, headers = {} }: {
    method?: string;
    user?: User | null;
    body?: unknown;
    headers?: Record<string, string>;
  } = {},
) {
  const init: RequestInit & { headers: Record<string, string> } = { method, headers: { ...headers } };
  if (user) init.headers.cookie = user.cookie;
  if (body !== undefined) {
    init.body = typeof body === "string" ? body : JSON.stringify(body);
    init.headers["content-type"] = "application/json";
  }
  return (handler as Handler)(new Request("http://localhost:3000/api/editor", init), {
    params: Promise.resolve(params) as Promise<never>,
  });
}

const DURATION = 12;
const ASSET = { width: 1080, height: 1920, fps: 30, duration: DURATION, hasAudio: true, waveform: [0.2, 0.8] };
const DOCUMENT = EditDocumentSchema.parse({
  segments: [{ id: "original", start: 0, end: DURATION }],
  words: [{ id: "word-0", start: 0.5, end: 1, text: "hello" }],
  hookTitle: "Hook",
});

function makeClip(taskId: string, id: string, filename: string): ClipDoc {
  const now = new Date();
  return {
    id,
    filename,
    storageKey: storageKeys.clip(taskId, filename),
    startTime: "00:10",
    endTime: "00:22",
    duration: DURATION,
    text: "hello world",
    relevanceScore: 0.9,
    reasoning: "Strong hook",
    viralityScore: 80,
    hookScore: 20,
    engagementScore: 20,
    valueScore: 20,
    shareabilityScore: 20,
    hookType: "question",
    hookTitle: "Hook",
    sourceRanges: [{ start: 10, end: 22 }],
    createdAt: now,
    updatedAt: now,
  };
}

let task: TaskDoc;
let clipA: ClipDoc;
let clipB: ClipDoc;
const clipParams = (clip: ClipDoc = clipA) => ({ id: task._id, clipId: clip.id });

beforeEach(async () => {
  const { tasks, jobs, clipDrafts, workerStatus } = collections();
  await Promise.all([tasks.deleteMany({}), jobs.deleteMany({}), clipDrafts.deleteMany({}), workerStatus.deleteMany({})]);
  task = await createTask({
    userId: owner.id,
    source: { type: "youtube", url: "https://youtu.be/abcdefghijk", title: "Talk" },
    settings: settingsFromCreateRequest({ caption_template: "hormozi" }),
  });
  clipA = makeClip(task._id, `${task._id}-a`, "clip_1.mp4");
  clipB = makeClip(task._id, `${task._id}-b`, "clip_2.mp4");
  await tasks.updateOne({ _id: task._id }, { $set: { status: "completed", clips: [clipA, clipB] } });
});

const setStatus = (status: TaskDoc["status"]) =>
  collections().tasks.updateOne({ _id: task._id }, { $set: { status } });

/** What the prepare_editor handler does once the engine has written the media. */
async function simulatePrepare(clip: ClipDoc) {
  const storage = getStorage();
  const keys = storageKeys.editorMedia(clip.id, clip.filename);
  await storage.writeStream(keys.cleanKey, Readable.from([Buffer.from("0123456789")]));
  await storage.writeStream(keys.thumbnailsKey, Readable.from([Buffer.from("jpeg")]));
  expect(await completePrepare(clip.id, clip.filename, { asset: ASSET, document: DOCUMENT })).toBe(true);
}

const exportBody = (overrides: Record<string, unknown> = {}) => ({
  basis: clipA.filename,
  preset: "reels",
  document: DOCUMENT,
  ...overrides,
});

describe("editor state lifecycle", () => {
  it("guards ownership", async () => {
    expect((await call(getEditor, clipParams(), { user: null })).status).toBe(401);
    expect((await call(getEditor, clipParams(), { user: stranger })).status).toBe(403);
    const missing = await call(getEditor, { id: task._id, clipId: "nope" });
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ detail: "Clip not found" });
    expect((await call(getEditor, { id: "missing-task", clipId: clipA.id })).status).toBe(404);
  });

  it("prepares, then saves drafts with a revision compare-and-set", async () => {
    const initial = await call(getEditor, clipParams());
    expect(await initial.json()).toEqual({ status: "unprepared", basis: "clip_1.mp4", jobs: [] });

    const first = await call(prepare, clipParams(), { method: "POST" });
    expect(first.status).toBe(202);
    expect(await first.json()).toEqual({ status: "preparing", worker_online: false });

    await writeWorkerHeartbeat({ workerId: "w1", startedAt: new Date(), version: "test" });
    const again = await call(prepare, clipParams(), { method: "POST" });
    expect(await again.json()).toEqual({ status: "preparing", worker_online: true });
    const prepareJobs = await collections().jobs.find({ type: "prepare_editor" }).toArray();
    expect(prepareJobs).toHaveLength(1);
    expect(prepareJobs[0]).toMatchObject({ clipId: clipA.id, activeKey: `prepare:${clipA.id}`, payload: { filename: "clip_1.mp4" } });

    expect(await (await call(getEditor, clipParams())).json()).toMatchObject({ status: "preparing" });
    const early = await call(media, { ...clipParams(), asset: "clean.mp4" });
    expect(early.status).toBe(404);
    expect(await early.json()).toEqual({ detail: "Preview not ready" });

    // Saving before the preview is ready is refused.
    const notReady = await call(saveEditor, clipParams(), { method: "PATCH", body: { basis: clipA.filename, revision: 0, document: DOCUMENT } });
    expect(notReady.status).toBe(409);
    expect(await notReady.json()).toEqual({ detail: NOT_READY_MESSAGE });

    await simulatePrepare(clipA);
    const ready = await (await call(getEditor, clipParams())).json();
    expect(ready).toMatchObject({
      status: "ready",
      basis: "clip_1.mp4",
      ...ASSET,
      draft: { revision: 0, document: { hookTitle: "Hook", segments: DOCUMENT.segments } },
      original: { segments: DOCUMENT.segments },
      jobs: [],
    });
    expect(Object.keys(ready.captionLooks)).toContain("hormozi");
    expect((await call(prepare, clipParams(), { method: "POST" }).then((r) => r.json())).status).toBe("ready");

    const save = (body: unknown) => call(saveEditor, clipParams(), { method: "PATCH", body });
    const edited = { ...DOCUMENT, segments: [{ id: "a", start: 1, end: 5 }] };
    const saved = await save({ basis: clipA.filename, revision: 0, document: edited });
    expect(saved.status).toBe(200);
    expect(await saved.json()).toMatchObject({ revision: 1, document: { segments: [{ id: "a", start: 1, end: 5 }] } });

    const stale = await save({ basis: clipA.filename, revision: 0, document: edited });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toEqual({ detail: REVISION_CONFLICT_MESSAGE });

    const changed = await save({ basis: "clip_old.mp4", revision: 1, document: edited });
    expect(changed.status).toBe(409);
    expect(await changed.json()).toEqual({ detail: CLIP_CHANGED_MESSAGE });

    const tooLong = await save({ basis: clipA.filename, revision: 1, document: { ...edited, segments: [{ id: "a", start: 0, end: 20 }] } });
    expect(tooLong.status).toBe(400);
    expect(await tooLong.json()).toEqual({ detail: "An edit extends past the original clip" });

    const extraKey = await save({ basis: clipA.filename, revision: 1, document: { ...edited, rotate: 90 } });
    expect(extraKey.status).toBe(400);
    for (const revision of ["1", true, -1, 1.5]) {
      const bad = await save({ basis: clipA.filename, revision, document: edited });
      expect(await bad.json()).toEqual({ detail: "Invalid draft revision" });
    }
    const invalidJson = await call(saveEditor, clipParams(), { method: "PATCH", body: "{" });
    expect(invalidJson.status).toBe(400);
    expect(await invalidJson.json()).toEqual({ detail: "Invalid JSON body" });

    // As in editor.py, a running restyle or reprocess never blocks autosave.
    await setStatus("processing");
    const duringRestyle = await save({ basis: clipA.filename, revision: 1, document: edited });
    expect(duringRestyle.status).toBe(200);
    expect(await duringRestyle.json()).toMatchObject({ revision: 2 });
    expect((await call(getEditor, clipParams())).status).toBe(200);

    expect((await call(saveEditor, clipParams(), { method: "PATCH", user: stranger, body: {} })).status).toBe(403);
  });

  it("re-queues a prepare whose job ended without preparing the draft", async () => {
    await call(prepare, clipParams(), { method: "POST" });
    const lease = (await claimJob("w1", ["prepare_editor"]))!;
    await failPrepare(clipA.id, lease._id); // the handler's catch, before its finishJob
    // A retry in that window follows the still-running job, which then finishes as failed.
    expect(await (await call(prepare, clipParams(), { method: "POST" })).json()).toMatchObject({ status: "preparing" });
    await finishJob(lease, { status: "failed", error: "boom" });

    expect(await (await call(getEditor, clipParams())).json()).toMatchObject({ status: "failed", error: PREPARE_FAILED_MESSAGE });
    expect(await (await call(prepare, clipParams(), { method: "POST" })).json()).toMatchObject({ status: "preparing" });
    const queued = await collections().jobs.find({ type: "prepare_editor", status: "queued" }).toArray();
    expect(queued).toHaveLength(1);
    expect((await collections().clipDrafts.findOne({ _id: clipA.id }))?.jobId).toBe(queued[0]._id);
    expect(await (await call(getEditor, clipParams())).json()).toMatchObject({ status: "preparing" });

    // A job that never appeared gets a grace period, then counts as dead too.
    const { clipDrafts, jobs } = collections();
    await jobs.deleteMany({});
    await clipDrafts.updateOne({ _id: clipA.id }, { $set: { jobId: "f".repeat(32) } });
    expect(await (await call(getEditor, clipParams())).json()).toMatchObject({ status: "preparing" });
    await clipDrafts.updateOne({ _id: clipA.id }, { $set: { updatedAt: new Date(Date.now() - 120_000) } });
    expect(await (await call(getEditor, clipParams())).json()).toMatchObject({ status: "failed" });
    await call(prepare, clipParams(), { method: "POST" });
    expect(await jobs.countDocuments({ type: "prepare_editor", status: "queued" })).toBe(1);
  });

  it("serves preview media with ranges", async () => {
    await call(prepare, clipParams(), { method: "POST" });
    await simulatePrepare(clipA);

    const clean = await call(media, { ...clipParams(), asset: "clean.mp4" });
    expect(clean.status).toBe(200);
    expect(clean.headers.get("content-type")).toBe("video/mp4");
    expect(clean.headers.get("cache-control")).toBe("private, no-cache");
    expect(await clean.text()).toBe("0123456789");

    const partial = await call(media, { ...clipParams(), asset: "clean.mp4" }, { headers: { range: "bytes=2-5" } });
    expect(partial.status).toBe(206);
    expect(partial.headers.get("content-range")).toBe("bytes 2-5/10");
    expect(await partial.text()).toBe("2345");

    const thumbnails = await call(media, { ...clipParams(), asset: "thumbnails.jpg" });
    expect(thumbnails.headers.get("content-type")).toBe("image/jpeg");

    for (const asset of ["draft.json", "constructor", "../clean.mp4"]) {
      const response = await call(media, { ...clipParams(), asset });
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ detail: "Preview not ready" });
    }
    expect((await call(media, { ...clipParams(), asset: "clean.mp4" }, { user: stranger })).status).toBe(403);
  });
});

describe("editor exports", () => {
  beforeEach(async () => {
    await call(prepare, clipParams(), { method: "POST" });
    await simulatePrepare(clipA);
  });

  it("validates, queues, limits and cancels exports", async () => {
    const post = (body: unknown) => call(startExport, clipParams(), { method: "POST", body });

    const unprepared = await call(startExport, clipParams(clipB), { method: "POST", body: exportBody({ basis: clipB.filename }) });
    expect(unprepared.status).toBe(409);
    expect(await unprepared.json()).toEqual({ detail: "Prepare the editor preview before exporting" });
    expect(await (await post(exportBody({ basis: "other.mp4" }))).json()).toEqual({ detail: CLIP_CHANGED_MESSAGE });
    const preset = await post(exportBody({ preset: "vimeo" }));
    expect(preset.status).toBe(400);
    expect(await preset.json()).toEqual({ detail: "Unknown export preset" });
    expect((await post(exportBody({ preset: null }))).status).toBe(400);
    const tooLong = await post(exportBody({ document: { ...DOCUMENT, words: [{ id: "w", start: 1, end: 13, text: "x" }] } }));
    expect(await tooLong.json()).toEqual({ detail: "A caption extends past the original clip" });

    const created = await post(exportBody({ preset: undefined }));
    expect(created.status).toBe(202);
    const job = await created.json();
    expect(job).toEqual({ id: expect.stringMatching(/^[a-f0-9]{32}$/), status: "queued", progress: 0, worker_online: false });
    const stored = await collections().jobs.findOne({ _id: job.id });
    expect(stored).toMatchObject({ type: "export_editor", taskId: task._id, clipId: clipA.id, userId: owner.id });
    expect(stored?.payload).toEqual({ document: DOCUMENT, preset: "tiktok", basis: "clip_1.mp4" });

    expect(await (await call(exportStatus, { ...clipParams(), jobId: job.id })).json()).toEqual({ id: job.id, status: "queued", progress: 0 });
    expect((await call(exportStatus, { ...clipParams(), jobId: "abc" })).status).toBe(404);
    const unknown = await call(exportStatus, { ...clipParams(), jobId: "f".repeat(32) });
    expect(await unknown.json()).toEqual({ detail: "Export not found" });
    expect((await call(exportStatus, { ...clipParams(clipB), jobId: job.id })).status).toBe(404);
    expect((await call(exportStatus, { ...clipParams(), jobId: job.id }, { user: stranger })).status).toBe(403);

    const second = await (await post(exportBody())).json();
    const third = await (await post(exportBody())).json();
    const limited = await post(exportBody());
    expect(limited.status).toBe(429);
    expect(await limited.json()).toEqual({ detail: "Three exports are already running for this clip" });

    // Queued: cancelled at once. Running: the worker is told to stop.
    expect(await (await call(cancelExport, { ...clipParams(), jobId: job.id }, { method: "DELETE" })).json()).toEqual({ status: "cancelled" });
    const running = await claimJob("w1", ["export_editor"]);
    expect(running?._id).toBe(second.id);
    expect(await (await call(cancelExport, { ...clipParams(), jobId: second.id }, { method: "DELETE" })).json()).toEqual({ status: "cancelling" });
    expect((await collections().jobs.findOne({ _id: second.id }))?.cancelRequested).toBe(true);
    expect(await (await call(exportStatus, { ...clipParams(), jobId: second.id })).json()).toMatchObject({ status: "rendering" });
    expect(await (await call(cancelExport, { ...clipParams(), jobId: job.id }, { method: "DELETE" })).json()).toEqual({ status: "cancelled" });

    // A slot is free again (one cancelled), so a new export is admitted.
    expect((await post(exportBody())).status).toBe(202);

    const state = await (await call(getEditor, clipParams())).json();
    expect(state.jobs.map((j: { id: string }) => j.id)).toEqual(expect.arrayContaining([job.id, second.id, third.id]));
    expect(state.jobs.find((j: { id: string }) => j.id === job.id)).toEqual({ id: job.id, status: "cancelled", progress: 0 });

    // No processing lock: a queued reprocess or restyle does not block exports.
    await setStatus("queued");
    await call(cancelExport, { ...clipParams(), jobId: third.id }, { method: "DELETE" });
    expect((await post(exportBody())).status).toBe(202);
  });

  it("serves a finished export as an attachment", async () => {
    const { id } = await (await call(startExport, clipParams(), { method: "POST", body: exportBody() })).json();
    const file = (jobId = id) => call(exportFile, { ...clipParams(), jobId });

    const notReady = await file();
    expect(notReady.status).toBe(409);
    expect(await notReady.json()).toEqual({ detail: "Export is not ready" });

    const lease = (await claimJob("w1", ["export_editor"]))!;
    const fileKey = storageKeys.editorExport(id);
    await finishJob(lease, { status: "succeeded", result: { fileKey } });
    expect(await (await call(exportStatus, { ...clipParams(), jobId: id })).json()).toEqual({ id, status: "completed", progress: 100 });
    expect((await file()).status).toBe(409); // succeeded, but the file is missing

    await getStorage().writeStream(fileKey, Readable.from([Buffer.from("mp4-bytes")]));
    const response = await file();
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("video/mp4");
    expect(response.headers.get("content-disposition")).toBe(
      `attachment; filename="clipwright-${clipA.id.slice(0, 8)}-${id.slice(0, 6)}.mp4"`,
    );
    expect(await response.text()).toBe("mp4-bytes");
    expect(await (await call(cancelExport, { ...clipParams(), jobId: id }, { method: "DELETE" })).json()).toEqual({ status: "completed" });
    expect((await file("../../etc/passwd")).status).toBe(404);
  });
});

describe("combine", () => {
  const post = (body: unknown, user: User = owner) => call(combine, { id: task._id }, { method: "POST", body, user });

  it("validates the selection", async () => {
    for (const clip_ids of [undefined, "x", [clipA.id], [clipA.id, clipA.id], [clipA.id, 3], Array.from({ length: 21 }, (_, i) => `c${i}`)]) {
      const response = await post({ clip_ids });
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ detail: "Select between 2 and 20 distinct clips" });
    }
    expect((await post({ clip_ids: [clipA.id, "nope"] })).status).toBe(404);
    expect((await post({ clip_ids: [clipA.id, clipB.id] }, stranger)).status).toBe(403);

    await call(prepare, clipParams(), { method: "POST" });
    await simulatePrepare(clipA);
    const unprepared = await post({ clip_ids: [clipA.id, clipB.id] });
    expect(unprepared.status).toBe(409);
    expect(await unprepared.json()).toEqual({ detail: "Prepare each selected clip before combining" });

    // No route-level processing lock; the worker's appendClip refuses a busy task.
    await setStatus("processing");
    expect(await (await post({ clip_ids: [clipA.id, clipB.id] })).json()).toEqual({ detail: "Prepare each selected clip before combining" });
  });

  it("queues combine_editor on the anchor clip with a snapshot of each draft", async () => {
    for (const clip of [clipA, clipB]) {
      await call(prepare, clipParams(clip), { method: "POST" });
      await simulatePrepare(clip);
    }
    const response = await post({ clip_ids: [clipB.id, clipA.id] });
    expect(response.status).toBe(202);
    const body = await response.json();
    expect(body).toEqual({ id: expect.stringMatching(/^[a-f0-9]{32}$/), anchor_clip_id: clipB.id, worker_online: false });

    const job = await collections().jobs.findOne({ _id: body.id });
    expect(job).toMatchObject({ type: "combine_editor", clipId: clipB.id, taskId: task._id, status: "queued" });
    const inputs = job?.payload.inputs as { id: string; filename: string; state: unknown; ranges: unknown; document: { captions: { template: string } } }[];
    expect(inputs.map((input) => input.id)).toEqual([clipB.id, clipA.id]);
    expect(inputs[0]).toMatchObject({
      filename: "clip_2.mp4",
      state: { width: 1080, height: 1920, hasAudio: true },
      ranges: [{ start: 10, end: 22 }],
      document: { segments: DOCUMENT.segments },
    });

    // Combine jobs count against the anchor's export limit and show up in its job list.
    expect(await (await call(exportStatus, { ...clipParams(clipB), jobId: body.id })).json()).toEqual({ id: body.id, status: "queued", progress: 0 });
    await post({ clip_ids: [clipB.id, clipA.id] });
    await post({ clip_ids: [clipB.id, clipA.id] });
    const limited = await post({ clip_ids: [clipB.id, clipA.id] });
    expect(limited.status).toBe(429);
    expect(await limited.json()).toEqual({ detail: "Wait for an existing export to finish before combining" });
    expect((await post({ clip_ids: [clipA.id, clipB.id] })).status).toBe(202);
  });
});
