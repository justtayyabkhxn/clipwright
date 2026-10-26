/** @vitest-environment node */
import { ApiError } from "@/server/http";
import { requireUser } from "@/server/session";

import { POST } from "./route";

vi.mock("@/server/session", () => ({ requireUser: vi.fn() }));

describe("POST /api/upload/authorization", () => {
  it("sends the browser to /api/upload with local storage", async () => {
    vi.mocked(requireUser).mockResolvedValue({ id: "u1", email: "u@example.com", name: "u", isAdmin: false });
    const response = await POST(new Request("http://localhost/api/upload/authorization", { method: "POST", body: "{}" }));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    // Never {storage: "local"}: the client takes the S3 branch whenever `storage` is present.
    expect(await response.json()).toEqual({ directUpload: false });
  });

  it("needs a session", async () => {
    vi.mocked(requireUser).mockRejectedValue(new ApiError(401, "Unauthorized"));
    const response = await POST(new Request("http://localhost/api/upload/authorization", { method: "POST" }));
    expect([response.status, await response.json()]).toEqual([401, { detail: "Unauthorized" }]);
  });
});
