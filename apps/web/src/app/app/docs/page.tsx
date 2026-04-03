import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@tokenmaxxing/ui/components/card";
import { cn } from "@tokenmaxxing/ui/lib/utils";

export const metadata = { title: "API Docs - tokenmaxx.ing" };

const endpoints = [
  {
    method: "GET",
    path: "/api/leaderboard",
    auth: false,
    description: "Paginated global leaderboard. Add client or model param for filtered rankings computed on-the-fly.",
    params: [
      { name: "period", values: "daily | weekly | monthly | alltime", default: "alltime" },
      { name: "sort", values: "score | tokens | cost", default: "score" },
      { name: "page", values: "number", default: "1" },
      { name: "client", values: "claude-code | codex | cursor | ...", default: "none" },
      { name: "model", values: "any model name", default: "none" },
    ],
  },
  {
    method: "GET",
    path: "/api/users/[username]",
    auth: false,
    description: "Public profile with token breakdown, rank, cache hit rate, models/clients used, and daily activity history.",
    params: [],
  },
  {
    method: "GET",
    path: "/api/badge/[username]",
    auth: false,
    description: "Shields.io-compatible JSON badge. Embed in README files.",
    params: [
      { name: "style", values: "tokens | cost | rank | streak | cache", default: "tokens" },
    ],
  },
  {
    method: "GET",
    path: "/api/card/[username]",
    auth: false,
    description: "SVG profile card with stats and activity heatmap. Embed in README files or share.",
    params: [],
  },
  {
    method: "POST",
    path: "/api/submit",
    auth: true,
    description: "Submit usage records in batches of up to 500. Duplicates are deduplicated by sessionHash.",
    params: [],
  },
  {
    method: "GET",
    path: "/api/me",
    auth: true,
    description: "Current user stats and global rank.",
    params: [],
  },
  {
    method: "GET",
    path: "/api/orgs/export",
    auth: true,
    description: "Export org usage data. Requires active Clerk org membership.",
    params: [
      { name: "format", values: "csv | json", default: "csv" },
      { name: "days", values: "7 | 30 | 90 | 0", default: "30" },
    ],
  },
] as const;

export default function DocsPage() {
  return (
    <main className="mx-auto w-full max-w-4xl px-6 py-8">
      <h1 className="mb-2 text-3xl font-bold tracking-tight">API</h1>
      <p className="mb-8 text-muted-foreground">
        All public endpoints return JSON with CORS enabled. Authenticated endpoints require a{" "}
        <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-sm">Bearer</code> token from{" "}
        <a href="/app/settings" className="underline">Settings</a>.
      </p>

      <div className="space-y-6">
        {endpoints.map((ep) => (
          <Card key={`${ep.method} ${ep.path}`}>
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center gap-3 text-base">
                <span className={cn("rounded px-2 py-0.5 font-mono text-xs", ep.method === "GET" ? "bg-green-500/15 text-green-700 dark:text-green-400" : "bg-blue-500/15 text-blue-700 dark:text-blue-400")}>
                  {ep.method}
                </span>
                <code className="font-mono">{ep.path}</code>
                {ep.auth && (
                  <span className="rounded bg-muted px-2 py-0.5 text-xs text-muted-foreground">auth</span>
                )}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <p className="mb-3 text-sm text-muted-foreground">{ep.description}</p>
              {ep.params.length > 0 && (
                <div className="space-y-1">
                  {ep.params.map((p) => (
                    <div key={p.name} className="flex gap-4 text-sm">
                      <code className="font-mono text-foreground">{p.name}</code>
                      <span className="font-mono text-muted-foreground">{p.values}</span>
                      <span className="text-xs text-muted-foreground">default: {p.default}</span>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        ))}
      </div>

      <h2 className="mb-4 mt-12 text-xl font-semibold">CLI</h2>
      <Card>
        <CardContent className="pt-6">
          <code className="block rounded bg-muted px-4 py-3 font-mono text-sm">
            bunx tokenmaxxing submit
          </code>
          <p className="mt-3 text-sm text-muted-foreground">
            Parses local AI agent usage data and uploads to tokenmaxx.ing.
            Supports Claude Code, Codex, Gemini CLI, Cursor, OpenCode, Ampcode, Roo Code, and more.
          </p>
        </CardContent>
      </Card>
    </main>
  );
}
