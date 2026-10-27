// Fake AssemblyAI v2 API: upload, submit, then poll (one "processing" answer, then "completed")
// with word timings for a fixed script that fits the 45 s synthetic video.
import { randomUUID } from "node:crypto";
import { startJsonServer, type FakeServer } from "./http";

/** [start ms, end ms, text]. Gaps of 400 ms between utterances; all inside 0-42 s. */
export const SCRIPT: [number, number, string][] = [
  [400, 6600, "Welcome back to the channel, today we are testing how short clips get made."],
  [7000, 13400, "The first trick is simple: open with the most surprising thing you learned."],
  [13800, 20600, "People decide in about two seconds whether they keep watching or scroll away."],
  [21000, 27600, "The second trick is to cut every pause that does not carry any meaning."],
  [28000, 34600, "Silence feels three times longer on a phone than it does in real life."],
  [35000, 42000, "Finally, end on a line that makes viewers want to share it with a friend."],
];

function transcript() {
  const utterances = SCRIPT.map(([start, end, text]) => {
    const tokens = text.split(" ");
    const step = (end - start) / tokens.length;
    const words = tokens.map((token, i) => ({
      text: token,
      start: Math.round(start + i * step),
      end: Math.round(start + (i + 1) * step - 40),
      confidence: 0.99,
      speaker: "A",
    }));
    return { text, start, end, confidence: 0.99, speaker: "A", words };
  });
  return {
    text: SCRIPT.map(([, , text]) => text).join(" "),
    words: utterances.flatMap((utterance) => utterance.words),
    utterances,
    language_code: "en",
    language_confidence: 0.98,
  };
}

const error = (status: number, message: string) => ({ status, json: { error: message } });

export function startFakeAssemblyAI(): Promise<FakeServer> {
  const jobs = new Map<string, { audio_url: string; polls: number }>();
  let base = "";
  const fake = startJsonServer("assemblyai", (request, body, url) => {
    if (!request.headers.authorization) return error(401, "Authentication error, API token missing/invalid");
    if (request.method === "POST" && url.pathname === "/v2/upload") {
      if (body.length < 1000) return error(400, "upload is too small to be audio");
      return { json: { upload_url: `${base}/files/${randomUUID()}` } };
    }
    if (request.method === "POST" && url.pathname === "/v2/transcript") {
      const { audio_url } = JSON.parse(body.toString("utf8"));
      const id = randomUUID();
      jobs.set(id, { audio_url, polls: 0 });
      return { json: { id, status: "queued", audio_url } };
    }
    const poll = url.pathname.match(/^\/v2\/transcript\/([\w-]+)$/);
    if (request.method === "GET" && poll) {
      const job = jobs.get(poll[1]);
      if (!job) return error(404, "Transcript not found");
      job.polls += 1;
      if (job.polls === 1) return { json: { id: poll[1], status: "processing", audio_url: job.audio_url } };
      return { json: { id: poll[1], status: "completed", audio_url: job.audio_url, ...transcript() } };
    }
    return error(404, `no fake route for ${request.method} ${url.pathname}`);
  });
  return fake.then((server) => ((base = server.url), server));
}
