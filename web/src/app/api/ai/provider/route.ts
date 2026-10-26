import { createProxyResponse, fetchBackend } from "@/server/backend-api";

export async function GET() {
  return createProxyResponse(await fetchBackend("/ai/provider", { cache: "no-store" }));
}
