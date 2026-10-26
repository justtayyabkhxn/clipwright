/** @vitest-environment node */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { EngineCancelled, EngineError, runEngine, type EngineEvent } from "./engine";

// A stand-in for `python -m clipwright_engine`, speaking the same stdin/stdout protocol.
const FAKE_ENGINE = String.raw`
const fs = require("node:fs");
let input = "";
process.stdin.on("data", (chunk) => (input += chunk));
process.stdin.on("end", () => {
  const request = JSON.parse(input);
  const emit = (event) => process.stdout.write(JSON.stringify(event) + "\n");
  const cancelled = () => request.cancel_file && fs.existsSync(request.cancel_file);
  switch (request.mode) {
    case "ok":
      emit({ type: "progress", pct: 10, message: "Rendering…" });
      process.stdout.write("not json\n");
      emit({ type: "clip_start", index: 0, total: 2 });
      emit({ type: "clip", index: 0, clip: { filename: "clip_1.mp4" } });
      emit({ type: "clip_failed", index: 1, message: "bad segment" });
      emit({ type: "result", data: { echo: request.value, clips: 1 } });
      break;
    case "error":
      process.stderr.write("Traceback: something deep\n");
      emit({ type: "error", code: "too_long", message: "Video is too long (100 min)." });
      process.exitCode = 1;
      break;
    case "crash":
      process.stderr.write("x".repeat(6000) + "\nKeyError: 'boom'\n");
      process.exit(3);
    case "silent":
      break;
    case "cancellable": {
      emit({ type: "progress", pct: 1 });
      const timer = setInterval(() => {
        if (cancelled()) {
          clearInterval(timer);
          emit({ type: "error", code: "cancelled", message: "Cancelled" });
          process.exit(2);
        }
      }, 20);
      break;
    }
    case "stubborn":
      emit({ type: "progress", pct: 1 });
      setInterval(() => {}, 1000);
      break;
    case "events":
      for (let i = 0; i < 5; i++) emit({ type: "clip", index: i, clip: {} });
      setTimeout(() => emit({ type: "result", data: {} }), 2000);
      break;
    case "quick":
      emit({ type: "clip", index: 0, clip: {} });
      emit({ type: "clip", index: 1, clip: {} });
      emit({ type: "result", data: {} });
      break;
  }
});
`;

let dir: string;
let script: string;

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "cw-engine-"));
  script = path.join(dir, "fake-engine.cjs");
  await fs.writeFile(script, FAKE_ENGINE);
});

afterAll(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

const exec = () => ({ file: process.execPath, args: [script] });

describe("runEngine", () => {
  it("streams events in order and resolves with the result data", async () => {
    const events: EngineEvent[] = [];
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const data = await runEngine("render-clips", { mode: "ok", value: "héllo ✓" }, { exec: exec(), onEvent: (e) => void events.push(e) });
    warn.mockRestore();
    expect(data).toEqual({ echo: "héllo ✓", clips: 1 });
    expect(events.map((e) => e.type)).toEqual(["progress", "clip_start", "clip", "clip_failed"]);
    expect(events[0]).toEqual({ type: "progress", pct: 10, message: "Rendering…" });
  });

  it("passes engine errors through with their code", async () => {
    const error = await runEngine("prepare-source", { mode: "error" }, { exec: exec() }).catch((e) => e);
    expect(error).toBeInstanceOf(EngineError);
    expect(error).toMatchObject({ code: "too_long", message: "Video is too long (100 min)." });
    expect(error.stderr).toContain("Traceback");
  });

  it("reports crashes with the stderr tail", async () => {
    const error = await runEngine("probe", { mode: "crash" }, { exec: exec() }).catch((e) => e);
    expect(error).toMatchObject({ code: "internal" });
    expect(error.message).toMatch(/^The render engine probe failed \(exit code 3\)\./);
    expect(error.message).toContain("KeyError: 'boom'");
    expect(error.stderr.length).toBeLessThanOrEqual(4096);
  });

  it("fails when the engine exits without a result", async () => {
    await expect(runEngine("probe", { mode: "silent" }, { exec: exec() })).rejects.toMatchObject({
      code: "internal",
      message: "The render engine probe exited without a result.",
    });
  });

  it("fails cleanly when the interpreter is missing", async () => {
    await expect(
      runEngine("probe", {}, { exec: { file: path.join(dir, "no-such-python.exe"), args: [] } }),
    ).rejects.toMatchObject({ code: "internal", message: expect.stringContaining("Could not start the render engine") });
  });

  it("writes the cancel file on abort and lets the engine stop itself", async () => {
    const controller = new AbortController();
    const cancelFile = path.join(dir, "jobs", "cancel-1");
    const run = runEngine("render-clips", { mode: "cancellable", cancel_file: cancelFile }, {
      exec: exec(),
      cancelFile,
      signal: controller.signal,
      onEvent: () => controller.abort(),
    });
    await expect(run).rejects.toBeInstanceOf(EngineCancelled);
    await expect(fs.stat(cancelFile)).resolves.toBeTruthy();
  });

  it("kills an engine that ignores the cancel file after the grace period", async () => {
    const started = Date.now();
    const run = runEngine("render-clips", { mode: "stubborn" }, { exec: exec(), cancelFile: path.join(dir, "cancel-2"), timeoutMs: 200 });
    await expect(run).rejects.toMatchObject({ code: "timeout", message: "The render engine timed out after 0 s." });
    expect(Date.now() - started).toBeGreaterThanOrEqual(5000);
  }, 20_000);

  it("kills at once without a cancel file", async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 200);
    const started = Date.now();
    await expect(runEngine("render-clips", { mode: "stubborn" }, { exec: exec(), signal: controller.signal })).rejects.toBeInstanceOf(
      EngineCancelled,
    );
    expect(Date.now() - started).toBeLessThan(4000);
  });

  it("refuses an already-aborted signal", async () => {
    await expect(runEngine("probe", {}, { exec: exec(), signal: AbortSignal.abort() })).rejects.toBeInstanceOf(EngineCancelled);
  });

  it("stops the engine and rethrows when an event handler fails", async () => {
    const seen: number[] = [];
    const failure = new Error("Task was cancelled");
    const run = runEngine("render-clips", { mode: "events" }, {
      exec: exec(),
      onEvent: async (event) => {
        if (event.type !== "clip") return;
        seen.push(event.index);
        await new Promise((resolve) => setTimeout(resolve, 10));
        if (event.index === 1) throw failure;
      },
    });
    await expect(run).rejects.toBe(failure);
    expect(seen).toEqual([0, 1]);
  });

  it("rethrows a handler failure that comes after the engine exited", async () => {
    const seen: number[] = [];
    const failure = new Error("pushClip CAS missed");
    const run = runEngine("render-clips", { mode: "quick" }, {
      exec: exec(),
      onEvent: async (event) => {
        if (event.type !== "clip") return;
        seen.push(event.index);
        await new Promise((resolve) => setTimeout(resolve, 300));
        throw failure;
      },
    });
    await expect(run).rejects.toBe(failure);
    expect(seen).toEqual([0]);
  });

  it("reports a cancel that arrives while handlers drain after exit", async () => {
    const controller = new AbortController();
    const run = runEngine("render-clips", { mode: "quick" }, {
      exec: exec(),
      signal: controller.signal,
      onEvent: async () => {
        await new Promise((resolve) => setTimeout(resolve, 300));
        controller.abort();
      },
    });
    await expect(run).rejects.toBeInstanceOf(EngineCancelled);
  });
});
