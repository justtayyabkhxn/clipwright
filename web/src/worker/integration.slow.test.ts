/** @vitest-environment node */
// Slow: the real Python engine and ffmpeg render a synthetic upload end to end (minutes, no network,
// no paid calls). Run it with `CLIPWRIGHT_SLOW_TESTS=1 pnpm exec vitest run src/worker/integration.slow.test.ts`.
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { fakeFetch, messageResponse } from "../server/ai/__fixtures__/fake-anthropic";
import { collections } from "../server/db";
import { startPrepare } from "../server/drafts";
import { runEngine } from "../server/engine";
import { paths } from "../server/env";
import { claimJob, enqueueJob } from "../server/jobs";
import { updateSettings } from "../server/settings";
import { getStorage } from "../server/storage";
import { createQueuedTask, settingsFromCreateRequest } from "../server/tasks";
import { runJob } from "./run-job";
import { setupWorkerTestEnv } from "./test-utils";

const enabled =
  process.env.CLIPWRIGHT_SLOW_TESTS === "1" &&
  spawnSync("ffmpeg", ["-version"], { windowsHide: true }).status === 0 &&
  existsSync(path.resolve(process.cwd(), "..", "engine", process.platform === "win32" ? ".venv/Scripts/python.exe" : ".venv/bin/python"));

setupWorkerTestEnv("integration");

const SECONDS = 34;
const UTTERANCES = [
  { speaker: "A", start: 300, text: "Here is the one habit that doubled my output in a single month and it costs nothing at all to start today." },
  { speaker: "B", start: 16_300, text: "Most people never try it because it sounds far too simple, but the results show up within a few weeks for everyone." },
];

/** A v2 sidecar (AssemblyAI-style ms timings), so `transcribe` formats it without calling AssemblyAI. */
function sidecar() {
  const utterances = UTTERANCES.map(({ speaker, start, text }) => {
    const words = text.split(" ").map((token, i) => ({
      text: token,
      start: start + i * 700,
      end: start + i * 700 + 350,
      confidence: 0.99,
      speaker,
    }));
    return { text, start: words[0].start, end: words.at(-1)!.end, speaker, words };
  });
  return { version: 2, words: utterances.flatMap((u) => u.words), utterances, text: UTTERANCES.map((u) => u.text).join(" "), language_code: "en" };
}

/** Claude, faked: every transcript line of the prompt becomes a selected segment. */
const claude = fakeFetch((request) => {
  const prompt = String(request.body.messages[0].content);
  const lines = [...prompt.matchAll(/^\[(\d\d:\d\d) - (\d\d:\d\d)\] Speaker \w+: (.+)$/gm)];
  return messageResponse({
    most_relevant_segments: lines.map(([, start, end, text], i) => ({
      start_time: start,
      end_time: end,
      text,
      relevance_score: 0.9 - i / 10,
      reasoning: "Self-contained",
      virality: { hook_score: 20 - i, engagement_score: 18, value_score: 17, shareability_score: 15, hook_type: "statement", virality_reasoning: "Bold" },
      hook_title: `Synthetic hook ${i + 1}`,
    })),
    summary: "A synthetic talk",
    key_topics: ["habits"],
  });
});

async function probe(file: string) {
  return runEngine<{ duration: number; width: number; height: number; has_audio: boolean }>("probe", {
    work_dir: path.join(paths.workRoot, `probe-${randomUUID()}`),
    path: file,
  });
}

async function runNext(type: string) {
  const job = await claimJob("integration-worker");
  expect(job?.type).toBe(type);
  return runJob(job!, { runEngine, fetch: claude.fetch });
}

describe.skipIf(!enabled)("worker with the real engine (slow)", () => {
  it(
    "processes an upload into two clips, then prepares and exports one in the editor",
    async () => {
      const storage = getStorage();
      const uuid = randomUUID();
      const video = await storage.localPath(`uploads/${uuid}.mp4`);
      const ffmpeg = spawnSync(
        "ffmpeg",
        [
          ...["-v", "error", "-y", "-f", "lavfi", "-i", `testsrc2=size=1920x1080:rate=30:duration=${SECONDS}`],
          ...["-f", "lavfi", "-i", `sine=frequency=440:sample_rate=48000:duration=${SECONDS}`],
          ...["-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", video],
        ],
        { windowsHide: true, encoding: "utf8" },
      );
      expect(ffmpeg.status, ffmpeg.stderr).toBe(0);
      await fs.writeFile(await storage.localPath(`uploads/${uuid}.transcript_cache.json`), JSON.stringify(sidecar()));
      await updateSettings(
        {
          updates: { ANTHROPIC_API_KEY: "sk-ant-integration-test", ASSEMBLY_AI_API_KEY: "dummy-assemblyai-key" },
          delete_keys: [],
          prefer_admin_values: {},
        },
        "admin",
      );

      // --- process_task ---
      const { task } = await createQueuedTask({
        userId: "user-1",
        source: { type: "upload", url: `upload://${uuid}.mp4`, title: "Synthetic" },
        settings: settingsFromCreateRequest({}),
      });
      expect(await runNext("process_task")).toMatchObject({ status: "succeeded" });
      expect(claude.requests).toHaveLength(1);

      const done = (await collections().tasks.findOne({ _id: task._id }))!;
      expect(done).toMatchObject({ status: "completed", progress: 100, progressMessage: "Complete!" });
      expect(done.clips).toHaveLength(2);
      for (const clip of done.clips) {
        expect(clip.hookTitle).toMatch(/^Synthetic hook/);
        expect(clip.duration).toBeGreaterThan(10);
        expect(clip.duration).toBeLessThanOrEqual(20);
        const file = await probe(await storage.localPath(clip.storageKey));
        expect(file).toMatchObject({ width: 1080, height: 1920, has_audio: true });
        expect(Math.abs(file.duration - clip.duration)).toBeLessThan(0.35);
      }

      // --- prepare_editor ---
      const [clip] = done.clips;
      expect(await startPrepare(done, clip)).toEqual({ status: "preparing" });
      expect(await runNext("prepare_editor")).toEqual({ status: "succeeded" });
      const draft = (await collections().clipDrafts.findOne({ _id: clip.id }))!;
      expect(draft).toMatchObject({ status: "ready", basis: clip.filename, revision: 0 });
      expect(draft.document!.words.length).toBeGreaterThan(5);
      const clean = await probe(await storage.localPath(draft.media!.cleanKey));
      expect(Math.abs(clean.duration - draft.asset!.duration)).toBeLessThan(0.1);
      expect(await storage.stat(draft.media!.thumbnailsKey)).not.toBeNull();

      // --- export_editor ---
      const { job: exportJob } = await enqueueJob({
        type: "export_editor",
        taskId: task._id,
        clipId: clip.id,
        userId: task.userId,
        payload: { document: draft.document, preset: "tiktok", basis: clip.filename },
      });
      const exported = await runNext("export_editor");
      expect(exported).toMatchObject({ status: "succeeded", result: { fileKey: `editor-exports/${exportJob._id}.mp4` } });
      const output = await probe(await storage.localPath(`editor-exports/${exportJob._id}.mp4`));
      expect(output).toMatchObject({ width: 1080, height: 1920, has_audio: true });
      expect(Math.abs(output.duration - draft.asset!.duration)).toBeLessThan(0.35);
    },
    20 * 60_000,
  );
});
