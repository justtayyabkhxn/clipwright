"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Loader2, TriangleAlert } from "lucide-react";
import { toast } from "sonner";

import { usePassed, type YoutubePost } from "@/components/app/youtube-status-chip";
import { Button } from "@/components/ui/button";
import { formatSupportMessage, parseApiError } from "@/lib/api-error";
import { cn } from "@/lib/utils";
import { warnIfWorkerOffline } from "@/lib/worker-notice";

function formatWhen(iso: string) {
  return new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

/**
 * Posts held by YouTube's channel upload limit, on the task page and /youtube: no automatic retry.
 * "Post all" stays disabled until the latest hold ends, then queues every held post of the channel,
 * 10 minutes apart. Renders nothing when `posts` holds none.
 */
export function ChannelLimitBanner({ posts, onReleased, className }: { posts: YoutubePost[]; onReleased: () => void; className?: string }) {
  const t = useTranslations("youtube.channelLimit");
  const held = posts.filter((post) => post.state === "blocked" && post.wait_reason === "channel_limit");
  // ISO strings in one format compare as times.
  const until = held.reduce<string | null>((latest, post) => (post.not_before && (!latest || post.not_before > latest) ? post.not_before : latest), null);
  const ready = usePassed(until);
  const [posting, setPosting] = useState(false);
  if (!held.length) return null;

  const postAll = async () => {
    setPosting(true);
    try {
      const response = await fetch("/api/youtube/posts/release", { method: "POST" });
      if (!response.ok) throw new Error(formatSupportMessage(await parseApiError(response, t("failed"))));
      warnIfWorkerOffline(await response.json());
      onReleased();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("failed"));
    } finally {
      setPosting(false);
    }
  };

  return (
    <div className={cn("flex flex-wrap items-center justify-between gap-3 rounded-xl bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:bg-amber-950/40 dark:text-amber-200", className)}>
      <div className="flex min-w-0 items-start gap-2">
        <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
        <div>
          <p className="font-medium">{t("title")}</p>
          <p className="text-amber-800/80 dark:text-amber-200/80">
            {ready || !until ? t("ready", { count: held.length }) : t("waiting", { count: held.length, time: formatWhen(until) })}
          </p>
        </div>
      </div>
      <Button size="sm" onClick={() => void postAll()} disabled={!ready || posting}>
        {posting ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
        {posting ? t("posting") : t("postAll", { count: held.length })}
      </Button>
    </div>
  );
}
