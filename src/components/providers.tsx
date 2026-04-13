"use client";

import { ClerkProvider } from "@clerk/nextjs";

const BYPASS = process.env.NEXT_PUBLIC_BYPASS_AUTH === "true";

export function Providers({ children }: { children: React.ReactNode }) {
  if (BYPASS) return children;
  return <ClerkProvider dynamic>{children}</ClerkProvider>;
}
