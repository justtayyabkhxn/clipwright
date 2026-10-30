"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { motion, useInView, useReducedMotion } from "motion/react";
import { ArrowRight, Check, Copy, ExternalLink, Eye, Loader2 } from "lucide-react";

import { BrandMark, BrandWordmark, SourceCredit } from "@/components/brand";
import { ClipFace, HeroStage } from "@/components/landing/hero-stage";
import { Button } from "@/components/ui/button";
import { SOURCE_CODE_URL } from "@/lib/site";
import { cn } from "@/lib/utils";

/** Public front page for signed-out visitors: what Clipwright does, how to set it up, and the way in. */
export function Landing() {
  return (
    <div className="min-h-dvh bg-background text-foreground selection:bg-brand/25">
      <Header />
      <main>
        <Hero />
        <Pipeline />
        <ClipShowcase />
        <PostingSchedule />
        <Setup />
        <Close />
      </main>
      <footer className="border-t">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-6 py-6 text-xs text-muted-foreground">
          <span className="flex items-center gap-2">
            <BrandMark className="size-5" />
            <BrandWordmark className="text-base" />
          </span>
          <SourceCredit />
        </div>
      </footer>
    </div>
  );
}

function Header() {
  const t = useTranslations("landing.nav");
  return (
    <header className="sticky top-0 z-30 border-b border-transparent bg-background/85 backdrop-blur supports-[backdrop-filter]:bg-background/70">
      <div className="mx-auto flex h-16 max-w-6xl items-center gap-6 px-6">
        <Link href="/" aria-label="Clipwright" className="flex items-center gap-2">
          <BrandMark />
          <BrandWordmark />
        </Link>
        <nav aria-label="Page" className="hidden items-center gap-5 text-sm text-muted-foreground md:flex">
          <a href="#how" className="hover:text-foreground">{t("how")}</a>
          <a href="#posting" className="hover:text-foreground">{t("posting")}</a>
          <a href="#setup" className="hover:text-foreground">{t("setup")}</a>
          <a href={SOURCE_CODE_URL} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 hover:text-foreground">
            {t("source")}<ExternalLink className="size-3" aria-hidden />
          </a>
        </nav>
        <div className="ml-auto flex items-center gap-2">
          <Button variant="ghost" size="sm" asChild><Link href="/sign-in">{t("signIn")}</Link></Button>
          <Button size="sm" asChild className="bg-brand text-brand-foreground hover:bg-brand/90"><Link href="/sign-up">{t("signUp")}</Link></Button>
        </div>
      </div>
    </header>
  );
}

function Hero() {
  const t = useTranslations("landing.hero");
  return (
    <section className="mx-auto grid max-w-6xl items-center gap-12 px-6 pb-20 pt-12 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] lg:gap-16 lg:pb-28 lg:pt-16">
      <div>
        <h1 className="text-balance font-display text-[clamp(3rem,7.5vw,6rem)] font-semibold leading-[0.92] tracking-[-0.04em]">
          {t("title")}
          <span className="block text-brand">{t("titleAccent")}</span>
        </h1>
        <p className="mt-7 max-w-[58ch] text-pretty text-lg leading-relaxed text-muted-foreground">{t("body")}</p>
        <div className="mt-9 flex flex-wrap items-center gap-3">
          <Button size="lg" asChild className="h-12 bg-brand px-6 text-base text-brand-foreground hover:bg-brand/90">
            <Link href="/sign-up">{t("primary")}<ArrowRight className="size-4" aria-hidden /></Link>
          </Button>
          <Button size="lg" variant="outline" asChild className="h-12 px-6 text-base">
            <a href="#setup">{t("secondary")}</a>
          </Button>
        </div>
        <p className="mt-6 text-sm text-muted-foreground">{t("facts")}</p>
      </div>
      <HeroStage />
    </section>
  );
}

const STEPS = ["download", "transcribe", "pick", "render", "post"] as const;
/** The task page's own progress for each step; "post" is the YouTube chip, after the task completes. */
const STEP_PROGRESS: Record<(typeof STEPS)[number], number> = { download: 10, transcribe: 30, pick: 50, render: 70, post: 100 };

function Pipeline() {
  const t = useTranslations("landing.pipeline");
  return (
    <section id="how" className="scroll-mt-20 border-y bg-canvas">
      <div className="mx-auto max-w-6xl px-6 py-20 lg:py-24">
        <div className="max-w-2xl">
          <h2 className="text-balance font-display text-4xl font-semibold tracking-tight sm:text-5xl">{t("title")}</h2>
          <p className="mt-4 text-pretty text-lg text-muted-foreground">{t("body")}</p>
        </div>
        <ol className="mt-12 grid gap-px overflow-hidden rounded-2xl border bg-border md:grid-cols-5">
          {STEPS.map((step) => (
            <li key={step} className="flex flex-col bg-background p-5">
              <span className="font-display text-2xl font-semibold">{t(`steps.${step}.name`)}</span>
              <span className="mt-3 font-mono text-xs text-brand">{t(`steps.${step}.message`)}</span>
              <span aria-hidden className="mt-2 h-1 overflow-hidden rounded-full bg-muted">
                <span className="block h-full rounded-full bg-brand" style={{ width: `${STEP_PROGRESS[step]}%` }} />
              </span>
              <span className="mt-4 text-sm leading-relaxed text-muted-foreground">{t(`steps.${step}.detail`)}</span>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}

const SCORE_PARTS = [
  { key: "hook", value: 23 },
  { key: "engagement", value: 21 },
  { key: "value", value: 22 },
  { key: "shareability", value: 21 },
] as const;

function ClipShowcase() {
  const t = useTranslations("landing.clip");
  const caption = t.raw("caption") as string[];
  const features = t.raw("features") as string[];
  const total = SCORE_PARTS.reduce((sum, part) => sum + part.value, 0);
  return (
    <section className="mx-auto grid max-w-6xl items-center gap-14 px-6 py-20 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] lg:py-28">
      <figure className="mx-auto flex w-full max-w-md items-end gap-5">
        {/* A rendered clip, drawn: hook title on top, the speaker, word-synced captions. */}
        <ClipFace title={t("hookTitle")} caption={caption} highlight={2} className="w-[46%] shrink-0 rounded-[1.4rem]" />
        <figcaption className="min-w-0 flex-1 pb-2">
          <span className="text-xs text-muted-foreground">{t("example")}</span>
          <p className="mt-1 font-display text-6xl font-semibold leading-none tabular-nums">{total}</p>
          <p className="text-sm text-muted-foreground">{t("score")}</p>
          <dl className="mt-4 space-y-2">
            {SCORE_PARTS.map((part) => (
              <div key={part.key} className="text-xs">
                <div className="flex justify-between"><dt>{t(`parts.${part.key}`)}</dt><dd className="tabular-nums">{part.value}/25</dd></div>
                <div aria-hidden className="mt-1 h-1 rounded-full bg-muted"><div className="h-full rounded-full bg-brand" style={{ width: `${(part.value / 25) * 100}%` }} /></div>
              </div>
            ))}
          </dl>
          <p className="mt-4 text-xs font-medium">{t("hookType")}</p>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{t("reasoning")}</p>
        </figcaption>
      </figure>
      <div>
        <h2 className="text-balance font-display text-4xl font-semibold tracking-tight sm:text-5xl">{t("title")}</h2>
        <p className="mt-4 text-pretty text-lg text-muted-foreground">{t("body")}</p>
        <ul className="mt-8 space-y-3">
          {features.map((feature) => (
            <li key={feature} className="flex gap-3 text-[15px]">
              <Check className="mt-0.5 size-4 shrink-0 text-brand" aria-hidden />{feature}
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

/** Example schedule: six clips, ten minutes apart, starting 4:30 PM. */
const SCHEDULE = [
  { title: "The habit that doubled my output", views: 18400 },
  { title: "Why most advice fails beginners", views: 9600 },
  { title: "The 2-minute rule, explained", views: 12100 },
  { title: "What I'd tell myself at 20", views: 31500 },
  { title: "Stop planning, start shipping", views: 7200 },
  { title: "The question that changed my career", views: 14800 },
] as const;
const FIRST_SLOT = new Date(2026, 0, 1, 16, 30);
const STEP_MS = 1100;
const slotTime = (index: number) =>
  new Date(FIRST_SLOT.getTime() + index * 10 * 60_000).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
const COMPACT = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });

/**
 * The page's one authored motion: once in view, the clock walks the schedule and each clip goes from
 * waiting, to uploading, to posted with its views, ten (fast-forwarded) minutes apart.
 */
function PostingSchedule() {
  const t = useTranslations("landing.posting");
  const ref = useRef<HTMLDivElement>(null);
  const inView = useInView(ref, { once: true, amount: 0.4 });
  const reduceMotion = useReducedMotion();
  const [step, setStep] = useState(0);

  useEffect(() => {
    if (!inView || reduceMotion) return;
    const timer = window.setInterval(() => setStep((value) => (value > SCHEDULE.length * 2 ? value : value + 1)), STEP_MS / 2);
    return () => window.clearInterval(timer);
  }, [inView, reduceMotion]);

  // Each clip spends one half-step uploading, then is posted.
  const shown = reduceMotion ? SCHEDULE.length * 2 : step;
  const state = (index: number) => (shown >= index * 2 + 2 ? "posted" : shown === index * 2 + 1 ? "uploading" : "waiting");
  const now = Math.min(Math.floor(shown / 2), SCHEDULE.length - 1);

  return (
    <section id="posting" className="scroll-mt-16 bg-stone-950 text-white">
      <div className="relative mx-auto max-w-6xl px-6 py-20 lg:py-28">
        <div aria-hidden className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_80%_0%,oklch(0.55_0.13_39/0.22),transparent_55%)]" />
        <div className="relative grid gap-14 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
          <div>
            <h2 className="text-balance font-display text-5xl font-semibold leading-[0.98] tracking-[-0.03em] sm:text-6xl">{t("title")}</h2>
            <p className="mt-5 max-w-[52ch] text-pretty text-lg text-white/70">{t("body")}</p>
            <div className="mt-12 border-t border-white/15 pt-8">
              <h3 className="font-display text-2xl font-semibold">{t("learnTitle")}</h3>
              <p className="mt-3 max-w-[52ch] text-pretty text-white/70">{t("learnBody")}</p>
              <ul className="mt-6 space-y-3" aria-label={t("example")}>
                {([["story", 21000], ["question", 12400], ["statement", 6800]] as const).map(([key, avg], index) => (
                  <li key={key} className="text-sm">
                    <div className="flex justify-between"><span>{t(`bars.${key}`)}</span><span className="tabular-nums text-white/70">{COMPACT.format(avg)}</span></div>
                    <div aria-hidden className="mt-1.5 h-1.5 rounded-full bg-white/10">
                      <div className={cn("h-full rounded-full", index === 0 ? "bg-brand" : "bg-brand/45")} style={{ width: `${(avg / 21000) * 100}%` }} />
                    </div>
                  </li>
                ))}
              </ul>
              <p className="mt-6 text-sm text-white/55">{t("extras")}</p>
            </div>
          </div>

          <div ref={ref}>
            <div className="flex items-baseline justify-between gap-4 border-b border-white/15 pb-4">
              <span className="text-xs text-white/55">{t("example")}</span>
              <span className="font-display text-5xl font-semibold tabular-nums sm:text-6xl" aria-hidden>{slotTime(now)}</span>
            </div>
            <ol className="divide-y divide-white/10">
              {SCHEDULE.map((clip, index) => {
                const current = state(index);
                return (
                  <li key={clip.title} className="grid grid-cols-[4.5rem_minmax(0,1fr)_auto] items-center gap-4 py-4">
                    <span className="font-mono text-sm tabular-nums text-white/55">{slotTime(index)}</span>
                    <span className={cn("truncate text-[15px] transition-colors duration-500", current === "waiting" ? "text-white/45" : "text-white")}>{clip.title}</span>
                    <ScheduleChip state={current} time={slotTime(index)} views={clip.views} />
                  </li>
                );
              })}
            </ol>
          </div>
        </div>
      </div>
    </section>
  );
}

function ScheduleChip({ state, time, views }: { state: "waiting" | "uploading" | "posted"; time: string; views: number }) {
  const t = useTranslations("landing.posting");
  if (state === "waiting") {
    return <span className="rounded-full bg-white/10 px-2.5 py-1 text-xs text-white/60">{t("uploadsAt", { time })}</span>;
  }
  if (state === "uploading") {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full bg-white/10 px-2.5 py-1 text-xs text-white">
        <Loader2 className="size-3 animate-spin" aria-hidden />{t("uploading")}
      </span>
    );
  }
  return (
    <motion.span initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.4, ease: [0.16, 1, 0.3, 1] }} className="flex items-center gap-3">
      <span className="hidden items-center gap-1 text-sm font-semibold tabular-nums sm:inline-flex">
        <Eye className="size-4 text-white/55" aria-hidden />{COMPACT.format(views)}
      </span>
      <span className="rounded-full bg-emerald-400/15 px-2.5 py-1 text-xs font-medium text-emerald-300">{t("posted")}</span>
    </motion.span>
  );
}

const SETUP_ITEMS = [
  { key: "tools", required: true },
  { key: "mongo", required: true },
  { key: "anthropic", required: true },
  { key: "assembly", required: true },
  { key: "google", required: false },
] as const;

const QUICK_START = `git clone ${SOURCE_CODE_URL}.git clipwright
cd clipwright/engine && uv sync && cd ../web
npx -y pnpm@10 install
cp .env.example .env.local
npx -y pnpm@10 dev`;

function Setup() {
  const t = useTranslations("landing.setup");
  const tLimits = useTranslations("landing.limits");
  const then = t.raw("then") as string[];
  const limits = tLimits.raw("items") as string[];
  return (
    <section id="setup" className="scroll-mt-16 mx-auto max-w-6xl px-6 py-20 lg:py-28">
      <div className="max-w-2xl">
        <h2 className="text-balance font-display text-4xl font-semibold tracking-tight sm:text-5xl">{t("title")}</h2>
        <p className="mt-4 text-pretty text-lg text-muted-foreground">{t("body")}</p>
      </div>

      <div className="mt-12 grid grid-cols-1 gap-12 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <ul className="min-w-0 divide-y rounded-2xl border bg-card">
          {SETUP_ITEMS.map(({ key, required }) => (
            <li key={key} className="p-5">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="font-display text-xl font-semibold">{t(`items.${key}.name`)}</span>
                <span className={cn("rounded-full px-2 py-0.5 text-[11px] font-medium", required ? "bg-brand-soft text-brand" : "bg-muted text-muted-foreground")}>
                  {required ? t("required") : t("optional")}
                </span>
              </div>
              <p className="mt-1.5 text-sm text-muted-foreground">{t(`items.${key}.why`)}</p>
              <p className="mt-1 text-sm">{t(`items.${key}.where`)}</p>
            </li>
          ))}
        </ul>

        <div className="min-w-0">
          <h3 className="font-display text-2xl font-semibold">{t("quickTitle")}</h3>
          <p className="mt-2 text-sm text-muted-foreground">{t("quickBody")}</p>
          <CodeBlock code={QUICK_START} />
          <h3 className="mt-10 font-display text-2xl font-semibold">{t("thenTitle")}</h3>
          <ol className="mt-4 space-y-3">
            {then.map((line, index) => (
              <li key={line} className="flex gap-3 text-[15px]">
                <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-foreground text-xs font-semibold text-background tabular-nums">{index + 1}</span>
                <span className="pt-0.5">{line}</span>
              </li>
            ))}
          </ol>
          <div className="mt-10 rounded-2xl bg-brand-soft p-5">
            <h3 className="font-display text-xl font-semibold">{tLimits("title")}</h3>
            <ul className="mt-3 space-y-2 text-sm">
              {limits.map((line) => <li key={line}>{line}</li>)}
            </ul>
          </div>
        </div>
      </div>
    </section>
  );
}

function CodeBlock({ code }: { code: string }) {
  const t = useTranslations("landing.setup");
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      // Clipboard blocked (insecure origin): the text stays selectable.
    }
  };
  return (
    <div className="mt-4 overflow-hidden rounded-2xl bg-stone-950 text-stone-100">
      <div className="flex items-center justify-between border-b border-white/10 px-4 py-2">
        <span className="font-mono text-xs text-white/50">terminal</span>
        <button
          type="button"
          onClick={() => void copy()}
          className="inline-flex items-center gap-1.5 rounded-md bg-white/10 px-2.5 py-1 text-xs text-white/80 hover:bg-white/15 focus-visible:outline-2 focus-visible:outline-brand"
        >
          {copied ? <Check className="size-3.5" aria-hidden /> : <Copy className="size-3.5" aria-hidden />}
          {copied ? t("copied") : t("copy")}
        </button>
      </div>
      <pre className="overflow-x-auto p-5 font-mono text-[13px] leading-6 selection:bg-white/20"><code>{code}</code></pre>
    </div>
  );
}

function Close() {
  const t = useTranslations("landing.close");
  return (
    <section className="border-t bg-canvas">
      <div className="mx-auto max-w-6xl px-6 py-24 text-center lg:py-32">
        <h2 className="mx-auto max-w-4xl text-balance font-display text-[clamp(2.75rem,7vw,5.5rem)] font-semibold leading-[0.95] tracking-[-0.035em]">{t("title")}</h2>
        <p className="mx-auto mt-6 max-w-xl text-pretty text-lg text-muted-foreground">{t("body")}</p>
        <div className="mt-10 flex flex-wrap justify-center gap-3">
          <Button size="lg" asChild className="h-12 bg-brand px-7 text-base text-brand-foreground hover:bg-brand/90">
            <Link href="/sign-up">{t("primary")}<ArrowRight className="size-4" aria-hidden /></Link>
          </Button>
          <Button size="lg" variant="outline" asChild className="h-12 px-7 text-base"><Link href="/sign-in">{t("secondary")}</Link></Button>
        </div>
      </div>
    </section>
  );
}
