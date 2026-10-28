// Fake Anthropic Models + Messages API. Clip selection answers with two grounded segments of
// 15-30 s built from the "[MM:SS - MM:SS] ..." transcript lines found in the prompt. YouTube
// metadata, asked of the metadata model only, answers with fixed text built from the hook title.
import { startJsonServer, type FakeServer } from "./http";

const MODELS = [
  { type: "model", id: "claude-opus-5", display_name: "Claude Opus 5", created_at: "2026-01-01T00:00:00Z" },
  { type: "model", id: "claude-sonnet-5", display_name: "Claude Sonnet 5", created_at: "2026-01-01T00:00:00Z" },
];
export const FAKE_HOOK_TITLES = ["Open with the surprise", "Cut every empty pause"];
/** CLAUDE_METADATA_MODEL's default; global setup sets it explicitly. */
export const FAKE_METADATA_MODEL = "claude-sonnet-5";

/** What the fake writes for a clip's YouTube Short; the spec checks every upload against it. */
export function fakeYoutubeMetadata(hookTitle: string) {
  return {
    title: `${hookTitle}: a short-video editing tip`,
    description: `One tip from the test video: ${hookTitle.toLowerCase()}.`,
    hashtags: ["videoediting", "shortvideo", "creatortips"],
    tags: ["video editing", "short clips", "editing tips", "content creation", "video hooks"],
    language: "en",
  };
}

type Line = { start: string; end: string; startS: number; endS: number; text: string };

const seconds = (stamp: string) => stamp.split(":").reduce((total, part) => total * 60 + Number(part), 0);

/** The real transcript lines: the prompt's instructions carry example lines, so only read after "Transcript:". */
export function transcriptLines(prompt: string): Line[] {
  const lines: Line[] = [];
  const transcript = prompt.slice(prompt.lastIndexOf("\nTranscript:\n") + 1);
  for (const match of transcript.matchAll(/^\[(\d{2}:\d{2}(?::\d{2})?) - (\d{2}:\d{2}(?::\d{2})?)\] (.*)$/gm)) {
    lines.push({ start: match[1], end: match[2], startS: seconds(match[1]), endS: seconds(match[2]), text: match[3].replace(/^Speaker \w+: /, "").trim() });
  }
  return lines;
}

/** Up to `count` non-overlapping runs of whole lines lasting 15-30 s. */
export function pickSegments(lines: Line[], count = 2) {
  const picks: Line[][] = [];
  for (let i = 0; i < lines.length && picks.length < count; ) {
    let j = i;
    while (j < lines.length && lines[j].endS - lines[i].startS < 15) j++;
    if (j < lines.length && lines[j].endS - lines[i].startS <= 30) {
      picks.push(lines.slice(i, j + 1));
      i = j + 1;
    } else i++;
  }
  return picks.map((run, index) => ({
    start_time: run[0].start,
    end_time: run[run.length - 1].end,
    text: run.map((line) => line.text).join(" "),
    relevance_score: 0.9 - index * 0.1,
    reasoning: "Fake model: a self-contained tip from the transcript.",
    virality: {
      hook_score: 20 - index, engagement_score: 18, value_score: 19, shareability_score: 17,
      total_score: 74 - index, hook_type: "statement", virality_reasoning: "Fake model score.",
    },
    hook_title: FAKE_HOOK_TITLES[index] ?? `Fake clip ${index + 1}`,
    hook_start_time: null,
    hook_end_time: null,
  }));
}

const error = (status: number, type: string, message: string) => ({ status, json: { type: "error", error: { type, message } } });

export function startFakeAnthropic(): Promise<FakeServer> {
  return startJsonServer("anthropic", (request, body, url) => {
    // SDK 1.x sends the key as a bearer token; older SDKs use x-api-key.
    if (!request.headers["x-api-key"] && !request.headers.authorization) return error(401, "authentication_error", "an API key is required");
    if (request.method === "GET" && url.pathname === "/v1/models") {
      return { json: { data: MODELS, has_more: false, first_id: MODELS[0].id, last_id: MODELS.at(-1)!.id } };
    }
    const model = url.pathname.match(/^\/v1\/models\/(.+)$/);
    if (request.method === "GET" && model) {
      const found = MODELS.find((item) => item.id === decodeURIComponent(model[1]));
      return found ? { json: found } : error(404, "not_found_error", "model not found");
    }
    if (request.method === "POST" && url.pathname === "/v1/messages") {
      const params = JSON.parse(body.toString("utf8"));
      const schema = params.output_config?.format?.schema;
      const prompt = params.messages
        .filter((message: { role: string }) => message.role === "user")
        .map((message: { content: unknown }) => (typeof message.content === "string" ? message.content : JSON.stringify(message.content)))
        .join("\n");
      let text: string;
      if (schema?.properties?.hashtags) {
        if (params.model !== FAKE_METADATA_MODEL) return error(400, "invalid_request_error", `metadata expects ${FAKE_METADATA_MODEL}`);
        // The user turn is a one-line preamble, then the clip as JSON data.
        const clip = JSON.parse(prompt.slice(prompt.indexOf("{")));
        text = JSON.stringify(fakeYoutubeMetadata(String(clip.hook_title)));
      } else if (schema?.properties?.most_relevant_segments) {
        const segments = pickSegments(transcriptLines(prompt));
        text = JSON.stringify({ most_relevant_segments: segments, summary: "A fake summary of the test video.", key_topics: ["short clips", "editing"] });
      } else return error(400, "invalid_request_error", "fake only answers clip selection and YouTube metadata");
      return {
        json: {
          id: `msg_fake_${Date.now()}`, type: "message", role: "assistant", model: params.model,
          content: [{ type: "text", text }], stop_reason: "end_turn", stop_sequence: null,
          usage: { input_tokens: Math.ceil(prompt.length / 4), output_tokens: Math.ceil(text.length / 4) },
        },
      };
    }
    return error(404, "not_found_error", `no fake route for ${request.method} ${url.pathname}`);
  });
}
