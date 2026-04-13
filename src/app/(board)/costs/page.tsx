import { eq, sql } from "drizzle-orm";
import { requireOrg } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { costEvents } from "@/lib/db/schema";

export default async function CostsPage() {
  const { orgId } = await requireOrg();
  const db = getDb();
  const [events, summary] = await Promise.all([
    db.query.costEvents.findMany({
      where: eq(costEvents.orgId, orgId),
      orderBy: (table, { desc }) => [desc(table.createdAt)],
      limit: 500,
    }),
    db
      .select({
        totalCost: sql<string>`COALESCE(SUM(estimated_cost), 0)`,
        totalInputTokens: sql<number>`COALESCE(SUM(input_tokens), 0)`,
        totalOutputTokens: sql<number>`COALESCE(SUM(output_tokens), 0)`,
      })
      .from(costEvents)
      .where(eq(costEvents.orgId, orgId)),
  ]);

  const data = {
    events,
    summary: {
      totalCost: Number(summary[0]?.totalCost ?? 0),
      totalInputTokens: Number(summary[0]?.totalInputTokens ?? 0),
      totalOutputTokens: Number(summary[0]?.totalOutputTokens ?? 0),
    },
  };

  return (
    <div className="space-y-8">
      <div>
        <h2 className="text-2xl font-semibold tracking-tight text-balance">
          Costs
        </h2>
        <p className="mt-1 text-sm text-muted-foreground text-pretty">
          LLM token spend across agents and models.
        </p>
      </div>

      <div className="@container">
        <dl className="grid grid-cols-1 @lg:grid-cols-3">
          <div className="border-b border-border/50 pb-5 @lg:border-b-0 @lg:border-r @lg:pr-5">
            <dt className="truncate text-sm text-muted-foreground">
              Total Spend
            </dt>
            <dd className="mt-1 text-2xl font-semibold font-mono tabular-nums">
              ${data.summary.totalCost.toFixed(2)}
            </dd>
            <p className="mt-0.5 text-xs text-muted-foreground">this month</p>
          </div>

          <div className="border-b border-border/50 py-5 @lg:border-b-0 @lg:border-r @lg:px-5">
            <dt className="truncate text-sm text-muted-foreground">
              Input Tokens
            </dt>
            <dd className="mt-1 text-2xl font-semibold font-mono tabular-nums">
              {data.summary.totalInputTokens.toLocaleString()}
            </dd>
            <p className="mt-0.5 text-xs text-muted-foreground">this month</p>
          </div>

          <div className="pt-5 @lg:pl-5">
            <dt className="truncate text-sm text-muted-foreground">
              Output Tokens
            </dt>
            <dd className="mt-1 text-2xl font-semibold font-mono tabular-nums">
              {data.summary.totalOutputTokens.toLocaleString()}
            </dd>
            <p className="mt-0.5 text-xs text-muted-foreground">this month</p>
          </div>
        </dl>
      </div>

      <div>
        <h3 className="text-sm font-medium">Cost Events</h3>
        {data.events.length === 0 ? (
          <p className="mt-3 text-sm text-muted-foreground text-pretty">
            No cost data yet. Costs appear after agents run.
          </p>
        ) : (
          <div className="mt-3 space-y-px rounded-lg border border-border/50 overflow-hidden">
            {data.events.map((event) => (
              <div
                key={event.id}
                className="flex items-center justify-between gap-4 p-3 text-sm"
              >
                <div className="flex items-center gap-3 min-w-0">
                  <span className="font-mono text-xs text-muted-foreground shrink-0">
                    {event.provider}/{event.model}
                  </span>
                  <span className="text-xs text-muted-foreground truncate">
                    {event.agentId.slice(0, 8)}
                  </span>
                </div>
                <div className="flex items-center gap-4 shrink-0">
                  <span className="text-xs text-muted-foreground tabular-nums font-mono">
                    {event.inputTokens.toLocaleString()} in / {event.outputTokens.toLocaleString()} out
                  </span>
                  <span className="text-sm font-medium font-mono tabular-nums">
                    ${Number(event.estimatedCost).toFixed(4)}
                  </span>
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
  );
}
