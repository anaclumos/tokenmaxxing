import { auth } from "@clerk/nextjs/server";
import { users } from "@tokenmaxxing/db/index";
import { eq } from "drizzle-orm";

import { db } from "@/lib/db";

export async function getCurrentDbUser() {
  const { userId: clerkId } = await auth();
  if (!clerkId) {
    return { clerkId: null, user: null };
  }

  const [user] = await db().select().from(users).where(eq(users.clerkId, clerkId)).limit(1);

  return { clerkId, user: user ?? null };
}
