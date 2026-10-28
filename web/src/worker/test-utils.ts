// Shared setup for the worker tests: a memory Mongo and temp DATA_DIR per file, a fake engine runner
// that keeps runEngine's contract (events awaited in order, abort -> EngineCancelled), and fixtures.

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { MongoMemoryReplSet, MongoMemoryServer } from "mongodb-memory-server";
import { afterAll, beforeAll, beforeEach } from "vitest";
import { closeDb, collections, ensureIndexes } from "../server/db";
import { EngineCancelled, EngineError, type EngineEvent, type RunEngineOptions } from "../server/engine";
import { resetEnv } from "../server/env";
import { claimJob, enqueueJob, newJobId, type EnqueueInput } from "../server/jobs";
import { settingsFromCreateRequest } from "../server/tasks";
import type { ClipDoc, JobDoc, TaskDoc } from "../server/types";
import type { EngineClip, EngineRunner } from "./context";

const KEY_VARS = [
  "ANTHROPIC_API_KEY",
  "ASSEMBLY_AI_API_KEY",
  "CLAUDE_MODEL",
  "CLAUDE_RERANK_MODEL",
  "APP_SETTINGS_ENCRYPTION_KEY",
  "GOOGLE_OAUTH_CLIENT_ID",
  "GOOGLE_OAUTH_CLIENT_SECRET",
  "CLAUDE_METADATA_MODEL",
];

/** One memory server (a replica set when `replSet`) and temp DATA_DIR for the test file. */
export function setupWorkerTestEnv(name: string, options: { env?: Record<string, string>; replSet?: boolean } = {}) {
  const state = { dataDir: "" };
  const baseEnv = { ...process.env };
  let mongod: MongoMemoryServer | MongoMemoryReplSet;
  beforeAll(async () => {
    mongod = options.replSet ? await MongoMemoryReplSet.create({ replSet: { count: 1 } }) : await MongoMemoryServer.create();
    state.dataDir = await fs.mkdtemp(path.join(os.tmpdir(), `cw-${name}-`));
    const env: NodeJS.ProcessEnv = { ...baseEnv };
    for (const key of KEY_VARS) delete env[key];
    process.env = {
      ...env,
      MONGODB_URI: mongod.getUri(),
      MONGODB_DB: name,
      BETTER_AUTH_SECRET: "s".repeat(32),
      DATA_DIR: state.dataDir,
      ...options.env,
    };
    resetEnv();
    await ensureIndexes();
  }, 120_000);
  afterAll(async () => {
    await closeDb();
    await mongod.stop();
    await fs.rm(state.dataDir, { recursive: true, force: true, maxRetries: 3 });
    process.env = baseEnv;
    resetEnv();
  });
  beforeEach(async () => {
    const { tasks, jobs, clipDrafts, processingCache, appSettings, youtubeAccounts, youtubePosts } = collections();
    await Promise.all(
      [tasks, jobs, clipDrafts, processingCache, appSettings, youtubeAccounts, youtubePosts].map((c) => c.deleteMany({})),
    );
  });
  return state;
}

type Request = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
export type FakeCommand = (
  request: Request,
  io: { emit: (event: EngineEvent) => Promise<void>; signal?: AbortSignal },
) => unknown;

export function fakeEngine(commands: Record<string, FakeCommand>) {
  const calls: { command: string; request: Request }[] = [];
  const runEngine = (async (command: string, request: Request, options: RunEngineOptions = {}) => {
    calls.push({ command, request });
    if (options.signal?.aborted) throw new EngineCancelled();
    const handler = commands[command];
    if (!handler) throw new EngineError("invalid_request", `Unexpected engine command ${command}`);
    const emit = async (event: EngineEvent) => {
      if (options.signal?.aborted) throw new EngineCancelled();
      await options.onEvent?.(event);
    };
    return handler(request, { emit, signal: options.signal });
  }) as EngineRunner;
  return { runEngine, calls, commands: () => calls.map((call) => call.command) };
}

/** A render the user stops: rejects with EngineCancelled once the job's signal aborts. */
export function untilAborted(signal?: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    const fail = () => reject(new EngineCancelled());
    if (signal?.aborted) fail();
    signal?.addEventListener("abort", fail, { once: true });
  });
}

export async function writeFile(file: string, content = "data") {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content);
  return file;
}

/**
 * A fake `render-clips`: each segment gets clip_start, a file in output_dir and a `clip` event,
 * except the `fail` indexes (clip_failed). `rendering(i)` runs after clip_start, while segment i renders.
 */
export function fakeRender(options: { fail?: number[]; rendering?: (index: number, signal?: AbortSignal) => unknown } = {}): FakeCommand {
  return async (request, { emit, signal }) => {
    const clips: EngineClip[] = [];
    const failed: number[] = [];
    for (const [index, segment] of (request.segments as Request[]).entries()) {
      await emit({ type: "clip_start", index, total: request.segments.length });
      await options.rendering?.(index, signal);
      if (options.fail?.includes(index)) {
        failed.push(index);
        await emit({ type: "clip_failed", index, message: "Clip could not be rendered" });
        continue;
      }
      const filename = `clip_${index + 1}_${String(segment.start_time).replace(/\D/g, "")}-${String(segment.end_time).replace(/\D/g, "")}_${index}abc.mp4`;
      const ranges: [number, number][] = segment.keep_ranges ?? [[index * 10, index * 10 + 8]];
      const clip: EngineClip = {
        index,
        filename,
        path: await writeFile(path.join(request.output_dir, filename), `clip ${index}`),
        start_time: segment.start_time,
        end_time: segment.end_time,
        duration: ranges.reduce((total, [start, end]) => total + end - start, 0),
        text: `rendered ${segment.text}`,
        keep_ranges: ranges,
        source_ranges: ranges.map(([start, end]) => ({ start, end })),
        caption_settings: { font_size: 32, position_y: 0.7 },
      };
      clips.push(clip);
      await emit({ type: "clip", index, clip });
    }
    return { clips, failed };
  };
}

export async function seedTask(overrides: Partial<TaskDoc> = {}): Promise<TaskDoc> {
  const now = new Date();
  const task: TaskDoc = {
    _id: `task-${newJobId().slice(0, 8)}`,
    userId: "user-1",
    status: "queued",
    progress: 0,
    progressMessage: "",
    source: { type: "upload", url: "upload://00000000-0000-4000-8000-000000000001.mp4", title: "Talk" },
    settings: settingsFromCreateRequest({}),
    clips: [],
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
  await collections().tasks.insertOne(task);
  return task;
}

export function clipFixture(id: string, taskId: string, overrides: Partial<ClipDoc> = {}): ClipDoc {
  const now = new Date();
  return {
    id,
    filename: `${id}.mp4`,
    storageKey: `clips/${taskId}/${id}.mp4`,
    startTime: "00:05",
    endTime: "00:25",
    duration: 20,
    text: `words of ${id}`,
    relevanceScore: 0.9,
    reasoning: "Strong hook",
    viralityScore: 70,
    hookScore: 20,
    engagementScore: 18,
    valueScore: 17,
    shareabilityScore: 15,
    hookType: "question",
    hookTitle: `Hook ${id}`,
    sourceRanges: [{ start: 5, end: 25 }],
    keepRanges: [[5.2, 24.8]],
    captionSettings: { font_size: 32 },
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

/** Insert a job and claim it, as the worker loop would. */
export async function claimed(input: EnqueueInput): Promise<JobDoc> {
  await enqueueJob(input);
  const job = await claimJob("test-worker");
  if (!job || job._id !== (input.id ?? job._id)) throw new Error("Expected to claim the job just enqueued");
  return job;
}

export async function exists(file: string) {
  return fs.stat(file).then(
    () => true,
    () => false,
  );
}
