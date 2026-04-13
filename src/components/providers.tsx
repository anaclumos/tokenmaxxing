"use client";

import { ClerkProvider } from "@clerk/nextjs";

const BYPASS = process.env.NEXT_PUBLIC_BYPASS_AUTH === "true";

function MockProviders({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}

export function Providers({ children }: { children: React.ReactNode }) {
  if (BYPASS) return <MockProviders>{children}</MockProviders>;
  return <ClerkProvider dynamic>{children}</ClerkProvider>;
}
