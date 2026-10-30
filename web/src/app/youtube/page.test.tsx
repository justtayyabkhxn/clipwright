import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import YoutubePage from "./page";

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn() }));
vi.mock("sonner", () => ({ toast }));
const auth = vi.hoisted(() => ({ session: { data: { user: { id: "user-1" } } as unknown, isPending: false } }));
vi.mock("@/lib/auth-client", () => ({ useSession: () => auth.session }));

/** A `GET /api/youtube/posts` item, with every field defaulted. */
function post(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "p1", clip_id: "c1", state: "queued", phase: null, progress: null, wait_reason: null,
    title: null, description: null, tags: [] as string[], hashtags: [] as string[], video_url: null,
    privacy_status: null, upload_status: null, warning: null, error: null, not_before: null, insert_cap_reached: false,
    task_id: "t1", task_title: "Talk", clip_title: "Hook one", created_at: "2026-10-29T10:00:00.000Z", uploaded_at: null,
    ...overrides,
  };
}

const CONNECTED = {
  configured: true, connected: true, channel: { id: "UC1", title: "My Channel", handle: "@mine", thumbnail_url: null },
  status: "active", warning: null, auto_post: true, privacy: "public", made_for_kids: false,
};

/** The page's own format: the user's locale and time zone. */
const when = (iso: string) => new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

let account: Record<string, unknown>;
let posts: ReturnType<typeof post>[];
let truncated: boolean;
let retryCalls: string[];
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  Object.values(toast).forEach((fn) => fn.mockClear());
  auth.session = { data: { user: { id: "user-1" } }, isPending: false };
  account = CONNECTED;
  posts = [];
  truncated = false;
  retryCalls = [];
  fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === "/api/youtube/account") return Response.json(account);
    if (url === "/api/youtube/posts") return Response.json({ posts, truncated });
    const retry = /^\/api\/tasks\/([^/]+)\/youtube\/([^/]+)\/retry$/.exec(url);
    if (retry && init?.method === "POST") {
      retryCalls.push(`${retry[1]}/${retry[2]}`);
      // The retry route answers with the task route's shape: no overview fields.
      const updated: Record<string, unknown> = {
        ...posts.find((p) => p.id === retry[2]), state: "queued", error: null, insert_cap_reached: false, worker_online: false,
      };
      for (const key of ["task_id", "task_title", "clip_title", "created_at", "uploaded_at"]) delete updated[key];
      return Response.json(updated);
    }
    return Response.json({});
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => vi.unstubAllGlobals());

const postFetches = () => fetchMock.mock.calls.filter(([url]) => url === "/api/youtube/posts").length;

it("shows the channel, the counts, and the posts grouped by task, newest group first", async () => {
  posts = [
    post({ id: "p-new", task_id: "t2", task_title: "Podcast", state: "uploaded", video_url: "https://youtu.be/v1", title: "Claude's title", uploaded_at: "2026-10-29T11:00:00.000Z" }),
    post({ id: "p-working", state: "working", phase: "uploading", clip_title: "Hook two" }),
    post({ id: "p-queued", clip_title: null }),
    post({ id: "p-failed", state: "failed", error: "YouTube rejected the upload.", clip_title: "Hook three" }),
    post({ id: "p-cancelled", state: "cancelled", error: "Auto-post was turned off.", clip_title: "Hook four" }),
  ];
  render(<YoutubePage />);

  expect(await screen.findByRole("heading", { level: 1, name: "YouTube" })).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "Open My Channel on YouTube" })).toHaveAttribute("href", "https://www.youtube.com/channel/UC1");
  expect(screen.getByText("@mine")).toBeInTheDocument();
  expect(screen.getByText("Connected")).toBeInTheDocument();
  expect(screen.getByText("Auto-post on")).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "Settings" })).toHaveAttribute("href", "/settings#youtube");

  const counts = within(screen.getByRole("list", { name: "Summary" })).getAllByRole("listitem").map((item) => item.textContent);
  expect(counts).toEqual(["1Posted", "1Waiting", "1Uploading", "1Failed", "1Not posted"]);

  // One heading per generation, after the insights section's own.
  const [insights, ...groups] = screen.getAllByRole("heading", { level: 2 });
  expect(insights).toHaveTextContent("What performs");
  expect(groups.map((heading) => heading.textContent)).toEqual(["Podcast", "Talk"]);
  expect(within(groups[0]).getByRole("link")).toHaveAttribute("href", "/tasks/t2");
  expect(within(groups[1]).getByRole("link")).toHaveAttribute("href", "/tasks/t1");

  expect(screen.getByText("Claude's title")).toBeInTheDocument();
  expect(screen.getByText(`Uploaded ${when("2026-10-29T11:00:00.000Z")}`)).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "Posted" })).toHaveAttribute("href", "https://youtu.be/v1");
  expect(screen.getByText("Hook two")).toBeInTheDocument();
  expect(screen.getByText("Uploading…")).toBeInTheDocument();
  expect(screen.getByText("Clip")).toBeInTheDocument();
  expect(screen.getByText("Waiting to post")).toBeInTheDocument();
  expect(screen.getByText("YouTube rejected the upload.")).toBeInTheDocument();
  expect(screen.getByText("Auto-post was turned off.")).toBeInTheDocument();
  expect(screen.getAllByRole("listitem").filter((item) => item.closest("section"))).toHaveLength(5);
  expect(screen.queryByText("Showing the latest 200 posts")).not.toBeInTheDocument();
});

it("says so when the list is truncated, and shows the private-lock warning", async () => {
  account = { ...CONNECTED, status: "paused", warning: "private_lock", auto_post: false };
  posts = [post({ state: "uploaded", video_url: "https://youtu.be/v1" })];
  truncated = true;
  render(<YoutubePage />);

  expect(await screen.findByText("Showing the latest 200 posts")).toBeInTheDocument();
  expect(screen.getByText(/YouTube made your uploads private/)).toBeInTheDocument();
  expect(screen.getByText("Posting paused")).toBeInTheDocument();
  expect(screen.getByText("Auto-post off")).toBeInTheDocument();
});

it("with no channel connected, shows a Settings link and still lists what was posted", async () => {
  account = { ...CONNECTED, connected: false, channel: null, status: null, auto_post: false };
  posts = [
    post({ id: "p-up", state: "uploaded", video_url: "https://youtu.be/v1" }),
    post({ id: "p-off", state: "cancelled", error: "YouTube account was disconnected.", clip_title: "Hook two" }),
  ];
  render(<YoutubePage />);

  expect(await screen.findByText("No channel connected")).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "Open Settings" })).toHaveAttribute("href", "/settings#youtube");
  const counts = within(screen.getByRole("list", { name: "Summary" })).getAllByRole("listitem").map((item) => item.textContent);
  expect(counts).toEqual(["1Posted", "0Waiting", "0Uploading", "0Failed", "1Not posted"]);
  expect(screen.getByRole("link", { name: "Posted" })).toHaveAttribute("href", "https://youtu.be/v1");
  expect(screen.getByText("YouTube account was disconnected.")).toBeInTheDocument();
  expect(screen.queryByText("Nothing posted yet")).not.toBeInTheDocument();
});

it("asks a signed-out visitor to sign in, without calling the API", async () => {
  auth.session = { data: null, isPending: false };
  render(<YoutubePage />);

  expect(await screen.findByRole("link", { name: "Sign in" })).toHaveAttribute("href", "/sign-in");
  expect(fetchMock).not.toHaveBeenCalled();
});

it("explains when YouTube is not configured on the server", async () => {
  account = { ...CONNECTED, configured: false, connected: false, channel: null, status: null };
  render(<YoutubePage />);

  expect(await screen.findByText("YouTube isn't set up")).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "Open Settings" })).toHaveAttribute("href", "/settings#youtube");
});

it("shows an empty state when nothing has been posted", async () => {
  render(<YoutubePage />);
  expect(await screen.findByText("Nothing posted yet")).toBeInTheDocument();
});

it("shows the next scheduled try for a queued post that waits, and none once it is due", async () => {
  const later = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
  posts = [
    post({ id: "p-limit", wait_reason: "channel_limit", not_before: later, clip_title: "Held" }),
    post({ id: "p-due", wait_reason: "retry", not_before: "2020-01-01T00:00:00.000Z", clip_title: "Due" }),
    // The quota chip already says until when.
    post({ id: "p-quota", wait_reason: "quota", not_before: later, clip_title: "Quota" }),
  ];
  render(<YoutubePage />);

  expect(await screen.findByText("Waiting for YouTube's channel upload limit")).toBeInTheDocument();
  expect(screen.getByText(/^Waiting for YouTube's daily limit \(until /)).toBeInTheDocument();
  expect(screen.getByText(`Next try ${when(later)}`)).toBeInTheDocument();
  expect(screen.getAllByText(/^Next try/)).toHaveLength(1);
});

it("Try again asks first after the upload cap, then posts to the task's retry route", async () => {
  posts = [post({ id: "p-failed", task_id: "t9", state: "failed", error: "YouTube rejected the upload.", insert_cap_reached: true })];
  render(<YoutubePage />);
  const user = userEvent.setup({ delay: null });

  await user.click(await screen.findByRole("button", { name: "Try again" }));
  expect(await screen.findByText("If this clip is already on your channel, don't retry; it would post twice.")).toBeInTheDocument();
  expect(retryCalls).toHaveLength(0);

  await user.click(screen.getAllByRole("button", { name: "Try again" }).at(-1)!);
  await waitFor(() => expect(retryCalls).toEqual(["t9/p-failed"]));
  expect(await screen.findByText("Waiting to post")).toBeInTheDocument();
  // The row keeps its task group and title: the retry answer has no overview fields.
  expect(screen.getByRole("heading", { level: 2, name: "Talk" })).toBeInTheDocument();
  expect(screen.getByText("Hook one")).toBeInTheDocument();
  expect(toast.warning).toHaveBeenCalledWith(expect.stringContaining("worker isn't running"), expect.anything());
});

it("names the Try again button while it retries", async () => {
  posts = [post({ state: "failed", error: "Nope" })];
  fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === "/api/youtube/account") return Response.json(account);
    if (url === "/api/youtube/posts") return Response.json({ posts, truncated });
    return new Promise<Response>(() => {});
  });
  render(<YoutubePage />);
  const user = userEvent.setup({ delay: null });

  await user.click(await screen.findByRole("button", { name: "Try again" }));
  expect(await screen.findByRole("button", { name: "Retrying…" })).toBeDisabled();
});

it("polls every 4 s while a post is working or due, every 30 s while one waits or auto-post is on, and stops after", async () => {
  vi.useFakeTimers();
  const advance = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
  try {
    posts = [post({ state: "working", phase: "writing" })];
    const { unmount } = render(<YoutubePage />);
    await advance(0);
    expect(screen.getByText("Writing title…")).toBeInTheDocument();

    // Queued and due (a Try again, the next clip of a batch): the worker claims it within seconds.
    posts = [post({ state: "queued" })];
    await advance(4000);
    expect(screen.getByText("Waiting to post")).toBeInTheDocument();
    posts = [post({ state: "queued", wait_reason: "channel_limit", not_before: new Date(Date.now() + 3_600_000).toISOString() })];
    let calls = postFetches();
    await advance(4000);
    expect(postFetches()).toBe(calls + 1);
    expect(screen.getByText("Waiting for YouTube's channel upload limit")).toBeInTheDocument();

    // Only a post with a wait: 30 s.
    calls = postFetches();
    await advance(29_000);
    expect(postFetches()).toBe(calls);
    posts = [post({ state: "uploaded", video_url: "https://youtu.be/v1" })];
    await advance(1000);
    expect(postFetches()).toBe(calls + 1);
    expect(screen.getByRole("link", { name: "Posted" })).toBeInTheDocument();

    // Nothing moving, but auto-post is on: a finishing generation adds posts, so 30 s.
    calls = postFetches();
    await advance(30_000);
    expect(postFetches()).toBe(calls + 1);

    // Auto-post off: polling stops once the page sees it.
    account = { ...CONNECTED, auto_post: false };
    await advance(30_000);
    calls = postFetches();
    await advance(120_000);
    expect(postFetches()).toBe(calls);

    // A page left while a post is working stops polling.
    unmount();
    posts = [post({ state: "working", phase: "uploading" })];
    const working = render(<YoutubePage />);
    await act(async () => { await vi.advanceTimersByTimeAsync(4000); });
    const before = postFetches();
    working.unmount();
    await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
    expect(postFetches()).toBe(before);
  } finally {
    vi.useRealTimers();
  }
});

it("holds channel-limited clips with Post and Post all disabled until the 12 hours are over", async () => {
  const later = new Date(Date.now() + 6 * 3_600_000).toISOString();
  const earlier = new Date(Date.now() - 60_000).toISOString();
  posts = [
    post({ id: "h1", state: "blocked", wait_reason: "channel_limit", not_before: later }),
    post({ id: "h2", state: "blocked", wait_reason: "channel_limit", not_before: later, clip_title: "Hook two" }),
  ];
  const { unmount } = render(<YoutubePage />);

  expect(await screen.findByRole("button", { name: "Post all (2)" })).toBeDisabled();
  expect(screen.getByText(`2 clips are on hold. You can post them from ${when(later)}.`)).toBeInTheDocument();
  for (const button of screen.getAllByRole("button", { name: "Post" })) expect(button).toBeDisabled();
  unmount();

  // The hold is over: both buttons work.
  posts = posts.map((p) => post({ ...p, not_before: earlier }));
  render(<YoutubePage />);
  await userEvent.click(await screen.findByRole("button", { name: "Post all (2)" }));
  await waitFor(() => expect(fetchMock.mock.calls.some(([url, init]) => url === "/api/youtube/posts/release" && init?.method === "POST")).toBe(true));
  await userEvent.click(screen.getAllByRole("button", { name: "Post" })[0]);
  await waitFor(() => expect(retryCalls).toEqual(["t1/h1"]));
});
