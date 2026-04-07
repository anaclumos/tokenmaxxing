import { users } from "@tokenmaxxing/db/index";
import { eq } from "drizzle-orm";
import { cache } from "react";

import { db } from "@/lib/db";

export const getProfileUser = cache(async ({ username }: { username: string }) => {
  const [user] = await db()
    .select({
      clerkId: users.clerkId,
      username: users.username,
      privacyMode: users.privacyMode,
    })
    .from(users)
    .where(eq(users.username, username))
    .limit(1);

  return user ?? null;
});
