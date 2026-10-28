import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { vi } from "vitest";

import SettingsPage from "./page";

vi.mock("next/navigation", () => ({
  usePathname: () => "/settings",
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("@/lib/auth-client", () => ({
  useSession: () => ({
    data: { user: { id: "user-1", name: "Ada", email: "ada@example.com", is_admin: false } },
    isPending: false,
  }),
  authClient: { deleteUser: vi.fn(), signOut: vi.fn() },
}));

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const preferences = { fontFamily: "TikTokSans-Regular", fontSize: 24, fontColor: "#FFFFFF", clipLength: "auto" };

function mockFetches() {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/api/preferences")) return Response.json(init?.method === "PATCH" ? { ...preferences, ...JSON.parse(String(init.body)) } : preferences);
    if (url.includes("/api/fonts")) return Response.json({ fonts: [] });
    if (url.includes("/api/ai/provider")) return Response.json({ provider: "anthropic", model: "claude-opus-5", configured: true, llm_configured: true, transcription_configured: true });
    return Response.json({});
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("settings page", () => {
  beforeEach(() => {
    vi.stubGlobal("ResizeObserver", class {
      observe() {}
      unobserve() {}
      disconnect() {}
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("shows only the AI, caption defaults and account sections", async () => {
    mockFetches();
    render(<SettingsPage />);

    expect(await screen.findByRole("heading", { name: "AI and transcription" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Caption defaults" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Danger zone" })).toBeInTheDocument();
    expect(screen.queryByText(/Plan & billing|Notifications|Agents & API|Creator program/)).not.toBeInTheDocument();
  });

  it("saves caption defaults without notification settings", async () => {
    const fetchMock = mockFetches();
    render(<SettingsPage />);
    const user = userEvent.setup({ delay: null });

    await user.click(await screen.findByRole("button", { name: "Caption color #FFD700" }));
    await user.click(screen.getByRole("button", { name: "Save Preferences" }));

    await waitFor(() => expect(screen.getByText("Preferences saved successfully!")).toBeInTheDocument());
    const patch = fetchMock.mock.calls.find(([url, init]) => String(url).includes("/api/preferences") && init?.method === "PATCH");
    expect(JSON.parse(String(patch?.[1]?.body))).toEqual({ fontFamily: "TikTokSans-Regular", fontSize: 24, fontColor: "#FFD700" });
  });
});
