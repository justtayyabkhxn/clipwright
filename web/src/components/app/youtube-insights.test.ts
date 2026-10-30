import { describe, expect, it } from "vitest";
import { insightRows, type InsightPost } from "./youtube-insights";

const post = (views: number, overrides: Partial<InsightPost> = {}): InsightPost => ({
  state: "uploaded",
  upload_status: "processed",
  uploaded_at: null,
  stats: { views },
  hook_type: "question",
  duration: 25,
  virality_score: 80,
  caption_template: "hormozi",
  ...overrides,
});

describe("insightRows", () => {
  it("averages views per group, best first, hiding groups under 3 videos and unmeasured or deleted posts", () => {
    const rows = insightRows([
      post(100), post(200), post(300),
      post(1000, { hook_type: "story" }), post(2000, { hook_type: "story" }), post(3000, { hook_type: "story" }),
      post(9, { hook_type: "contrast" }), post(9, { hook_type: "contrast" }),
      post(99999, { hook_type: "story", upload_status: "deleted" }),
      { ...post(0, { hook_type: "story" }), stats: null },
      post(5, { hook_type: "story", state: "failed" }),
    ]);

    const byKey = Object.fromEntries(rows.map(({ dimension, rows }) => [dimension.key, rows]));
    expect(byKey.hookType).toEqual([
      { group: "story", videos: 3, avgViews: 2000 },
      { group: "question", videos: 3, avgViews: 200 },
    ]);
    expect(byKey.length).toEqual([{ group: "under30", videos: 8, avgViews: (600 + 6000 + 18) / 8 }]);
    // No upload times: the dimension is left out rather than shown empty.
    expect(byKey.timeOfDay).toBeUndefined();
  });
});
