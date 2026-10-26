import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { WORKER_OFFLINE_NOTICE } from "@/components/app/app-shell";
import { TooltipProvider } from "@/components/ui/tooltip";
import { WORKER_OFFLINE_MESSAGE } from "@/lib/worker-notice";
import HomeApp from "./home-app";

const push = vi.fn();
const warning = vi.fn();

vi.mock("next/navigation", () => ({
  usePathname: () => "/",
  useRouter: () => ({ push, refresh: vi.fn() }),
}));

vi.mock("sonner", () => ({ toast: { warning: (...args: unknown[]) => warning(...args), error: vi.fn(), success: vi.fn() } }));

vi.mock("@/lib/auth-client", () => ({
  useSession: () => ({
    data: { user: { id: "user-1", name: "Ada", email: "ada@example.com" } },
    isPending: false,
  }),
  signOut: vi.fn(),
}));

let fetchMock: ReturnType<typeof vi.fn>;
let preferences: Record<string, unknown>;
let health: () => Response;

beforeEach(() => {
  push.mockClear();
  warning.mockClear();
  sessionStorage.clear();
  vi.stubEnv("NEXT_PUBLIC_MAX_VIDEO_UPLOAD_BYTES", "2000000000");
  preferences = { fontFamily: null, fontSize: null, fontColor: null, clipLength: "auto", saved: false };
  health = () => Response.json({ ok: true, db: true, worker: { online: true, heartbeatAt: "2026-10-26T12:00:00.000Z" } });
  fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/api/tasks/create")) return Response.json({ task_id: "task-1", job_id: "job-1", message: "queued", worker_online: false });
    if (url.includes("/api/tasks")) return Response.json({ tasks: [] });
    if (url.includes("/api/fonts")) return Response.json({ fonts: [] });
    if (url.includes("caption-templates")) return Response.json({ templates: [] });
    if (url.includes("/api/preferences")) return Response.json(preferences);
    if (url.includes("/api/health")) return health();
    return Response.json({});
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

async function submitYouTube() {
  const user = userEvent.setup({ delay: null });
  await user.click(await screen.findByLabelText("YouTube URL"));
  await user.paste("https://www.youtube.com/watch?v=abcdefghijk");
  const generate = screen.getByRole("button", { name: "Generate clips" });
  await waitFor(() => expect(generate).toBeEnabled());
  await user.click(generate);
  await waitFor(() => expect(push).toHaveBeenCalledWith("/tasks/task-1"));
  const [, init] = fetchMock.mock.calls.find(([url]) => String(url).includes("/api/tasks/create"))!;
  return JSON.parse(String((init as RequestInit).body));
}

function videoFile(name: string, size: number) {
  const file = new File(["video"], name, { type: "video/mp4" });
  Object.defineProperty(file, "size", { value: size });
  return file;
}

it("states the upload limit and rejects a file over it before upload", async () => {
  render(<HomeApp />, { wrapper: TooltipProvider });

  expect(await screen.findByText(/Uploads up to 2 GB/)).toBeInTheDocument();
  expect(screen.getByText(/above 1080p or 60 fps are scaled down automatically/)).toBeInTheDocument();

  const input = document.getElementById("video-upload") as HTMLInputElement;
  fireEvent.change(input, { target: { files: [videoFile("talk.mp4", 2_000_000_001)] } });

  expect(await screen.findByText(/This file is 2.0 GB, which is over the 2 GB upload limit/)).toBeInTheDocument();
  expect(screen.queryByText(/ready to upload/)).not.toBeInTheDocument();

  fireEvent.change(input, { target: { files: [videoFile("talk.mp4", 2_000_000_000)] } });

  await waitFor(() => expect(screen.getByText(/ready to upload/)).toBeInTheDocument());
  expect(screen.queryByText(/over the 2 GB upload limit/)).not.toBeInTheDocument();
});

it("only accepts YouTube links", async () => {
  render(<HomeApp />, { wrapper: TooltipProvider });
  const user = userEvent.setup({ delay: null });

  await user.click(await screen.findByLabelText("YouTube URL"));
  await user.paste("https://www.twitch.tv/videos/12345");
  await user.click(screen.getByRole("button", { name: "Generate clips" }));

  expect(await screen.findByText("Only YouTube links are supported. Upload the file instead.")).toBeInTheDocument();
  expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/api/tasks/create"))).toBe(false);
});

it("creates the task, opens it and warns when the worker is offline", async () => {
  render(<HomeApp />, { wrapper: TooltipProvider });
  const body = await submitYouTube();
  expect(warning).toHaveBeenCalledWith(WORKER_OFFLINE_MESSAGE, expect.anything());
  expect(body).toMatchObject({
    source: { url: "https://www.youtube.com/watch?v=abcdefghijk", title: null },
    font_options: { font_family: null, font_size: null, font_color: null },
    caption_template: "default",
    output_format: "vertical",
    clip_length: "auto",
    add_subtitles: true,
    cut_long_pauses: true,
    pause_threshold_ms: 1200,
    remove_filler_words: true,
    filtered_words: [],
  });
  expect(body).not.toHaveProperty("include_broll");
  expect(body).not.toHaveProperty("processing_mode");
});

it("starts from the caption defaults saved in Settings", async () => {
  preferences = { fontFamily: "Inter-Bold", fontSize: 32, fontColor: "#FFD700", clipLength: "short", saved: true };
  render(<HomeApp />, { wrapper: TooltipProvider });
  const body = await submitYouTube();
  expect(body.font_options).toEqual({ font_family: "Inter-Bold", font_size: 32, font_color: "#FFD700" });
  expect(body.clip_length).toBe("short");
});

it("keeps the template default for a saved field that is null", async () => {
  preferences = { fontFamily: null, fontSize: 32, fontColor: null, clipLength: "auto", saved: true };
  render(<HomeApp />, { wrapper: TooltipProvider });
  const body = await submitYouTube();
  expect(body.font_options).toEqual({ font_family: null, font_size: 32, font_color: null });
});

it("keeps the template defaults for a user who only ever saved a clip length", async () => {
  // What GET /api/preferences returns once PATCH {clipLength} created user.preferences.
  preferences = { fontFamily: null, fontSize: null, fontColor: null, clipLength: "short", saved: true };
  render(<HomeApp />, { wrapper: TooltipProvider });
  const body = await submitYouTube();
  expect(body.font_options).toEqual({ font_family: null, font_size: null, font_color: null });
  expect(body.clip_length).toBe("short");
});

it("applies caption defaults saved with the Settings page's initial values", async () => {
  preferences = { fontFamily: "TikTokSans-Regular", fontSize: 24, fontColor: "#FFFFFF", clipLength: "auto", saved: true };
  render(<HomeApp />, { wrapper: TooltipProvider });
  const body = await submitYouTube();
  expect(body.font_options).toEqual({ font_family: "TikTokSans-Regular", font_size: 24, font_color: "#FFFFFF" });
});

it("says the worker is offline and lets the user dismiss it", async () => {
  // The route's real offline answer: 503 while no worker heartbeat is fresh.
  health = () => Response.json({ ok: false, db: true, worker: { online: false, heartbeatAt: null } }, { status: 503 });
  render(<HomeApp />, { wrapper: TooltipProvider });
  const user = userEvent.setup({ delay: null });

  expect(await screen.findByText(WORKER_OFFLINE_NOTICE)).toBeInTheDocument();
  expect(fetchMock.mock.calls.filter(([url]) => String(url).includes("/api/health"))).toHaveLength(1);
  await user.click(screen.getByRole("button", { name: "Close" }));
  expect(screen.queryByText(WORKER_OFFLINE_NOTICE)).not.toBeInTheDocument();
  expect(sessionStorage.getItem("clipwright.worker-notice.dismissed")).toBe("1");
});

it("shows no worker notice while the worker is online", async () => {
  render(<HomeApp />, { wrapper: TooltipProvider });
  await screen.findByLabelText("YouTube URL");
  await waitFor(() => expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/api/health"))).toBe(true));
  expect(screen.queryByText(WORKER_OFFLINE_NOTICE)).not.toBeInTheDocument();
});
