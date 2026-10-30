"use client";

import { useTranslations } from "next-intl";
import { motion, useReducedMotion } from "motion/react";
import { Eye } from "lucide-react";

import { cn } from "@/lib/utils";

/**
 * The hero's picture of the whole product: one long source video with its best moments marked on
 * the waveform, and three of them finished as 9:16 Shorts, scored and on their way to YouTube.
 * Example content, labelled as such.
 */

/** Marked moments on the waveform, as fractions of the source's length. */
const MOMENTS = [
  { from: 0.12, to: 0.24 },
  { from: 0.41, to: 0.55 },
  { from: 0.7, to: 0.81 },
];

const WAVE = Array.from({ length: 96 }, (_, i) => 0.25 + Math.abs(Math.sin(i * 0.83) * 0.45 + Math.sin(i * 0.29 + 1.3) * 0.3));

const EASE = [0.16, 1, 0.3, 1] as const;

export function HeroStage() {
  const t = useTranslations("landing.stage");
  const reduceMotion = useReducedMotion();
  const clips = t.raw("clips") as { title: string; caption: string[]; highlight: number; score: number; status: string }[];

  return (
    <div className="relative isolate overflow-hidden rounded-[1.75rem] bg-stone-950 p-5 text-white shadow-[0_30px_80px_-30px_oklch(0.235_0.012_55/0.6)] sm:p-7">
      <div aria-hidden className="absolute inset-0 -z-10 bg-[radial-gradient(ellipse_at_25%_0%,rgb(255_255_255/0.09),transparent_55%),radial-gradient(ellipse_at_85%_100%,oklch(0.55_0.13_39/0.35),transparent_55%)]" />

      {/* The source: a long 16:9 video and its waveform, three moments marked. */}
      <div className="rounded-2xl bg-white/[0.04] p-3 ring-1 ring-white/10">
        <div className="flex items-center justify-between gap-3 px-1 pb-2 font-mono text-[11px] text-white/55">
          <span className="truncate">{t("source")}</span>
          <span className="shrink-0 tabular-nums">1:24:10</span>
        </div>
        <div className="relative h-14 overflow-hidden rounded-lg bg-white/[0.03]">
          <svg aria-hidden viewBox="0 0 96 10" preserveAspectRatio="none" className="absolute inset-0 size-full">
            {WAVE.map((amp, i) => {
              const marked = MOMENTS.some((m) => i / 96 >= m.from && i / 96 <= m.to);
              return (
                <rect key={i} x={i + 0.2} y={5 - amp * 4.5} width={0.55} height={amp * 9} rx={0.25}
                  fill={marked ? "oklch(0.7 0.13 42)" : "rgb(255 255 255 / 0.28)"} />
              );
            })}
          </svg>
          {MOMENTS.map((moment, index) => (
            <motion.span
              key={index}
              aria-hidden
              className="absolute inset-y-1 rounded-md bg-[oklch(0.7_0.13_42/0.16)] ring-1 ring-[oklch(0.7_0.13_42/0.7)]"
              style={{ left: `${moment.from * 100}%`, width: `${(moment.to - moment.from) * 100}%` }}
              initial={reduceMotion ? false : { opacity: 0, scaleY: 0.4 }}
              animate={{ opacity: 1, scaleY: 1 }}
              transition={{ duration: 0.5, delay: 0.5 + index * 0.18, ease: EASE }}
            />
          ))}
          {!reduceMotion && (
            <motion.span
              aria-hidden
              className="absolute inset-y-0 w-0.5 bg-white shadow-[0_0_12px_2px_rgb(255_255_255/0.5)]"
              initial={{ left: "0%" }}
              animate={{ left: "100%" }}
              transition={{ duration: 6, ease: "linear", repeat: Infinity, repeatDelay: 1.5 }}
            />
          )}
        </div>
      </div>

      {/* Three finished Shorts, fanned like a hand of cards. */}
      <ol className="relative mt-6 grid grid-cols-3 gap-3 sm:gap-4">
        {clips.map((clip, index) => (
          <motion.li
            key={clip.title}
            className={cn("min-w-0", index === 1 ? "z-10" : "sm:mt-5")}
            initial={reduceMotion ? false : { opacity: 0, y: 28, rotate: 0 }}
            animate={{ opacity: 1, y: 0, rotate: [-4, 0, 4][index] }}
            transition={{ duration: 0.8, delay: 0.9 + index * 0.15, ease: EASE }}
          >
            <ClipFace title={clip.title} caption={clip.caption} highlight={clip.highlight} score={clip.score} tone={index} />
            <p className="mt-2.5 flex items-center justify-center gap-1.5 text-[11px] text-white/70">
              {index === 0 && <Eye className="size-3" aria-hidden />}
              <span className={cn("truncate", index === 0 && "font-semibold text-emerald-300")}>{clip.status}</span>
            </p>
          </motion.li>
        ))}
      </ol>
      <p className="mt-4 text-center text-[10px] text-white/35">{t("label")}</p>
    </div>
  );
}

const TONES = ["oklch(0.55 0.13 39 / 0.55)", "oklch(0.55 0.07 175 / 0.5)", "oklch(0.75 0.12 80 / 0.45)"];

/** A rendered Short, drawn: hook title, the speaker, and the burned-in caption with one word lit. */
export function ClipFace({ title, caption, highlight, score, tone = 0, className }: {
  title: string;
  caption: string[];
  highlight: number;
  score?: number;
  tone?: number;
  className?: string;
}) {
  return (
    <div className={cn("relative aspect-[9/16] w-full overflow-hidden rounded-[1.1rem] bg-stone-900 ring-1 ring-white/10 shadow-[0_18px_40px_-18px_rgb(0_0_0/0.8)]", className)}>
      <div aria-hidden className="absolute inset-0" style={{ background: `radial-gradient(circle at 50% 44%, ${TONES[tone % TONES.length]}, transparent 64%)` }} />
      <svg aria-hidden viewBox="0 0 90 160" className="absolute inset-0 size-full">
        <circle cx="45" cy="72" r="15" fill="oklch(0.72 0.03 55)" />
        <path d="M14 160 C14 112 76 112 76 160Z" fill="oklch(0.72 0.03 55)" />
      </svg>
      <p className="absolute inset-x-[8%] top-[6%] rounded-[0.4rem] bg-white px-1.5 py-1 text-center text-[clamp(7px,1.1vw,11px)] font-bold leading-tight text-stone-900">
        {title}
      </p>
      {score !== undefined && (
        <span className="absolute right-[8%] top-[24%] rounded-full bg-stone-950/80 px-1.5 py-0.5 text-[clamp(8px,1vw,11px)] font-semibold tabular-nums text-white ring-1 ring-white/15">
          {score}
        </span>
      )}
      <p className="absolute inset-x-[6%] bottom-[16%] text-center text-[clamp(8px,1.25vw,13px)] font-black uppercase leading-tight tracking-tight text-white [text-shadow:1px_1px_0_#000,-1px_-1px_0_#000,1px_-1px_0_#000,-1px_1px_0_#000,0_2px_0_#000]">
        {caption.map((word, index) => (
          <span key={index} className={cn(index === highlight && "text-amber-300")}>{word} </span>
        ))}
      </p>
    </div>
  );
}
