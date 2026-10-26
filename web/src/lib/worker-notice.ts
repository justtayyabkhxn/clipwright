import { toast } from "sonner";

export const WORKER_OFFLINE_MESSAGE = "The Clipwright worker isn't running. Start it with pnpm dev (or pnpm worker).";

/**
 * Enqueue routes answer `worker_online: false` when no worker heartbeat is fresh.
 * The job is still queued and runs once a worker starts, so this is a warning, not an error.
 */
export function warnIfWorkerOffline(body: unknown): void {
  if (body && typeof body === "object" && (body as { worker_online?: unknown }).worker_online === false) {
    toast.warning(WORKER_OFFLINE_MESSAGE, { id: "worker-offline", duration: 10_000 });
  }
}

/** Reads a JSON response body without consuming the original, then warns if the worker is offline. */
export async function warnIfWorkerOfflineResponse(response: Response): Promise<void> {
  try {
    warnIfWorkerOffline(await response.clone().json());
  } catch {
    // Not JSON; nothing to check.
  }
}
