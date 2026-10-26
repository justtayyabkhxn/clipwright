import { getClient, getDb } from "@/server/db";
import { handle, json } from "@/server/http";
import { workerStatus } from "@/server/jobs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CHECK_TIMEOUT_MS = 5000;

// The driver's own timeoutMS does not cover the first connect (30 s server selection).
async function within<T>(ms: number, work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`No answer within ${ms} ms`)), ms);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** `{ok, db, worker: {online, heartbeatAt}}`; 503 unless the database answers and a worker is alive. */
export const GET = handle(async () => {
  let db = false;
  let worker: { online: boolean; heartbeatAt: Date | null } = { online: false, heartbeatAt: null };
  try {
    // An explicit connect() replaces a topology closed by an earlier failed connect; operations alone never do.
    await within(CHECK_TIMEOUT_MS, getClient().connect().then(() => getDb().command({ ping: 1 }, { timeoutMS: CHECK_TIMEOUT_MS })));
    db = true;
    worker = await within(CHECK_TIMEOUT_MS, workerStatus());
  } catch (error) {
    if (!db) console.warn("[health] Database unreachable:", (error as Error).message);
  }
  const ok = db && worker.online;
  return json(
    { ok, db, worker: { online: worker.online, heartbeatAt: worker.heartbeatAt?.toISOString() ?? null } },
    { status: ok ? 200 : 503 },
  );
});
