import { clerkClient } from "@clerk/nextjs/server";
import { users } from "@tokenmaxxing/db/index";
import { inArray } from "drizzle-orm";
import type { NextRequest } from "next/server";

import { db } from "@/lib/db";
import { computeAllRankings } from "@/lib/rankings";

export async function GET(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Fetch all orgs and their members from Clerk
  const client = await clerkClient();
  const orgList = await client.organizations.getOrganizationList({
    limit: 100,
  });

  const orgs = await Promise.all(
    orgList.data.map(async (org) => {
      const members = await client.organizations.getOrganizationMembershipList({
        organizationId: org.id,
        limit: 500,
      });

      // Batch map Clerk user IDs to DB user IDs
      const clerkIds = members.data
        .map((m) => m.publicUserData?.userId)
        .filter((id): id is string => Boolean(id));

      const rows =
        clerkIds.length > 0
          ? await db()
              .select({ id: users.id })
              .from(users)
              .where(inArray(users.clerkId, clerkIds))
          : [];

      return { orgId: org.id, userIds: rows.map((r) => r.id) };
    })
  );

  await computeAllRankings(db(), orgs);
  return Response.json({
    ok: true,
    globalRanked: true,
    orgsRanked: orgs.length,
  });
}
