// The Clipwright worker: `pnpm worker` (or `pnpm dev`, next to Next). It claims jobs from Mongo,
// runs them through the Python engine, and keeps the queue and storage tidy.

import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

// web/, however the worker was started (from web/ like the package scripts, or the repo root).
const webDir = existsSync(path.join(process.cwd(), "web", "package.json")) ? path.join(process.cwd(), "web") : process.cwd();
const requireFromWeb = createRequire(path.join(webDir, "package.json"));
// @next/env belongs to next, not to web/ directly; resolve it from next's own install.
const { loadEnvConfig } = createRequire(requireFromWeb.resolve("next/package.json"))("@next/env") as {
  loadEnvConfig(dir: string, dev?: boolean): unknown;
};
// Before any server module reads process.env (they are imported below, after this).
loadEnvConfig(webDir, process.env.NODE_ENV !== "production");

const HEARTBEAT_INTERVAL_MS = 10_000;
const IDLE_POLL_MS = 1_000;

async function main() {
  const [{ closeDb, collections, ensureIndexes }, jobs, { env }, { registerFailureHooks, runJob }, cron] = await Promise.all([
    import("../server/db"),
    import("../server/jobs"),
    import("../server/env"),
    import("./run-job"),
    import("./cron"),
  ]);

  const workerId = `${os.hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;
  const startedAt = new Date();
  const version = String((requireFromWeb("./package.json") as { version?: string }).version ?? "dev");
  const shutdown = new AbortController();

  process.on("SIGINT", () => stop("SIGINT"));
  process.on("SIGTERM", () => stop("SIGTERM"));
  function stop(signal: string) {
    if (shutdown.signal.aborted) {
      console.log(`[worker] ${signal} again: exiting now`);
      process.exit(1);
    }
    console.log(`[worker] ${signal}: stopping running jobs (they go back to the queue)...`);
    shutdown.abort();
  }

  await ensureIndexes();
  registerFailureHooks();

  const beat = () =>
    jobs.writeWorkerHeartbeat({ workerId, startedAt, version }).catch((error) => console.error("[worker] Heartbeat failed", error));
  await beat();
  const heartbeat = setInterval(beat, HEARTBEAT_INTERVAL_MS);

  let cronRunning: Promise<void> | null = null;
  const runCron = () => {
    cronRunning ??= cron.runCron().finally(() => (cronRunning = null));
  };
  runCron();
  const cronTimer = setInterval(runCron, cron.CRON_INTERVAL_MS);

  const idle = () => sleep(IDLE_POLL_MS, undefined, { signal: shutdown.signal }).catch(() => {});
  const slot = async (index: number) => {
    while (!shutdown.signal.aborted) {
      try {
        await jobs.reapExpiredJobs();
        const job = await jobs.claimJob(workerId);
        if (!job) {
          await idle();
          continue;
        }
        console.log(`[worker] slot ${index}: ${job.type} ${job._id} (task ${job.taskId}, attempt ${job.attempts})`);
        const outcome = await runJob(job, undefined, shutdown.signal);
        console.log(`[worker] slot ${index}: ${job.type} ${job._id} -> ${outcome?.status ?? "released"}`);
      } catch (error) {
        console.error(`[worker] slot ${index}: poll failed`, error);
        await idle();
      }
    }
  };

  console.log(`[worker] ${workerId} started with ${env.WORKER_CONCURRENCY} slot(s)`);
  await Promise.all(Array.from({ length: env.WORKER_CONCURRENCY }, (_, index) => slot(index + 1)));

  clearInterval(heartbeat);
  clearInterval(cronTimer);
  await cronRunning;
  // Show the worker as offline right away instead of after the 30 s heartbeat window.
  await collections().workerStatus.deleteOne({ _id: "worker", workerId }).catch(() => {});
  await closeDb();
  console.log("[worker] stopped");
  process.exit(0);
}

main().catch((error) => {
  console.error("[worker] Fatal error", error);
  process.exit(1);
});
