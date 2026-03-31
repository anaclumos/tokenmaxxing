import type { NextRequest } from "next/server";
import { clerkClient } from "@clerk/nextjs/server";
import { eq } from "drizzle-orm";
import { users } from "@tokenmaxxing/db/index";
import { db } from "@/lib/db";
import { computeAllRankings } from "@/lib/rankings";

export async function GET(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Fetch all orgs and their members from Clerk
  const client = await clerkClient();
  const orgList = await client.organizations.getOrganizationList({ limit: 100 });

  const orgs = await Promise.all(
    orgList.data.map(async (org) => {
      const members = await client.organizations.getOrganizationMembershipList({
        organizationId: org.id,
        limit: 500,
      });

      // Map Clerk user IDs to our DB user IDs
      const userIds: string[] = [];
      for (const m of members.data) {
        const clerkId = m.publicUserData?.userId;
        if (!clerkId) continue;
        const [row] = await db()
          .select({ id: users.id })
          .from(users)
          .where(eq(users.clerkId, clerkId))
          .limit(1);
        if (row) userIds.push(row.id);
      }

      return { orgId: org.id, userIds };
    }),
  );

  await computeAllRankings(db(), orgs);
  return Response.json({ ok: true, globalRanked: true, orgsRanked: orgs.length });
}
