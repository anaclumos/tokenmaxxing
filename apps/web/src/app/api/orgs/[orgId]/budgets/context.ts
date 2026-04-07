import { auth, clerkClient } from "@clerk/nextjs/server";
import { users } from "@tokenmaxxing/db/index";
import { inArray } from "drizzle-orm";

import { db } from "@/lib/db";

export async function getOrgAdminContext({ routeOrgId }: { routeOrgId: string }) {
  const { isAuthenticated, orgId, has } = await auth();

  if (!isAuthenticated || !orgId) {
    return { error: Response.json({ error: "Unauthorized" }, { status: 401 }) };
  }

  if (orgId !== routeOrgId || !has({ role: "org:admin" })) {
    return { error: Response.json({ error: "Forbidden" }, { status: 403 }) };
  }

  const client = await clerkClient();
  const memberships = await client.organizations.getOrganizationMembershipList({
    organizationId: routeOrgId,
    limit: 500,
  });
  const clerkIds = memberships.data
    .map((member) => member.publicUserData?.userId)
    .filter((id): id is string => Boolean(id));
  const members =
    clerkIds.length > 0
      ? await db()
          .select({
            id: users.id,
            username: users.username,
            clerkId: users.clerkId,
          })
          .from(users)
          .where(inArray(users.clerkId, clerkIds))
      : [];

  return {
    error: null,
    members,
    routeOrgId,
  };
}
