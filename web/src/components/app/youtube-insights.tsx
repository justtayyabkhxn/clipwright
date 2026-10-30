"use client";

import { useTranslations } from "next-intl";
import { COUNT } from "@/components/app/youtube-status-chip";
import { cn } from "@/lib/utils";

/** The fields of a `GET /api/youtube/posts` item the insights group by. */
export type InsightPost = {
  state: string;
  upload_status: string | null;
  uploaded_at: string | null;
  stats: { views: number } | null;
  hook_type: string | null;
  duration: number | null;
  virality_score: number | null;
  caption_template: string | null;
};

/** A group needs this many videos before its average means anything. */
const MIN_GROUP = 3;

type Dimension = { key: string; groupOf: (post: InsightPost) => string | null };

const DIMENSIONS: Dimension[] = [
  { key: "hookType", groupOf: (post) => post.hook_type },
  {
    key: "length",
    groupOf: ({ duration: d }) => (d === null ? null : d < 30 ? "under30" : d < 60 ? "30to60" : "over60"),
  },
  { key: "captionStyle", groupOf: (post) => post.caption_template },
  {
    key: "timeOfDay",
    // The viewer's own time zone: that's the clock they schedule by.
    groupOf: ({ uploaded_at }) => {
      if (!uploaded_at) return null;
      const hour = new Date(uploaded_at).getHours();
      return hour >= 5 && hour < 12 ? "morning" : hour >= 12 && hour < 17 ? "afternoon" : hour >= 17 && hour < 22 ? "evening" : "night";
    },
  },
  {
    key: "score",
    groupOf: ({ virality_score: s }) => (s === null ? null : s >= 85 ? "85plus" : s >= 70 ? "70to84" : s >= 50 ? "50to69" : "under50"),
  },
];

type Row = { group: string; videos: number; avgViews: number };

function rowsFor(posts: InsightPost[], dimension: Dimension): Row[] {
  const groups = new Map<string, number[]>();
  for (const post of posts) {
    const group = dimension.groupOf(post);
    if (group === null) continue;
    groups.set(group, [...(groups.get(group) ?? []), post.stats!.views]);
  }
  return [...groups]
    .filter(([, views]) => views.length >= MIN_GROUP)
    .map(([group, views]) => ({ group, videos: views.length, avgViews: views.reduce((a, b) => a + b, 0) / views.length }))
    .sort((a, b) => b.avgViews - a.avgViews);
}

/** Each dimension with at least one group of MIN_GROUP live, measured videos, best average first. */
export function insightRows(posts: InsightPost[]) {
  const measured = posts.filter((post) => post.state === "uploaded" && post.upload_status !== "deleted" && post.stats);
  return DIMENSIONS.map((dimension) => ({ dimension, rows: rowsFor(measured, dimension) })).filter(({ rows }) => rows.length > 0);
}

/** Average views per group of posted clips (hook type, length, caption style, time of day, Claude's score). */
export function YoutubeInsights({ posts }: { posts: InsightPost[] }) {
  const t = useTranslations("youtube.insights");
  const dimensions = insightRows(posts);

  return (
    <section aria-labelledby="insights-title" className="mt-8">
      <h2 id="insights-title" className="font-display text-lg font-semibold tracking-tight">{t("title")}</h2>
      <p className="mt-0.5 text-xs text-muted-foreground">{t("description", { min: MIN_GROUP })}</p>
      {dimensions.length === 0 ? (
        <p className="mt-3 rounded-xl border bg-background px-4 py-3 text-sm text-muted-foreground">{t("notEnough", { min: MIN_GROUP })}</p>
      ) : (
        <div className="mt-3 grid gap-3 md:grid-cols-2">
          {dimensions.map(({ dimension, rows }) => {
            const best = rows[0].avgViews || 1;
            return (
              <div key={dimension.key} className="rounded-xl border bg-background px-4 py-3">
                <h3 className="text-sm font-semibold">{t(`dimensions.${dimension.key}`)}</h3>
                <ul className="mt-2 space-y-2">
                  {rows.map((row, index) => (
                    <li key={row.group} className="text-sm">
                      <div className="flex items-baseline justify-between gap-3">
                        <span className="truncate">{groupLabel(t, dimension.key, row.group)}</span>
                        <span className="shrink-0 tabular-nums">
                          <span className="font-semibold">{COUNT.format(Math.round(row.avgViews))}</span>
                          <span className="text-xs text-muted-foreground"> {t("avgViews", { count: row.videos })}</span>
                        </span>
                      </div>
                      <div className="mt-1 h-1.5 rounded-full bg-muted">
                        <div
                          className={cn("h-full rounded-full", index === 0 ? "bg-red-500" : "bg-red-500/40")}
                          style={{ width: `${Math.max(4, (row.avgViews / best) * 100)}%` }}
                        />
                      </div>
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

/** Known groups have copy; a caption template or hook type the copy doesn't know shows its own name. */
function groupLabel(t: ReturnType<typeof useTranslations>, dimension: string, group: string) {
  const key = `groups.${dimension}.${group}`;
  return t.has(key) ? t(key) : group.charAt(0).toUpperCase() + group.slice(1);
}
