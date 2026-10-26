import { Scale } from "lucide-react";
import { SOURCE_CODE_URL } from "@/lib/site";
import { cn } from "@/lib/utils";

/** The Clipwright mark: a vertical clip cut in two. Same drawing as `app/icon.svg`. */
export function BrandMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" aria-hidden className={cn("size-6 shrink-0", className)}>
      <rect width="32" height="32" rx="8" fill="var(--brand)" />
      <path fill="var(--brand-foreground)" d="M9.2 16.9V7.7A2.5 2.5 0 0 1 11.7 5.2H18.7A2.5 2.5 0 0 1 21.2 7.7V13.9Z" />
      <path fill="var(--brand-foreground)" d="M10 20.1V23.5A2.5 2.5 0 0 0 12.5 26H19.5A2.5 2.5 0 0 0 22 23.5V17.1Z" />
    </svg>
  );
}

export function BrandWordmark({ className }: { className?: string }) {
  return (
    <span className={cn("font-display text-[1.15rem] font-semibold leading-none tracking-tight", className)}>
      Clipwright
    </span>
  );
}

const SOURCE_CREDIT = "Based on SupoClip · AGPL-3.0";

/** AGPL-3.0 credit and source link for the upstream project. `iconOnly` fits the collapsed rail. */
export function SourceCredit({ className, iconOnly = false }: { className?: string; iconOnly?: boolean }) {
  return (
    <a href={SOURCE_CODE_URL} target="_blank" rel="noreferrer"
      aria-label={iconOnly ? SOURCE_CREDIT : undefined} title={iconOnly ? SOURCE_CREDIT : undefined}
      className={cn("text-[11px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline", className)}>
      {iconOnly ? <Scale aria-hidden className="size-4" /> : SOURCE_CREDIT}
    </a>
  );
}
