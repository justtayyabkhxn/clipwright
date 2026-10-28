import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { TooltipProvider } from "@/components/ui/tooltip";
import TaskPage from "./page";

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn() }));
vi.mock("sonner", () => ({ toast }));
vi.mock("next/navigation", () => ({
  useParams: () => ({ id: "t1" }),
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));
vi.mock("@/lib/auth-client", () => ({
  useSession: () => ({ data: { user: { id: "user-1", email: "ada@example.com" } }, isPending: false }),
}));

const RESTYLE_FAILED = "Restyle failed. Your existing clips are unchanged.";

function clip(id: string, order: number) {
  return {
    id, filename: `${id}.mp4`, start_time: "00:00", end_time: "00:20", duration: 20, text: "Hello there", relevance_score: 0.9,
    reasoning: "", clip_order: order, created_at: "2026-10-26T10:00:00Z", video_url: `/api/tasks/t1/clips/${id}/file`,
    virality_score: 70, hook_score: 18, engagement_score: 17, value_score: 18, shareability_score: 17, hook_type: "question", hook_title: `Hook ${id}`,
  };
}

/** A `GET /api/tasks/[id]/youtube` post (design §4.8), with every field defaulted. */
function post(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "post-1", clip_id: "old", state: "queued", phase: null, progress: null, wait_reason: null,
    title: null, description: null, tags: [] as string[], hashtags: [] as string[], video_url: null,
    privacy_status: null, warning: null, error: null, not_before: null, insert_cap_reached: false,
    ...overrides,
  };
}

let task: Record<string, unknown>;
let clips: ReturnType<typeof clip>[];
let youtubePosts: ReturnType<typeof post>[];
let youtubeRetryCalls: string[];
let settingsBody: Record<string, unknown> | null;
let taskGetFails: boolean;
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  Object.values(toast).forEach((fn) => fn.mockClear());
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  task = {
    id: "t1", user_id: "user-1", source_id: "t1", source_title: "Talk", source_type: "youtube", source_url: "https://youtu.be/abcdefghijk",
    status: "completed", progress: 100, progress_message: "Complete!", clips_count: 1, created_at: "2026-10-26T10:00:00Z", updated_at: "2026-10-26T10:00:00Z",
    font_family: null, font_size: null, font_color: null, caption_template: "default", cut_long_pauses: true, pause_threshold_ms: 1200,
    remove_filler_words: true, filtered_words: [],
  };
  clips = [clip("old", 1)];
  youtubePosts = [];
  youtubeRetryCalls = [];
  settingsBody = null;
  taskGetFails = false;
  fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === "/api/tasks/t1/settings") {
      settingsBody = JSON.parse(String(init?.body));
      task = { ...task, status: "processing", progress: 0, progress_message: "Applying new style..." };
      return Response.json({ task, message: "Restyling", worker_online: false });
    }
    if (url === "/api/tasks/t1/resume") {
      task = { ...task, status: "queued", progress: 0, progress_message: "Re-queued by user" };
      return Response.json({ message: "Task resumed" });
    }
    if (url === "/api/tasks/t1/clips") return Response.json({ task_id: "t1", clips, total_clips: clips.length });
    if (url === "/api/tasks/t1") return taskGetFails ? Response.json({ detail: "down" }, { status: 500 }) : Response.json(task);
    if (url === "/api/tasks/t1/youtube") return Response.json({ posts: youtubePosts });
    const retryMatch = /^\/api\/tasks\/t1\/youtube\/([^/]+)\/retry$/.exec(url);
    if (retryMatch && init?.method === "POST") {
      const id = retryMatch[1];
      youtubeRetryCalls.push(id);
      const updated = post({ ...youtubePosts.find((p) => p.id === id), state: "queued", wait_reason: null, error: null, insert_cap_reached: false });
      youtubePosts = youtubePosts.map((p) => (p.id === id ? updated : p));
      return Response.json({ ...updated, worker_online: true });
    }
    if (url === "/api/fonts") return Response.json({ fonts: [] });
    if (url === "/api/caption-templates") return Response.json({ templates: [] });
    return Response.json({});
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => vi.unstubAllGlobals());

async function startRestyle({ failTaskGets = false } = {}) {
  render(<TaskPage />, { wrapper: TooltipProvider });
  const user = userEvent.setup({ delay: null });
  await user.click(await screen.findByRole("button", { name: "Restyle" }));
  // The page must follow the job from the POST response alone.
  taskGetFails = failTaskGets;
  await user.click(await screen.findByRole("button", { name: "Apply to All Clips" }));
  expect(await screen.findByText("Applying new style...")).toBeInTheDocument();
  // The old clips stay visible while the job runs, and the panel says they will be replaced.
  expect(screen.getByRole("button", { name: "Preview Hook old" })).toBeInTheDocument();
  expect(screen.getByText(/Your current clips stay below/)).toBeInTheDocument();
  // Cancelling a restyle would leave only Resume, which re-runs the pipeline and deletes the clips.
  expect(screen.queryByRole("button", { name: "Cancel" })).not.toBeInTheDocument();
  expect(settingsBody).toMatchObject({ caption_template: "default", apply_to_existing: true });
  expect(toast.warning).toHaveBeenCalledWith(expect.stringContaining("worker isn't running"), expect.anything());
  expect(toast.success).not.toHaveBeenCalled();
}

async function poll() {
  // The page polls every 2 s; coming back online triggers the same refresh immediately.
  await act(async () => { window.dispatchEvent(new Event("online")); });
}

it("follows a restyle job and swaps in the re-rendered clips", async () => {
  await startRestyle({ failTaskGets: true });
  await poll();
  expect(await screen.findByText(/Can.t reach the server right now/)).toBeInTheDocument();

  taskGetFails = false;
  task = { ...task, status: "completed", progress: 100, progress_message: "Complete!" };
  clips = [clip("new", 1)];
  await poll();

  expect(await screen.findByRole("button", { name: "Preview Hook new" })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Preview Hook old" })).not.toBeInTheDocument();
  await waitFor(() => expect(toast.success).toHaveBeenCalledWith("New style applied to every clip"));
  expect(toast.error).not.toHaveBeenCalled();
});

it("reports a failed restyle and keeps the existing clips", async () => {
  await startRestyle();
  task = { ...task, status: "completed", progress: 100, progress_message: RESTYLE_FAILED };
  await poll();

  await waitFor(() => expect(toast.error).toHaveBeenCalledWith(RESTYLE_FAILED));
  expect(screen.getByRole("button", { name: "Preview Hook old" })).toBeInTheDocument();
  expect(toast.success).not.toHaveBeenCalled();
});

it("does not announce a restyle that ended without completing", async () => {
  await startRestyle();
  task = { ...task, status: "cancelled", progress: 0, progress_message: "Cancelled by user" };
  await poll();

  const user = userEvent.setup({ delay: null });
  await user.click(await screen.findByRole("button", { name: "Resume" }));
  await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Generation resumed"));
  task = { ...task, status: "completed", progress: 100, progress_message: "Complete!" };
  await poll();

  expect(await screen.findByRole("button", { name: "Restyle" })).toBeInTheDocument();
  expect(toast.success).not.toHaveBeenCalledWith("New style applied to every clip");
});

it("shows why a generation failed", async () => {
  const reason = "Add your Anthropic API key in Settings → AI before generating clips.";
  task = { ...task, status: "error", progress: 0, progress_message: reason, clips_count: 0 };
  clips = [];
  render(<TaskPage />, { wrapper: TooltipProvider });
  expect(await screen.findByText("Processing Failed")).toBeInTheDocument();
  expect(screen.getByText(reason)).toBeInTheDocument();
});

it("shows a status chip per clip", async () => {
  clips = [
    clip("c-queued", 1), clip("c-writing", 2), clip("c-uploading", 3), clip("c-posted", 4),
    clip("c-private", 5), clip("c-quota", 6), clip("c-failed", 7),
  ];
  youtubePosts = [
    post({ id: "p-queued", clip_id: "c-queued", state: "queued" }),
    post({ id: "p-writing", clip_id: "c-writing", state: "working", phase: "writing" }),
    post({ id: "p-uploading", clip_id: "c-uploading", state: "working", phase: "uploading" }),
    post({ id: "p-posted", clip_id: "c-posted", state: "uploaded", video_url: "https://youtu.be/xyz", title: "T" }),
    post({ id: "p-private", clip_id: "c-private", state: "uploaded", video_url: "https://youtu.be/abc", warning: "private_lock" }),
    post({ id: "p-quota", clip_id: "c-quota", state: "queued", wait_reason: "quota", not_before: "2026-10-28T13:05:00.000Z" }),
    post({ id: "p-failed", clip_id: "c-failed", state: "failed", error: "YouTube rejected the upload." }),
  ];

  render(<TaskPage />, { wrapper: TooltipProvider });

  expect(await screen.findByText("Waiting to post")).toBeInTheDocument();
  expect(screen.getByText("Writing title…")).toBeInTheDocument();
  expect(screen.getByText("Uploading…")).toBeInTheDocument();
  const postedLink = screen.getByRole("link", { name: "Posted" });
  expect(postedLink).toHaveAttribute("target", "_blank");
  expect(postedLink).toHaveAttribute("href", "https://youtu.be/xyz");
  expect(screen.getByText("Private on YouTube")).toBeInTheDocument();
  const expectedTime = new Date("2026-10-28T13:05:00.000Z").toLocaleTimeString("en", { hour: "numeric", minute: "2-digit" });
  expect(screen.getByText(`Waiting for YouTube's daily limit (until ${expectedTime})`)).toBeInTheDocument();
  expect(screen.getByText("Failed")).toBeInTheDocument();
  expect(screen.getByText("YouTube rejected the upload.")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
});

it("shows the blocked chip for a reconnect wait, linking to Settings", async () => {
  clips = [clip("c-blocked", 1)];
  youtubePosts = [post({ id: "p-blocked", clip_id: "c-blocked", state: "blocked", wait_reason: "reconnect" })];
  render(<TaskPage />, { wrapper: TooltipProvider });

  expect(await screen.findByText("Reconnect YouTube to post")).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "Reconnect in Settings" })).toHaveAttribute("href", "/settings#youtube");
});

it("shows the blocked chip for a private lock, with the paused copy and a Settings link", async () => {
  clips = [clip("c-paused", 1)];
  youtubePosts = [post({ id: "p-paused", clip_id: "c-paused", state: "blocked", wait_reason: "private_lock" })];
  render(<TaskPage />, { wrapper: TooltipProvider });

  expect(await screen.findByText("Posting paused")).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "Resume posting in Settings" })).toHaveAttribute("href", "/settings#youtube");
});

it("names an unrecognized warning code in a plain text line, never as raw HTML", async () => {
  clips = [clip("c-warned", 1)];
  youtubePosts = [post({
    id: "p-warned", clip_id: "c-warned", state: "uploaded", video_url: "https://youtu.be/xyz",
    warning: "<b>age_restricted</b>",
  })];
  render(<TaskPage />, { wrapper: TooltipProvider });

  expect(await screen.findByText("YouTube flagged this upload (<b>age_restricted</b>)")).toBeInTheDocument();
  expect(document.querySelector("b")).not.toBeInTheDocument();
});

it("Try again posts to the retry route", async () => {
  clips = [clip("c-failed", 1)];
  youtubePosts = [post({ id: "p-failed", clip_id: "c-failed", state: "failed", error: "YouTube rejected the upload.", insert_cap_reached: true })];
  render(<TaskPage />, { wrapper: TooltipProvider });
  const user = userEvent.setup({ delay: null });

  await user.click(await screen.findByRole("button", { name: "Try again" }));
  expect(await screen.findByText("If this clip is already on your channel, don't retry; it would post twice.")).toBeInTheDocument();
  expect(youtubeRetryCalls).toHaveLength(0);

  await user.click(screen.getAllByRole("button", { name: "Try again" }).at(-1)!);
  await waitFor(() => expect(youtubeRetryCalls).toEqual(["p-failed"]));
  expect(await screen.findByText("Waiting to post")).toBeInTheDocument();
});

it("focus view shows the posted title, description, hashtags and tags", async () => {
  clips = [clip("c-posted", 1)];
  youtubePosts = [post({
    id: "p-posted", clip_id: "c-posted", state: "uploaded", video_url: "https://youtu.be/xyz",
    title: "Big Title", description: "A great clip about things.", tags: ["tag one", "tagtwo"], hashtags: ["shorts", "clip"],
  })];
  render(<TaskPage />, { wrapper: TooltipProvider });
  const user = userEvent.setup({ delay: null });
  await user.click(await screen.findByRole("button", { name: /Preview/ }));

  expect(await screen.findByText("Big Title")).toBeInTheDocument();
  expect(screen.getByText("A great clip about things.")).toBeInTheDocument();
  expect(screen.getByText("#shorts")).toBeInTheDocument();
  expect(screen.getByText("#clip")).toBeInTheDocument();
  expect(screen.getByText(/tag one/)).toBeInTheDocument();
  expect(screen.getByText(/tagtwo/)).toBeInTheDocument();
});

it("polls posts every 4 s while any is queued or working, and stops after", async () => {
  vi.useFakeTimers();
  try {
    clips = [clip("c1", 1)];
    youtubePosts = [post({ id: "p1", clip_id: "c1", state: "queued" })];
    render(<TaskPage />, { wrapper: TooltipProvider });
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(screen.getByText("Waiting to post")).toBeInTheDocument();

    youtubePosts = [post({ id: "p1", clip_id: "c1", state: "working", phase: "uploading" })];
    await act(async () => { await vi.advanceTimersByTimeAsync(4000); });
    expect(screen.getByText("Uploading…")).toBeInTheDocument();

    youtubePosts = [post({ id: "p1", clip_id: "c1", state: "uploaded", video_url: "https://youtu.be/xyz" })];
    await act(async () => { await vi.advanceTimersByTimeAsync(4000); });
    expect(screen.getByRole("link", { name: "Posted" })).toBeInTheDocument();

    const postCalls = () => fetchMock.mock.calls.filter((args) => args[0] === "/api/tasks/t1/youtube").length;
    const callsBefore = postCalls();
    await act(async () => { await vi.advanceTimersByTimeAsync(8000); });
    expect(postCalls()).toBe(callsBefore);
  } finally {
    vi.useRealTimers();
  }
});
