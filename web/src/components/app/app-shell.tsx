"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  CornerDownLeft, Film, LogOut, PanelLeftClose, PanelLeftOpen, Plus, Search, Settings, Sparkles, X, Youtube,
} from "lucide-react";
import { modelLabel, useAiProvider } from "@/hooks/use-ai-provider";
import { toast } from "sonner";
import { signOut, useSession } from "@/lib/auth-client";
import { fetchGenerations, timeAgo, type GenerationSummary } from "@/lib/generations";
import { ACTIVE_TASK_STATUSES, StatusBadge } from "@/components/app/status-badge";
import { BrandMark, BrandWordmark, SourceCredit } from "@/components/brand";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Kbd } from "@/components/ui/kbd";
import { cn } from "@/lib/utils";

type NavItem = { href: string; labelKey: "create" | "library" | "youtube" | "settings"; icon: typeof Film; match: (path: string) => boolean };

const NAV: NavItem[] = [
  { href: "/", labelKey: "create", icon: Sparkles, match: (p) => p === "/" },
  { href: "/list", labelKey: "library", icon: Film, match: (p) => p.startsWith("/list") || p.startsWith("/tasks") },
  { href: "/youtube", labelKey: "youtube", icon: Youtube, match: (p) => p === "/youtube" },
  { href: "/settings", labelKey: "settings", icon: Settings, match: (p) => p === "/settings" },
];

function initials(name?: string | null, email?: string | null) {
  const source = name?.trim() || email || "?";
  return source.split(/[\s@.]+/).filter(Boolean).slice(0, 2).map((part) => part[0]?.toUpperCase()).join("");
}

/** Signed-in application chrome: sidebar on desktop, tab bar on mobile, ⌘K palette everywhere. */
export function AppShell({ children }: { children: React.ReactNode }) {
  const t = useTranslations("shell");
  const { data: session } = useSession();
  const pathname = usePathname();
  const router = useRouter();
  const [paletteOpen, setPaletteOpen] = useState(false);
  // The editor needs every pixel — collapse the sidebar to an icon rail there.
  const editorRoute = /^\/tasks\/[^/]+\/edit/.test(pathname);
  const [collapsed, setCollapsedState] = useState(false);
  useEffect(() => {
    try { setCollapsedState(localStorage.getItem(SIDEBAR_KEY) === "1"); } catch {}
  }, []);
  const setCollapsed = (value: boolean) => {
    setCollapsedState(value);
    try { localStorage.setItem(SIDEBAR_KEY, value ? "1" : "0"); } catch {}
  };
  const compact = editorRoute || collapsed;

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setPaletteOpen((open) => !open);
        return;
      }
      const target = event.target as HTMLElement | null;
      const typing = target?.closest("input, textarea, select, [contenteditable=true], [role=dialog]");
      if (!typing && !event.metaKey && !event.ctrlKey && !event.altKey && event.key.toLowerCase() === "n") {
        event.preventDefault();
        router.push("/");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [router]);

  // Children must keep the same tree position whether or not the session has
  // loaded — otherwise the page remounts and re-runs its initial fetches.
  const user = session?.user;
  const items = NAV.map((item) => ({ ...item, label: t(`nav.${item.labelKey}`) }));

  return (
    <div data-app-shell={user ? "" : undefined} className={cn(user && "flex min-h-dvh bg-canvas")}>
      {user ? <aside
        className={cn(
          "sticky top-0 hidden h-dvh shrink-0 flex-col border-r border-sidebar-border bg-sidebar md:flex",
          compact ? "w-16 items-center px-2" : "w-60 px-3",
        )}
      >
        <div className={cn("flex h-14 w-full items-center", compact ? "justify-center" : "justify-between px-2")}>
          <Link href="/" aria-label="Clipwright" className="flex items-center gap-2">
            <BrandMark />
            {!compact && <BrandWordmark />}
          </Link>
          {!compact && !editorRoute && (
            <button type="button" onClick={() => setCollapsed(true)} aria-label={t("collapse")}
              className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-foreground">
              <PanelLeftClose className="size-4" />
            </button>
          )}
        </div>
        {compact && !editorRoute && (
          <button type="button" onClick={() => setCollapsed(false)} aria-label={t("expand")}
            className="mb-2 rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-foreground">
            <PanelLeftOpen className="size-4" />
          </button>
        )}

        <SidebarLink compact={compact} href="/" label={t("nav.newGeneration")} shortcut="N" className="mb-4 mt-1 bg-brand text-brand-foreground shadow-[0_1px_2px_oklch(0.3_0.05_40/0.25)] hover:bg-brand/90 hover:text-brand-foreground">
          <Plus className="size-4" />
        </SidebarLink>

        <nav aria-label={t("search.mainNav")} className="flex w-full flex-col gap-0.5">
          {items.map((item) => {
            const active = item.match(pathname);
            return (
              <SidebarLink key={item.href} compact={compact} href={item.href} label={item.label} active={active}>
                <item.icon className="size-4" />
              </SidebarLink>
            );
          })}
        </nav>

        <button
          type="button"
          onClick={() => setPaletteOpen(true)}
          className={cn(
            "mt-4 flex h-9 w-full items-center gap-2 rounded-lg border border-sidebar-border bg-background text-sm text-muted-foreground transition-colors hover:text-foreground",
            compact ? "justify-center px-0" : "px-2.5",
          )}
          aria-label={t("search.generations")}
        >
          <Search className="size-4 shrink-0" />
          {!compact && <><span className="flex-1 text-left">{t("search.label")}</span><Kbd>⌘K</Kbd></>}
        </button>

        {!compact && <RecentProjects pathname={pathname} />}

        <div className="mt-auto w-full space-y-2 pb-3">
          {/* The home page shows this notice in its own content. */}
          {!compact && pathname !== "/" && <WorkerOfflineNotice className="text-xs" />}
          <ProviderIndicator compact={compact} />
          <UserRow compact={compact} name={user.name} email={user.email} />
          <SourceCredit iconOnly={compact} className={compact ? "flex justify-center rounded-md p-2 hover:bg-sidebar-accent" : "block px-2.5"} />
        </div>
      </aside> : null}

      <div className={cn(user && "flex min-w-0 flex-1 flex-col pb-[calc(4rem+env(safe-area-inset-bottom))] md:pb-0")}>
        {user ? <header className="sticky top-0 z-30 flex h-14 items-center justify-between border-b bg-background/80 px-4 backdrop-blur md:hidden">
          <Link href="/" aria-label="Clipwright" className="flex items-center gap-2">
            <BrandMark className="size-[22px]" /><BrandWordmark />
          </Link>
          <div className="flex items-center gap-1">
            <button type="button" onClick={() => setPaletteOpen(true)} aria-label={t("search.generations")} className="rounded-lg p-2 text-muted-foreground hover:bg-accent">
              <Search className="size-5" />
            </button>
          </div>
        </header> : null}
        {children}
        {user ? <footer className="px-4 py-4 text-center md:hidden"><SourceCredit /></footer> : null}
      </div>

      {user ? <nav aria-label={t("search.mobileNav")} style={{ gridTemplateColumns: `repeat(${items.length}, minmax(0, 1fr))` }} className="fixed inset-x-0 bottom-0 z-40 grid border-t bg-background/90 pb-[env(safe-area-inset-bottom)] backdrop-blur md:hidden">
        {items.map((item) => {
          const active = item.match(pathname);
          return (
            <Link key={item.href} href={item.href} aria-current={active ? "page" : undefined}
              className={cn("flex h-16 flex-col items-center justify-center gap-1 text-[11px] font-medium", active ? "text-foreground" : "text-muted-foreground")}>
              <item.icon className={cn("size-5", active && "text-brand")} />{item.label}
            </Link>
          );
        })}
      </nav> : null}

      {user ? <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} /> : null}
    </div>
  );
}

const SIDEBAR_KEY = "clipwright.sidebar.collapsed";

/** The last few generations, so returning to a running task is one click. */
function RecentProjects({ pathname }: { pathname: string }) {
  const t = useTranslations("shell");
  const [recent, setRecent] = useState<GenerationSummary[] | null>(null);
  useEffect(() => {
    let alive = true;
    void fetchGenerations().then((items) => alive && setRecent(items.slice(0, 5))).catch(() => alive && setRecent([]));
    return () => { alive = false; };
  }, [pathname]);
  if (!recent?.length) return null;
  return (
    <div className="mt-6 w-full min-h-0 overflow-y-auto">
      <p className="px-2.5 pb-1.5 text-xs font-medium text-muted-foreground">{t("recent")}</p>
      <ul className="flex flex-col gap-0.5">
        {recent.map((item) => {
          const href = `/tasks/${item.id}`;
          const active = pathname === href;
          return (
            <li key={item.id}>
              <Link href={href} aria-current={active ? "page" : undefined} title={item.source_title}
                className={cn("flex h-8 items-center gap-2 rounded-md px-2.5 text-[13px] transition-colors",
                  active ? "bg-background text-foreground ring-1 ring-sidebar-border" : "text-muted-foreground hover:bg-sidebar-accent hover:text-foreground")}>
                <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full",
                  item.status === "completed" ? "bg-emerald-600" : item.status === "error" ? "bg-red-600" : ACTIVE_TASK_STATUSES.includes(item.status) ? "bg-brand motion-safe:animate-pulse" : "bg-muted-foreground/40")} />
                <span className="truncate">{item.source_title || t("untitled")}</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** Which model is picking clips right now; links to its settings. */
function ProviderIndicator({ compact }: { compact: boolean }) {
  const t = useTranslations("shell");
  const provider = useAiProvider();
  if (!provider) return null;
  const name = modelLabel(provider) ?? provider.provider;
  const status = provider.configured ? t("ai.ready") : t("ai.notConfigured");
  const link = (
    <Link href="/settings#ai" aria-label={`${name}: ${status}`}
      className={cn("flex items-center gap-2 rounded-lg text-xs transition-colors hover:bg-sidebar-accent", compact ? "justify-center p-2" : "px-2.5 py-2")}>
      <span aria-hidden className={cn("size-2 shrink-0 rounded-full", provider.configured ? "bg-brand" : "bg-amber-500")} />
      {!compact && (
        <span className="min-w-0 flex-1 leading-tight">
          <span className="block truncate font-medium text-foreground">{name}</span>
          <span className="block text-muted-foreground">{status}</span>
        </span>
      )}
    </Link>
  );
  if (!compact) return link;
  return <Tooltip><TooltipTrigger asChild>{link}</TooltipTrigger><TooltipContent side="right">{name} · {status}</TooltipContent></Tooltip>;
}

export const WORKER_OFFLINE_NOTICE = "The Clipwright worker isn't running, so new videos will wait in the queue. Start it with pnpm dev (or pnpm worker).";
const WORKER_NOTICE_DISMISSED_KEY = "clipwright.worker-notice.dismissed";

/** Checks `GET /api/health` once on mount; a calm, dismissible note while no worker heartbeat is fresh. */
export function WorkerOfflineNotice({ className }: { className?: string }) {
  const common = useTranslations("common");
  const [offline, setOffline] = useState(false);
  useEffect(() => {
    try { if (sessionStorage.getItem(WORKER_NOTICE_DISMISSED_KEY) === "1") return; } catch {}
    let alive = true;
    void fetch("/api/health", { cache: "no-store" })
      // The route answers 503 while no worker is alive, so read the body whatever the status. An
      // unreachable database also reports the worker offline; that is not this notice's message.
      .then((response) => response.json().catch(() => null))
      .then((body: { db?: unknown; worker?: { online?: unknown } } | null) =>
        alive && setOffline(body?.db === true && body.worker?.online === false))
      .catch(() => {});
    return () => { alive = false; };
  }, []);
  if (!offline) return null;
  const dismiss = () => {
    setOffline(false);
    try { sessionStorage.setItem(WORKER_NOTICE_DISMISSED_KEY, "1"); } catch {}
  };
  return (
    <div role="status" className={cn("flex items-start gap-2.5 rounded-xl border bg-muted/60 px-3 py-2.5 text-muted-foreground", className)}>
      <span aria-hidden className="mt-[0.4em] size-2 shrink-0 rounded-full bg-amber-500" />
      <p className="min-w-0 flex-1 leading-snug">{WORKER_OFFLINE_NOTICE}</p>
      <button type="button" onClick={dismiss} aria-label={common("close")}
        className="-m-1 shrink-0 rounded-md p-1 transition-colors hover:bg-background hover:text-foreground">
        <X className="size-3.5" />
      </button>
    </div>
  );
}

function SidebarLink({ href, label, active, compact, shortcut, className, children }: {
  href: string; label: string; active?: boolean; compact: boolean; shortcut?: string; className?: string; children: React.ReactNode;
}) {
  const link = (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      aria-label={compact ? label : undefined}
      className={cn(
        "flex h-9 w-full items-center gap-2.5 rounded-lg text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        compact ? "justify-center" : "px-2.5",
        active ? "bg-background text-foreground shadow-xs ring-1 ring-sidebar-border" : "text-muted-foreground hover:bg-sidebar-accent hover:text-foreground",
        className,
      )}
    >
      {children}
      {!compact && <span className="flex-1">{label}</span>}
      {!compact && shortcut && <span className="text-[11px] opacity-60">{shortcut}</span>}
    </Link>
  );
  if (!compact) return link;
  return <Tooltip><TooltipTrigger asChild>{link}</TooltipTrigger><TooltipContent side="right">{label}</TooltipContent></Tooltip>;
}

function UserRow({ compact, name, email }: { compact: boolean; name?: string | null; email?: string | null }) {
  const t = useTranslations("shell");
  const [signingOut, setSigningOut] = useState(false);
  const handleSignOut = async () => {
    setSigningOut(true);
    try { await signOut(); window.location.assign("/sign-in"); }
    catch { toast.error(t("user.signOutError")); setSigningOut(false); }
  };
  return (
    <div className={cn("flex items-center gap-2 rounded-lg", compact ? "flex-col" : "px-1.5 py-1")}>
      <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-brand to-amber-400 text-xs font-semibold text-white">
        {initials(name, email)}
      </span>
      {!compact && (
        <div className="min-w-0 flex-1 leading-tight">
          <p className="truncate text-sm font-medium">{name || t("user.creator")}</p>
          <p className="truncate text-xs text-muted-foreground">{email}</p>
        </div>
      )}
      <Tooltip>
        <TooltipTrigger asChild>
          <button type="button" onClick={() => void handleSignOut()} disabled={signingOut} aria-label={t("user.signOut")}
            className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-foreground disabled:opacity-50">
            <LogOut className="size-4" />
          </button>
        </TooltipTrigger>
        <TooltipContent side={compact ? "right" : "top"}>{signingOut ? t("user.signingOut") : t("user.signOut")}</TooltipContent>
      </Tooltip>
    </div>
  );
}

type PaletteEntry = { id: string; label: string; hint?: string; href: string; icon: typeof Film; generation?: GenerationSummary };

function CommandPalette({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const t = useTranslations("shell");
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [generations, setGenerations] = useState<GenerationSummary[]>([]);
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setActive(0);
    void fetchGenerations().then(setGenerations).catch(() => {});
  }, [open]);

  const entries = useMemo<PaletteEntry[]>(() => {
    const q = query.trim().toLowerCase();
    const actions: PaletteEntry[] = [
      { id: "new", label: t("nav.newGeneration"), hint: t("palette.newHint"), href: "/", icon: Plus },
      { id: "library", label: t("palette.library"), href: "/list", icon: Film },
      { id: "youtube", label: t("nav.youtube"), href: "/youtube", icon: Youtube },
      { id: "settings", label: t("nav.settings"), href: "/settings", icon: Settings },
    ].filter((entry) => !q || entry.label.toLowerCase().includes(q));
    const matches = generations
      .filter((generation) => !q || generation.source_title.toLowerCase().includes(q))
      .slice(0, 8)
      .map((generation) => ({
        id: generation.id, label: generation.source_title, hint: timeAgo(generation.created_at),
        href: `/tasks/${generation.id}`, icon: Film, generation,
      }));
    return [...actions, ...matches];
  }, [generations, query, t]);

  const go = useCallback((entry: PaletteEntry | undefined) => {
    if (!entry) return;
    onOpenChange(false);
    router.push(entry.href);
  }, [onOpenChange, router]);

  useEffect(() => {
    listRef.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent showCloseButton={false} className="top-[18%] max-w-xl translate-y-0 gap-0 overflow-hidden p-0">
        <DialogTitle className="sr-only">{t("search.dialog")}</DialogTitle>
        <div className="flex items-center gap-3 border-b px-4">
          <Search className="size-4 text-muted-foreground" />
          <input
            autoFocus
            value={query}
            onChange={(event) => { setQuery(event.target.value); setActive(0); }}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown") { event.preventDefault(); setActive((i) => Math.min(entries.length - 1, i + 1)); }
              if (event.key === "ArrowUp") { event.preventDefault(); setActive((i) => Math.max(0, i - 1)); }
              if (event.key === "Enter") { event.preventDefault(); go(entries[active]); }
            }}
            placeholder={t("search.placeholder")}
            aria-label={t("search.inputLabel")}
            className="h-12 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          />
          <Kbd>esc</Kbd>
        </div>
        <div ref={listRef} className="max-h-80 overflow-y-auto p-1.5" role="listbox">
          {entries.length === 0 && <p className="px-3 py-8 text-center text-sm text-muted-foreground">{t("search.empty", { query })}</p>}
          {entries.map((entry, index) => (
            <button
              key={entry.id}
              type="button"
              role="option"
              aria-selected={index === active}
              data-index={index}
              onMouseMove={() => setActive(index)}
              onClick={() => go(entry)}
              className={cn("flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-sm", index === active && "bg-accent")}
            >
              <entry.icon className="size-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate">{entry.label}</span>
              {entry.generation ? <StatusBadge status={entry.generation.status} /> : null}
              {entry.hint && <span className="shrink-0 text-xs text-muted-foreground">{entry.hint}</span>}
              {index === active && <CornerDownLeft className="size-3.5 text-muted-foreground" />}
            </button>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
