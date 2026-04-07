import { randomBytes, createHash } from "node:crypto";

import { apiTokens } from "@tokenmaxxing/db/index";
import { eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { getCurrentDbUser } from "@/lib/current-user";

// Generate a new API token
export async function POST() {
  const { clerkId, user } = await getCurrentDbUser();
  if (!clerkId) return Response.json({ error: "Unauthorized" }, { status: 401 });

  if (!user) return Response.json({ error: "User not found" }, { status: 404 });

  // Generate token: tmx_<random 32 bytes hex>
  const raw = randomBytes(32).toString("hex");
  const token = `tmx_${raw}`;
  const hash = createHash("sha256").update(token).digest("hex");
  const prefix = token.slice(0, 12);

  await db().insert(apiTokens).values({
    userId: user.id,
    tokenHash: hash,
    prefix,
    name: "CLI",
  });

  // Return the full token ONCE - it's never stored in plaintext
  return Response.json({ token });
}

// List user's tokens (prefix only)
export async function GET() {
  const { clerkId, user } = await getCurrentDbUser();
  if (!clerkId) return Response.json({ error: "Unauthorized" }, { status: 401 });

  if (!user) return Response.json({ error: "User not found" }, { status: 404 });

  const tokens = await db()
    .select({
      id: apiTokens.id,
      prefix: apiTokens.prefix,
      name: apiTokens.name,
      lastUsedAt: apiTokens.lastUsedAt,
      createdAt: apiTokens.createdAt,
    })
    .from(apiTokens)
    .where(eq(apiTokens.userId, user.id));

  return Response.json({ tokens });
}
