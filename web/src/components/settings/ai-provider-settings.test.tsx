import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { vi } from "vitest";

import { fetchAiProvider } from "@/hooks/use-ai-provider";
import { AiProviderSettings, type RuntimeSetting } from "./ai-provider-settings";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const KEY = "sk-ant-api03-secret-value-zz99";
const ASSEMBLY = "aai-0123456789abcdef";

function row(key: string, overrides: Partial<RuntimeSetting>): RuntimeSetting {
  return {
    key, label: key, description: "", input_type: "password", source: "admin", configured: true, value_hint: null,
    has_admin_value: true, has_env_value: false, prefer_admin_value: false, overridden_by_env: false, ...overrides,
  };
}

const configured = [
  row("ANTHROPIC_API_KEY", { value_hint: "sk-ant-…zz99" }),
  row("ASSEMBLY_AI_API_KEY", { value_hint: "…cdef" }),
  row("CLAUDE_MODEL", { input_type: "text", value_hint: "claude-sonnet-5" }),
];

function json(body: unknown, status = 200) {
  return Promise.resolve(new Response(JSON.stringify(body), { status }));
}

function mockFetch({ settings = configured, testResult = {}, provider = { provider: "anthropic", model: "claude-sonnet-5", configured: true, llm_configured: true, transcription_configured: true } }: {
  settings?: RuntimeSetting[]; testResult?: unknown; provider?: Record<string, unknown>;
} = {}) {
  const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>((url) => {
    if (url === "/api/ai/provider") return json(provider);
    if (url === "/api/admin/runtime-settings") return json({ settings });
    if (url === "/api/admin/ai/test-connection") return json(testResult);
    return json({}, 404);
  });
  vi.stubGlobal("fetch", fetchMock);
  // The provider status is cached per module; reload it for this test's response.
  void fetchAiProvider(true);
  return fetchMock;
}

function patchBodies(fetchMock: ReturnType<typeof mockFetch>) {
  return fetchMock.mock.calls
    .filter(([url, init]) => url === "/api/admin/runtime-settings" && init?.method === "PATCH")
    .map(([, init]) => JSON.parse(String(init?.body)));
}

afterEach(() => vi.unstubAllGlobals());

it("shows the masked saved keys and the saved model, never the key itself", async () => {
  mockFetch();
  render(<AiProviderSettings isAdmin />);
  expect(await screen.findByText("Saved key: sk-ant-…zz99")).toBeInTheDocument();
  expect(screen.getByText("Saved key: …cdef")).toBeInTheDocument();
  expect(screen.getAllByText("Claude Sonnet 5").length).toBeGreaterThan(0);
  expect(document.body.textContent).not.toContain(KEY);
});

it("tests a pasted key server-side and explains an invalid key", async () => {
  const fetchMock = mockFetch({ testResult: { ok: false, status: "invalid_key", message: "Anthropic rejected this API key.", models: [] } });
  render(<AiProviderSettings isAdmin />);
  const user = userEvent.setup({ delay: null });
  await user.type(await screen.findByLabelText("Anthropic API key"), KEY);
  await user.click(screen.getByRole("button", { name: "Test connection" }));

  expect(await screen.findByText("Invalid key.")).toBeInTheDocument();
  const call = fetchMock.mock.calls.find(([url]) => url === "/api/admin/ai/test-connection") as unknown as [string, RequestInit];
  expect(JSON.parse(String(call[1].body))).toMatchObject({ provider: "anthropic", api_key: KEY, model: "claude-sonnet-5" });
});

it("saves the model as a plain CLAUDE_MODEL id together with a new Anthropic key", async () => {
  const fetchMock = mockFetch();
  render(<AiProviderSettings isAdmin />);
  const user = userEvent.setup({ delay: null });
  await user.type(await screen.findByLabelText("Anthropic API key"), KEY);
  await user.click(screen.getByRole("button", { name: "Save" }));

  await waitFor(() => expect(patchBodies(fetchMock)).toHaveLength(1));
  expect(patchBodies(fetchMock)[0]).toEqual({
    updates: { CLAUDE_MODEL: "claude-sonnet-5", ANTHROPIC_API_KEY: KEY },
    prefer_admin_values: { CLAUDE_MODEL: false, ANTHROPIC_API_KEY: false },
  });
});

it("saves and removes the AssemblyAI key without a connection test", async () => {
  const fetchMock = mockFetch();
  render(<AiProviderSettings isAdmin />);
  const user = userEvent.setup({ delay: null });
  const input = await screen.findByLabelText("AssemblyAI API key");
  expect(screen.getAllByRole("button", { name: "Test connection" })).toHaveLength(1);
  await user.type(input, ASSEMBLY);
  await user.click(screen.getByRole("button", { name: "Save key" }));
  await waitFor(() => expect(patchBodies(fetchMock)).toHaveLength(1));
  expect(patchBodies(fetchMock)[0]).toEqual({
    updates: { ASSEMBLY_AI_API_KEY: ASSEMBLY },
    prefer_admin_values: { ASSEMBLY_AI_API_KEY: false },
  });
  await waitFor(() => expect(input).toHaveValue(""));

  await user.click(screen.getAllByRole("button", { name: "Remove saved key" })[1]);
  await waitFor(() => expect(patchBodies(fetchMock)).toHaveLength(2));
  expect(patchBodies(fetchMock)[1]).toEqual({ delete_keys: ["ASSEMBLY_AI_API_KEY"] });
});

it("names the missing key for an admin and shows each key's status next to its field", async () => {
  mockFetch({
    settings: [configured[0], row("ASSEMBLY_AI_API_KEY", { configured: false, has_admin_value: false, source: "unset" }), configured[2]],
    provider: { provider: "anthropic", model: "claude-sonnet-5", configured: false, llm_configured: true, transcription_configured: false },
  });
  render(<AiProviderSettings isAdmin />);
  expect(await screen.findByText("Missing: AssemblyAI API key")).toBeInTheDocument();
  await waitFor(() => expect(screen.getByLabelText("AssemblyAI API key")).toHaveAccessibleDescription("Not configured"));
  expect(screen.getByLabelText("Anthropic API key")).toHaveAccessibleDescription("Ready");
  // Header status plus the AssemblyAI field.
  expect(screen.getAllByText("Not configured")).toHaveLength(2);
});

it("is read-only for non-admins and still says what is missing", async () => {
  const fetchMock = mockFetch({ provider: { provider: "anthropic", model: "claude-opus-5", configured: false, llm_configured: false, transcription_configured: true } });
  render(<AiProviderSettings isAdmin={false} />);
  expect(await screen.findByText("Only an administrator can change these keys.")).toBeInTheDocument();
  expect(await screen.findByText("Missing: Anthropic API key")).toBeInTheDocument();
  expect(screen.queryByLabelText("Anthropic API key")).not.toBeInTheDocument();
  expect(screen.queryByLabelText("AssemblyAI API key")).not.toBeInTheDocument();
  expect(fetchMock.mock.calls.some(([url]) => url === "/api/admin/runtime-settings")).toBe(false);
});

it("tells a non-admin every key that is missing", async () => {
  mockFetch({ provider: { provider: "anthropic", model: "claude-opus-5", configured: false, llm_configured: false, transcription_configured: false } });
  render(<AiProviderSettings isAdmin={false} />);
  expect(await screen.findByText("Missing: Anthropic API key, AssemblyAI API key")).toBeInTheDocument();
  expect(screen.getByText("Not configured")).toBeInTheDocument();
});

it("names only the transcription key when Claude is configured", async () => {
  mockFetch({ provider: { provider: "anthropic", model: "claude-opus-5", configured: false, llm_configured: true, transcription_configured: false } });
  render(<AiProviderSettings isAdmin={false} />);
  expect(await screen.findByText("Missing: AssemblyAI API key")).toBeInTheDocument();
});
