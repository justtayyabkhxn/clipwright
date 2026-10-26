import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import { paths } from "./env";

export type EngineEvent =
  | { type: "progress"; pct: number; message?: string }
  | { type: "clip_start"; index: number; total: number }
  | { type: "clip"; index: number; clip: Record<string, unknown> }
  | { type: "clip_failed"; index: number; message: string };

export class EngineError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly stderr = "",
  ) {
    super(message);
  }
}

export class EngineCancelled extends Error {
  constructor() {
    super("The render engine was cancelled.");
  }
}

export type RunEngineOptions = {
  /** Awaited in order; a rejection stops the engine and rejects the run with that error. */
  onEvent?: (event: EngineEvent) => void | Promise<void>;
  signal?: AbortSignal;
  /** Written on abort/timeout so the engine can stop its ffmpeg children before it is killed. */
  cancelFile?: string;
  timeoutMs?: number;
  /** Replaces `ENGINE_PYTHON -X utf8 -m clipwright_engine <command>` (tests use a fake engine). */
  exec?: { file: string; args: string[] };
};

type StopReason = "cancelled" | "timeout" | { error: unknown };

const KILL_GRACE_MS = 5_000;
const STDERR_TAIL_BYTES = 4096;

function killTree(pid: number) {
  if (process.platform === "win32") {
    spawn("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" }).on("error", () => {});
  } else {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
}

/**
 * Run one engine command: JSON request on stdin, NDJSON events on stdout, the last one
 * `result` or `error`. Exit 0 = success, 1 = error, 2 = cancelled.
 */
export async function runEngine<T = Record<string, unknown>>(
  command: string,
  request: Record<string, unknown>,
  options: RunEngineOptions = {},
): Promise<T> {
  const { onEvent, signal, cancelFile, timeoutMs } = options;
  if (signal?.aborted) throw new EngineCancelled();

  const exec = options.exec ?? {
    file: paths.enginePython,
    args: ["-X", "utf8", "-m", "clipwright_engine", command],
  };
  const child = spawn(exec.file, exec.args, {
    cwd: options.exec ? undefined : paths.engineDir,
    env: { ...process.env, PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8" },
    windowsHide: true,
    // Its own process group, so the whole tree (ffmpeg included) can be killed on POSIX.
    detached: process.platform !== "win32",
    stdio: ["pipe", "pipe", "pipe"],
  });

  let stderr = "";
  let result: { data: T } | null = null;
  let reported: { code: string; message: string } | null = null;
  let stopReason: StopReason | null = null;
  let queue: Promise<void> = Promise.resolve();
  let exited = false;
  let killTimer: NodeJS.Timeout | undefined;
  let timeout: NodeJS.Timeout | undefined;

  const exit = new Promise<{ code: number | null; spawnError?: Error }>((resolve) => {
    child.once("error", (spawnError) => resolve({ code: null, spawnError }));
    child.once("close", (code) => resolve({ code }));
  }).finally(() => {
    exited = true;
    clearTimeout(killTimer);
    clearTimeout(timeout);
  });

  const stop = async (reason: StopReason) => {
    if (stopReason) return;
    // Recorded even after exit: a handler can still fail (or a cancel arrive) while the queue drains.
    stopReason = reason;
    if (exited) return;
    if (cancelFile) {
      await fs.mkdir(path.dirname(cancelFile), { recursive: true }).catch(() => {});
      await fs.writeFile(cancelFile, "").catch(() => {});
      killTimer = setTimeout(() => !exited && child.pid && killTree(child.pid), KILL_GRACE_MS);
    } else if (child.pid) {
      killTree(child.pid);
    }
  };

  const onAbort = () => void stop("cancelled");
  signal?.addEventListener("abort", onAbort, { once: true });
  if (timeoutMs) timeout = setTimeout(() => void stop("timeout"), timeoutMs);

  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr = (stderr + chunk).slice(-STDERR_TAIL_BYTES);
  });

  createInterface({ input: child.stdout, crlfDelay: Infinity }).on("line", (line) => {
    if (!line.trim()) return;
    let event: EngineEvent | { type: "result"; data?: T } | { type: "error"; code?: string; message?: string };
    try {
      event = JSON.parse(line);
    } catch {
      console.warn(`[engine] Ignoring non-JSON output from ${command}: ${line.slice(0, 200)}`);
      return;
    }
    if (event.type === "result") {
      result = { data: event.data ?? ({} as T) };
    } else if (event.type === "error") {
      reported = { code: String(event.code ?? "internal"), message: String(event.message ?? "The render engine failed.") };
    } else if (onEvent) {
      queue = queue.then(async () => {
        if (stopReason) return;
        try {
          await onEvent(event);
        } catch (error) {
          await stop({ error });
        }
      });
    }
  });

  child.stdin.on("error", () => {}); // EPIPE when the engine exits before reading its request
  child.stdin.end(JSON.stringify(request));

  const { code, spawnError } = await exit;
  await queue;
  signal?.removeEventListener("abort", onAbort);

  const tail = stderr.trim();
  const withTail = (message: string) => (tail ? `${message}\n${tail}` : message);
  // Assigned in callbacks, which TS does not see: it would narrow these to their initial null.
  const reason = stopReason as StopReason | null;
  const engineResult = result as { data: T } | null;
  const engineError = reported as { code: string; message: string } | null;

  if (spawnError) {
    throw new EngineError("internal", `Could not start the render engine (${exec.file}): ${spawnError.message}`, tail);
  }
  if (reason && typeof reason === "object") throw reason.error;
  if (reason === "cancelled") throw new EngineCancelled();
  if (reason === "timeout") {
    throw new EngineError("timeout", `The render engine timed out after ${Math.round(timeoutMs! / 1000)} s.`, tail);
  }
  if (code === 2 || engineError?.code === "cancelled") throw new EngineCancelled();
  if (engineError) throw new EngineError(engineError.code, engineError.message, tail);
  if (code === 0 && engineResult) return engineResult.data;
  if (code === 0) throw new EngineError("internal", withTail(`The render engine ${command} exited without a result.`), tail);
  throw new EngineError("internal", withTail(`The render engine ${command} failed (exit code ${code}).`), tail);
}
