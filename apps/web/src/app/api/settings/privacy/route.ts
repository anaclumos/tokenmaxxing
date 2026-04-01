import { auth } from "@clerk/nextjs/server";
import { users } from "@tokenmaxxing/db/index";
import { eq } from "drizzle-orm";
import { z } from "zod";

import { db } from "@/lib/db";

const Body = z.object({ privacyMode: z.boolean() });

export async function PUT(req: Request) {
  const { userId: clerkId } = await auth();
  if (!clerkId) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const parsed = Body.safeParse(await req.json());
  if (!parsed.success) {
    return Response.json({ error: "Invalid body" }, { status: 400 });
  }

  await db()
    .update(users)
    .set({ privacyMode: parsed.data.privacyMode, updatedAt: new Date() })
    .where(eq(users.clerkId, clerkId));

  return Response.json({ ok: true });
}
