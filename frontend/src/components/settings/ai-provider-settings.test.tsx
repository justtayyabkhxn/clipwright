import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { vi } from "vitest";

import { AiProviderSettings } from "./ai-provider-settings";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const KEY = "sk-ant-api03-secret-value-zz99";

const settings = [
  { key: "ANTHROPIC_API_KEY", label: "Anthropic API key", description: "", input_type: "password", source: "admin", configured: true,
    value_hint: "sk-ant-…zz99", has_admin_value: true, has_env_value: false, prefer_admin_value: false, overridden_by_env: false },
  { key: "LLM", label: "LLM model", description: "", input_type: "text", source: "admin", configured: true,
    value_hint: "anthropic:claude-sonnet-5", has_admin_value: true, has_env_value: false, prefer_admin_value: false, overridden_by_env: false },
];

function json(body: unknown, status = 200) {
  return Promise.resolve(new Response(JSON.stringify(body), { status }));
}

function mockFetch(testResult: unknown) {
  const fetchMock = vi.fn((url: string) => {
    if (url === "/api/ai/provider") return json({ provider: "anthropic", model: "claude-sonnet-5", configured: true });
    if (url === "/api/admin/runtime-settings") return json({ settings });
    if (url === "/api/admin/ai/test-connection") return json(testResult);
    return json({}, 404);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => vi.unstubAllGlobals());

it("shows the masked saved key and the saved model, never the key itself", async () => {
  mockFetch({});
  render(<AiProviderSettings isAdmin />);
  expect(await screen.findByText("Saved key: sk-ant-…zz99")).toBeInTheDocument();
  expect(screen.getAllByText("Claude Sonnet 5").length).toBeGreaterThan(0);
  expect(document.body.textContent).not.toContain(KEY);
});

it("tests a pasted key server-side and explains an invalid key", async () => {
  const fetchMock = mockFetch({ ok: false, status: "invalid_key", message: "Anthropic rejected this API key.", models: [] });
  render(<AiProviderSettings isAdmin />);
  const user = userEvent.setup();
  await user.type(await screen.findByLabelText("Anthropic API key"), KEY);
  await user.click(screen.getByRole("button", { name: "Test connection" }));

  expect(await screen.findByText("Invalid key.")).toBeInTheDocument();
  const call = fetchMock.mock.calls.find(([url]) => url === "/api/admin/ai/test-connection") as unknown as [string, RequestInit];
  expect(JSON.parse(String(call[1].body))).toMatchObject({ provider: "anthropic", api_key: KEY, model: "claude-sonnet-5" });
});

it("is read-only for non-admins", async () => {
  mockFetch({});
  render(<AiProviderSettings isAdmin={false} />);
  expect(await screen.findByText("Only an administrator can change the AI provider.")).toBeInTheDocument();
  expect(screen.queryByLabelText("Anthropic API key")).not.toBeInTheDocument();
});
