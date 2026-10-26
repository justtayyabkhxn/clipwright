import { beforeEach, describe, expect, it, vi } from "vitest";

const warning = vi.fn();
vi.mock("sonner", () => ({ toast: { warning: (...args: unknown[]) => warning(...args) } }));

import { WORKER_OFFLINE_MESSAGE, warnIfWorkerOffline, warnIfWorkerOfflineResponse } from "./worker-notice";

describe("worker offline notice", () => {
  beforeEach(() => warning.mockClear());

  it("warns only when the response says the worker is offline", () => {
    warnIfWorkerOffline({ task_id: "t", worker_online: true });
    warnIfWorkerOffline({ task_id: "t" });
    warnIfWorkerOffline(null);
    expect(warning).not.toHaveBeenCalled();
    warnIfWorkerOffline({ task_id: "t", worker_online: false });
    expect(warning).toHaveBeenCalledWith(WORKER_OFFLINE_MESSAGE, expect.objectContaining({ id: "worker-offline" }));
  });

  it("leaves the response body readable", async () => {
    const response = new Response(JSON.stringify({ id: "job", worker_online: false }));
    await warnIfWorkerOfflineResponse(response);
    expect(warning).toHaveBeenCalledOnce();
    await expect(response.json()).resolves.toEqual({ id: "job", worker_online: false });
    await warnIfWorkerOfflineResponse(new Response("not json"));
    expect(warning).toHaveBeenCalledOnce();
  });
});
