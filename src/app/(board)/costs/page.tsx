"use client";

import { useOrgId } from "@/hooks/use-org-id";
import { Card, CardContent } from "@/components/ui/card";
import { useCallback, useEffect, useState } from "react";

type CostEvent = {
  id: string;
  agentId: string;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  estimatedCost: string;
  createdAt: string;
};

type CostData = {
  events: CostEvent[];
  summary: {
    totalCost: string;
    totalInputTokens: number;
    totalOutputTokens: number;
  };
};

export default function CostsPage() {
  const orgId = useOrgId();
  const [data, setData] = useState<CostData | null>(null);

  const fetchCosts = useCallback(async () => {
    if (!orgId) return;
    const res = await fetch(`/api/orgs/${orgId}/costs`);
    if (res.ok) setData(await res.json());
  }, [orgId]);

  useEffect(() => {
    fetchCosts();
  }, [fetchCosts]);

  const totalCost = Number(data?.summary.totalCost ?? 0);
  const totalInput = Number(data?.summary.totalInputTokens ?? 0);
  const totalOutput = Number(data?.summary.totalOutputTokens ?? 0);

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

      <div className="grid gap-4 grid-cols-1 sm:grid-cols-3">
        <Card size="sm">
          <CardContent>
            <dt className="truncate text-sm text-muted-foreground">
              Total Spend
            </dt>
            <dd className="mt-1 text-2xl font-semibold font-mono tabular-nums">
              ${totalCost.toFixed(2)}
            </dd>
            <p className="mt-0.5 text-xs text-muted-foreground">this month</p>
          </CardContent>
        </Card>

        <Card size="sm">
          <CardContent>
            <dt className="truncate text-sm text-muted-foreground">
              Input Tokens
            </dt>
            <dd className="mt-1 text-2xl font-semibold font-mono tabular-nums">
              {totalInput.toLocaleString()}
            </dd>
            <p className="mt-0.5 text-xs text-muted-foreground">this month</p>
          </CardContent>
        </Card>

        <Card size="sm">
          <CardContent>
            <dt className="truncate text-sm text-muted-foreground">
              Output Tokens
            </dt>
            <dd className="mt-1 text-2xl font-semibold font-mono tabular-nums">
              {totalOutput.toLocaleString()}
            </dd>
            <p className="mt-0.5 text-xs text-muted-foreground">this month</p>
          </CardContent>
        </Card>
      </div>

      <div>
        <h3 className="text-sm font-medium">Cost Events</h3>
        {!data?.events.length ? (
          <p className="mt-3 text-sm text-muted-foreground text-pretty">
            No cost data yet. Costs appear after agents run.
          </p>
        ) : (
          <div className="mt-3 space-y-2">
            {data.events.map((event) => (
              <Card key={event.id} size="sm">
                <CardContent className="flex items-center justify-between gap-4">
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
                      {event.inputTokens.toLocaleString()} in /{" "}
                      {event.outputTokens.toLocaleString()} out
                    </span>
                    <span className="text-sm font-medium font-mono tabular-nums">
                      ${Number(event.estimatedCost).toFixed(4)}
                    </span>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
