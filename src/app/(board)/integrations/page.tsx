import { eq } from "drizzle-orm";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { requireOrg } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { orgMcpInstallations } from "@/lib/db/schema";

export default async function IntegrationsPage() {
  const { orgId } = await requireOrg();
  const db = getDb();
  const [catalog, installed] = await Promise.all([
    db.query.mcpCatalogEntries.findMany({
      orderBy: (table, { asc }) => [asc(table.name)],
    }),
    db.query.orgMcpInstallations.findMany({
      where: eq(orgMcpInstallations.orgId, orgId),
      with: {
        catalogEntry: {
          columns: {
            id: true,
            name: true,
            authType: true,
            docsUrl: true,
            serverUrl: true,
          },
        },
      },
      orderBy: (table, { desc }) => [desc(table.activatedAt)],
    }),
  ]);

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
          <TabsTrigger value="installed">Installed ({installed.length})</TabsTrigger>
        </TabsList>

        <TabsContent value="catalog" className="mt-6">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {catalog.map((entry) => (
              <Card key={entry.id} size="sm">
                <CardContent className="flex flex-col justify-between gap-4">
                  <div>
                    <div className="flex items-center gap-2">
                      <p className="text-sm font-medium">{entry.name}</p>
                      <Badge variant="outline" className="text-xs">
                        {entry.authType.replace("_", " ")}
                      </Badge>
                    </div>
                    <p className="mt-1 text-sm text-muted-foreground text-pretty">
                      {entry.description}
                    </p>
                  </div>
                  <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
                    <span className="font-mono">{entry.serverUrl}</span>
                    {entry.docsUrl && (
                      <a
                        href={entry.docsUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="underline underline-offset-3 hover:text-foreground"
                      >
                        Docs
                      </a>
                    )}
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        </TabsContent>

        <TabsContent value="installed" className="mt-6">
          {installed.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No integrations installed yet.
            </p>
          ) : (
            <div className="space-y-2">
              {installed.map((inst) => (
                <Card key={inst.id} size="sm">
                  <CardContent className="flex items-center justify-between gap-4">
                    <div className="min-w-0">
                      <p className="text-sm font-medium truncate">
                        {inst.customName ??
                          inst.catalogEntry?.name ??
                          "Custom server"}
                      </p>
                      <p className="mt-0.5 text-xs text-muted-foreground font-mono truncate">
                        {inst.customUrl ?? inst.catalogEntry?.serverUrl}
                      </p>
                      {inst.catalogEntry?.docsUrl && (
                        <a
                          href={inst.catalogEntry.docsUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="mt-1 inline-block text-xs text-muted-foreground underline underline-offset-3 hover:text-foreground"
                        >
                          Documentation
                        </a>
                      )}
                    </div>
                    <Badge
                      variant={inst.status === "active" ? "secondary" : "outline"}
                      className="text-xs shrink-0"
                    >
                      {inst.status}
                    </Badge>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}
