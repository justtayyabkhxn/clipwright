"use client";

import Link from "next/link";
import { useState } from "react";
import { useTranslations } from "next-intl";
import { ExternalLink, Loader2 } from "lucide-react";
import { toast } from "sonner";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { formatSupportMessage, parseApiError } from "@/lib/api-error";
import { warnIfWorkerOffline } from "@/lib/worker-notice";
import { PAUSED, RECONNECT } from "@/lib/youtube-blocked";
import { cn } from "@/lib/utils";

/** One `GET /api/tasks/[id]/youtube` post (design §4.8). Mirrors `SerializedPost`, client-side only. */
export interface YoutubePost {
  id: string;
  clip_id: string | null;
  state: "queued" | "working" | "uploaded" | "blocked" | "failed" | "cancelled";
  phase: "writing" | "uploading" | null;
  wait_reason: "retry" | "quota" | "channel_limit" | "restyle" | "reconnect" | "private_lock" | null;
  title: string | null;
  description: string | null;
  tags: string[];
  hashtags: string[];
  video_url: string | null;
  /** YouTube's `uploadStatus` from the last verify: "deleted", "rejected" and "failed" change the uploaded chip. */
  upload_status: string | null;
  warning: string | null;
  error: string | null;
  not_before: string | null;
  insert_cap_reached: boolean;
}

/** Known `rejectionReason`/`failureReason` codes (design §4.6) with their own copy; anything else gets a generic line. */
const KNOWN_WARNING_CODES: Record<string, string> = { duplicate: "youtube.warnings.duplicate" };

/**
 * A blocked post's stored sentence that the pill already says: RECONNECT (with or without a reason
 * code) and PAUSED. Anything else, such as "Create a YouTube channel, then reconnect", is shown.
 */
const BLOCKED_PILL_SAYS = [RECONNECT, PAUSED];

function formatLocalTime(iso: string) {
  return new Date(iso).toLocaleTimeString("en", { hour: "numeric", minute: "2-digit" });
}

function pillClass(tone: "muted" | "warn" | "error" | "success") {
  return cn(
    "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium",
    tone === "muted" && "bg-muted text-muted-foreground",
    tone === "warn" && "bg-amber-500/10 text-amber-700 dark:text-amber-400",
    tone === "error" && "bg-red-500/10 text-red-700 dark:text-red-400",
    tone === "success" && "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
  );
}

/** A post's status chip (design §4.8), on the task page's clip tiles and the /youtube page. */
export function YoutubeStatusChip({ post, retrying, onRetry }: { post: YoutubePost; retrying: boolean; onRetry: () => void }) {
  const t = useTranslations("task");

  if (post.state === "cancelled") {
    // A clip or task delete cancels without a reason: nothing to show.
    if (!post.error) return null;
    return (
      <div className="flex flex-wrap items-center gap-1.5">
        <span className={pillClass("muted")}>{t("youtube.notPosted")}</span>
        <span className="text-[10px] text-muted-foreground">{post.error}</span>
      </div>
    );
  }

  if (post.state === "working") {
    return <span className={pillClass("muted")}>{post.phase === "uploading" ? t("youtube.uploading") : t("youtube.writingTitle")}</span>;
  }

  if (post.state === "queued") {
    const text = post.wait_reason === "quota" && post.not_before ? t("youtube.waitingQuota", { time: formatLocalTime(post.not_before) })
      : post.wait_reason === "channel_limit" ? t("youtube.waitingChannelLimit")
      : post.wait_reason === "retry" ? t("youtube.waitingRetry")
      : post.wait_reason === "restyle" ? t("youtube.waitingRestyle")
      : t("youtube.waitingToPost");
    return (
      <div className="flex flex-wrap items-center gap-1.5">
        <span className={pillClass("muted")}>{text}</span>
        {post.wait_reason === "retry" && post.error && <span className="text-[10px] text-muted-foreground">{post.error}</span>}
      </div>
    );
  }

  if (post.state === "blocked") {
    const locked = post.wait_reason === "private_lock";
    // A locked post's error is the pause sentence or a wait from before the lock: never news.
    const error = post.error;
    const reason = !locked && error && !BLOCKED_PILL_SAYS.some((said) => error.startsWith(said)) ? error : null;
    return (
      <div className="space-y-0.5">
        <div className="flex flex-wrap items-center gap-1">
          <span className={pillClass("warn")}>{locked ? t("youtube.pausedPrivateLock") : t("youtube.reconnectToPost")}</span>
          <Link href="/settings#youtube" className="text-[10px] text-muted-foreground underline-offset-2 hover:underline">
            {locked ? t("youtube.resumeInSettings") : t("youtube.reconnectInSettings")}
          </Link>
        </div>
        {reason && <p className="text-[10px] leading-snug text-muted-foreground">{reason}</p>}
      </div>
    );
  }

  if (post.state === "failed") {
    return (
      <div className="space-y-1">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className={pillClass("error")}>{t("youtube.failed")}</span>
          <span className="text-[10px] text-muted-foreground">{post.error || t("youtube.failedGeneric")}</span>
        </div>
        <Button
          size="sm"
          variant="outline"
          className="h-6 px-2 text-[10px]"
          onClick={onRetry}
          disabled={retrying}
          aria-label={retrying ? t("youtube.retrying") : undefined}
        >
          {retrying ? <Loader2 className="size-3 animate-spin" /> : t("youtube.tryAgain")}
        </Button>
      </div>
    );
  }

  // state === "uploaded"
  // Deleted in Studio: the link would be dead.
  if (post.upload_status === "deleted") return <span className={pillClass("muted")}>{t("youtube.removed")}</span>;
  // A rejection outranks the lock: on a private-locked project it gets the Flagged pill, with the lock's line under it.
  const rejected = post.upload_status === "rejected" || post.upload_status === "failed";
  const privateLine = post.warning === "private_lock" && (
    <p className="text-[10px] leading-snug text-muted-foreground">
      {t("youtube.privateOnYoutubeLine")}{" "}
      <Link href="/settings#youtube" className="underline-offset-2 hover:underline">{t("youtube.manageInSettings")}</Link>
    </p>
  );
  if (privateLine && !rejected) {
    return (
      <div className="space-y-0.5">
        <span className={pillClass("warn")}>{t("youtube.privateOnYoutube")}</span>
        {privateLine}
      </div>
    );
  }
  const flagged = rejected || Boolean(post.warning);
  const tone = flagged ? "warn" : "success";
  const label = flagged ? t("youtube.flagged") : t("youtube.posted");
  return (
    <div className="space-y-0.5">
      {post.video_url ? (
        <a href={post.video_url} target="_blank" rel="noreferrer" className={cn(pillClass(tone), "hover:underline")}>
          {label}<ExternalLink className="size-2.5" />
        </a>
      ) : (
        <span className={pillClass(tone)}>{label}</span>
      )}
      {privateLine || (post.warning && (
        <p className="text-[10px] leading-snug text-muted-foreground">
          {t(KNOWN_WARNING_CODES[post.warning] ?? "youtube.warningUnknown", { code: post.warning })}
        </p>
      ))}
    </div>
  );
}

/**
 * "Try again" on a failed or blocked post (design §4.8), shared by the task page and /youtube: a post
 * that used up its upload-insert cap asks first, since the clip may already be on the channel.
 * Render `confirmDialog` once; `onRetried` gets the retry route's updated post.
 */
export function useYoutubeRetry(onRetried: (postId: string, updated: Partial<YoutubePost>) => void) {
  const t = useTranslations("task");
  const [retryingPostId, setRetryingPostId] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<{ taskId: string; post: YoutubePost } | null>(null);

  const retry = async (taskId: string, post: YoutubePost) => {
    setRetryingPostId(post.id);
    try {
      const response = await fetch(`/api/tasks/${taskId}/youtube/${post.id}/retry`, { method: "POST" });
      if (!response.ok) {
        toast.error(formatSupportMessage(await parseApiError(response, t("youtube.retryFailed"))));
        return;
      }
      const data = await response.json();
      warnIfWorkerOffline(data);
      onRetried(post.id, data);
      setConfirm(null);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("youtube.retryFailed"));
    } finally {
      setRetryingPostId(null);
    }
  };

  const requestRetry = (taskId: string, post: YoutubePost) => {
    if (retryingPostId) return;
    if (post.insert_cap_reached) { setConfirm({ taskId, post }); return; }
    void retry(taskId, post);
  };

  const confirmDialog = (
    <AlertDialog open={confirm !== null} onOpenChange={(open) => { if (!open) setConfirm(null); }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t("youtube.retryConfirmTitle")}</AlertDialogTitle>
          <AlertDialogDescription>{t("youtube.retryConfirmBody")}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={retryingPostId !== null}>{t("cancel")}</AlertDialogCancel>
          <AlertDialogAction onClick={() => confirm && void retry(confirm.taskId, confirm.post)} disabled={retryingPostId !== null}>
            {retryingPostId ? t("youtube.retrying") : t("youtube.tryAgain")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );

  return { retryingPostId, requestRetry, confirmDialog };
}
