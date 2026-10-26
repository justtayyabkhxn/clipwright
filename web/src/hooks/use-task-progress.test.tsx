import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TASK_POLL_INTERVAL_MS, useTaskProgress } from "./use-task-progress";

describe("generation progress polling", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("polls every 2 seconds while active and stops when the task settles", async () => {
    const refresh = vi.fn().mockResolvedValue(true);
    const { rerender, unmount } = renderHook(({ active }) => useTaskProgress({ taskId: "one", active, refresh }), { initialProps: { active: true } });
    expect(refresh).not.toHaveBeenCalled();
    await act(async () => { await vi.advanceTimersByTimeAsync(TASK_POLL_INTERVAL_MS); });
    expect(refresh).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(TASK_POLL_INTERVAL_MS * 2); });
    expect(refresh).toHaveBeenCalledTimes(3);
    rerender({ active: false });
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(refresh).toHaveBeenCalledTimes(3);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("reports a failed poll as reconnecting until a later poll succeeds", async () => {
    const refresh = vi.fn().mockResolvedValueOnce(false).mockRejectedValueOnce(new Error("offline")).mockResolvedValue(true);
    const { result, unmount } = renderHook(() => useTaskProgress({ taskId: "one", active: true, refresh }));
    await act(async () => { await vi.advanceTimersByTimeAsync(TASK_POLL_INTERVAL_MS); });
    expect(result.current.reconnecting).toBe(true);
    await act(async () => { await vi.advanceTimersByTimeAsync(TASK_POLL_INTERVAL_MS); });
    expect(result.current.reconnecting).toBe(true);
    await act(async () => { await vi.advanceTimersByTimeAsync(TASK_POLL_INTERVAL_MS); });
    expect(result.current.reconnecting).toBe(false);
    unmount();
  });

  it("refreshes when the tab becomes visible or the network returns, never overlapping requests", async () => {
    let resolve!: () => void;
    const refresh = vi.fn(() => new Promise<void>((done) => { resolve = done; }));
    const { unmount } = renderHook(() => useTaskProgress({ taskId: "one", active: true, refresh }));
    act(() => { window.dispatchEvent(new Event("online")); });
    expect(refresh).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(TASK_POLL_INTERVAL_MS * 3); });
    act(() => { document.dispatchEvent(new Event("visibilitychange")); });
    expect(refresh).toHaveBeenCalledTimes(1);
    await act(async () => resolve());
    act(() => { document.dispatchEvent(new Event("visibilitychange")); });
    expect(refresh).toHaveBeenCalledTimes(2);
    unmount();
  });
});
