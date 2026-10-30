"use client";

import dynamic from "next/dynamic";

import { PageLoading } from "@/components/app/page-state";
import { useSession } from "@/lib/auth-client";

const HomeApp = dynamic(() => import("@/components/home-app"), {
  ssr: false,
});

const Landing = dynamic(() => import("@/components/landing/landing").then((mod) => mod.Landing));

/** Signed in: the app's home. Signed out: the public landing page. */
export function HomeRouter() {
  const { data: session, isPending } = useSession();
  if (isPending) return <PageLoading />;
  return session?.user ? <HomeApp /> : <Landing />;
}
