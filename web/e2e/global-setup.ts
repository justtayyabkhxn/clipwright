import { randomUUID } from "crypto";
import { mkdir, writeFile } from "fs/promises";
import path from "path";

import { hashPassword } from "better-auth/crypto";
import { MongoClient, ObjectId } from "mongodb";

import type { ClipDoc, TaskDoc } from "../src/server/types";

const DEFAULT_SETTINGS: TaskDoc["settings"] = {
  fontFamily: null, fontSize: null, fontColor: null, captionTemplate: "default", outputFormat: "vertical",
  addSubtitles: true, clipLength: "auto", cutLongPauses: true, pauseThresholdMs: 1200, removeFillerWords: true, filteredWords: [],
};

/** Seeds two Better Auth users (one admin) and two tasks straight into MongoDB. */
export default async function globalSetup() {
  const client = new MongoClient(process.env.MONGODB_URI!);
  await client.connect();
  const db = client.db(process.env.MONGODB_DB);
  const now = new Date();
  const regularEmail = "e2e-user@clipwright.test";
  const adminEmail = "e2e-admin@clipwright.test";
  const password = "Password123!";

  const stale = await db.collection("user").find({ email: { $in: [regularEmail, adminEmail] } }).toArray();
  const staleIds = stale.map((user) => user._id as ObjectId);
  await db.collection("tasks").deleteMany({ userId: { $in: staleIds.map((id) => id.toHexString()) } });
  await db.collection("account").deleteMany({ userId: { $in: staleIds } });
  await db.collection("session").deleteMany({ userId: { $in: staleIds } });
  await db.collection("user").deleteMany({ _id: { $in: staleIds } });

  const passwordHash = await hashPassword(password);
  const users = [
    { _id: new ObjectId(), name: "E2E User", email: regularEmail, is_admin: false },
    { _id: new ObjectId(), name: "E2E Admin", email: adminEmail, is_admin: true },
  ];
  await db.collection("user").insertMany(users.map((user) => ({ ...user, emailVerified: false, image: null, createdAt: now, updatedAt: now })));
  await db.collection("account").insertMany(users.map((user) => ({
    _id: new ObjectId(),
    accountId: user._id.toHexString(),
    providerId: "credential",
    userId: user._id,
    password: passwordHash,
    createdAt: now,
    updatedAt: now,
  })));

  const userId = users[0]._id.toHexString();
  const completedTaskId = randomUUID();
  const queuedTaskId = randomUUID();
  const clip: ClipDoc = {
    id: randomUUID(), filename: "seeded-clip.mp4", storageKey: `clips/${completedTaskId}/seeded-clip.mp4`,
    startTime: "00:00", endTime: "00:15", duration: 15, text: "This is a seeded clip",
    relevanceScore: 0.99, reasoning: "Seed data for Playwright",
    viralityScore: 0, hookScore: 0, engagementScore: 0, valueScore: 0, shareabilityScore: 0,
    hookType: null, hookTitle: null, sourceRanges: [{ start: 0, end: 15 }], createdAt: now, updatedAt: now,
  };
  const completedSourceTitle = "Seeded marketing walkthrough";
  const tasks: TaskDoc[] = [
    {
      _id: completedTaskId, userId, status: "completed", progress: 100, progressMessage: "Complete!",
      source: { type: "youtube", url: "https://www.youtube.com/watch?v=jNQXAC9IVRw", title: completedSourceTitle, videoId: "jNQXAC9IVRw" },
      settings: DEFAULT_SETTINGS, clips: [clip], createdAt: now, updatedAt: now,
    },
    {
      _id: queuedTaskId, userId, status: "queued", progress: 0, progressMessage: "",
      source: { type: "youtube", url: "https://www.youtube.com/watch?v=abcdefghijk", title: "Queued seed source", videoId: "abcdefghijk" },
      settings: DEFAULT_SETTINGS, clips: [], createdAt: new Date(now.getTime() - 60_000), updatedAt: now,
    },
  ];
  await db.collection<TaskDoc>("tasks").insertMany(tasks);
  await client.close();

  const seedPath = path.join(process.cwd(), "e2e", ".seed.json");
  await mkdir(path.dirname(seedPath), { recursive: true });
  await writeFile(seedPath, JSON.stringify({
    regular: { email: regularEmail, password },
    admin: { email: adminEmail, password },
    completedTaskId,
    queuedTaskId,
    completedSourceTitle,
  }, null, 2));
}
