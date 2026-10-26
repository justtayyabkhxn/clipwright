"use client";

import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import { useEffect } from "react";

import { PageLoading } from "@/components/app/page-state";
import { useSession } from "@/lib/auth-client";

const HomeApp = dynamic(() => import("@/components/home-app"), {
  ssr: false,
});

export function HomeRouter() {
  const router = useRouter();
  const { data: session, isPending } = useSession();
  const signedOut = !isPending && !session?.user;

  useEffect(() => {
    if (signedOut) router.replace("/sign-in");
  }, [router, signedOut]);

  return session?.user ? <HomeApp /> : <PageLoading />;
}
