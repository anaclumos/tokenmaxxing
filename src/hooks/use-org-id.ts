"use client";

import { useAuth } from "@clerk/nextjs";

const BYPASS = process.env.NEXT_PUBLIC_BYPASS_AUTH === "true";

export function useOrgId(): string | null | undefined {
  if (BYPASS) return "org_test";

  // eslint-disable-next-line react-hooks/rules-of-hooks
  const { orgId } = useAuth();
  return orgId;
}
