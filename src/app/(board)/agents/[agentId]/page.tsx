"use client";

import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { useOrgId } from "@/hooks/use-org-id";
import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";

type Agent = {
  id: string;
  name: string;
  shortname: string;
  model: string;
  provider: string;
  role: string;
  title: string;
  status: string;
  systemPrompt: string | null;
  reportsTo: string | null;
  monthlyBudgetCents: number | null;
  createdAt: string;
};

type Issue = {
  id: string;
  title: string;
  status: string;
  priority: string;
  createdAt: string;
};

const STATUS_COLORS: Record<string, "default" | "secondary" | "outline"> = {
  backlog: "outline",
  todo: "outline",
  in_progress: "secondary",
  in_review: "secondary",
  done: "default",
};

export default function AgentDetailPage() {
  const orgId = useOrgId();
  const { agentId } = useParams<{ agentId: string }>();
  const [agent, setAgent] = useState<Agent | null>(null);
  const [issues, setIssues] = useState<Issue[]>([]);

  const fetchAgent = useCallback(async () => {
    if (!orgId) return;
    const res = await fetch(`/api/orgs/${orgId}/agents/${agentId}`);
    if (res.ok) setAgent(await res.json());
  }, [orgId, agentId]);

  const fetchIssues = useCallback(async () => {
    if (!orgId) return;
    const res = await fetch(
      `/api/orgs/${orgId}/issues?assigneeId=${agentId}`,
    );
    if (res.ok) setIssues(await res.json());
  }, [orgId, agentId]);

  useEffect(() => {
    fetchAgent();
    fetchIssues();
  }, [fetchAgent, fetchIssues]);

  if (!agent) {
    return (
      <div className="py-16 text-center text-sm text-muted-foreground">
        Loading...
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <h2 className="text-2xl font-semibold tracking-tight text-balance">
          {agent.name}
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
                <dt className="text-muted-foreground">Title</dt>
                <dd>{agent.title}</dd>
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
            <h3 className="text-sm font-medium">
              Assigned Issues ({issues.length})
            </h3>
            {issues.length === 0 ? (
              <p className="mt-3 text-sm text-muted-foreground text-pretty">
                No issues assigned to this agent.
              </p>
            ) : (
              <div className="mt-3 space-y-px rounded-lg border border-border/50 overflow-hidden">
                {issues.map((issue) => (
                  <Link
                    key={issue.id}
                    href={`/issues/${issue.id}`}
                    className="flex items-center justify-between gap-4 p-3 hover:bg-muted/50 transition-colors"
                  >
                    <p className="text-sm font-medium truncate min-w-0">
                      {issue.title}
                    </p>
                    <div className="flex items-center gap-2 shrink-0">
                      <Badge
                        variant={STATUS_COLORS[issue.status] ?? "outline"}
                        className="text-xs"
                      >
                        {issue.status.replace("_", " ")}
                      </Badge>
                      <span className="text-xs text-muted-foreground">
                        {issue.priority}
                      </span>
                    </div>
                  </Link>
                ))}
              </div>
            )}
          </div>
        </div>

        <div>
          <h3 className="text-sm font-medium">Stats</h3>
          <dl className="mt-3 space-y-3 text-sm">
            <div className="flex justify-between">
              <dt className="text-muted-foreground">Shortname</dt>
              <dd className="font-mono text-xs">@{agent.shortname}</dd>
            </div>
            <Separator />
            <div className="flex justify-between">
              <dt className="text-muted-foreground">Assigned Issues</dt>
              <dd className="font-mono tabular-nums">{issues.length}</dd>
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
      </div>
    </div>
  );
}
