import { verifyWebhook } from "@clerk/nextjs/webhooks";
import { eq } from "drizzle-orm";
import type { NextRequest } from "next/server";
import { users } from "@tokenmaxxing/db/index";
import { db } from "@/lib/db";

export async function POST(req: NextRequest) {
  const evt = await verifyWebhook(req);

  if (evt.type === "user.created" || evt.type === "user.updated") {
    const { id, username, image_url, email_addresses } = evt.data;
    const email = email_addresses?.[0]?.email_address ?? null;
    const name = username ?? id;

    await db()
      .insert(users)
      .values({
        clerkId: id,
        username: name,
        avatarUrl: image_url,
        email,
      })
      .onConflictDoUpdate({
        target: users.clerkId,
        set: { username: name, avatarUrl: image_url, email, updatedAt: new Date() },
      });
  }

  if (evt.type === "user.deleted") {
    const { id } = evt.data;
    if (id) {
      await db().delete(users).where(eq(users.clerkId, id));
    }
  }

  return new Response("ok", { status: 200 });
}
