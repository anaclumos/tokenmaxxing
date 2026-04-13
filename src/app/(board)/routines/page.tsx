import { eq } from "drizzle-orm";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { NewRoutineDialog } from "@/app/(board)/_components/new-routine-dialog";
import { requireOrg } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { agents, routines } from "@/lib/db/schema";

type RoutinesPageProps = {
  searchParams: Promise<{
    error?: string;
    status?: string;
  }>;
};

export default async function RoutinesPage({
  searchParams,
}: RoutinesPageProps) {
  const [{ orgId }, flash] = await Promise.all([requireOrg(), searchParams]);
  const db = getDb();
  const [routineRows, agentRows] = await Promise.all([
    db.query.routines.findMany({
      where: eq(routines.orgId, orgId),
      with: {
        agent: {
          columns: {
            id: true,
            name: true,
            title: true,
          },
        },
        triggers: {
          columns: {
            cronExpression: true,
          },
        },
      },
      orderBy: (table, { desc }) => [desc(table.createdAt)],
    }),
    db.query.agents.findMany({
      where: eq(agents.orgId, orgId),
      orderBy: (table, { asc }) => [asc(table.createdAt)],
    }),
  ]);

  const routineList = routineRows.map((routine) => ({
    ...routine,
    schedule: routine.triggers[0]?.cronExpression ?? null,
  }));

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-semibold tracking-tight text-balance">
            Routines
          </h2>
          <p className="mt-1 text-sm text-muted-foreground text-pretty">
            Scheduled agent work on a cron schedule.
          </p>
        </div>
        <NewRoutineDialog
          agents={agentRows.map((agent) => ({ id: agent.id, title: agent.title }))}
        />
      </div>

      {flash.status === "created" && (
        <Alert>
          <AlertDescription>Routine created.</AlertDescription>
        </Alert>
      )}
      {flash.error && (
        <Alert variant="destructive">
          <AlertDescription>{flash.error}</AlertDescription>
        </Alert>
      )}

      {routineList.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16">
          <p className="text-sm text-muted-foreground text-pretty">
            No routines configured. Set up recurring agent tasks.
          </p>
        </div>
      ) : (
        <div className="space-y-px rounded-lg border border-border/50 overflow-hidden">
          {routineList.map((routine) => (
            <div
              key={routine.id}
              className="flex items-center justify-between gap-4 p-4"
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
                <span className="text-xs text-muted-foreground">
                  {routine.agent.title}
                </span>
                {routine.schedule && (
                  <span className="text-xs text-muted-foreground font-mono">
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
  );
}
