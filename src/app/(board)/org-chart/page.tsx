import { Badge } from "@/components/ui/badge";
import { eq } from "drizzle-orm";
import { requireOrg } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { agents } from "@/lib/db/schema";

type Agent = {
  id: string;
  name: string;
  title: string;
  role: string;
  status: string;
  reportsTo: string | null;
};

type TreeNode = Agent & { children: TreeNode[] };

function buildTree(agents: Agent[]): TreeNode[] {
  const map = new Map<string, TreeNode>();
  for (const agent of agents) {
    map.set(agent.id, { ...agent, children: [] });
  }

  const roots: TreeNode[] = [];
  for (const node of map.values()) {
    if (node.reportsTo && map.has(node.reportsTo)) {
      map.get(node.reportsTo)!.children.push(node);
    } else {
      roots.push(node);
    }
  }

  return roots;
}

function AgentNode({ node, depth }: { node: TreeNode; depth: number }) {
  return (
    <>
      <div
        className="flex items-center gap-3 p-3"
        style={{ paddingLeft: `${depth * 24 + 12}px` }}
      >
        {depth > 0 && (
          <span className="text-muted-foreground text-xs select-none">
            {"└"}
          </span>
        )}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium truncate">{node.name}</span>
            <Badge variant="secondary" className="text-xs shrink-0">
              {node.role}
            </Badge>
            {node.status !== "active" && (
              <Badge variant="outline" className="text-xs shrink-0">
                {node.status}
              </Badge>
            )}
          </div>
          <p className="text-xs text-muted-foreground truncate">{node.title}</p>
        </div>
      </div>
      {node.children.map((child) => (
        <AgentNode key={child.id} node={child} depth={depth + 1} />
      ))}
    </>
  );
}

export default async function OrgChartPage() {
  const { orgId } = await requireOrg();
  const db = getDb();
  const rows = await db.query.agents.findMany({
    where: eq(agents.orgId, orgId),
    orderBy: (table, { asc }) => [asc(table.createdAt)],
  });
  const tree = buildTree(rows);

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-semibold tracking-tight text-balance">
          Org Chart
        </h2>
        <p className="mt-1 text-sm text-muted-foreground text-pretty">
          Agent hierarchy and reporting lines.
        </p>
      </div>

      {rows.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16">
          <p className="text-sm text-muted-foreground text-pretty">
            Create agents with reporting lines to see the org chart.
          </p>
        </div>
      ) : (
        <div className="space-y-px rounded-lg border border-border/50 overflow-hidden">
          {tree.map((root) => (
            <AgentNode key={root.id} node={root} depth={0} />
          ))}
        </div>
      )}
    </div>
  );
}
