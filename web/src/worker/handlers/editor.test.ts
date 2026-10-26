/** @vitest-environment node */
import path from "node:path";
import { Collection } from "mongodb";
import { describe, expect, it, vi } from "vitest";
import { collections } from "../../server/db";
import { PREPARE_FAILED_MESSAGE, startPrepare } from "../../server/drafts";
import { EngineError } from "../../server/engine";
import { claimJob, requestCancel } from "../../server/jobs";
import { getStorage, storageKeys } from "../../server/storage";
import { EXPORT_FAILED_MESSAGE, EXPORT_TTL_MS } from "../../server/tasks";
import { EditDocumentSchema, type ClipDoc, type DraftDoc, type EditDocument } from "../../server/types";
import { runJob } from "../run-job";
import { claimed, clipFixture, fakeEngine, seedTask, untilAborted, setupWorkerTestEnv, writeFile, type FakeCommand } from "../test-utils";
import { COMBINE_FAILED_MESSAGE } from "./combine-editor";
import { CLIP_CHANGED_EXPORT_MESSAGE } from "./export-clip";
import { EDITOR_EXPORT_FAILED_MESSAGE } from "./export-editor";

setupWorkerTestEnv("editor");

const VIDEO_KEY = "uploads/00000000-0000-4000-8000-000000000001.mp4";
const ASSET = { width: 1080, height: 1920, fps: 30, duration: 20, hasAudio: true, waveform: [0.1, 0.5] };
const documentOf = (end = 20, words = ["hello", "world"]): EditDocument =>
  EditDocumentSchema.parse({
    segments: [{ id: "original", start: 0, end }],
    words: words.map((text, i) => ({ id: `word-${i}`, start: i, end: i + 0.5, text })),
  });

let seq = 0;
async function idleTask(clips: (id: string, taskId: string) => ClipDoc[]) {
  const id = `task-editor-${++seq}`; // storage is not cleared between tests
  const task = await seedTask({ _id: id, status: "completed", progress: 100, clips: clips("", id) });
  await writeFile(await getStorage().localPath(VIDEO_KEY), "video");
  return task;
}

async function readyDraft(task: { _id: string; userId: string }, clip: ClipDoc): Promise<DraftDoc> {
  const media = storageKeys.editorMedia(clip.id, clip.filename);
  await writeFile(await getStorage().localPath(media.cleanKey), "clean");
  await writeFile(await getStorage().localPath(media.thumbnailsKey), "thumbs");
  const draft: DraftDoc = {
    _id: clip.id,
    taskId: task._id,
    userId: task.userId,
    basis: clip.filename,
    status: "ready",
    asset: ASSET,
    media,
    revision: 2,
    document: documentOf(),
    original: documentOf(),
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  await collections().clipDrafts.insertOne(draft);
  return draft;
}

const progressThenWrite =
  (output: (request: Record<string, string>) => string[], result: (request: Record<string, string>) => unknown): FakeCommand =>
  async (request, { emit }) => {
    await emit({ type: "progress", pct: 40, message: "Rendering..." });
    for (const file of output(request)) await writeFile(file, "media");
    return result(request);
  };

describe("prepare_editor", () => {
  const prepareEngine = () =>
    fakeEngine({
      "editor-prepare": progressThenWrite(
        (r) => [path.join(r.output_dir, "clean.mp4"), path.join(r.output_dir, "thumbnails.jpg")],
        (r) => ({
          asset: ASSET,
          clean_path: path.join(r.output_dir, "clean.mp4"),
          thumbnails_path: path.join(r.output_dir, "thumbnails.jpg"),
          initial_document: { ...documentOf(), hookTitle: "Hook c1" },
        }),
      ),
    });

  it("stores the preview media and seeds revision 0 with the original", async () => {
    const task = await idleTask((_, id) => [clipFixture("c1", id)]);
    await startPrepare(task, task.clips[0]);
    const job = (await claimJob("test-worker"))!;
    const engine = prepareEngine();
    expect(await runJob(job, { runEngine: engine.runEngine })).toEqual({ status: "succeeded" });

    expect(engine.calls[0].request).toMatchObject({
      source_video_path: await getStorage().localPath(VIDEO_KEY),
      source_ranges: [{ start: 5, end: 25 }],
      output_format: "vertical",
      clip_text: "words of c1",
      hook_title: "Hook c1",
      add_subtitles: true,
      caption_settings: { font_size: 32 },
      task_style: { caption_template: "default", font_family: null, font_size: null, font_color: null },
    });
    const media = storageKeys.editorMedia("c1", "c1.mp4");
    const draft = (await collections().clipDrafts.findOne({ _id: "c1" }))!;
    expect(draft).toMatchObject({ status: "ready", basis: "c1.mp4", revision: 0, asset: ASSET, media });
    expect(draft.document).toEqual(draft.original);
    expect(draft.document!.hookTitle).toBe("Hook c1");
    expect(await getStorage().stat(media.cleanKey)).not.toBeNull();
    expect(await getStorage().stat(media.thumbnailsKey)).not.toBeNull();
  });

  it("marks the draft failed when the engine fails", async () => {
    const task = await idleTask((_, id) => [clipFixture("c1", id)]);
    await startPrepare(task, task.clips[0]);
    const job = (await claimJob("test-worker"))!;
    const engine = fakeEngine({ "editor-prepare": () => Promise.reject(new EngineError("render_failed", "ffmpeg died")) });
    expect(await runJob(job, { runEngine: engine.runEngine })).toEqual({ status: "failed", error: "ffmpeg died" });
    expect((await collections().clipDrafts.findOne({ _id: "c1" }))!).toMatchObject({ status: "failed", error: PREPARE_FAILED_MESSAGE });
  });

  it("fails without rendering when the clip file changed after the request", async () => {
    const task = await idleTask((_, id) => [clipFixture("c1", id)]);
    await startPrepare(task, task.clips[0]);
    await collections().tasks.updateOne({ _id: task._id }, { $set: { "clips.0.filename": "other.mp4" } });
    const job = (await claimJob("test-worker"))!;
    const engine = prepareEngine();
    expect(await runJob(job, { runEngine: engine.runEngine })).toMatchObject({ status: "failed" });
    expect(engine.calls).toHaveLength(0);
    expect((await collections().clipDrafts.findOne({ _id: "c1" }))!.status).toBe("failed");
  });
});

describe("export_editor", () => {
  it("renders the submitted document over the clean preview into editor-exports", async () => {
    const task = await idleTask((_, id) => [clipFixture("c1", id)]);
    const draft = await readyDraft(task, task.clips[0]);
    const document = documentOf(12);
    const job = await claimed({
      type: "export_editor",
      taskId: task._id,
      clipId: "c1",
      userId: task.userId,
      payload: { document, preset: "reels", basis: "c1.mp4" },
    });
    const engine = fakeEngine({ "editor-render": progressThenWrite((r) => [r.output], (r) => ({ path: r.output })) });
    const before = Date.now();
    const outcome = await runJob(job, { runEngine: engine.runEngine });

    const fileKey = storageKeys.editorExport(job._id);
    expect(outcome).toMatchObject({ status: "succeeded", result: { fileKey } });
    expect(outcome!.expiresAt!.getTime()).toBeGreaterThanOrEqual(before + EXPORT_TTL_MS);
    expect(engine.calls[0].request).toMatchObject({
      clean_path: await getStorage().localPath(draft.media!.cleanKey),
      document,
      preset: "reels",
    });
    expect(await getStorage().stat(fileKey)).not.toBeNull();
    expect((await collections().jobs.findOne({ _id: job._id }))!).toMatchObject({ status: "succeeded", progress: 100, result: { fileKey } });
  });

  it("fails with the editor's message", async () => {
    const task = await idleTask((_, id) => [clipFixture("c1", id)]);
    await readyDraft(task, task.clips[0]);
    const job = await claimed({ type: "export_editor", taskId: task._id, clipId: "c1", userId: task.userId, payload: { document: documentOf(), preset: "tiktok", basis: "c1.mp4" } });
    const engine = fakeEngine({ "editor-render": () => Promise.reject(new EngineError("render_failed", "boom")) });
    expect(await runJob(job, { runEngine: engine.runEngine })).toEqual({ status: "failed", error: EDITOR_EXPORT_FAILED_MESSAGE });
  });

  it("is cancelled by DELETE while rendering", async () => {
    const task = await idleTask((_, id) => [clipFixture("c1", id)]);
    await readyDraft(task, task.clips[0]);
    const job = await claimed({ type: "export_editor", taskId: task._id, clipId: "c1", userId: task.userId, payload: { document: documentOf(), preset: "tiktok", basis: "c1.mp4" } });
    const engine = fakeEngine({
      "editor-render": async (_request, { signal }) => {
        await requestCancel({ _id: job._id });
        await untilAborted(signal);
      },
    });
    expect(await runJob(job, { runEngine: engine.runEngine, heartbeatMs: 20 })).toEqual({ status: "cancelled" });
    expect(await getStorage().stat(storageKeys.editorExport(job._id))).toBeNull();
  });
});

describe("combine_editor", () => {
  async function combining() {
    const task = await idleTask((_, id) => [clipFixture("c1", id), clipFixture("c2", id, { sourceRanges: [{ start: 40, end: 60 }] })]);
    const inputs = [];
    for (const clip of task.clips) {
      const draft = await readyDraft(task, clip);
      inputs.push({ id: clip.id, filename: clip.filename, document: draft.document!, state: { width: 1080, height: 1920, hasAudio: true }, ranges: clip.sourceRanges });
    }
    const job = await claimed({ type: "combine_editor", taskId: task._id, clipId: "c1", userId: task.userId, payload: { inputs } });
    const combined = documentOf(30, ["one", "two", "three"]);
    const engine = fakeEngine({
      "editor-combine": progressThenWrite(
        (r) => ["clean.mp4", "export.mp4", "thumbnails.jpg"].map((name) => path.join(r.output_dir, name)),
        (r) => ({
          clean_path: path.join(r.output_dir, "clean.mp4"),
          export_path: path.join(r.output_dir, "export.mp4"),
          thumbnails_path: path.join(r.output_dir, "thumbnails.jpg"),
          document: { ...combined, segments: [{ id: "combined", start: 0, end: 30 }], hookTitle: "" },
          asset: { ...ASSET, duration: 30 },
          source_ranges: [{ start: 5, end: 25 }, { start: 40, end: 50 }],
        }),
      ),
    });
    return { task, job, engine };
  }

  it("appends the combined clip with a ready draft and keeps the inputs", async () => {
    const { task, job, engine } = await combining();
    const outcome = await runJob(job, { runEngine: engine.runEngine });

    const [request] = engine.calls.map((call) => call.request);
    expect(request.inputs).toEqual([
      expect.objectContaining({ clean_path: await getStorage().localPath(storageKeys.editorMedia("c1", "c1.mp4").cleanKey), has_audio: true, width: 1080, height: 1920, source_ranges: [{ start: 5, end: 25 }] }),
      expect.objectContaining({ source_ranges: [{ start: 40, end: 60 }] }),
    ]);
    const after = (await collections().tasks.findOne({ _id: task._id }))!;
    expect(after.clips.map((clip) => clip.id).slice(0, 2)).toEqual(["c1", "c2"]);
    const created = after.clips[2];
    expect(created).toMatchObject({
      filename: expect.stringMatching(/^combined_[0-9a-f]{32}\.mp4$/),
      startTime: "00:00",
      endTime: "00:30",
      duration: 30,
      text: "one two three",
      relevanceScore: 0,
      reasoning: "Combined in the clip editor",
      sourceRanges: [{ start: 5, end: 25 }, { start: 40, end: 50 }],
    });
    const fileKey = storageKeys.editorExport(job._id);
    expect(outcome).toMatchObject({ status: "succeeded", result: { clip_id: created.id, fileKey } });
    const media = storageKeys.editorMedia(created.id, created.filename);
    expect((await collections().clipDrafts.findOne({ _id: created.id }))!).toMatchObject({
      taskId: task._id,
      basis: created.filename,
      status: "ready",
      revision: 0,
      media,
      asset: { duration: 30 },
    });
    for (const key of [fileKey, created.storageKey, media.cleanKey, media.thumbnailsKey]) {
      expect(await getStorage().stat(key)).not.toBeNull();
    }
  });

  it("rolls back its files and draft when an input clip changed meanwhile", async () => {
    const { task, job, engine } = await combining();
    await collections().tasks.updateOne({ _id: task._id }, { $set: { "clips.1.filename": "c2-restyled.mp4" } });
    expect(await runJob(job, { runEngine: engine.runEngine })).toEqual({ status: "failed", error: COMBINE_FAILED_MESSAGE });

    expect((await collections().tasks.findOne({ _id: task._id }))!.clips).toHaveLength(2);
    expect(await collections().clipDrafts.countDocuments({ taskId: task._id })).toBe(2);
    expect(await getStorage().list(`clips/${task._id}/`)).toEqual([]);
    expect(await getStorage().stat(storageKeys.editorExport(job._id))).toBeNull();
  });

  it("keeps the combined clip when the append committed but its reply was lost", async () => {
    const { task, job, engine } = await combining();
    const updateOne = Collection.prototype.updateOne;
    const spy = vi.spyOn(Collection.prototype, "updateOne").mockImplementation(async function (this: Collection, ...args: unknown[]) {
      const result = await updateOne.apply(this, args as never);
      if (this.collectionName !== "tasks") return result;
      spy.mockRestore();
      throw new Error("connection reset");
    } as never);
    let outcome;
    try {
      outcome = await runJob(job, { runEngine: engine.runEngine });
    } finally {
      spy.mockRestore();
    }
    const created = (await collections().tasks.findOne({ _id: task._id }))!.clips[2];
    expect(outcome).toMatchObject({ status: "succeeded", result: { clip_id: created.id } });
    expect(await collections().clipDrafts.countDocuments({ _id: created.id })).toBe(1);
    expect(await getStorage().stat(created.storageKey)).not.toBeNull();
  });
});

describe("export_clip", () => {
  async function exporting(preset = "shorts") {
    const task = await idleTask((_, id) => [clipFixture("c1", id)]);
    await writeFile(await getStorage().localPath(task.clips[0].storageKey), "clip");
    const job = await claimed({ type: "export_clip", taskId: task._id, clipId: "c1", userId: task.userId, payload: { preset, filename: "c1.mp4" }, liveKey: "c1:hash" });
    return { task, job };
  }

  it("re-encodes the clip into exports/ with a 7-day expiry", async () => {
    const { task, job } = await exporting();
    const engine = fakeEngine({ "export-preset": progressThenWrite((r) => [r.output], (r) => ({ path: r.output })) });
    const outcome = await runJob(job, { runEngine: engine.runEngine });
    expect(engine.calls[0].request).toMatchObject({ input: await getStorage().localPath(task.clips[0].storageKey), preset: "shorts" });
    const fileKey = storageKeys.presetExport(job._id);
    expect(outcome).toMatchObject({ status: "succeeded", result: { fileKey }, expiresAt: expect.any(Date) });
    const stored = (await collections().jobs.findOne({ _id: job._id }))!;
    expect(stored).toMatchObject({ status: "succeeded", liveKey: "c1:hash", result: { fileKey } });
    expect(stored.expiresAt!.getTime() - Date.now()).toBeGreaterThan(EXPORT_TTL_MS - 60_000);
    expect(await getStorage().stat(fileKey)).not.toBeNull();
  });

  it("fails when the clip file changed during the encode", async () => {
    const { task, job } = await exporting();
    const engine = fakeEngine({
      "export-preset": async (request) => {
        await collections().tasks.updateOne({ _id: task._id }, { $set: { "clips.0.filename": "c1-new.mp4" } });
        await writeFile(request.output);
        return { path: request.output };
      },
    });
    expect(await runJob(job, { runEngine: engine.runEngine })).toEqual({ status: "failed", error: CLIP_CHANGED_EXPORT_MESSAGE });
    expect(await getStorage().stat(storageKeys.presetExport(job._id))).toBeNull();
    expect((await collections().jobs.findOne({ _id: job._id }))!.liveKey).toBeUndefined();
  });

  it("reports engine failures with the export message", async () => {
    const { job } = await exporting();
    const engine = fakeEngine({ "export-preset": () => Promise.reject(new EngineError("render_failed", "x")) });
    expect(await runJob(job, { runEngine: engine.runEngine })).toEqual({ status: "failed", error: EXPORT_FAILED_MESSAGE });
  });
});
