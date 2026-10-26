import { headers } from "next/headers";
import { getAuth } from "./auth";
import { ApiError } from "./http";

export type SessionUser = { id: string; email: string; name: string; isAdmin: boolean };

/** The Better Auth session, from the request's headers or (in route handlers) `next/headers`. */
export async function getServerSession(request?: Request) {
  return getAuth().api.getSession({ headers: request ? request.headers : await headers() });
}

export async function getSessionUser(request?: Request): Promise<SessionUser | null> {
  const session = await getServerSession(request);
  if (!session) return null;
  const { id, email, name, is_admin } = session.user;
  return { id, email, name, isAdmin: Boolean(is_admin) };
}

export async function requireUser(request?: Request): Promise<SessionUser> {
  const user = await getSessionUser(request);
  if (!user) throw new ApiError(401, "Unauthorized");
  return user;
}

export async function requireAdmin(request?: Request): Promise<SessionUser> {
  const user = await requireUser(request);
  if (!user.isAdmin) throw new ApiError(403, "Admin access required");
  return user;
}
