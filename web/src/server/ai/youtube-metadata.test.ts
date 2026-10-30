/** @vitest-environment node */
// Claude-written YouTube Shorts metadata (design §4.5). Fake Anthropic fetch, same pattern as
// claude-provider.test.ts; no paid calls.

import { afterEach, describe, expect, it, vi } from "vitest";
import { fakeFetch, messageResponse } from "./__fixtures__/fake-anthropic";
import { OutputValidationError } from "./schemas";
import {
  fitTags,
  parseYoutubeMetadata,
  writeYoutubeMetadata,
  youtubeDescription,
} from "./youtube-metadata";

const TEST_KEY = "sk-ant-api03-test-secret-value-a1b2";
const MODEL = "claude-sonnet-5";
const INPUT = {
  sourceTitle: "How index funds work",
  hookTitle: "Why index funds beat stock picking",
  transcript: "Here is the one habit that doubled my output in a month.",
};
const VALID_OUTPUT = {
  title: "Why index funds beat stock picking",
  description: "A short breakdown of why low-cost index funds outperform most stock pickers.",
  hashtags: ["investing", "indexfunds"],
  tags: ["index funds", "passive investing"],
  language: "en",
};

const write = (fetch: typeof globalThis.fetch) => writeYoutubeMetadata(INPUT, { apiKey: TEST_KEY, model: MODEL, fetch });

afterEach(() => vi.restoreAllMocks());

describe("writeYoutubeMetadata", () => {
  it("sends the clip as data with the metadata model", async () => {
    const fake = fakeFetch(() => messageResponse(VALID_OUTPUT, { model: MODEL }));
    await write(fake.fetch);

    const [request] = fake.requests;
    expect(request.body.model).toBe(MODEL);
    expect(request.body.output_config.format.type).toBe("json_schema");
    const prompt: string = request.body.messages[0].content;
    expect(prompt).toContain(INPUT.transcript);
    expect(() => JSON.parse(prompt.slice(prompt.indexOf("{")))).not.toThrow();
    const system: string = request.body.system;
    expect(system.toLowerCase()).toContain("data");
    expect(system.toLowerCase()).toContain("never");
  });

  it("adds the video summary, topics and why-it-works only when known", async () => {
    const fake = fakeFetch(() => messageResponse(VALID_OUTPUT, { model: MODEL }));
    await write(fake.fetch);
    await writeYoutubeMetadata(
      { ...INPUT, videoSummary: "A talk on investing.", videoTopics: ["index funds"], whyItWorks: "Contrarian claim" },
      { apiKey: TEST_KEY, model: MODEL, fetch: fake.fetch },
    );

    const data = (i: number) => {
      const prompt: string = fake.requests[i].body.messages[0].content;
      return JSON.parse(prompt.slice(prompt.indexOf("{")));
    };
    expect(Object.keys(data(0)).sort()).toEqual(["hook_title", "source_title", "transcript"]);
    expect(data(1)).toMatchObject({ video_summary: "A talk on investing.", video_topics: ["index funds"], why_it_works: "Contrarian claim" });
  });

  it("returns parsed metadata with the model name", async () => {
    const fake = fakeFetch(() => messageResponse(VALID_OUTPUT));
    const result = await write(fake.fetch);
    expect(result).toEqual({
      title: VALID_OUTPUT.title,
      description: VALID_OUTPUT.description,
      hashtags: VALID_OUTPUT.hashtags,
      tags: VALID_OUTPUT.tags,
      language: "en",
      model: MODEL,
    });
  });

  it("repairs once on invalid output then succeeds", async () => {
    const tooLongTitle = "x".repeat(150);
    const fake = fakeFetch((_, index) =>
      messageResponse(index === 0 ? { ...VALID_OUTPUT, title: tooLongTitle } : VALID_OUTPUT),
    );
    const result = await write(fake.fetch);
    expect(result.title).toBe(VALID_OUTPUT.title);
    expect(fake.requests).toHaveLength(2);
    const repairPrompt: string = fake.requests[1].body.messages.at(-1).content;
    expect(repairPrompt).toContain("validation error");
  });

  it("throws after the output retry budget", async () => {
    const tooLongTitle = "x".repeat(150);
    const fake = fakeFetch(() => messageResponse({ ...VALID_OUTPUT, title: tooLongTitle }));
    await expect(write(fake.fetch)).rejects.toThrow("Exceeded maximum output retries");
    expect(fake.requests).toHaveLength(3);
  });
});

describe("parseYoutubeMetadata", () => {
  it("strips angle brackets and enforces the title length", () => {
    // Stripping "<b>" and "</b>" still leaves 157 characters, over the 100 cap: rejected.
    const title = "<b>Hi</b>" + "x".repeat(150);
    expect(() => parseYoutubeMetadata({ ...VALID_OUTPUT, title })).toThrow(OutputValidationError);

    // A title that fits once the tags are stripped is repaired in place, not rejected.
    const repairable = parseYoutubeMetadata({ ...VALID_OUTPUT, title: "<b>Great tip</b>" });
    expect(repairable.title).toBe("bGreat tip/b");
    expect(repairable.title).not.toMatch(/[<>]/);
  });

  it("rejects a description that is within the character budget but over the byte budget", () => {
    // 3000 Devanagari characters is well under 5000 by JS .length, but ~9000 UTF-8 bytes: this
    // only rejects correctly when the byte length (not the character length) is measured.
    const description = "धन".repeat(1500); // 2 chars * 1500 = 3000 chars, 6 bytes each in UTF-8
    expect(description.length).toBe(3000);
    expect(() =>
      parseYoutubeMetadata({ ...VALID_OUTPUT, description, hashtags: ["a", "b", "c", "d", "e"] }),
    ).toThrow(OutputValidationError);
  });

  it("fits a multibyte description and its hashtags into the 5000-byte budget", () => {
    const description = "धन".repeat(300); // 600 chars, ~1800 UTF-8 bytes: comfortably under budget
    const result = parseYoutubeMetadata({ ...VALID_OUTPUT, description, hashtags: ["a", "b", "c", "d", "e"] });
    expect(Buffer.byteLength(youtubeDescription(result), "utf8")).toBeLessThanOrEqual(5000);
  });

  it.each([
    ["a link", "Watch this https://example.com"],
    ["a bare www link", "More at www.example.com"],
    ["a leading hashtag", "#shorts The habit that doubled my output"],
    ["a hashtag after a word", "The habit that doubled my output #productivity"],
    ["a line break", "The habit\nthat doubled my output"],
  ])("rejects a title with %s, for the repair turn", (_name, title) => {
    expect(() => parseYoutubeMetadata({ ...VALID_OUTPUT, title })).toThrow(OutputValidationError);
  });

  it("allows a '#' inside a word, as in C#", () => {
    expect(parseYoutubeMetadata({ ...VALID_OUTPUT, title: "Why C# beats Java for games" }).title).toBe("Why C# beats Java for games");
  });

  it("uploads the description alone when no hashtag survives cleaning", () => {
    const result = parseYoutubeMetadata({ ...VALID_OUTPUT, hashtags: ["bad tag", "#"] });
    expect(result.hashtags).toEqual([]);
    expect(youtubeDescription(result)).toBe(VALID_OUTPUT.description);
  });

  it("drops an invalid language instead of rejecting the metadata", () => {
    const result = parseYoutubeMetadata({ ...VALID_OUTPUT, language: "not a real language tag!" });
    expect(result.language).toBeUndefined();
  });
});

describe("fitTags", () => {
  it("cleans tags that YouTube would reject", () => {
    const input = ["a,b", "<x>", "long tag " + "y".repeat(600), "ok"];
    const result = fitTags(input);
    for (const tag of result) {
      expect(tag).not.toMatch(/[,<>]/);
    }
    const total = result.reduce(
      (sum, tag, index) => sum + tag.length + (tag.includes(" ") ? 2 : 0) + (index > 0 ? 1 : 0),
      0,
    );
    expect(total).toBeLessThanOrEqual(500);
    expect(result).toEqual(["ab", "x"]);
  });

  it("keeps every tag when the total is well under budget", () => {
    expect(fitTags(["index funds", "passive investing", "money"])).toEqual([
      "index funds",
      "passive investing",
      "money",
    ]);
  });
});

describe("youtubeDescription", () => {
  it("puts the full-video link before the hashtags, and drops it rather than pass the byte limit", () => {
    const url = "https://www.youtube.com/watch?v=abcdefghijk";
    expect(youtubeDescription({ description: "Body", hashtags: ["a"] }, url)).toBe(`Body\n\nFull video: ${url}\n\n#a`);
    expect(youtubeDescription({ description: "Body", hashtags: [] }, url)).toBe(`Body\n\nFull video: ${url}`);
    const full = "x".repeat(4990);
    expect(youtubeDescription({ description: full, hashtags: [] }, url)).toBe(full);
  });

  it("joins the description and hashtags with the required separator", () => {
    expect(youtubeDescription({ description: "Body text.", hashtags: ["money", "tips"] })).toBe(
      "Body text.\n\n#money #tips",
    );
  });
});

describe("dedupeHashtags via parseYoutubeMetadata", () => {
  it("dedupes hashtags, keeps Unicode letters, at most 5", () => {
    const result = parseYoutubeMetadata({
      ...VALID_OUTPUT,
      hashtags: ["#Money", "money", "धन", "bad tag", "x", "y", "z"],
    });
    expect(result.hashtags).toEqual(["Money", "धन", "x", "y", "z"]);
  });
});
