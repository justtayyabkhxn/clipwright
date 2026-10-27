import { MongoClient, type Db } from "mongodb";
import { env } from "./env";
import type {
  AppSettingDoc,
  DraftDoc,
  JobDoc,
  OAuthStateDoc,
  ProcessingCacheDoc,
  TaskDoc,
  UserDoc,
  WorkerStatusDoc,
  YoutubeAccountDoc,
  YoutubePostDoc,
} from "./types";

// One client per process, kept across Next dev hot reloads.
const cache = globalThis as unknown as {
  __clipwrightMongo?: MongoClient;
  __clipwrightConnect?: Promise<void>;
  __clipwrightIndexes?: Promise<void>;
};

export function getClient(): MongoClient {
  const client = (cache.__clipwrightMongo ??= new MongoClient(env.MONGODB_URI));
  // A failed connect leaves a closed topology on the client that operations never replace
  // ("Topology is closed" forever); only connect() builds a new one. So connect explicitly, and
  // again on the first call after a failure. The operations that raced a failed attempt report it.
  if (!cache.__clipwrightConnect) {
    const attempt: Promise<void> = client.connect().then(
      () => undefined,
      () => {
        if (cache.__clipwrightConnect === attempt) cache.__clipwrightConnect = undefined;
      },
    );
    cache.__clipwrightConnect = attempt;
  }
  return client;
}

export function getDb(): Db {
  return getClient().db(env.MONGODB_DB);
}

export function collections() {
  if (!cache.__clipwrightIndexes) {
    ensureIndexes().catch((error) => console.error("[db] Could not create indexes", error));
  }
  const db = getDb();
  return {
    tasks: db.collection<TaskDoc>("tasks"),
    clipDrafts: db.collection<DraftDoc>("clip_drafts"),
    jobs: db.collection<JobDoc>("jobs"),
    processingCache: db.collection<ProcessingCacheDoc>("processing_cache"),
    appSettings: db.collection<AppSettingDoc>("app_settings"),
    workerStatus: db.collection<WorkerStatusDoc>("worker_status"),
    users: db.collection<UserDoc>("user"),
    youtubeAccounts: db.collection<YoutubeAccountDoc>("youtube_accounts"),
    oauthStates: db.collection<OAuthStateDoc>("oauth_states"),
    youtubePosts: db.collection<YoutubePostDoc>("youtube_posts"),
  };
}

async function createIndexes() {
  const db = getDb();
  const exists = (field: string) => ({ partialFilterExpression: { [field]: { $exists: true } } });
  await Promise.all([
    // Better Auth's adapter creates none of its own.
    db.collection("user").createIndex({ email: 1 }, { unique: true }),
    db.collection("session").createIndex({ token: 1 }, { unique: true }),
    db.collection("session").createIndex({ userId: 1 }),
    db.collection("session").createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
    db.collection("account").createIndex({ userId: 1 }),
    db.collection("account").createIndex({ providerId: 1, accountId: 1 }),
    db.collection("verification").createIndex({ identifier: 1 }),
    db.collection("verification").createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
    db.collection("tasks").createIndex({ userId: 1, createdAt: -1 }),
    db.collection("tasks").createIndex({ status: 1, updatedAt: 1 }),
    db.collection("tasks").createIndex({ autopost: 1 }, { partialFilterExpression: { autopost: "pending" } }),
    db.collection("clip_drafts").createIndex({ taskId: 1 }),
    db.collection("jobs").createIndex({ status: 1, runAt: 1 }),
    db.collection("jobs").createIndex({ status: 1, lockedUntil: 1 }),
    db.collection("jobs").createIndex({ activeKey: 1 }, { unique: true, ...exists("activeKey") }),
    db.collection("jobs").createIndex({ liveKey: 1 }, { unique: true, ...exists("liveKey") }),
    db.collection("jobs").createIndex({ clipId: 1, type: 1, createdAt: -1 }),
    db.collection("jobs").createIndex({ taskId: 1 }),
    // Not a TTL: expired export docs must outlive their files until the cron deletes both.
    db.collection("jobs").createIndex({ status: 1, expiresAt: 1 }),
    db.collection("youtube_posts").createIndex({ lineageId: 1 }, { unique: true }),
    db.collection("youtube_posts").createIndex({ taskId: 1 }),
    db.collection("youtube_posts").createIndex({ userId: 1 }),
    db.collection("youtube_posts").createIndex({ state: 1, notBefore: 1 }),
    db.collection("oauth_states").createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
  ]);
}

/** Close the cached client (worker shutdown, tests). */
export async function closeDb() {
  const client = cache.__clipwrightMongo;
  cache.__clipwrightMongo = undefined;
  cache.__clipwrightConnect = undefined;
  cache.__clipwrightIndexes = undefined;
  await client?.close();
}

/** Idempotent. Awaited by the worker at startup; started lazily by the first `collections()` call. */
export function ensureIndexes(): Promise<void> {
  cache.__clipwrightIndexes ??= createIndexes().catch((error) => {
    cache.__clipwrightIndexes = undefined;
    throw error;
  });
  return cache.__clipwrightIndexes;
}
