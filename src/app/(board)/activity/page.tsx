import { Badge } from "@/components/ui/badge";
import { eq } from "drizzle-orm";
import { requireOrg } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { activityLog } from "@/lib/db/schema";

export default async function ActivityPage() {
  const { orgId } = await requireOrg();
  const db = getDb();
  const entries = await db.query.activityLog.findMany({
    where: eq(activityLog.orgId, orgId),
    orderBy: (table, { desc }) => [desc(table.createdAt)],
    limit: 100,
  });

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-semibold tracking-tight text-balance">
          Activity
        </h2>
        <p className="mt-1 text-sm text-muted-foreground text-pretty">
          Audit log of all actions across your organization.
        </p>
      </div>

      {entries.length === 0 ? (
        <p className="text-sm text-muted-foreground">No activity yet.</p>
      ) : (
        <div className="space-y-px rounded-lg border border-border/50 overflow-hidden">
          {entries.map((entry) => (
            <div
              key={entry.id}
              className="flex items-center justify-between gap-4 p-4"
            >
              <div className="flex items-center gap-3 min-w-0">
                <Badge variant="outline" className="text-xs shrink-0">
                  {entry.actorType}
                </Badge>
                <span className="text-sm font-medium shrink-0">
                  {entry.action}
                </span>
                <span className="text-sm text-muted-foreground truncate">
                  {entry.resourceType}/{entry.resourceId.slice(0, 8)}
                </span>
              </div>
              <time className="text-xs text-muted-foreground tabular-nums shrink-0">
                {new Date(entry.createdAt).toLocaleString()}
              </time>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
