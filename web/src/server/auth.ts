import { betterAuth } from "better-auth";
import { mongodbAdapter } from "better-auth/adapters/mongodb";
import { nextCookies } from "better-auth/next-js";
import { collections, getClient, getDb } from "./db";
import { env } from "./env";
import { deleteAllUserData } from "./tasks";

function trustedOrigins(): string[] {
  const extra = env.BETTER_AUTH_TRUSTED_ORIGINS.split(",").map((origin) => origin.trim());
  return [...new Set([env.BETTER_AUTH_URL, ...extra, "http://localhost:3000", "http://127.0.0.1:3000"].filter(Boolean))];
}

function adminEmails(): Set<string> {
  return new Set(env.ADMIN_EMAILS.split(",").map((email) => email.trim().toLowerCase()).filter(Boolean));
}

function createAuth() {
  return betterAuth({
    secret: env.BETTER_AUTH_SECRET,
    baseURL: env.BETTER_AUTH_URL,
    trustedOrigins: trustedOrigins(),
    database: mongodbAdapter(getDb(), { client: getClient(), transaction: env.MONGODB_TRANSACTIONS }),
    user: {
      additionalFields: {
        is_admin: { type: "boolean", input: false, defaultValue: false },
      },
      deleteUser: {
        enabled: true,
        beforeDelete: async (user) => {
          await deleteAllUserData(user.id);
        },
      },
    },
    databaseHooks: {
      user: {
        create: {
          // The first account, and any ADMIN_EMAILS address, becomes an admin.
          // ponytail: two simultaneous first sign-ups can both become admin.
          before: async (user) => {
            const first = (await collections().users.countDocuments({}, { limit: 1 })) === 0;
            const listed = adminEmails().has(user.email.toLowerCase());
            return { data: { ...user, is_admin: first || listed } };
          },
        },
      },
    },
    emailAndPassword: {
      enabled: true,
      disableSignUp: env.DISABLE_SIGN_UP,
      revokeSessionsOnPasswordReset: true,
      // No email transport: the link goes to the server console.
      sendResetPassword: async ({ user, url }) => {
        console.log(`[auth] Password reset link for ${user.email}: ${url}`);
      },
    },
    plugins: [nextCookies()],
  });
}

export type Auth = ReturnType<typeof createAuth>;
export type Session = Auth["$Infer"]["Session"];

const cache = globalThis as unknown as { __clipwrightAuth?: Auth };

/** Built on first use so importing this module needs no env (e.g. during `next build`). */
export function getAuth(): Auth {
  return (cache.__clipwrightAuth ??= createAuth());
}

export const auth: Auth = new Proxy({} as Auth, { get: (_target, key) => getAuth()[key as keyof Auth] });
