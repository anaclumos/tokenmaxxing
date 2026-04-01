import { auth, clerkClient } from "@clerk/nextjs/server";
import { users, usageRecords } from "@tokenmaxxing/db/index";
import { gte, and, inArray, desc } from "drizzle-orm";

import { db } from "@/lib/db";

const VALID_FORMATS = ["csv", "json"] as const;
const VALID_DAYS = [7, 30, 90, 0] as const;

export async function GET(req: Request) {
  const { userId: clerkId, orgId } = await auth();
  if (!clerkId || !orgId) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(req.url);
  const format = url.searchParams.get("format") ?? "csv";
  if (!VALID_FORMATS.includes(format as (typeof VALID_FORMATS)[number])) {
    return Response.json({ error: "Invalid format: csv or json" }, { status: 400 });
  }

  const daysParam = Number(url.searchParams.get("days") ?? 30);
  const days = VALID_DAYS.includes(daysParam as (typeof VALID_DAYS)[number]) ? daysParam : 30;
  const since = days > 0 ? new Date(Date.now() - days * 86_400_000) : null;

  // Get org members
  const client = await clerkClient();
  const members = await client.organizations.getOrganizationMembershipList({
    organizationId: orgId,
    limit: 500,
  });
  const clerkIds = members.data
    .map((m) => m.publicUserData?.userId)
    .filter((id): id is string => Boolean(id));

  if (clerkIds.length === 0) {
    return format === "json"
      ? Response.json([])
      : new Response("", { headers: { "Content-Type": "text/csv" } });
  }

  const dbUsers = await db()
    .select({ id: users.id, username: users.username })
    .from(users)
    .where(inArray(users.clerkId, clerkIds));

  const userIds = dbUsers.map((u) => u.id);
  if (userIds.length === 0) {
    return format === "json"
      ? Response.json([])
      : new Response("", { headers: { "Content-Type": "text/csv" } });
  }

  const userMap = new Map(dbUsers.map((u) => [u.id, u.username]));

  const conditions = [inArray(usageRecords.userId, userIds)];
  if (since) conditions.push(gte(usageRecords.timestamp, since));

  const rows = await db()
    .select({
      timestamp: usageRecords.timestamp,
      userId: usageRecords.userId,
      client: usageRecords.client,
      model: usageRecords.model,
      inputTokens: usageRecords.inputTokens,
      outputTokens: usageRecords.outputTokens,
      cacheReadTokens: usageRecords.cacheReadTokens,
      cacheWriteTokens: usageRecords.cacheWriteTokens,
      reasoningTokens: usageRecords.reasoningTokens,
      costUsd: usageRecords.costUsd,
      project: usageRecords.project,
    })
    .from(usageRecords)
    .where(and(...conditions))
    .orderBy(desc(usageRecords.timestamp))
    .limit(10_000);

  const records = rows.map((r) => ({
    date: r.timestamp.toISOString().slice(0, 10),
    username: userMap.get(r.userId) ?? "unknown",
    client: r.client,
    model: r.model,
    inputTokens: r.inputTokens,
    outputTokens: r.outputTokens,
    cacheReadTokens: r.cacheReadTokens,
    cacheWriteTokens: r.cacheWriteTokens,
    reasoningTokens: r.reasoningTokens,
    costUsd: Number(r.costUsd),
    project: r.project ?? "",
  }));

  if (format === "json") {
    return Response.json(records);
  }

  // CSV
  const header = "date,username,client,model,inputTokens,outputTokens,cacheReadTokens,cacheWriteTokens,reasoningTokens,costUsd,project";
  const csvRows = records.map((r) =>
    `${r.date},${r.username},${r.client},"${r.model}",${r.inputTokens},${r.outputTokens},${r.cacheReadTokens},${r.cacheWriteTokens},${r.reasoningTokens},${r.costUsd},"${r.project}"`
  );

  return new Response([header, ...csvRows].join("\n"), {
    headers: {
      "Content-Type": "text/csv",
      "Content-Disposition": `attachment; filename="usage-export-${days || "all"}d.csv"`,
    },
  });
}
