import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

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

beforeEach(() => {
  push.mockClear();
  warning.mockClear();
  vi.stubEnv("NEXT_PUBLIC_MAX_VIDEO_UPLOAD_BYTES", "2000000000");
  fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/api/tasks/create")) return Response.json({ task_id: "task-1", job_id: "job-1", message: "queued", worker_online: false });
    if (url.includes("/api/tasks")) return Response.json({ tasks: [] });
    if (url.includes("/api/fonts")) return Response.json({ fonts: [] });
    if (url.includes("caption-templates")) return Response.json({ templates: [] });
    if (url.includes("/api/preferences")) return Response.json({ clipLength: "auto" });
    return Response.json({});
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

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
  const user = userEvent.setup({ delay: null });

  await user.click(await screen.findByLabelText("YouTube URL"));
  await user.paste("https://www.youtube.com/watch?v=abcdefghijk");
  await user.click(screen.getByRole("button", { name: "Generate clips" }));

  await waitFor(() => expect(push).toHaveBeenCalledWith("/tasks/task-1"));
  expect(warning).toHaveBeenCalledWith(WORKER_OFFLINE_MESSAGE, expect.anything());
  const [, init] = fetchMock.mock.calls.find(([url]) => String(url).includes("/api/tasks/create"))!;
  const body = JSON.parse(String((init as RequestInit).body));
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
