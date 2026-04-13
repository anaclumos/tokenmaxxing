import { getDb } from "@/lib/db";
import { activityLog } from "@/lib/db/schema";

export async function logActivity(params: {
  orgId: string;
  actorType: string;
  actorId: string;
  action: string;
  resourceType: string;
  resourceId: string;
  metadata?: Record<string, unknown>;
}) {
  const db = getDb();
  await db.insert(activityLog).values(params);
}
