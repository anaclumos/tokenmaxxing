import { Card, CardContent, CardHeader, CardTitle } from "@tokenmaxxing/ui/components/card";
import { cn } from "@tokenmaxxing/ui/lib/utils";
import Link from "next/link";

const endpoints = [
  {
    method: "GET",
    path: "/api/leaderboard",
    format: "JSON",
    auth: false,
    description:
      "Paginated global leaderboard. Add client or model param for filtered rankings computed on-the-fly.",
    params: [
      {
        name: "period",
        values: "daily | weekly | monthly | alltime",
        default: "alltime",
      },
      { name: "sort", values: "score | tokens | cost", default: "score" },
      { name: "page", values: "number", default: "1" },
      {
        name: "client",
        values: "claude-code | codex | cursor | ...",
        default: "none",
      },
      { name: "model", values: "any model name", default: "none" },
    ],
  },
  {
    method: "GET",
    path: "/api/users/[username]",
    format: "JSON",
    auth: false,
    description:
      "Public profile with token breakdown, rank, cache hit rate, earned badges, models/clients used, and daily activity history.",
    params: [],
  },
  {
    method: "GET",
    path: "/api/badge/[username]",
    format: "JSON",
    auth: false,
    description: "Shields.io-compatible JSON badge. Embed in README files.",
    params: [
      {
        name: "style",
        values: "tokens | cost | rank | streak | cache | achievement",
        default: "tokens",
      },
      {
        name: "format",
        values: "name | mark",
        default: "name (achievement only)",
      },
    ],
  },
  {
    method: "GET",
    path: "/api/card/[username]",
    format: "SVG",
    auth: false,
    description:
      "SVG profile card with stats and activity heatmap. Embed in README files or share.",
    params: [],
  },
  {
    method: "GET",
    path: "/api/wrapped/[username]",
    format: "SVG",
    auth: false,
    description:
      "SVG year-in-review card with yearly totals, top clients/models, streak, and compact badge marks.",
    params: [{ name: "year", values: "number", default: "current year" }],
  },
  {
    method: "POST",
    path: "/api/submit",
    format: "JSON",
    auth: true,
    description:
      "Submit usage records in batches of up to 500. Duplicates are deduplicated by sessionHash and the response includes newly unlocked derived badges.",
    params: [],
  },
  {
    method: "GET",
    path: "/api/me",
    format: "JSON",
    auth: true,
    description: "Current user stats and global rank for API-token clients.",
    params: [],
  },
  {
    method: "GET",
    path: "/api/tokens",
    format: "JSON",
    auth: true,
    description: "List API tokens for the signed-in Clerk user.",
    params: [],
  },
  {
    method: "POST",
    path: "/api/tokens",
    format: "JSON",
    auth: true,
    description: "Create a new API token for the signed-in Clerk user.",
    params: [],
  },
  {
    method: "PUT",
    path: "/api/settings/privacy",
    format: "JSON",
    auth: true,
    description: "Update the signed-in user's privacy mode from the web app.",
    params: [],
  },
  {
    method: "PUT",
    path: "/api/settings/weekly-digest",
    format: "JSON",
    auth: true,
    description: "Update the signed-in user's weekly digest opt-in setting.",
    params: [],
  },
  {
    method: "GET",
    path: "/api/orgs/export",
    format: "CSV or JSON",
    auth: true,
    description: "Export org usage data. Requires active Clerk org membership.",
    params: [
      { name: "format", values: "csv | json", default: "csv" },
      { name: "days", values: "7 | 30 | 90 | 0", default: "30" },
    ],
  },
] as const;

export function ApiDocs() {
  return (
    <main className="mx-auto w-full max-w-4xl px-6 py-8">
      <h1 className="mb-2 text-3xl font-bold tracking-tight">API</h1>
      <p className="mb-8 text-muted-foreground">
        Public endpoints return either JSON or SVG, depending on the route. Token-based endpoints
        require a <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-sm">Bearer</code>{" "}
        token from{" "}
        <Link href="/app/settings" className="underline">
          Settings
        </Link>
        , while browser settings endpoints use your Clerk session.
      </p>

      <div className="space-y-6">
        {endpoints.map((endpoint) => (
          <Card key={`${endpoint.method} ${endpoint.path}`}>
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center gap-3 text-base">
                <span
                  className={cn(
                    "rounded px-2 py-0.5 font-mono text-xs",
                    endpoint.method === "GET"
                      ? "bg-green-500/15 text-green-700 dark:text-green-400"
                      : "bg-blue-500/15 text-blue-700 dark:text-blue-400",
                  )}
                >
                  {endpoint.method}
                </span>
                <code className="font-mono">{endpoint.path}</code>
                <span className="rounded bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                  {endpoint.format}
                </span>
                {endpoint.auth && (
                  <span className="rounded bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                    auth
                  </span>
                )}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <p className="mb-3 text-sm text-muted-foreground">{endpoint.description}</p>
              {endpoint.params.length > 0 && (
                <div className="space-y-1">
                  {endpoint.params.map((param) => (
                    <div key={param.name} className="flex gap-4 text-sm">
                      <code className="font-mono text-foreground">{param.name}</code>
                      <span className="font-mono text-muted-foreground">{param.values}</span>
                      <span className="text-xs text-muted-foreground">
                        default: {param.default}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        ))}
      </div>

      <h2 className="mb-4 mt-12 text-xl font-semibold">CLI</h2>
      <div className="space-y-4">
        <Card>
          <CardContent className="pt-6">
            <code className="block rounded bg-muted px-4 py-3 font-mono text-sm">
              bunx tokenmaxxing submit
            </code>
            <p className="mt-3 text-sm text-muted-foreground">
              Parses local AI agent usage data and uploads to tokenmaxx.ing. Supports Claude Code,
              Codex, Gemini CLI, Cursor, OpenCode, Ampcode, Roo Code, and more.
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="pt-6">
            <code className="block rounded bg-muted px-4 py-3 font-mono text-sm">
              bunx tokenmaxxing wrapped --year 2025
            </code>
            <p className="mt-3 text-sm text-muted-foreground">
              Generates a local year-in-review image from your parsed usage data. Defaults to PNG
              output and also supports SVG.
            </p>
          </CardContent>
        </Card>
      </div>
    </main>
  );
}
