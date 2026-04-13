import { notFound } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { requireOrg } from "@/lib/auth";
import {
  getAgent,
  getAgentCostSummary,
  listAgentRecentActivity,
  listAgentRecentCosts,
  listAgentRoutines,
} from "@/lib/board/data";

type AgentDetailPageProps = {
  params: Promise<{ agentId: string }>;
};

export default async function AgentDetailPage({
  params,
}: AgentDetailPageProps) {
  const [{ orgId }, { agentId }] = await Promise.all([requireOrg(), params]);
  const [agent, routines, costSummary, recentCosts, recentActivity] =
    await Promise.all([
      getAgent(orgId, agentId),
      listAgentRoutines(orgId, agentId),
      getAgentCostSummary(orgId, agentId),
      listAgentRecentCosts(orgId, agentId),
      listAgentRecentActivity(orgId, agentId),
    ]);

  if (!agent) {
    notFound();
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <h2 className="text-2xl font-semibold tracking-tight text-balance">
          {agent.title}
        </h2>
        <Badge
          variant={agent.status === "active" ? "secondary" : "outline"}
        >
          {agent.status}
        </Badge>
      </div>

      <div className="grid gap-8 lg:grid-cols-3">
        <div className="lg:col-span-2 space-y-6">
          <div>
            <h3 className="text-sm font-medium">Profile</h3>
            <dl className="mt-3 space-y-3 text-sm">
              <div className="flex justify-between">
                <dt className="text-muted-foreground">Name</dt>
                <dd>{agent.name}</dd>
              </div>
              <Separator />
              <div className="flex justify-between">
                <dt className="text-muted-foreground">Role</dt>
                <dd>
                  <Badge variant="secondary" className="text-xs">
                    {agent.role}
                  </Badge>
                </dd>
              </div>
              <Separator />
              <div className="flex justify-between">
                <dt className="text-muted-foreground">Provider / Model</dt>
                <dd className="font-mono text-xs">
                  {agent.provider}/{agent.model}
                </dd>
              </div>
              <Separator />
              <div className="flex justify-between">
                <dt className="text-muted-foreground">Budget</dt>
                <dd className="font-mono tabular-nums">
                  {agent.monthlyBudgetCents
                    ? `$${(agent.monthlyBudgetCents / 100).toFixed(0)}/mo`
                    : "Unlimited"}
                </dd>
              </div>
            </dl>
          </div>

          <div>
            <h3 className="text-sm font-medium">Assigned Routines ({routines.length})</h3>
            {routines.length === 0 ? (
              <p className="mt-3 text-sm text-muted-foreground text-pretty">
                No routines are assigned to this agent.
              </p>
            ) : (
              <div className="mt-3 space-y-px rounded-lg border border-border/50 overflow-hidden">
                {routines.map((routine) => (
                  <div
                    key={routine.id}
                    className="flex items-center justify-between gap-4 p-3"
                  >
                    <div className="min-w-0">
                      <p className="text-sm font-medium truncate">{routine.name}</p>
                      {routine.description && (
                        <p className="mt-0.5 text-xs text-muted-foreground truncate">
                          {routine.description}
                        </p>
                      )}
                    </div>
                    <div className="flex items-center gap-3 shrink-0">
                      {routine.schedule && (
                        <span className="text-xs font-mono text-muted-foreground">
                          {routine.schedule}
                        </span>
                      )}
                      <Badge
                        variant={routine.status === "active" ? "secondary" : "outline"}
                        className="text-xs"
                      >
                        {routine.status}
                      </Badge>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div>
            <h3 className="text-sm font-medium">Recent Cost Events</h3>
            {recentCosts.length === 0 ? (
              <p className="mt-3 text-sm text-muted-foreground text-pretty">
                No cost events recorded for this agent yet.
              </p>
            ) : (
              <div className="mt-3 space-y-px rounded-lg border border-border/50 overflow-hidden">
                {recentCosts.map((event) => (
                  <div
                    key={event.id}
                    className="flex items-center justify-between gap-4 p-3"
                  >
                    <div className="min-w-0">
                      <p className="text-sm font-medium truncate">
                        {event.provider}/{event.model}
                      </p>
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        {event.inputTokens.toLocaleString()} in / {event.outputTokens.toLocaleString()} out
                      </p>
                    </div>
                    <div className="text-right shrink-0">
                      <p className="font-mono text-sm">
                        ${Number(event.estimatedCost).toFixed(4)}
                      </p>
                      <time className="text-xs text-muted-foreground tabular-nums">
                        {new Date(event.createdAt).toLocaleDateString()}
                      </time>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        <div className="space-y-6">
          <div>
            <h3 className="text-sm font-medium">Stats</h3>
            <dl className="mt-3 space-y-3 text-sm">
              <div className="flex justify-between">
                <dt className="text-muted-foreground">Shortname</dt>
                <dd className="font-mono text-xs">@{agent.shortname}</dd>
              </div>
              <Separator />
              <div className="flex justify-between">
                <dt className="text-muted-foreground">Routines</dt>
                <dd className="font-mono tabular-nums">{routines.length}</dd>
              </div>
              <Separator />
              <div className="flex justify-between">
                <dt className="text-muted-foreground">Total Spend</dt>
                <dd className="font-mono tabular-nums">
                  ${costSummary.totalCost.toFixed(2)}
                </dd>
              </div>
              <Separator />
              <div className="flex justify-between">
                <dt className="text-muted-foreground">Tokens</dt>
                <dd className="font-mono text-xs tabular-nums">
                  {costSummary.totalInputTokens.toLocaleString()} / {costSummary.totalOutputTokens.toLocaleString()}
                </dd>
              </div>
              <Separator />
              <div className="flex justify-between">
                <dt className="text-muted-foreground">Created</dt>
                <dd className="text-xs tabular-nums">
                  {new Date(agent.createdAt).toLocaleDateString()}
                </dd>
              </div>
            </dl>
          </div>

          <div>
            <h3 className="text-sm font-medium">Recent Activity</h3>
            {recentActivity.length === 0 ? (
              <p className="mt-3 text-sm text-muted-foreground text-pretty">
                No recent activity for this agent.
              </p>
            ) : (
              <div className="mt-3 space-y-px rounded-lg border border-border/50 overflow-hidden">
                {recentActivity.map((entry) => (
                  <div key={entry.id} className="p-3">
                    <p className="text-sm font-medium">{entry.action}</p>
                    <time className="mt-0.5 block text-xs text-muted-foreground tabular-nums">
                      {new Date(entry.createdAt).toLocaleString()}
                    </time>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
