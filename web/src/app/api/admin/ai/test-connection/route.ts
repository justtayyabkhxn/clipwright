import { NextResponse } from "next/server";

import { createTextProxyResponse, fetchBackend } from "@/server/backend-api";
import { getServerSession } from "@/server/session";

// Tests a Claude API key server-side. The key travels only browser → this
// route → backend and is never echoed back.
export async function POST(request: Request) {
  const session = await getServerSession();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!(session.user as { is_admin?: boolean }).is_admin) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const upstream = await fetchBackend("/admin/ai/test-connection", {
    method: "POST",
    userId: session.user.id,
    extraHeaders: { "Content-Type": "application/json" },
    body: await request.text(),
    cache: "no-store",
  });

  return createTextProxyResponse(upstream);
}
