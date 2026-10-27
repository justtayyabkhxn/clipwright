/** @vitest-environment node */
import { Collection } from "mongodb";
import { describe, expect, it, vi } from "vitest";
import { collections } from "../../server/db";
import { requestCancel } from "../../server/jobs";
import { getStorage } from "../../server/storage";
import { casStatus, RESTYLE_CANCELLED_MESSAGE, RESTYLE_FAILED_MESSAGE, settingsFromCreateRequest } from "../../server/tasks";
import { runJob } from "../run-job";
import { claimed, clipFixture, fakeEngine, fakeRender, seedTask, untilAborted, setupWorkerTestEnv, writeFile, type FakeCommand } from "../test-utils";
import { SOURCE_MISSING_MESSAGE } from "./restyle-task";

setupWorkerTestEnv("restyle");

const VIDEO_KEY = "uploads/00000000-0000-4000-8000-000000000001.mp4";
let seq = 0;

/** A completed task with two clips (files and one draft), restyled as the settings route leaves it. */
async function restyling(payload: Record<string, unknown> = { cleanupChanged: false }) {
  const jobId = "b".repeat(32);
  const id = `task-restyle-${++seq}`; // storage is not cleared between tests
  const clips = [
    clipFixture("old-1", id),
    clipFixture("old-2", id, { sourceRanges: [{ start: 30, end: 50 }], keepRanges: undefined, startTime: "00:30", endTime: "00:50" }),
  ];
  const storage = getStorage();
  for (const clip of clips) await writeFile(await storage.localPath(clip.storageKey), "old");
  await writeFile(await storage.localPath(VIDEO_KEY), "video");
  await writeFile(await storage.localPath("editor/old-1/abc/clean.mp4"), "preview");
  await collections().clipDrafts.insertOne({
    _id: "old-1",
    taskId: id,
    userId: "user-1",
    basis: "old-1.mp4",
    status: "ready",
    revision: 3,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  const task = await seedTask({
    _id: id,
    status: "processing",
    progress: 0,
    progressMessage: "Applying new style...",
    settings: { ...settingsFromCreateRequest({}), captionTemplate: "hormozi", fontColor: "#FF0000" },
    clips,
    run: { jobId },
  });
  const job = await claimed({ id: jobId, type: "restyle_task", taskId: id, userId: task.userId, payload, activeKey: `task:${id}` });
  return { task, job };
}

const load = (id: string) => collections().tasks.findOne({ _id: id });
const clipKeys = async (taskId: string) => (await getStorage().list(`clips/${taskId}/`)).map((item) => item.key).sort();

describe("restyle_task", () => {
  it("re-renders every clip from its kept ranges and swaps them in at once", async () => {
    const { task, job } = await restyling();
    const messages: string[] = [];
    const engine = fakeEngine({
      "render-clips": fakeRender({
        rendering: async () => {
          messages.push((await load(task._id))!.progressMessage);
        },
      }),
    });
    expect(await runJob(job, { runEngine: engine.runEngine })).toEqual({ status: "succeeded", result: { clips: 2 } });

    const [render] = engine.calls;
    expect(render.request.segments).toEqual([
      { start_time: "00:05", end_time: "00:25", text: "words of old-1", hook_title: "Hook old-1", keep_ranges: [[5.2, 24.8]] },
      { start_time: "00:30", end_time: "00:50", text: "words of old-2", hook_title: "Hook old-2", keep_ranges: [[30, 50]] },
    ]);
    expect(render.request.options).toMatchObject({ caption_template: "hormozi", font_color: "#FF0000", max_clip_seconds: 60 });
    expect(messages).toEqual(["Applying new style...", "Applying new style..."]);

    const done = (await load(task._id))!;
    expect(done).toMatchObject({ status: "completed", progress: 100, progressMessage: "Complete!" });
    expect(done.clips.map((clip) => clip.id)).not.toContain("old-1");
    expect(done.clips[0]).toMatchObject({ viralityScore: 70, hookTitle: "Hook old-1", reasoning: "Strong hook", text: "rendered words of old-1" });
    expect(await clipKeys(task._id)).toEqual(done.clips.map((clip) => clip.storageKey).sort());
    expect(await collections().clipDrafts.countDocuments({ _id: "old-1" })).toBe(0);
    expect(await getStorage().stat("editor/old-1/abc/clean.mp4")).toBeNull();
  });

  it("keeps each clip's lineage through a restyle", async () => {
    const jobId = "c".repeat(32);
    const id = `task-restyle-${++seq}`;
    const clips = [clipFixture("a", id), clipFixture("b", id, { lineageId: "L" })];
    await writeFile(await getStorage().localPath(VIDEO_KEY), "video");
    const task = await seedTask({ _id: id, status: "processing", clips, run: { jobId } });
    const job = await claimed({ id: jobId, type: "restyle_task", taskId: id, userId: task.userId, payload: { cleanupChanged: false }, activeKey: `task:${id}` });

    expect(await runJob(job, { runEngine: fakeEngine({ "render-clips": fakeRender() }).runEngine })).toEqual({ status: "succeeded", result: { clips: 2 } });

    const after = (await load(id))!;
    expect(after.clips.map((clip) => clip.lineageId)).toEqual(["a", "L"]);
    expect(after.clips.map((clip) => clip.id)).not.toEqual(["a", "b"]);
  });

  it("cleans the source ranges again when the cleanup settings changed", async () => {
    const { job } = await restyling({ cleanupChanged: true });
    const engine = fakeEngine({ "render-clips": fakeRender() });
    await runJob(job, { runEngine: engine.runEngine });
    expect(engine.calls[0].request.segments[0]).toMatchObject({ source_ranges: [{ start: 5, end: 25 }] });
    expect(engine.calls[0].request.segments[0]).not.toHaveProperty("keep_ranges");
  });

  it("keeps the old clips and their settings and reports the failure when nothing renders", async () => {
    const previousSettings = settingsFromCreateRequest({});
    const { task, job } = await restyling({ cleanupChanged: false, previousSettings });
    const outcome = await runJob(job, { runEngine: fakeEngine({ "render-clips": fakeRender({ fail: [0, 1] }) }).runEngine });
    expect(outcome).toEqual({ status: "failed", error: RESTYLE_FAILED_MESSAGE });
    const after = (await load(task._id))!;
    expect(after).toMatchObject({ status: "completed", progress: 100, progressMessage: RESTYLE_FAILED_MESSAGE });
    expect(after.settings).toEqual(previousSettings);
    expect(after.clips.map((clip) => clip.id)).toEqual(["old-1", "old-2"]);
    expect(await clipKeys(task._id)).toEqual([`clips/${task._id}/old-1.mp4`, `clips/${task._id}/old-2.mp4`]);
  });

  it("keeps the old clips when the source is gone", async () => {
    const { task, job } = await restyling();
    await getStorage().delete(VIDEO_KEY);
    const engine = fakeEngine({});
    expect(await runJob(job, { runEngine: engine.runEngine })).toEqual({ status: "failed", error: SOURCE_MISSING_MESSAGE });
    expect(engine.calls).toHaveLength(0);
    expect((await load(task._id))!).toMatchObject({ status: "completed", progressMessage: RESTYLE_FAILED_MESSAGE, clips: [{ id: "old-1" }, { id: "old-2" }] });
  });

  it("on a cancel during the render keeps the old clips and leaves the task as the cancel route set it", async () => {
    const { task, job } = await restyling();
    const render: FakeCommand = fakeRender({
      rendering: async (index, signal) => {
        if (index !== 1) return;
        // What POST /cancel does for a restyle.
        await casStatus(task._id, ["processing"], { status: "completed", progress: 100, progressMessage: RESTYLE_CANCELLED_MESSAGE });
        await requestCancel({ taskId: task._id, type: "restyle_task" });
        await untilAborted(signal);
      },
    });
    expect(await runJob(job, { runEngine: fakeEngine({ "render-clips": render }).runEngine, heartbeatMs: 20 })).toEqual({ status: "cancelled" });

    const after = (await load(task._id))!;
    expect(after).toMatchObject({ status: "completed", progressMessage: RESTYLE_CANCELLED_MESSAGE });
    expect(after.clips.map((clip) => clip.id)).toEqual(["old-1", "old-2"]);
    expect(await clipKeys(task._id)).toEqual([`clips/${task._id}/old-1.mp4`, `clips/${task._id}/old-2.mp4`]);
    expect(await collections().clipDrafts.countDocuments({ _id: "old-1" })).toBe(1);
    expect((await collections().jobs.findOne({ _id: job._id }))!.status).toBe("cancelled");
  });

  it("deletes the clips it already stored when the cancel lands after the render", async () => {
    const { task, job } = await restyling();
    const storage = getStorage();
    const putFile = storage.putFile.bind(storage);
    let newKey = "";
    // POST /cancel arrives once the first new clip is in storage.
    const spy = vi.spyOn(storage, "putFile").mockImplementationOnce(async (key, file) => {
      await putFile(key, file);
      newKey = key;
      await casStatus(task._id, ["processing"], { status: "completed", progress: 100, progressMessage: RESTYLE_CANCELLED_MESSAGE });
      await requestCancel({ taskId: task._id, type: "restyle_task" });
    });
    try {
      expect(await runJob(job, { runEngine: fakeEngine({ "render-clips": fakeRender() }).runEngine, heartbeatMs: 20 })).toEqual({ status: "cancelled" });
    } finally {
      spy.mockRestore();
    }
    expect(newKey).toMatch(/clip_1_/);
    expect(await getStorage().stat(newKey)).toBeNull();
    const after = (await load(task._id))!;
    expect(after).toMatchObject({ status: "completed", progressMessage: RESTYLE_CANCELLED_MESSAGE });
    expect(after.clips.map((clip) => clip.id)).toEqual(["old-1", "old-2"]);
    expect(await clipKeys(task._id)).toEqual([`clips/${task._id}/old-1.mp4`, `clips/${task._id}/old-2.mp4`]);
  });

  it("keeps the new clips when the swap committed but its old-clip cleanup threw", async () => {
    const { task, job } = await restyling();
    const deleteMany = Collection.prototype.deleteMany;
    // One transient failure of the draft cleanup that runs after the swap (multi-deletes are not retried).
    const spy = vi.spyOn(Collection.prototype, "deleteMany").mockImplementation(function (this: Collection, ...args: unknown[]) {
      if (this.collectionName !== "clip_drafts") return deleteMany.apply(this, args as never);
      spy.mockRestore();
      return Promise.reject(new Error("connection reset"));
    } as never);
    try {
      expect(await runJob(job, { runEngine: fakeEngine({ "render-clips": fakeRender() }).runEngine })).toEqual({ status: "succeeded", result: { clips: 2 } });
    } finally {
      spy.mockRestore();
    }
    const after = (await load(task._id))!;
    expect(after).toMatchObject({ status: "completed", progressMessage: "Complete!" });
    expect(after.clips.map((clip) => clip.id)).not.toContain("old-1");
    for (const clip of after.clips) expect(await getStorage().stat(clip.storageKey)).not.toBeNull();
  });
});
