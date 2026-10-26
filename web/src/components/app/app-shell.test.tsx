import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { TooltipProvider } from "@/components/ui/tooltip";
import { AppShell, WORKER_OFFLINE_NOTICE } from "./app-shell";

let pathname = "/settings";

vi.mock("next/navigation", () => ({
  usePathname: () => pathname,
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

vi.mock("@/lib/auth-client", () => ({
  useSession: () => ({ data: { user: { id: "user-1", name: "Ada", email: "ada@example.com" } }, isPending: false }),
  signOut: vi.fn(),
}));

let fetchMock: ReturnType<typeof vi.fn>;
// GET /api/health's real offline answer: 503 with the worker down.
let health: () => Response;

beforeEach(() => {
  sessionStorage.clear();
  health = () => Response.json({ ok: false, db: true, worker: { online: false, heartbeatAt: null } }, { status: 503 });
  fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/api/health")) return health();
    if (url.includes("/api/tasks")) return Response.json({ tasks: [] });
    return Response.json({});
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => vi.unstubAllGlobals());

it("shows the worker-offline notice by the provider indicator", async () => {
  pathname = "/settings";
  render(<AppShell><p>page</p></AppShell>, { wrapper: TooltipProvider });
  expect(await screen.findByText(WORKER_OFFLINE_NOTICE)).toBeInTheDocument();
});

it("stays quiet when the database, not the worker, is what is down", async () => {
  pathname = "/settings";
  health = () => Response.json({ ok: false, db: false, worker: { online: false, heartbeatAt: null } }, { status: 503 });
  render(<AppShell><p>page</p></AppShell>, { wrapper: TooltipProvider });
  await waitFor(() => expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/api/health"))).toBe(true));
  await screen.findByText("page");
  expect(screen.queryByText(WORKER_OFFLINE_NOTICE)).not.toBeInTheDocument();
});

it("leaves the notice to the home page's own content on /", async () => {
  pathname = "/";
  render(<AppShell><p>page</p></AppShell>, { wrapper: TooltipProvider });
  await screen.findByText("page");
  await waitFor(() => expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/api/tasks"))).toBe(true));
  expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/api/health"))).toBe(false);
});
