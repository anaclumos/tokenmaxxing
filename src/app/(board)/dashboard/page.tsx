import { Card, CardContent } from "@/components/ui/card";
import { requireOrg } from "@/lib/auth";
import { getDashboardData } from "@/lib/board/data";

export default async function DashboardPage() {
  const { orgId } = await requireOrg();
  const data = await getDashboardData(orgId);

  return (
    <div className="space-y-8">
      <div>
        <h2 className="text-2xl font-semibold tracking-tight text-balance">
          Dashboard
        </h2>
        <p className="mt-1 text-sm text-muted-foreground text-pretty">
          Runtime overview for your AI agent team.
        </p>
      </div>

      <div className="grid gap-4 grid-cols-1 sm:grid-cols-3">
        <Card size="sm">
          <CardContent>
            <dt className="truncate text-sm text-muted-foreground">
              Active Agents
            </dt>
            <dd className="mt-1 text-2xl font-semibold tabular-nums">
              {data.activeAgents}
            </dd>
          </CardContent>
        </Card>

        <Card size="sm">
          <CardContent>
            <dt className="truncate text-sm text-muted-foreground">
              Total Runs
            </dt>
            <dd className="mt-1 text-2xl font-semibold tabular-nums">
              {data.totalRuns}
            </dd>
          </CardContent>
        </Card>

        <Card size="sm">
          <CardContent>
            <dt className="truncate text-sm text-muted-foreground">
              Monthly Spend
            </dt>
            <dd className="mt-1 text-2xl font-semibold tabular-nums font-mono">
              ${data.monthlySpend.toFixed(2)}
            </dd>
          </CardContent>
        </Card>
      </div>

      <div>
        <h3 className="text-sm font-medium">Recent Activity</h3>
        {data.recentActivity.length === 0 ? (
          <p className="mt-3 text-sm text-muted-foreground text-pretty">
            No activity yet. Create your first agent to get started.
          </p>
        ) : (
          <div className="mt-3 space-y-2">
            {data.recentActivity.map((entry) => (
              <Card key={entry.id} size="sm">
                <CardContent className="flex items-center justify-between gap-4">
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="font-medium shrink-0">{entry.action}</span>
                    <span className="text-muted-foreground truncate">
                      {entry.resourceType}/{entry.resourceId.slice(0, 8)}
                    </span>
                  </div>
                  <time className="text-xs text-muted-foreground tabular-nums shrink-0">
                    {new Date(entry.createdAt).toLocaleDateString()}
                  </time>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
