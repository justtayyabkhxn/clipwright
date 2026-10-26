"use client";

import { useEffect, useRef, useState } from "react";

export const TASK_POLL_INTERVAL_MS = 2000;

/**
 * Polls a running task every 2 s, and again when the tab becomes visible or the
 * network comes back. `refresh` resolves `false` (or throws) when a poll fails;
 * `reconnecting` stays true until a later poll succeeds.
 */
export function useTaskProgress({ taskId, active, refresh }: {
  taskId: string;
  active: boolean;
  refresh: () => Promise<unknown>;
}) {
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;
  const [reconnecting, setReconnecting] = useState(false);

  useEffect(() => {
    if (!active || !taskId) {
      setReconnecting(false);
      return;
    }
    let disposed = false;
    let refreshing = false;
    const reconcile = async () => {
      if (disposed || refreshing) return;
      refreshing = true;
      try {
        const ok = await refreshRef.current();
        if (!disposed) setReconnecting(ok === false);
      } catch {
        // Keep polling; a transport failure is not a failed generation.
        if (!disposed) setReconnecting(true);
      } finally {
        refreshing = false;
      }
    };
    const timer = window.setInterval(() => { void reconcile(); }, TASK_POLL_INTERVAL_MS);
    const onVisible = () => { if (document.visibilityState === "visible") void reconcile(); };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("online", onVisible);
    return () => {
      disposed = true;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("online", onVisible);
    };
  }, [taskId, active]);
  return { reconnecting };
}
