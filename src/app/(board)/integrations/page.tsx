"use client";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useOrgId } from "@/hooks/use-org-id";
import { useCallback, useEffect, useState } from "react";

const CATALOG_PREVIEW = [
  { name: "GitHub", description: "Repositories, issues, PRs", category: "Development" },
  { name: "Linear", description: "Issue tracking and project management", category: "Development" },
  { name: "Slack", description: "Messaging and notifications", category: "Communication" },
  { name: "Notion", description: "Documentation and wikis", category: "Knowledge" },
  { name: "Sentry", description: "Error tracking and monitoring", category: "Development" },
  { name: "Vercel", description: "Deployments and logs", category: "Infrastructure" },
];

type CatalogEntry = {
  id: string;
  name: string;
  slug: string;
  description: string;
  iconUrl: string | null;
  authType: string;
  serverUrl: string;
  docsUrl: string | null;
  createdAt: string;
};

type Installation = {
  id: string;
  orgId: string;
  catalogEntryId: string | null;
  customUrl: string | null;
  customName: string | null;
  status: string;
  activatedBy: string;
  activatedAt: string;
};

export default function IntegrationsPage() {
  const orgId = useOrgId();
  const [catalog, setCatalog] = useState<CatalogEntry[]>([]);
  const [installed, setInstalled] = useState<Installation[]>([]);

  const fetchCatalog = useCallback(async () => {
    const res = await fetch("/api/mcp/catalog");
    if (res.ok) setCatalog(await res.json());
  }, []);

  const fetchInstalled = useCallback(async () => {
    if (!orgId) return;
    const res = await fetch(`/api/orgs/${orgId}/mcp`);
    if (res.ok) setInstalled(await res.json());
  }, [orgId]);

  useEffect(() => {
    fetchCatalog();
    fetchInstalled();
  }, [fetchCatalog, fetchInstalled]);

  const displayCatalog = catalog.length > 0
    ? catalog.map((e) => ({ name: e.name, description: e.description, category: e.authType }))
    : CATALOG_PREVIEW;

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-semibold tracking-tight text-balance">
          Integrations
        </h2>
        <p className="mt-1 text-sm text-muted-foreground text-pretty">
          Connect MCP servers to give your agents access to external tools.
        </p>
      </div>

      <Tabs defaultValue="catalog">
        <TabsList>
          <TabsTrigger value="catalog">Catalog</TabsTrigger>
          <TabsTrigger value="installed">
            Installed ({installed.length})
          </TabsTrigger>
        </TabsList>

        <TabsContent value="catalog" className="mt-6">
          <div className="grid gap-px overflow-hidden rounded-lg border border-border/50 sm:grid-cols-2 lg:grid-cols-3">
            {displayCatalog.map((entry) => (
              <div
                key={entry.name}
                className="flex flex-col justify-between gap-4 border-b border-r border-border/50 p-5 last:border-b-0 sm:[&:nth-child(2n)]:border-r-0 lg:[&:nth-child(2n)]:border-r lg:[&:nth-child(3n)]:border-r-0"
              >
                <div>
                  <div className="flex items-center gap-2">
                    <p className="text-sm font-medium">{entry.name}</p>
                    <Badge variant="outline" className="text-xs">
                      {entry.category}
                    </Badge>
                  </div>
                  <p className="mt-1 text-sm text-muted-foreground text-pretty">
                    {entry.description}
                  </p>
                </div>
                <Button variant="outline" size="sm" className="w-fit">
                  Connect
                </Button>
              </div>
            ))}
          </div>
        </TabsContent>

        <TabsContent value="installed" className="mt-6">
          {installed.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No integrations installed yet.
            </p>
          ) : (
            <div className="space-y-px rounded-lg border border-border/50 overflow-hidden">
              {installed.map((inst) => (
                <div
                  key={inst.id}
                  className="flex items-center justify-between gap-4 p-4"
                >
                  <div className="min-w-0">
                    <p className="text-sm font-medium truncate">
                      {inst.customName ?? inst.catalogEntryId?.slice(0, 8) ?? "Custom"}
                    </p>
                    {inst.customUrl && (
                      <p className="mt-0.5 text-xs text-muted-foreground font-mono truncate">
                        {inst.customUrl}
                      </p>
                    )}
                  </div>
                  <Badge
                    variant={inst.status === "active" ? "secondary" : "outline"}
                    className="text-xs shrink-0"
                  >
                    {inst.status}
                  </Badge>
                </div>
              ))}
            </div>
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}
