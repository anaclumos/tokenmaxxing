import Link from "next/link";
import { eq } from "drizzle-orm";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { NewAgentDialog } from "@/app/(board)/_components/new-agent-dialog";
import { requireOrg } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { agents } from "@/lib/db/schema";

type AgentsPageProps = {
  searchParams: Promise<{
    error?: string;
    status?: string;
  }>;
};

export default async function AgentsPage({
  searchParams,
}: AgentsPageProps) {
  const [{ orgId }, flash] = await Promise.all([requireOrg(), searchParams]);
  const db = getDb();
  const rows = await db.query.agents.findMany({
    where: eq(agents.orgId, orgId),
    orderBy: (table, { asc }) => [asc(table.createdAt)],
  });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-semibold tracking-tight text-balance">
            Agents
          </h2>
          <p className="mt-1 text-sm text-muted-foreground text-pretty">
            Your AI team members and their roles.
          </p>
        </div>
        <NewAgentDialog />
      </div>

      {flash.status === "created" && (
        <Alert>
          <AlertDescription>Agent created.</AlertDescription>
        </Alert>
      )}
      {flash.error && (
        <Alert variant="destructive">
          <AlertDescription>{flash.error}</AlertDescription>
        </Alert>
      )}

      {rows.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16">
          <p className="text-sm text-muted-foreground text-pretty">
            No agents yet. Create your first agent to start building your team.
          </p>
        </div>
      ) : (
        <div className="space-y-px rounded-lg border border-border/50 overflow-hidden">
          {rows.map((agent) => (
            <Link
              key={agent.id}
              href={`/agents/${agent.id}`}
              className="flex items-center justify-between gap-4 p-4 hover:bg-muted/50 transition-colors"
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 min-w-0">
                  <p className="text-sm font-medium truncate">{agent.title}</p>
                  <Badge variant="secondary" className="text-xs shrink-0">
                    {agent.role}
                  </Badge>
                </div>
                <p className="mt-0.5 text-xs text-muted-foreground truncate">
                  {agent.name} · @{agent.shortname} · {agent.provider}/{agent.model}
                </p>
              </div>

              <div className="flex items-center gap-3 shrink-0">
                {agent.monthlyBudgetCents && (
                  <span className="text-xs text-muted-foreground font-mono tabular-nums">
                    ${(agent.monthlyBudgetCents / 100).toFixed(0)}/mo
                  </span>
                )}
                <Badge
                  variant={agent.status === "active" ? "secondary" : "outline"}
                  className="text-xs"
                >
                  {agent.status}
                </Badge>
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
