"use client";

import { Badge } from "@/components/ui/badge";
import { useOrgId } from "@/hooks/use-org-id";
import { useCallback, useEffect, useState } from "react";

type ActivityEntry = {
  id: string;
  actorType: string;
  actorId: string;
  action: string;
  resourceType: string;
  resourceId: string;
  metadata: Record<string, unknown> | null;
  createdAt: string;
};

export default function ActivityPage() {
  const orgId = useOrgId();
  const [entries, setEntries] = useState<ActivityEntry[]>([]);

  const fetchActivity = useCallback(async () => {
    if (!orgId) return;
    const res = await fetch(`/api/orgs/${orgId}/activity`);
    if (res.ok) setEntries(await res.json());
  }, [orgId]);

  useEffect(() => {
    fetchActivity();
  }, [fetchActivity]);

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
