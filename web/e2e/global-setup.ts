// Boots the whole stack with no paid services: an in-memory Mongo replica set, fake Anthropic and
// AssemblyAI servers, a synthetic video, `next dev` and the real worker + Python engine.
// The returned function is the teardown. State for the spec goes through process.env (E2E_*).
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createWriteStream, mkdirSync, rmSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import { startFakeAnthropic } from "./fakes/anthropic";
import { startFakeAssemblyAI } from "./fakes/assemblyai";

const webDir = path.resolve(__dirname, "..");

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function kill(child: ChildProcess) {
  if (child.exitCode !== null || child.pid === undefined) return;
  if (process.platform === "win32") {
    try {
      execFileSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    } catch {
      // Already gone.
    }
  } else {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
}

let stopping = false;

function start(name: string, args: string[], env: NodeJS.ProcessEnv, logDir: string): ChildProcess {
  const log = createWriteStream(path.join(logDir, `${name}.log`));
  const child = spawn(process.execPath, args, { cwd: webDir, env, detached: process.platform !== "win32", windowsHide: true });
  child.stdout?.pipe(log);
  child.stderr?.pipe(log);
  child.on("exit", (code) => code && !stopping && console.error(`[e2e] ${name} exited with ${code}; see ${path.join(logDir, `${name}.log`)}`));
  return child;
}

export default async function globalSetup() {
  const started = Date.now();
  const runDir = path.join(os.tmpdir(), `cw-e2e-${process.pid}`);
  // Logs outlive the run (one fixed dir, replaced each run) so a failure can be read afterwards.
  const logDir = path.join(os.tmpdir(), "cw-e2e-logs");
  rmSync(logDir, { recursive: true, force: true });
  mkdirSync(logDir, { recursive: true });
  mkdirSync(runDir, { recursive: true });

  const children: ChildProcess[] = [];
  const closers: (() => Promise<unknown>)[] = [];
  const teardown = async () => {
    stopping = true;
    children.forEach(kill);
    for (const close of closers.reverse()) await close().catch(() => {});
    rmSync(runDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
  };

  try {
    const mongo = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: "wiredTiger" } });
    closers.push(() => mongo.stop());
    const anthropic = await startFakeAnthropic();
    closers.push(anthropic.close);
    const assembly = await startFakeAssemblyAI();
    closers.push(assembly.close);

    const video = path.join(runDir, "synthetic-talk.mp4");
    execFileSync("ffmpeg", [
      "-v", "error", "-y",
      "-f", "lavfi", "-i", "testsrc2=size=1920x1080:rate=30:duration=45",
      "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=45",
      "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", video,
    ], { stdio: "inherit", timeout: 120_000 });

    const port = await freePort();
    const baseURL = `http://127.0.0.1:${port}`;
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      NODE_ENV: "development",
      MONGODB_URI: mongo.getUri(),
      MONGODB_DB: "clipwright_e2e",
      BETTER_AUTH_SECRET: "clipwright-e2e-secret-0123456789abcdef",
      BETTER_AUTH_URL: baseURL,
      NEXT_PUBLIC_APP_URL: baseURL,
      DATA_DIR: path.join(runDir, "data"),
      ANTHROPIC_BASE_URL: anthropic.url,
      ASSEMBLYAI_BASE_URL: assembly.url,
      CLAUDE_MODEL: "claude-opus-5",
      // Keys come from Settings in the spec; never from the developer's shell.
      ANTHROPIC_API_KEY: "",
      ASSEMBLY_AI_API_KEY: "",
      NEXT_TELEMETRY_DISABLED: "1",
    };
    children.push(start("next", [path.join(webDir, "node_modules/next/dist/bin/next"), "dev", "--turbopack", "--hostname", "127.0.0.1", "--port", String(port)], env, logDir));
    children.push(start("worker", [path.join(webDir, "node_modules/tsx/dist/cli.mjs"), "src/worker/main.ts"], env, logDir));

    // /api/health is 200 once Next compiled it, Mongo answers and the worker has written a heartbeat.
    const deadline = Date.now() + 240_000;
    for (;;) {
      if (children.some((child) => child.exitCode !== null)) throw new Error(`A server exited early; logs in ${logDir}`);
      const ok = await fetch(`${baseURL}/api/health`).then((response) => response.ok, () => false);
      if (ok) break;
      if (Date.now() > deadline) throw new Error(`Stack not healthy after 240 s; logs in ${logDir}`);
      await sleep(1000);
    }

    Object.assign(process.env, {
      E2E_BASE_URL: baseURL,
      E2E_VIDEO: video,
      E2E_LOG_DIR: logDir,
      E2E_ANTHROPIC_URL: anthropic.url,
      E2E_ASSEMBLYAI_URL: assembly.url,
    });
    console.log(`[e2e] stack ready at ${baseURL} in ${((Date.now() - started) / 1000).toFixed(1)} s (logs: ${logDir})`);
    return teardown;
  } catch (error) {
    await teardown();
    throw error;
  }
}
