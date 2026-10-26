import { expect, it } from "vitest";

import { isRestyleRun } from "./status-badge";

it("recognises a running restyle by its job type or the restyle route's message", () => {
  expect(isRestyleRun({ status: "processing", run_type: "restyle_task" })).toBe(true);
  expect(isRestyleRun({ status: "processing", progress_message: "Applying new style..." })).toBe(true);
  expect(isRestyleRun({ status: "processing", run_type: "process_task", progress_message: "Finding moments..." })).toBe(false);
  expect(isRestyleRun({ status: "completed", run_type: "restyle_task" })).toBe(false);
});
