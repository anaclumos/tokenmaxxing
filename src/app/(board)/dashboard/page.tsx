"use client";

import { useOrgId } from "@/hooks/use-org-id";
import { useCallback, useEffect, useState } from "react";

type DashboardData = {
  activeAgents: number;
  openIssues: number;
  pendingApprovals: number;
  monthlySpend: number;
  recentActivity: {
    id: string;
    action: string;
    actorType: string;
    actorId: string;
    resourceType: string;
    resourceId: string;
    createdAt: string;
  }[];
};

export default function DashboardPage() {
  const orgId = useOrgId();
  const [data, setData] = useState<DashboardData | null>(null);

  const fetchDashboard = useCallback(async () => {
    if (!orgId) return;
    const res = await fetch(`/api/orgs/${orgId}/dashboard`);
    if (res.ok) setData(await res.json());
  }, [orgId]);

  useEffect(() => {
    fetchDashboard();
  }, [fetchDashboard]);

  return (
    <div className="space-y-8">
      <div>
        <h2 className="text-2xl font-semibold tracking-tight text-balance">
          Dashboard
        </h2>
        <p className="mt-1 text-sm text-muted-foreground text-pretty">
          Overview of your AI-powered company.
        </p>
      </div>

      <div className="@container">
        <dl className="grid grid-cols-1 @lg:grid-cols-2 @3xl:grid-cols-4">
          <div className="border-b border-border/50 pb-5 @lg:border-b-0 @lg:border-r @lg:pr-5 @3xl:border-r @3xl:pr-5">
            <dt className="truncate text-sm text-muted-foreground">
              Active Agents
            </dt>
            <dd className="mt-1 text-2xl font-semibold tabular-nums">
              {data?.activeAgents ?? 0}
            </dd>
          </div>

          <div className="border-b border-border/50 py-5 @lg:border-b-0 @lg:pl-5 @3xl:border-r @3xl:pr-5">
            <dt className="truncate text-sm text-muted-foreground">
              Open Issues
            </dt>
            <dd className="mt-1 text-2xl font-semibold tabular-nums">
              {data?.openIssues ?? 0}
            </dd>
          </div>

          <div className="border-b border-border/50 py-5 @lg:border-b-0 @lg:border-r @lg:pr-5 @3xl:pl-5 @3xl:pr-5">
            <dt className="truncate text-sm text-muted-foreground">
              Pending Approvals
            </dt>
            <dd className="mt-1 text-2xl font-semibold tabular-nums">
              {data?.pendingApprovals ?? 0}
            </dd>
          </div>

          <div className="pt-5 @lg:pl-5 @3xl:pl-5">
            <dt className="truncate text-sm text-muted-foreground">
              Monthly Spend
            </dt>
            <dd className="mt-1 text-2xl font-semibold tabular-nums font-mono">
              ${(data?.monthlySpend ?? 0).toFixed(2)}
            </dd>
          </div>
        </dl>
      </div>

      <div>
        <h3 className="text-sm font-medium">Recent Activity</h3>
        {!data?.recentActivity.length ? (
          <p className="mt-3 text-sm text-muted-foreground text-pretty">
            No activity yet. Create your first agent to get started.
          </p>
        ) : (
          <div className="mt-3 space-y-px rounded-lg border border-border/50 overflow-hidden">
            {data.recentActivity.map((entry) => (
              <div
                key={entry.id}
                className="flex items-center justify-between gap-4 p-3 text-sm"
              >
                <div className="flex items-center gap-2 min-w-0">
                  <span className="font-medium shrink-0">{entry.action}</span>
                  <span className="text-muted-foreground truncate">
                    {entry.resourceType}/{entry.resourceId.slice(0, 8)}
                  </span>
                </div>
                <time className="text-xs text-muted-foreground tabular-nums shrink-0">
                  {new Date(entry.createdAt).toLocaleDateString()}
                </time>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
