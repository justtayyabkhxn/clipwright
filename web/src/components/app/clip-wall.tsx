"use client";

import Link from "next/link";
import { useEffect } from "react";
import { useTranslations } from "next-intl";
import {
  AudioLines, Check, ChevronLeft, ChevronRight, Clapperboard, Download, ExternalLink, Flame, Loader2,
  MessageSquare, Play, Scissors, Share2, Sparkles, Star, Trash2, TrendingUp,
} from "lucide-react";
import { ClipCover, ScoreRing } from "@/components/app/clip-cover";
import DynamicVideoPlayer from "@/components/dynamic-video-player";
import { TranscriptPreview } from "@/components/transcript-preview";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { getClipUrl } from "@/lib/clip-actions";
import { formatClipDuration } from "@/lib/generations";
import { PAUSED, RECONNECT } from "@/lib/youtube-blocked";
import { cn } from "@/lib/utils";
import { modelLabel, useAiProvider } from "@/hooks/use-ai-provider";

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

/** The task page's per-clip status chip (design §4.8). Only `ClipTile` shows it. */
function YoutubeStatusChip({ post, retrying, onRetry }: { post: YoutubePost; retrying: boolean; onRetry: () => void }) {
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
        <Button size="sm" variant="outline" className="h-6 px-2 text-[10px]" onClick={onRetry} disabled={retrying}>
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

export interface WallClip {
  id: string;
  filename: string;
  start_time: string;
  end_time: string;
  duration: number;
  text: string;
  relevance_score: number;
  clip_order: number;
  video_url: string;
  virality_score: number;
  hook_score: number;
  engagement_score: number;
  value_score: number;
  shareability_score: number;
  hook_type: string | null;
  hook_title: string | null;
}

function clipTitle(clip: WallClip, fallback: string) {
  return clip.hook_title || fallback;
}

export function ClipTile({ clip, taskId, busy, best, editable, onOpen, onDownload, onDelete, post, retryingPostId, onRetryPost }: {
  clip: WallClip;
  taskId: string;
  busy: boolean;
  best: boolean;
  editable: boolean;
  onOpen: () => void;
  onDownload: () => void;
  onDelete?: () => void;
  /** The clip's YouTube auto-post status (design §4.8), or null if none was ever created. */
  post?: YoutubePost | null;
  retryingPostId?: string | null;
  onRetryPost?: (post: YoutubePost) => void;
}) {
  const t = useTranslations("task");
  const title = clipTitle(clip, t("clipNumber", { order: clip.clip_order }));
  return (
    <article className="group @container animate-rise">
      <button
        type="button"
        onClick={onOpen}
        aria-label={t("preview", { title })}
        className="block w-full rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
      >
        <ClipCover
          src={getClipUrl(clip.video_url, clip.filename)}
          className="aspect-[9/16] rounded-xl ring-1 ring-black/5 transition-shadow duration-200 group-hover:shadow-xl"
        >
          <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-black/75 via-transparent to-black/25" />
          {best && (
            <span className="absolute left-2 top-2 inline-flex items-center gap-1 rounded-full bg-brand px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-brand-foreground shadow">
              <Flame className="size-3" />{t("topPick")}
            </span>
          )}
          {clip.virality_score > 0 && (
            <span className="absolute right-2 top-2 rounded-full bg-black/55 text-white backdrop-blur">
              <ScoreRing score={clip.virality_score} size={36} />
            </span>
          )}
          <span className="absolute inset-0 flex items-center justify-center opacity-0 transition-opacity group-hover:opacity-100">
            <span className="flex size-12 items-center justify-center rounded-full bg-white/90 text-black shadow-lg"><Play className="ml-0.5 size-5 fill-current" /></span>
          </span>
          <span className="absolute bottom-2 right-2 rounded bg-black/60 px-1.5 py-0.5 text-[11px] font-medium tabular-nums text-white">{formatClipDuration(clip.duration)}</span>
        </ClipCover>
      </button>
      <div className="mt-2.5 px-0.5">
        <h3 className="line-clamp-2 text-sm font-semibold leading-snug">{title}</h3>
        <p className="mt-0.5 text-xs tabular-nums text-muted-foreground">{clip.start_time} – {clip.end_time}</p>
        {post && (
          <div className="mt-1.5">
            <YoutubeStatusChip post={post} retrying={retryingPostId === post.id} onRetry={() => onRetryPost?.(post)} />
          </div>
        )}
        <div className="mt-2 flex items-center gap-1">
          <Button size="sm" variant="outline" className="h-7 flex-1 px-2 text-xs" onClick={onDownload} disabled={busy} aria-label={t("downloadNamed", { title })}>
            {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Download className="size-3.5" />}<span className="hidden @min-[190px]:inline">{t("download")}</span>
          </Button>
          {editable && (
            <Button size="sm" variant="outline" className="h-7 px-2 text-xs" asChild>
              <Link href={`/tasks/${taskId}/edit?clip=${clip.id}`}><Scissors className="size-3.5" />{t("edit")}</Link>
            </Button>
          )}
          {onDelete && (
            <Button size="icon-sm" variant="ghost" className="size-7 text-muted-foreground hover:bg-red-50 hover:text-red-600" onClick={onDelete} aria-label={t("deleteClip")}>
              <Trash2 className="size-3.5" />
            </Button>
          )}
        </div>
      </div>
    </article>
  );
}

const BREAKDOWN = [
  { key: "hook_score", labelKey: "hook", icon: MessageSquare },
  { key: "engagement_score", labelKey: "engagement", icon: TrendingUp },
  { key: "value_score", labelKey: "value", icon: Star },
  { key: "shareability_score", labelKey: "shareability", icon: Share2 },
] as const;

export function ClipFocus({ clip, taskId, index, total, busy, editable, onNavigate, onClose, onDownload, onDelete, hookTypeLabel, post }: {
  clip: WallClip | null;
  taskId: string;
  index: number;
  total: number;
  busy: boolean;
  editable: boolean;
  onNavigate: (delta: number) => void;
  onClose: () => void;
  onDownload: () => void;
  onDelete?: () => void;
  hookTypeLabel: (hookType: string | null) => string;
  /** The clip's YouTube auto-post status (design §4.8); its metadata is shown read-only once Claude wrote it. */
  post?: YoutubePost | null;
}) {
  const t = useTranslations("task");
  useEffect(() => {
    if (!clip) return;
    const onKey = (event: KeyboardEvent) => {
      if ((event.target as HTMLElement | null)?.closest("input, textarea")) return;
      if (event.key === "ArrowRight" || event.key === "j") { event.preventDefault(); onNavigate(1); }
      if (event.key === "ArrowLeft" || event.key === "k") { event.preventDefault(); onNavigate(-1); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [clip, onNavigate]);

  return (
    <Dialog open={clip !== null} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="max-h-[92dvh] max-w-5xl gap-0 overflow-hidden p-0 md:grid-cols-[auto_1fr]">
        {clip && (
          <>
            <div className="relative flex items-center justify-center bg-stone-950 p-3 md:p-4">
              <DynamicVideoPlayer key={clip.id} src={getClipUrl(clip.video_url, clip.filename)} autoPlay className="h-[min(58dvh,560px)]! md:h-[min(80dvh,640px)]!" />
            </div>
            <div className="flex min-h-0 flex-col overflow-y-auto">
              <div className="flex items-center justify-between gap-2 border-b px-5 py-3 pr-12 text-xs text-muted-foreground">
                <span className="tabular-nums">{t("position", { current: index + 1, total })}</span>
                <div className="flex items-center gap-1">
                  <Button size="icon-sm" variant="ghost" onClick={() => onNavigate(-1)} aria-label={t("previous")}><ChevronLeft className="size-4" /></Button>
                  <Button size="icon-sm" variant="ghost" onClick={() => onNavigate(1)} aria-label={t("next")}><ChevronRight className="size-4" /></Button>
                </div>
              </div>
              <div className="space-y-5 p-5">
                <div>
                  <DialogTitle className="font-display text-xl font-bold leading-tight">{clipTitle(clip, t("clipNumber", { order: clip.clip_order }))}</DialogTitle>
                  <DialogDescription className="mt-1 tabular-nums">
                    {clip.start_time} – {clip.end_time} · {formatClipDuration(clip.duration)}
                  </DialogDescription>
                </div>

                {clip.virality_score > 0 && (
                  <section className="rounded-xl border p-4">
                    <div className="flex items-center gap-4">
                      <ScoreRing score={clip.virality_score} size={56} className="text-foreground [&>span]:text-base" />
                      <div>
                        <p className="text-sm font-semibold">{t("virality")}</p>
                        <p className="text-xs text-muted-foreground">
                          {clip.hook_type && clip.hook_type !== "none"
                            ? t("relevanceWithHook", { hook: hookTypeLabel(clip.hook_type), percent: Math.round(clip.relevance_score * 100) })
                            : t("relevance", { percent: Math.round(clip.relevance_score * 100) })}
                        </p>
                      </div>
                    </div>
                    {BREAKDOWN.some(({ key }) => clip[key] > 0) && <div className="mt-4 grid grid-cols-2 gap-x-5 gap-y-3">
                      {BREAKDOWN.map(({ key, labelKey, icon: Icon }) => (
                        <div key={key} className="space-y-1.5">
                          <div className="flex items-center justify-between text-xs">
                            <span className="flex items-center gap-1.5 text-muted-foreground"><Icon className="size-3" />{t(`scores.${labelKey}`)}</span>
                            <span className="font-medium tabular-nums">{clip[key]}/25</span>
                          </div>
                          <div className="h-1.5 overflow-hidden rounded-full bg-muted">
                            <div className="h-full rounded-full bg-foreground transition-[width] duration-500" style={{ width: `${(clip[key] / 25) * 100}%` }} />
                          </div>
                        </div>
                      ))}
                    </div>}
                  </section>
                )}

                {clip.text && <TranscriptPreview text={clip.text} clipTitle={clipTitle(clip, t("clipNumber", { order: clip.clip_order }))} />}

                {post?.title && (
                  <section className="space-y-2 rounded-xl border p-4">
                    <p className="text-sm font-semibold">{t("youtube.metadataTitle")}</p>
                    <p className="text-sm font-medium">{post.title}</p>
                    {post.description && <p className="whitespace-pre-wrap text-sm text-muted-foreground">{post.description}</p>}
                    {post.hashtags.length > 0 && (
                      <div className="flex flex-wrap gap-1">
                        {post.hashtags.map((hashtag) => (
                          <span key={hashtag} className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">#{hashtag}</span>
                        ))}
                      </div>
                    )}
                    {post.tags.length > 0 && (
                      <p className="text-xs text-muted-foreground">{t("youtube.tagsLabel")}: {post.tags.join(", ")}</p>
                    )}
                  </section>
                )}
              </div>
              <div className="mt-auto flex flex-wrap items-center gap-2 border-t bg-muted/30 px-5 py-3">
                <Button size="sm" onClick={onDownload} disabled={busy}>
                  {busy ? <Loader2 className="size-4 animate-spin" /> : <Download className="size-4" />}{t("download")}
                </Button>
                {editable && (
                  <Button size="sm" variant="outline" asChild>
                    <Link href={`/tasks/${taskId}/edit?clip=${clip.id}`}><Scissors className="size-4" />{t("openInEditor")}</Link>
                  </Button>
                )}
                {onDelete && (
                  <Button size="sm" variant="ghost" className="ml-auto text-muted-foreground hover:bg-red-50 hover:text-red-600" onClick={onDelete}>
                    <Trash2 className="size-4" />{t("delete")}
                  </Button>
                )}
              </div>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

const STEPS = [
  { id: "fetching", icon: Download, until: 20 },
  { id: "transcribing", icon: AudioLines, until: 45 },
  { id: "finding", icon: Sparkles, until: 65 },
  { id: "rendering", icon: Clapperboard, until: 100 },
] as const;

function stepFromMessage(message: string) {
  const text = message.toLowerCase();
  if (/render|clip \d|saving/.test(text)) return 3;
  if (/analy|moment|segment|ai /.test(text)) return 2;
  if (/transcri/.test(text)) return 1;
  if (/download|fetch/.test(text)) return 0;
  return null;
}

export function ProcessingPanel({ status, progress, message, readyCount, restyling = false }: {
  status: string; progress: number; message: string; readyCount: number;
  /** A restyle only re-renders; the clips on the page are the old ones until it swaps them all. */
  restyling?: boolean;
}) {
  const t = useTranslations("task");
  // Name the model only when it is Claude; the stage itself comes from the backend.
  const provider = useAiProvider(status === "processing" || status === "queued");
  const aiModel = provider?.provider === "anthropic" ? modelLabel(provider) : null;
  const byProgress = STEPS.findIndex((step) => progress < step.until);
  const activeStep = status === "queued" ? -1
    : restyling ? STEPS.length - 1
    : stepFromMessage(message) ?? (byProgress === -1 ? STEPS.length - 1 : byProgress);
  return (
    <section className="overflow-hidden rounded-2xl border bg-background" aria-live="polite">
      <div className="relative h-1 bg-muted">
        <div className="absolute inset-y-0 left-0 overflow-hidden bg-brand transition-[width] duration-700 ease-out progress-sheen" style={{ width: `${Math.max(progress, status === "queued" ? 2 : 6)}%` }} />
      </div>
      <div className="flex flex-col gap-6 p-5 sm:p-6 md:flex-row md:items-center md:justify-between">
        <div className="min-w-0">
          <p className="shimmer text-lg font-semibold">{message || (status === "queued" ? t("waiting") : t("processing"))}</p>
          <p className="mt-1 text-sm text-muted-foreground">
            {restyling ? t("restyleWaiting") : readyCount > 0 ? t("clipsReady", { count: readyCount }) : t("grabCoffee")}
          </p>
        </div>
        <ol className="grid grid-cols-4 gap-2 md:flex md:gap-1">
          {STEPS.map((step, index) => {
            const done = activeStep > index;
            const active = activeStep === index;
            return (
              <li key={step.id} className="flex flex-col items-center gap-1.5 md:w-24">
                <span className={cn(
                  "flex size-9 items-center justify-center rounded-full border transition-colors",
                  done && "border-foreground bg-foreground text-background",
                  active && "border-brand bg-brand-soft text-brand",
                  !done && !active && "text-muted-foreground",
                )}>
                  {done ? <Check className="size-4" /> : active ? <step.icon className="size-4 motion-safe:animate-pulse" /> : <step.icon className="size-4" />}
                </span>
                <span className={cn("text-center text-[11px] leading-tight", active ? "font-medium text-foreground" : "text-muted-foreground")}>{t(`steps.${step.id}`)}</span>
                {step.id === "finding" && aiModel && <span className="-mt-1 text-center text-[10px] leading-tight text-brand">{aiModel}</span>}
              </li>
            );
          })}
        </ol>
      </div>
      {progress > 0 && <p className="sr-only">{t("percentComplete", { progress })}</p>}
    </section>
  );
}

export function EmptyState({ icon, title, body, tone, children }: { icon: React.ReactNode; title: string; body: string; tone?: "error"; children?: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center rounded-2xl border border-dashed px-6 py-16 text-center">
      <span className={cn("flex size-14 items-center justify-center rounded-2xl", tone === "error" ? "bg-red-50 text-red-600" : "bg-muted text-muted-foreground")}>{icon}</span>
      <h2 className="mt-4 text-lg font-semibold">{title}</h2>
      <p className="mt-1 max-w-md text-sm text-muted-foreground">{body}</p>
      {children && <div className="mt-6 flex gap-2">{children}</div>}
    </div>
  );
}
