import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { Account } from "../src/lib/types.ts";
import { stubEnv } from "./edge-async-sweep-fixtures.ts";
import { storeDir } from "./edge-cli-surface-fixtures.ts";
import { fakeBin, serve, writePrivate } from "./edge-providers-fixtures.ts";
import type { Homes } from "./edge-telemetry-fixtures.ts";

const DAY_S = 86_400;
export const SESSION_S = 5 * 3600;
export const WEEK_S = 7 * DAY_S;

export function fakeJwt(payload: Record<string, unknown>): string {
  const head = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${head}.${body}.sig`;
}

export function agyIdentity(sub: string, project?: string): string {
  const owner = project === undefined ? sub : `${sub}:gcp:${project}`;
  return new Bun.CryptoHasher("sha256").update(owner).digest("hex");
}

export function agyToken(input: { sub: string; email?: string; access?: string; refresh?: string; expiry?: string; project?: string; authMethod?: string }): unknown {
  const idToken = fakeJwt({ sub: input.sub, email: input.email ?? `${input.sub}@example.com` });
  return {
    token: {
      access_token: input.access ?? "agy-access",
      refresh_token: input.refresh ?? "agy-refresh",
      token_type: "Bearer",
      expiry: input.expiry ?? new Date(Date.now() + 3600_000).toISOString(),
    },
    auth_method: input.authMethod ?? "consumer",
    id_token: idToken,
    id_token_email: input.email ?? `${input.sub}@example.com`,
    ...(input.project ? { project_id: input.project } : {}),
  };
}

export function quotaSummaryBody(remaining5h: number, remainingWeekly: number, reset5h: string, resetWeekly: string): unknown {
  return {
    groups: [
      {
        displayName: "Gemini Models",
        buckets: [
          { window: "5h", bucketId: "five_hour", remainingFraction: remaining5h, resetTime: reset5h },
          { window: "weekly", bucketId: "weekly", remainingFraction: remainingWeekly, resetTime: resetWeekly },
        ],
      },
    ],
  };
}

export function serveAgyQuota(input: { loadBody?: unknown; summaryBodies?: Record<string, unknown> }): { base: string; apiUrl: string; stop: () => void } {
  const loadBody = input.loadBody ?? { paidTier: { id: "g1-pro-tier", name: "Pro" } };
  const stub = serve((req) => {
    const url = new URL(req.url);
    const path = url.pathname;
    const bearer = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
    if (path.endsWith(":loadCodeAssist")) return Response.json(loadBody);
    if (path.endsWith(":retrieveUserQuotaSummary")) {
      const body = input.summaryBodies?.[bearer] ?? quotaSummaryBody(0.4, 0.7, new Date(Date.now() + SESSION_S * 1000).toISOString(), new Date(Date.now() + WEEK_S * 1000).toISOString());
      return Response.json(body);
    }
    return Response.json({ detail: "Not Found" }, { status: 404 });
  });
  return { base: stub.base, apiUrl: `${stub.base}/agy`, stop: stub.stop };
}

export function installFakeAgy(homes: Homes, tokenJson: string): { bin: string; dir: string; logins: () => string[] } {
  const dir = join(homes.home, "fake-agy");
  const log = join(dir, "logins.log");
  const bin = fakeBin(
    dir,
    "agy",
    [
      'if [ "$1" = "--version" ]; then echo "1.5.12"; exit 0; fi',
      '[ $# -eq 0 ] || exit 9',
      `token_dir="$HOME/.gemini/antigravity-cli"`,
      'mkdir -p "$token_dir"',
      `printf '%s\\n' '${tokenJson.replace(/'/g, `'\"'\"'`)}' > "$token_dir/antigravity-oauth-token"`,
      `printf '%s\\n' "$HOME" >> '${log}'`,
    ].join("\n"),
  );
  return { bin, dir, logins: () => (existsSync(log) ? readFileSync(log, "utf8").split("\n").filter((line) => line !== "") : []) };
}

export function pinAgyBin(homes: Homes, bin: string): void {
  const path = join(homes.state, "config.json");
  const config = z.record(z.string(), z.unknown()).parse(JSON.parse(readFileSync(path, "utf8")));
  writeFileSync(path, JSON.stringify({ ...config, agyBin: bin }));
}

export function agyEnv(homes: Homes, stub: { apiUrl: string }, input: { binDir: string; agyHome?: string }): Record<string, string> {
  const env: Record<string, string> = { ...stubEnv(homes, stub.apiUrl.replace(/\/agy$/, "")), TOKENMAXXING_AGY_API_URL: stub.apiUrl, PATH: `${input.binDir}:${process.env.PATH ?? ""}` };
  if (input.agyHome !== undefined) env.AGY_HOME = input.agyHome;
  return env;
}

export function writeAgyStore(homes: Homes, id: string, token: unknown): void {
  writePrivate(join(storeDir(homes, "agy", id), "antigravity-oauth-token"), JSON.stringify(token, null, 2));
}

export function agyAccounts(homes: Homes): Account[] {
  const path = join(homes.state, "agy-accounts.json");
  const AccountsIndexSchema = z.object({ accounts: z.array(z.looseObject({ id: z.string() })) });
  return existsSync(path) ? (AccountsIndexSchema.parse(JSON.parse(readFileSync(path, "utf8"))).accounts as Account[]) : [];
}