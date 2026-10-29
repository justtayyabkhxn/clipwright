"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { Settings, TriangleAlert, Youtube } from "lucide-react";
import { EmptyState } from "@/components/app/clip-wall";
import { PageError, PageLoading } from "@/components/app/page-state";
import { YoutubeStatusChip, useYoutubeRetry, type YoutubePost } from "@/components/app/youtube-status-chip";
import { Button } from "@/components/ui/button";
import { formatSupportMessage, parseApiError } from "@/lib/api-error";
import { useSession } from "@/lib/auth-client";

/** `GET /api/youtube/account` (design §9), the fields this page shows. Tokens never appear here. */
type Account = {
  configured: boolean;
  connected: boolean;
  channel: { id: string; title: string; handle: string | null; thumbnail_url: string | null } | null;
  status: "active" | "reauth_required" | "paused" | null;
  warning: string | null;
  auto_post: boolean;
};

/** One `GET /api/youtube/posts` item: the task page's post plus where it came from. */
type OverviewPost = YoutubePost & {
  task_id: string;
  task_title: string | null;
  clip_title: string | null;
  created_at: string;
  uploaded_at: string | null;
};

/** The user's own locale and time zone: a wait can run past midnight, so the day is included. */
function formatWhen(iso: string) {
  return new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

async function getJson<T>(url: string, fallback: string): Promise<T> {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) throw new Error(formatSupportMessage(await parseApiError(response, fallback)));
  return response.json();
}

/** Every clip's YouTube auto-post status in one place (design §10). */
export default function YoutubePage() {
  const t = useTranslations("youtube");
  const tSettings = useTranslations("settings.youtube");
  const { data: session, isPending } = useSession();
  const userId = session?.user?.id;
  const [account, setAccount] = useState<Account | null>(null);
  const [posts, setPosts] = useState<OverviewPost[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (background = false) => {
    try {
      const [nextAccount, list] = await Promise.all([
        getJson<Account>("/api/youtube/account", t("loadError")),
        getJson<{ posts: OverviewPost[]; truncated: boolean }>("/api/youtube/posts", t("loadError")),
      ]);
      setAccount(nextAccount);
      setPosts(list.posts);
      setTruncated(list.truncated);
      setError(null);
    } catch (err) {
      // A failed background poll keeps the last list.
      if (!background) setError(err instanceof Error ? err.message : t("loadError"));
    }
  }, [t]);

  useEffect(() => { if (userId) void load(); }, [load, userId]);

  const { retryingPostId, requestRetry, confirmDialog } = useYoutubeRetry((postId, updated) =>
    setPosts((current) => current.map((post) => (post.id === postId ? { ...post, ...updated } : post))));

  // Fast while something moves within seconds (a working post, or a queued one that is due: a Try
  // again or the next clip of a batch). Slow while a post waits, or while auto-post is on, since a
  // finishing generation adds posts the page has not seen.
  const due = (post: OverviewPost) => post.state === "queued" && (!post.not_before || Date.parse(post.not_before) <= Date.now());
  const pollMs = posts.some((post) => post.state === "working" || due(post)) ? 4000
    : posts.some((post) => post.state === "queued") || account?.auto_post ? 30_000
    : null;
  useEffect(() => {
    if (!pollMs) return;
    const timer = window.setInterval(() => { void load(true); }, pollMs);
    return () => window.clearInterval(timer);
  }, [pollMs, load]);

  if (isPending) return <PageLoading />;
  if (!userId) {
    return (
      <div className="mx-auto max-w-md px-4 py-24 text-center">
        <h1 className="font-display text-3xl font-bold tracking-tight">{t("signInRequired.title")}</h1>
        <p className="mb-8 mt-3 text-muted-foreground">{t("signInRequired.body")}</p>
        <Button size="lg" asChild><Link href="/sign-in">{t("signInRequired.action")}</Link></Button>
      </div>
    );
  }
  if (error) return <PageError message={error} retry={() => { setError(null); void load(); }} />;
  if (!account) return <PageLoading />;

  // A disconnected channel keeps its history: uploaded and cancelled posts stay listed.
  const channel = account.configured && account.connected ? account.channel : null;
  const settingsLink = <Link href="/settings#youtube">{t("openSettings")}</Link>;
  const count = (...states: YoutubePost["state"][]) => posts.filter((post) => states.includes(post.state)).length;
  const notPosted = count("cancelled");
  const counts = [
    { key: "posted", value: count("uploaded") },
    { key: "waiting", value: count("queued", "blocked") },
    { key: "uploading", value: count("working") },
    { key: "failed", value: count("failed") },
    ...(notPosted ? [{ key: "notPosted", value: notPosted }] : []),
  ];
  // Posts come newest first, so each task's group lands where its newest post is.
  const groups = new Map<string, OverviewPost[]>();
  for (const post of posts) groups.set(post.task_id, [...(groups.get(post.task_id) ?? []), post]);

  return (
    <main className="mx-auto w-full max-w-5xl px-4 py-8 sm:px-8 md:py-10">
      <h1 className="font-display text-3xl font-bold tracking-tight">{t("title")}</h1>
      <p className="mt-1 text-sm text-muted-foreground">{t("description")}</p>

      {!account.configured ? (
        <div className="mt-6">
          <EmptyState icon={<Youtube className="size-7" />} title={t("notConfiguredTitle")} body={t("notConfiguredBody")}>
            <Button asChild>{settingsLink}</Button>
          </EmptyState>
        </div>
      ) : !channel ? (
        <div className="mt-6">
          <EmptyState icon={<Youtube className="size-7" />} title={t("notConnectedTitle")} body={t("notConnectedBody")}>
            <Button asChild>{settingsLink}</Button>
          </EmptyState>
        </div>
      ) : (
        <div className="mt-6 rounded-xl border bg-background px-4 py-3">
          <div className="flex flex-wrap items-center gap-3">
            {channel.thumbnail_url ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={channel.thumbnail_url} alt="" className="size-10 shrink-0 rounded-full object-cover" />
            ) : (
              <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">
                <Youtube className="size-5" />
              </span>
            )}
            <div className="min-w-0 flex-1">
              <a
                href={`https://www.youtube.com/channel/${encodeURIComponent(channel.id)}`}
                target="_blank"
                rel="noreferrer"
                aria-label={t("account.openChannel", { channel: channel.title })}
                className="block truncate text-sm font-medium underline-offset-2 hover:underline"
              >
                {channel.title}
              </a>
              {channel.handle && <p className="truncate text-xs text-muted-foreground">{channel.handle}</p>}
            </div>
            <div className="flex flex-wrap items-center gap-1.5 text-xs">
              {account.status && <span className="rounded-full bg-muted px-2 py-0.5 text-muted-foreground">{t(`account.status.${account.status}`)}</span>}
              <span className="rounded-full bg-muted px-2 py-0.5 text-muted-foreground">
                {account.auto_post ? t("account.autoPostOn") : t("account.autoPostOff")}
              </span>
            </div>
            <Button size="sm" variant="outline" asChild>
              <Link href="/settings#youtube"><Settings className="size-4" />{t("settings")}</Link>
            </Button>
          </div>
          {account.warning === "private_lock" && (
            <p className="mt-3 flex items-start gap-2 rounded-lg bg-amber-50 px-3 py-2.5 text-sm text-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
              <TriangleAlert className="mt-0.5 size-4 shrink-0" />{tSettings("privateLock")}
            </p>
          )}
        </div>
      )}

      {posts.length === 0 ? (
        channel && (
          <div className="mt-6">
            <EmptyState icon={<Youtube className="size-7" />} title={t("emptyTitle")} body={t("emptyBody")} />
          </div>
        )
      ) : (
        <>
          <ul aria-label={t("summaryLabel")} className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-5">
            {counts.map(({ key, value }) => (
              <li key={key} className="rounded-xl border bg-background px-4 py-3">
                <span className="block text-2xl font-semibold tabular-nums">{value}</span>
                <span className="text-xs text-muted-foreground">{t(`counts.${key}`)}</span>
              </li>
            ))}
          </ul>

          <div className="mt-8 space-y-8">
            {[...groups].map(([taskId, taskPosts]) => (
              <section key={taskId}>
                <h2 className="mb-3 truncate font-display text-lg font-semibold tracking-tight">
                  {taskPosts[0].task_title === null ? t("taskGone") : (
                    <Link href={`/tasks/${taskId}`} className="underline-offset-2 hover:underline">{taskPosts[0].task_title}</Link>
                  )}
                </h2>
                <ul className="divide-y rounded-xl border bg-background">
                  {taskPosts.map((post) => (
                    <li key={post.id} className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-start sm:justify-between sm:gap-6">
                      <p className="min-w-0 text-sm font-medium leading-snug">{post.title || post.clip_title || t("clip")}</p>
                      <div className="space-y-1 sm:w-72 sm:shrink-0">
                        <YoutubeStatusChip post={post} retrying={retryingPostId === post.id} onRetry={() => requestRetry(post.task_id, post)} />
                        {/* The quota chip already says until when. */}
                        {post.state === "queued" && post.wait_reason !== "quota" && post.not_before && Date.parse(post.not_before) > Date.now() && (
                          <p className="text-[11px] text-muted-foreground">{t("nextTry", { time: formatWhen(post.not_before) })}</p>
                        )}
                        {post.state === "uploaded" && post.uploaded_at && (
                          <p className="text-[11px] text-muted-foreground">{t("uploadedAt", { time: formatWhen(post.uploaded_at) })}</p>
                        )}
                      </div>
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </div>

          {truncated && <p className="mt-6 text-center text-xs text-muted-foreground">{t("truncated")}</p>}
        </>
      )}

      {confirmDialog}
    </main>
  );
}
