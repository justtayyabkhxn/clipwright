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

let task: Record<string, unknown>;
let clips: ReturnType<typeof clip>[];
let settingsBody: Record<string, unknown> | null;
let taskGetFails: boolean;

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
  settingsBody = null;
  taskGetFails = false;
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
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
    if (url === "/api/fonts") return Response.json({ fonts: [] });
    if (url === "/api/caption-templates") return Response.json({ templates: [] });
    return Response.json({});
  }));
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
