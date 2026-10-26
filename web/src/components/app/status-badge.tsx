"use client";

import { useTranslations } from "next-intl";

import { cn } from "@/lib/utils";

export const ACTIVE_TASK_STATUSES = ["queued", "processing"];
export const RESUMABLE_TASK_STATUSES = ["cancelled", "error"];
/** The restyle route's progress message; the restyle job runs under it until the new clips are in. */
export const RESTYLE_RUNNING_MESSAGE = "Applying new style...";

/**
 * A running restyle is never offered Cancel: Resume on a cancelled task re-runs the whole
 * pipeline, which deletes the clips the restyle was meant to keep.
 */
export function isRestyleRun(task: { status: string; run_type?: string | null; progress_message?: string | null }) {
  return ACTIVE_TASK_STATUSES.includes(task.status)
    && (task.run_type === "restyle_task" || task.progress_message === RESTYLE_RUNNING_MESSAGE);
}
const styles: Record<string, string> = {
  completed: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
  processing: "bg-sky-500/10 text-sky-700 dark:text-sky-400",
  queued: "bg-amber-500/10 text-amber-700 dark:text-amber-400",
  error: "bg-red-500/10 text-red-700 dark:text-red-400",
  cancelled: "bg-stone-500/10 text-stone-600 dark:text-stone-400",
};

export function StatusBadge({ status, className }: { status: string; className?: string }) {
  const t = useTranslations("library");
  const label = status === "completed" ? t("status.completed")
    : status === "processing" ? t("status.processing")
    : status === "queued" ? t("status.queued")
    : status === "error" ? t("status.failed")
    : status === "cancelled" ? t("status.cancelled")
    : status;
  const style = styles[status] ?? "bg-muted text-muted-foreground";
  return <span className={cn("inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-medium capitalize", style, className)}>
    <span aria-hidden className={cn("h-1.5 w-1.5 rounded-full bg-current", status === "processing" && "motion-safe:animate-pulse")} />
    {label}
  </span>;
}
