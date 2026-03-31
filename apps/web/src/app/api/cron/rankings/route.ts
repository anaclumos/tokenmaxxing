import type { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { computeAllRankings } from "@/lib/rankings";

export async function GET(req: NextRequest) {
  // Verify cron secret to prevent unauthorized access
  const authHeader = req.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  await computeAllRankings(db());
  return Response.json({ ok: true });
}
