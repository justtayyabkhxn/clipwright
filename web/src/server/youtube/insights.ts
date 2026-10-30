// What performs on a creator's channel, from their posted Shorts' view counts, as a short note for
// the clip-selection prompts (`channelNotes`). Read-only; the worker calls it before analysis.

import { collections } from "../db";
import { lineageOf } from "./posts";

/** Below this many measured videos the note says nothing reliable, so there is none. */
export const MIN_MEASURED_POSTS = 10;
/** A hook type or length bucket needs this many videos before its average is mentioned. */
const MIN_GROUP = 3;
const TOP_CLIPS = 5;
const EXCERPT_WORDS = 25;
/** The newest posts only: a channel's audience drifts, and the note must stay small. */
const RECENT_POSTS = 200;

type Measured = { views: number; hookType: string | null; duration: number; hookTitle: string | null; text: string };

const lengthBucket = (seconds: number) => (seconds < 30 ? "under 30 s" : seconds < 60 ? "30-60 s" : "over 60 s");

function averages(rows: Measured[], groupOf: (row: Measured) => string | null): string | null {
  const groups = new Map<string, number[]>();
  for (const row of rows) {
    const group = groupOf(row);
    if (group) groups.set(group, [...(groups.get(group) ?? []), row.views]);
  }
  const parts = [...groups]
    .filter(([, views]) => views.length >= MIN_GROUP)
    .map(([group, views]) => ({ group, count: views.length, avg: Math.round(views.reduce((a, b) => a + b, 0) / views.length) }))
    .sort((a, b) => b.avg - a.avg)
    .map(({ group, count, avg }) => `${group} ${avg} avg views (${count} clips)`);
  return parts.length >= 2 ? parts.join(", ") : null;
}

/** First words of the clip, on one line, as plain data (no quotes that could close the note's own). */
function excerpt(text: string): string {
  const words = text.replace(/["\r\n]+/g, " ").split(/\s+/).filter(Boolean);
  return words.slice(0, EXCERPT_WORDS).join(" ") + (words.length > EXCERPT_WORDS ? " ..." : "");
}

/**
 * Null until the user has MIN_MEASURED_POSTS live posted clips with view counts. Otherwise: the
 * median, average views by hook type and by length (when at least two groups qualify), and the
 * top clips with their opening words.
 */
export async function channelNotesFor(userId: string): Promise<string | null> {
  const { youtubePosts, tasks } = collections();
  const posts = await youtubePosts
    .find(
      { userId, state: "uploaded", uploadStatus: { $ne: "deleted" }, stats: { $exists: true } },
      { projection: { taskId: 1, lineageId: 1, stats: 1 } },
    )
    .sort({ uploadedAt: -1 })
    .limit(RECENT_POSTS)
    .toArray();
  if (posts.length < MIN_MEASURED_POSTS) return null;

  const taskDocs = await tasks
    .find(
      { _id: { $in: [...new Set(posts.map((post) => post.taskId))] }, userId },
      { projection: { "clips.id": 1, "clips.lineageId": 1, "clips.hookType": 1, "clips.duration": 1, "clips.hookTitle": 1, "clips.text": 1 } },
    )
    .toArray();
  const clipByLineage = new Map(taskDocs.flatMap((task) => task.clips.map((clip) => [lineageOf(clip), clip] as const)));
  const rows: Measured[] = posts.flatMap((post) => {
    const clip = clipByLineage.get(post.lineageId);
    return clip ? [{ views: post.stats!.views, hookType: clip.hookType, duration: clip.duration, hookTitle: clip.hookTitle, text: clip.text }] : [];
  });
  if (rows.length < MIN_MEASURED_POSTS) return null;

  const sorted = [...rows].sort((a, b) => b.views - a.views);
  const mid = sorted.length / 2;
  const median = Number.isInteger(mid) ? Math.round((sorted[mid - 1].views + sorted[mid].views) / 2) : sorted[Math.floor(mid)].views;
  const lines = [`- ${rows.length} recent posted Shorts, median ${median} views.`];
  const byHook = averages(rows, (row) => row.hookType);
  if (byHook) lines.push(`- By hook type: ${byHook}.`);
  const byLength = averages(rows, (row) => lengthBucket(row.duration));
  if (byLength) lines.push(`- By length: ${byLength}.`);
  lines.push("- Top clips:");
  for (const row of sorted.slice(0, TOP_CLIPS)) {
    const title = row.hookTitle ? `${row.hookTitle.replace(/["\r\n]+/g, " ")}; ` : "";
    lines.push(`  - ${row.views} views (${title}${row.hookType ?? "no hook type"}, ${Math.round(row.duration)} s), opening: ${excerpt(row.text)}`);
  }
  return lines.join("\n");
}
