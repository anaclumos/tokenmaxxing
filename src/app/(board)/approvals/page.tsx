"use client";

import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useOrgId } from "@/hooks/use-org-id";
import { useCallback, useEffect, useState } from "react";

type Approval = {
  id: string;
  issueId: string;
  agentId: string;
  type: string;
  status: string;
  payload: Record<string, unknown> | null;
  decidedBy: string | null;
  decidedAt: string | null;
  createdAt: string;
};

const STATUS_VARIANTS: Record<string, "default" | "secondary" | "outline" | "destructive"> = {
  pending: "outline",
  approved: "default",
  rejected: "destructive",
};

export default function ApprovalsPage() {
  const orgId = useOrgId();
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [tab, setTab] = useState("pending");

  const fetchApprovals = useCallback(async () => {
    if (!orgId) return;
    const params = tab !== "all" ? `?status=${tab}` : "";
    const res = await fetch(`/api/orgs/${orgId}/approvals${params}`);
    if (res.ok) setApprovals(await res.json());
  }, [orgId, tab]);

  useEffect(() => {
    fetchApprovals();
  }, [fetchApprovals]);

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-semibold tracking-tight text-balance">
          Approvals
        </h2>
        <p className="mt-1 text-sm text-muted-foreground text-pretty">
          Review and approve agent decisions.
        </p>
      </div>

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="pending">Pending</TabsTrigger>
          <TabsTrigger value="approved">Approved</TabsTrigger>
          <TabsTrigger value="rejected">Rejected</TabsTrigger>
        </TabsList>

        <TabsContent value={tab} className="mt-6">
          {approvals.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No {tab} approvals.
            </p>
          ) : (
            <div className="space-y-px rounded-lg border border-border/50 overflow-hidden">
              {approvals.map((approval) => (
                <div
                  key={approval.id}
                  className="flex items-center justify-between gap-4 p-4"
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <p className="text-sm font-medium truncate">
                        {approval.type}
                      </p>
                      <Badge
                        variant={STATUS_VARIANTS[approval.status] ?? "outline"}
                        className="text-xs shrink-0"
                      >
                        {approval.status}
                      </Badge>
                    </div>
                    <p className="mt-0.5 text-xs text-muted-foreground truncate">
                      Agent {approval.agentId.slice(0, 8)} on issue{" "}
                      {approval.issueId.slice(0, 8)}
                    </p>
                  </div>
                  <time className="text-xs text-muted-foreground tabular-nums shrink-0">
                    {new Date(approval.createdAt).toLocaleString()}
                  </time>
                </div>
              ))}
            </div>
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}
