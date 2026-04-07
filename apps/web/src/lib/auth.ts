import { createHash } from "node:crypto";

import { auth } from "@clerk/nextjs/server";
import { apiTokens } from "@tokenmaxxing/db/index";
import { eq } from "drizzle-orm";

import { db } from "@/lib/db";

// Verify a Bearer API token, return userId or null
export async function authenticateToken(req: Request): Promise<string | null> {
  const header = req.headers.get("authorization");
  if (!header?.startsWith("Bearer ")) return null;

  const token = header.slice(7);
  const hash = createHash("sha256").update(token).digest("hex");

  const [row] = await db()
    .select({ userId: apiTokens.userId })
    .from(apiTokens)
    .where(eq(apiTokens.tokenHash, hash))
    .limit(1);

  if (!row) return null;

  await db().update(apiTokens).set({ lastUsedAt: new Date() }).where(eq(apiTokens.tokenHash, hash));

  return row.userId;
}

export async function canAccessPrivateUser({
  req,
  user,
}: {
  req: Request;
  user: { id: string; clerkId: string };
}) {
  const [{ userId: clerkUserId }, apiUserId] = await Promise.all([auth(), authenticateToken(req)]);

  return clerkUserId === user.clerkId || apiUserId === user.id;
}
