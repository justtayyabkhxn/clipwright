import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { vi } from "vitest";

import { YoutubeSettings } from "./youtube-settings";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const searchParams = new URLSearchParams();
vi.mock("next/navigation", () => ({ useSearchParams: () => searchParams }));

function json(body: unknown, status = 200) {
  return Promise.resolve(new Response(JSON.stringify(body), { status }));
}

const notConfigured = { configured: false, connected: false, channel: null, status: null, warning: null, auto_post: false, privacy: "public", made_for_kids: false, setup_hint: "Set GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET to enable YouTube auto-post." };
const disconnected = { configured: true, connected: false, channel: null, status: null, warning: null, auto_post: false, privacy: "public", made_for_kids: false };
const connectedAccount = (overrides: Record<string, unknown> = {}) => ({
  configured: true,
  connected: true,
  channel: { id: "chan1", title: "Ada's Channel", handle: "@ada", thumbnail_url: null },
  status: "active",
  warning: null,
  auto_post: true,
  privacy: "public",
  made_for_kids: false,
  ...overrides,
});

function mockFetch({ account = disconnected, connectResponse, resumeResponse }: {
  account?: Record<string, unknown>; connectResponse?: unknown; resumeResponse?: unknown;
} = {}) {
  const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>((url, init) => {
    if (url === "/api/youtube/account" && (!init || init.method === undefined)) return json(account);
    if (url === "/api/youtube/connect" && init?.method === "POST") return json(connectResponse ?? { authorize_url: "https://accounts.google.com/o/oauth2/v2/auth?client_id=test" });
    if (url === "/api/youtube/account/resume" && init?.method === "POST") return json(resumeResponse ?? { ...account, status: "active", warning: null, worker_online: true });
    if (url === "/api/youtube/account" && init?.method === "PATCH") return json({ ...account, ...JSON.parse(String(init.body)) });
    if (url === "/api/youtube/account" && init?.method === "DELETE") return json({ message: "YouTube account disconnected" });
    return json({}, 404);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

beforeEach(() => {
  for (const key of [...searchParams.keys()]) searchParams.delete(key);
});
afterEach(() => vi.unstubAllGlobals());

it("shows the setup hint when not configured", async () => {
  mockFetch({ account: notConfigured });
  render(<YoutubeSettings />);

  expect(await screen.findByText(/GOOGLE_OAUTH_CLIENT_ID/)).toBeInTheDocument();
  expect(screen.getByText(/GOOGLE_OAUTH_CLIENT_SECRET/)).toBeInTheDocument();
  expect(screen.getByText("docs/youtube.md")).toBeInTheDocument();
  expect(screen.queryByRole("link", { name: /setup guide/i })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /connect/i })).not.toBeInTheDocument();
});

it("posts to /api/youtube/connect and navigates to the authorize URL", async () => {
  const fetchMock = mockFetch({ account: disconnected });
  const originalLocation = window.location;
  Object.defineProperty(window, "location", { value: { ...originalLocation, href: "" }, writable: true });
  try {
    render(<YoutubeSettings />);
    const user = userEvent.setup({ delay: null });
    await user.click(await screen.findByRole("button", { name: "Connect YouTube" }));

    await waitFor(() => expect(window.location.href).toBe("https://accounts.google.com/o/oauth2/v2/auth?client_id=test"));
    expect(fetchMock.mock.calls.some(([url, init]) => url === "/api/youtube/connect" && init?.method === "POST")).toBe(true);
  } finally {
    Object.defineProperty(window, "location", { value: originalLocation, writable: true });
  }
});

it("connected view shows the channel, the auto-post switch, visibility and made-for-kids selects", async () => {
  mockFetch({ account: connectedAccount() });
  render(<YoutubeSettings />);

  expect(await screen.findByText("Ada's Channel")).toBeInTheDocument();
  expect(screen.getByText("@ada")).toBeInTheDocument();
  expect(screen.getByRole("switch", { name: "Publish every new clip to this channel as soon as it's ready" })).toBeChecked();
  expect(screen.getByText("Public")).toBeInTheDocument();
  expect(screen.getByText("No")).toBeInTheDocument();
});

it("shows the reconnect prompt and the private-lock warning with Resume posting", async () => {
  const fetchMock = mockFetch({ account: connectedAccount({ status: "reauth_required", warning: "private_lock" }) });
  render(<YoutubeSettings />);

  expect(await screen.findByRole("button", { name: "Reconnect" })).toBeInTheDocument();
  expect(screen.getByText(/renewed/i)).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Resume posting" })).toBeInTheDocument();
  expect(screen.getByText(/audit/i)).toBeInTheDocument();

  const user = userEvent.setup({ delay: null });
  await user.click(screen.getByRole("button", { name: "Resume posting" }));
  await waitFor(() => expect(fetchMock.mock.calls.some(([url, init]) => url === "/api/youtube/account/resume" && init?.method === "POST")).toBe(true));
});

it.each([
  ["denied", /declined/i],
  ["expired", /connection link expired/i],
  ["missing_scope", /both permissions are required/i],
  ["no_channel", /has no YouTube channel/i],
  ["exchange_failed", /connecting to youtube failed/i],
  ["not_configured", /not configured on this server/i],
])("maps youtube_error=%s to its own copy", async (code, expected) => {
  searchParams.set("youtube_error", code);
  mockFetch({ account: disconnected });
  render(<YoutubeSettings />);

  expect(await screen.findByText(expected)).toBeInTheDocument();
});

it("falls back to a generic message for an unrecognized youtube_error and never echoes it", async () => {
  searchParams.set("youtube_error", "some_unexpected_code");
  mockFetch({ account: disconnected });
  render(<YoutubeSettings />);

  expect(await screen.findByText(/went wrong/i)).toBeInTheDocument();
  expect(document.body.textContent).not.toContain("some_unexpected_code");
});

it("asks for confirmation before disconnecting", async () => {
  const fetchMock = mockFetch({ account: connectedAccount() });
  render(<YoutubeSettings />);
  const user = userEvent.setup({ delay: null });

  await user.click(await screen.findByRole("button", { name: "Disconnect" }));
  expect(screen.getByText(/disconnect this channel/i)).toBeInTheDocument();
  expect(fetchMock.mock.calls.some(([, init]) => init?.method === "DELETE")).toBe(false);

  await user.click(screen.getAllByRole("button", { name: "Disconnect" }).at(-1)!);
  await waitFor(() => expect(fetchMock.mock.calls.some(([url, init]) => url === "/api/youtube/account" && init?.method === "DELETE")).toBe(true));
});
