import { eq } from "drizzle-orm";
import { after } from "next/server";
import type { NextRequest } from "next/server";
import { SubmitPayload } from "@tokenmaxxing/shared/types";
import { apiTokens, usageRecords } from "@tokenmaxxing/db/index";
import { db } from "@/lib/db";
import { recomputeAggregates } from "@/lib/aggregates";
import { rateLimit } from "@/lib/rate-limit";
import { createHash } from "node:crypto";

// Verify Bearer token, return userId
async function authenticate(req: NextRequest): Promise<string | null> {
  const auth = req.headers.get("authorization");
  if (!auth?.startsWith("Bearer ")) return null;

  const token = auth.slice(7);
  const hash = createHash("sha256").update(token).digest("hex");

  const rows = await db()
    .select({ userId: apiTokens.userId })
    .from(apiTokens)
    .where(eq(apiTokens.tokenHash, hash))
    .limit(1);

  if (rows.length === 0) return null;

  // Update last used timestamp
  await db()
    .update(apiTokens)
    .set({ lastUsedAt: new Date() })
    .where(eq(apiTokens.tokenHash, hash));

  return rows[0].userId;
}

export async function POST(req: NextRequest) {
  const userId = await authenticate(req);
  if (!userId) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { ok } = rateLimit(`submit:${userId}`, 100, 60_000);
  if (!ok) {
    return Response.json({ error: "Rate limited" }, { status: 429, headers: { "Retry-After": "60" } });
  }

  const body = await req.json();
  const parsed = SubmitPayload.safeParse(body);
  if (!parsed.success) {
    return Response.json({ error: "Invalid payload", details: parsed.error.issues }, { status: 400 });
  }

  let inserted = 0;
  let skipped = 0;

  for (const record of parsed.data.records) {
    try {
      await db().insert(usageRecords).values({
        userId,
        client: record.client,
        model: record.model,
        sessionHash: record.sessionHash,
        timestamp: new Date(record.timestamp),
        inputTokens: record.tokens.input,
        outputTokens: record.tokens.output,
        cacheReadTokens: record.tokens.cacheRead,
        cacheWriteTokens: record.tokens.cacheWrite,
        reasoningTokens: record.tokens.reasoning,
        costUsd: record.costUsd.toFixed(6),
      });
      inserted++;
    } catch (e: unknown) {
      // Unique constraint violation = duplicate session hash
      if (e instanceof Error && e.message.includes("unique")) {
        skipped++;
      } else {
        throw e;
      }
    }
  }

  // Recompute aggregates after responding
  if (inserted > 0) {
    after(() => recomputeAggregates(db(), userId));
  }

  return Response.json({ inserted, skipped, total: parsed.data.records.length });
}
