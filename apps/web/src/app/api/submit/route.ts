import { after } from "next/server";
import { SubmitPayload } from "@tokenmaxxing/shared/types";
import { usageRecords } from "@tokenmaxxing/db/index";
import { db } from "@/lib/db";
import { authenticateToken } from "@/lib/auth";
import { recomputeAggregates } from "@/lib/aggregates";

export async function POST(req: Request) {
  const userId = await authenticateToken(req);
  if (!userId) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
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
