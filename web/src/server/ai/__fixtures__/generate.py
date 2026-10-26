"""Regenerate python-golden.json from the original Python AI layer.

The original lives at commit 1dbb178 (backend/src/ai.py). Run with the backend venv:
  backend/.venv/Scripts/python.exe -X utf8 web/src/server/ai/__fixtures__/generate.py
"""

import asyncio
import json
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[5]
sys.path.insert(0, str(ROOT / "backend"))
os.environ["ANTHROPIC_API_KEY"] = "sk-ant-golden"
for key in ("GOOGLE_API_KEY", "OPENAI_API_KEY", "OPENROUTER_API_KEY", "LLM"):
    os.environ.pop(key, None)

import anthropic  # noqa: E402
import httpx  # noqa: E402
from pydantic_ai import Agent, NativeOutput  # noqa: E402
from pydantic_ai.providers.anthropic import AnthropicProvider  # noqa: E402

from src import ai  # noqa: E402
from src.config import Config  # noqa: E402

PRESETS = ["auto", "short", "medium", "long"]


def label(seconds: int) -> str:
    minutes, secs = divmod(seconds, 60)
    return f"{minutes:02d}:{secs:02d}"


def even_transcript(total_seconds: int, line_seconds: int = 10) -> str:
    return "\n".join(
        f"[{label(start)} - {label(start + line_seconds)}] Speaker A: Line at {start} seconds is here."
        for start in range(0, total_seconds, line_seconds)
    )


TRANSCRIPT = "\n".join([
    "[00:00 - 00:09] Speaker A: Welcome back to the show, today we have a special guest.",
    "[00:09 - 00:21] Speaker B: Thanks for having me. I want to talk about the biggest mistake I made.",
    "[00:21 - 00:34] Speaker B: I spent forty thousand dollars on ads before I had a single customer.",
    "[00:34 - 00:47] Speaker A: Wait, forty thousand? Why would anyone do that?",
    "[00:47 - 01:02] Speaker B: Because everybody told me growth comes first, and nobody told me to validate.",
    "[01:02 - 01:15] Speaker B: So here's the lesson: talk to ten customers before you spend a single dollar.",
    "[01:15 - 01:31] Speaker A: That's actually the best advice I've heard all year, honestly.",
    "[01:31 - 01:48] Speaker B: And the second thing, never hire before you have repeatable sales.",
    "[01:48 - 02:05] Speaker A: Let's take a quick break and hear from our sponsor.",
])

SIGNALS = "\n".join([
    "Deterministic clip-worthiness signals to consider before ranking:",
    "- [00:21 - 00:34] score=3.0: trigger phrase, short punchy line; I spent forty thousand dollars",
    "- [00:34 - 00:47] score=4.5: trigger phrase, question/hook; Wait, forty thousand?",
    "- [12:10 - 12:20] score=1.0: pause before line; Later moment",
    "- [101:00 - 101:10] score=1.25: audio peak; Past the hundred minute mark",
])

TRANSCRIPTS = {
    "show": TRANSCRIPT,
    "even_180": even_transcript(180),
    "even_70m": even_transcript(70 * 60),
    "mixed_hours": "\n".join([
        "[59:40 - 59:58] Speaker A: Right before the hour mark we set up the story.",
        "[59:58 - 60:20] Speaker A: Then the twist lands just after the hour mark here.",
        "[60:20 - 60:41] Speaker B: And that is how three digit minutes keep working fine.",
        "[100:00 - 100:20] Speaker A: First long sentence past the hundred minute mark.",
        "[100:20 - 100:40] Speaker A: Second sentence with the payoff.",
    ]),
}


def dump(segment):
    return segment.model_dump()


def segment(start, end, text="Some useful words here.", total=60, **extra):
    quarter = total // 4
    data = {
        "start_time": start,
        "end_time": end,
        "text": text,
        "virality": {
            "hook_score": quarter,
            "engagement_score": quarter,
            "value_score": quarter,
            "shareability_score": total - 3 * quarter,
            "total_score": total,
        },
    }
    data.update(extra)
    return data


def prompts():
    analysis_cases = []
    for preset in PRESETS:
        analysis_cases.append({"transcript": TRANSCRIPT, "clip_signals": None, "window": None, "clip_length": preset})
    analysis_cases += [
        {"transcript": TRANSCRIPT, "clip_signals": SIGNALS, "window": None, "clip_length": "auto"},
        {"transcript": TRANSCRIPT, "clip_signals": SIGNALS, "window": [600, 1320], "clip_length": "medium"},
        {"transcript": TRANSCRIPT, "clip_signals": None, "window": [6000, 6720], "clip_length": "long"},
        {"transcript": "", "clip_signals": "", "window": [0, 720], "clip_length": "short"},
    ]
    for case in analysis_cases:
        case["prompt"] = ai.build_transcript_analysis_prompt(
            transcript=case["transcript"],
            clip_signals=case["clip_signals"],
            window=tuple(case["window"]) if case["window"] else None,
            clip_length=case["clip_length"],
        )

    candidates = [
        segment("00:09", "00:47", "Thanks for having me. I want to talk about the biggest mistake I made.", hook_title="The $40k mistake I keep seeing"),
        segment("01:02", "01:31", "So here's the lesson: talk to ten customers.", hook_title=None),
        segment("59:58", "60:41", "Then the twist lands just after the hour mark here.", hook_title=""),
    ]
    rerank = {
        "candidates": candidates,
        "prompt": ai.build_candidate_rerank_prompt([ai.TranscriptSegment.model_validate(c) for c in candidates]),
    }
    return {
        "system": {preset: ai.build_transcript_system_prompt(preset) for preset in PRESETS},
        "rerank_system": ai.candidate_rerank_system_prompt,
        "analysis": analysis_cases,
        "rerank": rerank,
    }


def validation_cases():
    cases = []

    def add(transcript_name, clip_length, segments):
        text = TRANSCRIPTS[transcript_name]
        models = [ai.TranscriptSegment.model_validate(s) for s in segments]
        result = ai._validate_segments(
            models, ai._parse_transcript_lines(text), ai._parse_transcript_spans(text), clip_length
        )
        cases.append({
            "transcript": transcript_name,
            "clip_length": clip_length,
            "segments": segments,
            "result": [dump(s) for s in result],
        })

    add("show", "auto", [
        segment("00:09", "00:47", "Thanks for having me. I want to talk about the biggest mistake I made.", 80,
                hook_title="  “The $40k mistake #startup #growth”.  ", hook_start_time="00:21", hook_end_time="00:27"),
        segment("00:10", "00:50", "paraphrased words that differ", 70, hook_title="#only #tags"),
        segment("00:20", "00:30", "too short a moment here", 50),
        segment("00:00", "02:05", "the entire episode from start to finish", 40),
        segment("01:02", "01:02", "identical start and end", 50),
        segment("1:02", "1:31", "So here's the lesson", 65, hook_start_time="01:10", hook_end_time="01:25"),
        segment("00:00", "00:30", "two words", 90),
        segment("00:00", "00:3x", "bad timestamp format here", 90),
        segment("00:21.5", "00:47", "fractional timestamp is invalid", 90),
        segment(" 00:21", "00:47 ", "whitespace is accepted by int", 55, hook_title="Why nobody tells you this about VC and everything else that matters"),
        segment("05:00", "05:40", "far away from every transcript line", 96),
    ])
    add("even_180", "short", [segment("00:00", "01:30", "Useful context and thought.")])
    add("even_180", "medium", [segment("00:30", "00:40", "Useful context and thought.")])
    add("even_180", "long", [segment("00:30", "01:00", "Useful context and thought."), segment("00:00", "01:30", "Useful context and thought.")])
    add("even_70m", "auto", [segment("65:00", "66:30"), segment("12:03", "12:41", total=73)])
    add("mixed_hours", "auto", [
        segment("59:40", "60:41", "Right before the hour mark we set up the story.", 77),
        segment("100:00", "100:40", "First long sentence past the hundred minute mark.", 66, hook_title="Past the hundred minute mark"),
        segment("1:40:00", "1:40:40", "hour format labels never match line labels", 60),
    ])
    return cases


HOOK_TITLES = [
    None, "", "   ", "The habit that doubled my output",
    '  "Why nobody tells you this about VC."  ', "“Do this before your next interview”",
    "`Markdown` title #viral #fyp", "Stop doing this!?...", "Is this real? --- ",
    "#привет 世界 #日本語 title",
    "Big news #नमस्ते everyone",
    "one two three four five six seven eight nine ten eleven twelve",
    "Supercalifragilisticexpialidocious-and-more-hyphenated-words-to-push-past-the-limit right",
    "A short start then averyveryveryveryveryveryveryveryveryverylongwordwithoutspaces",
    "The \U0001F680 rocket title that keeps on going with emoji \U0001F525 and many many words",
    "Café crème brûlée — the secret ingredient nobody uses –",
    "\t\nTabs\tand\nnewlines\r\neverywhere  ",
    "x" * 70,
]

TIMESTAMP_INPUTS = [
    "02:35", "01:02:35", "0:05", "100:05", "  00:30", "00:30 ", "1_0:05", "+1:05", "-1:30",
    "", "00:3x", "00:21.5", "1:2:3:4", "12", "::",
]


def safe_parse(value):
    try:
        return ai._parse_transcript_timestamp_seconds(value)
    except ValueError:
        return None


def rescale_cases():
    cases = []
    for subs, new_total in [
        ([15, 15, 15, 15], 88), ([22, 22, 22, 24], 91), ([0, 0, 0, 0], 50), ([25, 25, 25, 25], 100),
        ([3, 7, 11, 19], 77), ([20, 5, 0, 0], 99), ([10, 10, 10, 10], 0), ([1, 2, 3, 4], 101),
        ([25, 0, 0, 0], 60), ([13, 13, 14, 20], 33),
    ]:
        virality = ai.ViralityAnalysis(
            hook_score=subs[0], engagement_score=subs[1], value_score=subs[2], shareability_score=subs[3],
            total_score=sum(subs),
        )
        ai._rescale_virality(virality, new_total)
        cases.append({"subscores": subs, "new_total": new_total, "result": virality.model_dump()})
    return cases


def window_cases():
    cases = []
    for minutes, line_seconds in [(10, 10), (15, 10), (16, 10), (23, 10), (60, 10), (110, 10), (31, 7), (21, 30)]:
        windows = ai.split_transcript_into_windows(even_transcript(minutes * 60, line_seconds))
        cases.append({
            "minutes": minutes,
            "line_seconds": line_seconds,
            "windows": [{"start": w["start"], "end": w["end"], "lines": len(w["transcript"].splitlines()),
                         "first": w["transcript"].splitlines()[0][:16], "last": w["transcript"].splitlines()[-1][:18]}
                        for w in windows],
        })
    return cases


def model_cases():
    inputs = [
        {"most_relevant_segments": [{"start_time": "00:00", "end_time": "00:15", "segment": "From a local model."}],
         "summary": "A short summary.", "key_topics": ["local"]},
        {"most_relevant_segments": [{"start_time": "00:00", "end_time": "00:15", "text": "Text wins.", "segment": "ignored",
                                     "title": "Title alias", "headline": "ignored", "relevance_score": 85,
                                     "virality": {"hook_score": 20, "hook_type": None}}],
         "summary": "s", "key_topics": [], "broll_opportunities": [{"broll": ["x"]}]},
        {"most_relevant_segments": [{"start_time": "00:00", "end_time": "00:15", "text": "t", "headline": "Headline alias",
                                     "relevance_score": 100, "reasoning": "why", "hook_start_time": "00:03", "hook_end_time": None}],
         "summary": "s", "key_topics": ["a", "b"]},
        {"most_relevant_segments": [{"start_time": "00:00", "end_time": "00:15", "text": "t", "relevance_score": 1,
                                     "virality": {"hook_score": 25, "engagement_score": 0, "value_score": 10,
                                                  "shareability_score": 7, "total_score": 3, "hook_type": "statistic",
                                                  "virality_reasoning": "numbers"}}],
         "summary": "s", "key_topics": []},
        {"most_relevant_segments": [], "summary": "", "key_topics": []},
    ]
    return [{"input": data, "output": ai.TranscriptAnalysis.model_validate(data).model_dump()} for data in inputs]


async def request_bodies():
    captured = []

    def handler(request):
        captured.append((json.loads(request.content), request.headers.get("anthropic-beta")))
        payload = {"ranking": []} if len(captured) % 2 == 0 else {"most_relevant_segments": [], "summary": "", "key_topics": []}
        return httpx.Response(200, json={
            "id": "msg", "type": "message", "role": "assistant", "model": "claude-opus-5",
            "content": [{"type": "text", "text": json.dumps(payload)}],
            "stop_reason": "end_turn", "stop_sequence": None, "usage": {"input_tokens": 1, "output_tokens": 1},
        })

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    sdk = anthropic.AsyncAnthropic(api_key="sk-ant-golden", http_client=client, max_retries=0)
    real = AnthropicProvider
    ai.AnthropicProvider = type("GoldenProvider", (), {
        "model_profile": staticmethod(real.model_profile),
        "__new__": lambda cls, **kwargs: real(anthropic_client=sdk),
    })
    config = Config()
    bodies = {}
    for model_name in ("claude-opus-5", "claude-sonnet-5"):
        model = ai._build_transcript_model(config, f"anthropic:{model_name}")
        await Agent(model, output_type=NativeOutput(ai.TranscriptAnalysis, strict=True), system_prompt="SYSTEM").run("PROMPT")
        await Agent(model, output_type=NativeOutput(ai.CandidateRanking, strict=True), system_prompt="SYSTEM").run("PROMPT")
        (analysis, analysis_beta), (ranking, _) = captured[-2:]
        bodies[model_name] = {"analysis": analysis, "ranking": ranking, "beta": analysis_beta}
    await client.aclose()
    return bodies


def main():
    golden = {
        "source": "backend/src/ai.py at commit 1dbb178",
        "transcripts": TRANSCRIPTS,
        "signals": SIGNALS,
        "prompts": prompts(),
        "requests": asyncio.run(request_bodies()),
        "validation": validation_cases(),
        "hook_titles": [[raw, ai.sanitize_hook_title(raw)] for raw in HOOK_TITLES],
        "timestamps": {
            "parse": [[value, safe_parse(value)] for value in TIMESTAMP_INPUTS],
            "format": [[s, ai._format_transcript_timestamp(s)] for s in (-5, 0, 59, 155, 3599, 3600, 3755, 6005, 360000)],
            "minutes": [[s, ai._format_minutes_label(s)] for s in (-5, 0, 59, 155, 3755, 6005, 60000)],
        },
        "rescale": rescale_cases(),
        "windows": window_cases(),
        "signal_filters": [
            [start, end, ai._filter_clip_signals_for_window(SIGNALS, start, end)]
            for start, end in ((0, 720), (600, 1320), (720, 1440), (6000, 6720), (1000, 1100))
        ],
        "final_clips": [
            [seconds, max_clips, ai.max_final_clips_for_duration(seconds, max_clips)]
            for seconds in (0, 60, 299, 300, 301, 1200, 1500, 1501, 2700, 3000, 5400, 12000)
            for max_clips in (1, 3, 5, 10, 20, 50)
        ],
        "models": model_cases(),
    }
    out = Path(__file__).with_name("python-golden.json")
    out.write_text(json.dumps(golden, indent=1, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"wrote {out}")


if __name__ == "__main__":
    main()
