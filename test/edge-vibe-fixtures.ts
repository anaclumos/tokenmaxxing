import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { AccountsIndexSchema, type Account } from "../src/lib/types.ts";
import { stubEnv } from "./edge-async-sweep-fixtures.ts";
import { storeDir } from "./edge-cli-surface-fixtures.ts";
import { fakeBin, serve, writePrivate } from "./edge-providers-fixtures.ts";
import type { Homes } from "./edge-telemetry-fixtures.ts";

export const DAY_S = 86_400;

export type MistralUser = { id: string; email: string; organization?: { id: string } };

export type MistralStub = { base: string; apiUrl: string; calls: { path: string; key: string }[]; stop: () => void };

export function vibeIdentity(user: string, organization?: string): string {
  return new Bun.CryptoHasher("sha256").update(organization === undefined ? user : `${user}:${organization}`).digest("hex");
}

export function budgetBody(usagePercentage: number, resetAt: string): unknown {
  return {
    vibe_budget: { usage_percentage: usagePercentage, initial_budget: 150, currency: "USD", reset_at: resetAt, payg_enabled: false },
    api_budget: { usage_percentage: 5, initial_budget: 15, currency: "USD", reset_at: resetAt, payg_enabled: false },
  };
}

export function serveMistral(input: { users: Record<string, MistralUser>; budgets?: Record<string, unknown>; refusals?: Record<string, number> }): MistralStub {
  const calls: { path: string; key: string }[] = [];
  const defaultReset = new Date(Date.now() + 20 * DAY_S * 1000).toISOString();
  const stub = serve((req) => {
    const path = new URL(req.url).pathname;
    const key = (req.headers.get("authorization") ?? "").replace(/^Bearer /, "");
    calls.push({ path, key });
    const refusal = input.refusals?.[key];
    if (refusal !== undefined) return Response.json({ detail: `HTTP ${refusal}` }, { status: refusal });
    const user = input.users[key];
    if (user === undefined) return Response.json({ detail: "Unauthorized" }, { status: 401 });
    if (path === "/mistral/v1/users/me") return Response.json({ ...user, workspace: { id: "workspace_test" } });
    if (path === "/mistral/v1/billing/subscription") return Response.json({ plan_name: "Pro", vibe_payg_enabled: false });
    if (path === "/mistral/v1/billing/budget") return Response.json(input.budgets?.[key] ?? budgetBody(0, defaultReset));
    return Response.json({ detail: "Not Found" }, { status: 404 });
  });
  return { ...stub, apiUrl: `${stub.base}/mistral`, calls };
}

export function installFakeVibe(homes: Homes, setupKey: string | null): { bin: string; dir: string; setups: () => string[] } {
  const dir = join(homes.home, "fake-vibe");
  const log = join(dir, "setups.log");
  const bin = fakeBin(
    dir,
    "vibe",
    [
      'if [ "$1" = "--version" ]; then echo "vibe 3.1.0"; exit 0; fi',
      '[ "$1" = "--setup" ] || exit 9',
      `printf '%s\\n' "$VIBE_HOME" >> '${log}'`,
      setupKey === null ? "exit 1" : `printf "MISTRAL_API_KEY='%s'\\n" '${setupKey}' > "$VIBE_HOME/.env"`,
    ].join("\n"),
  );
  return { bin, dir, setups: () => (existsSync(log) ? readFileSync(log, "utf8").split("\n").filter((line) => line !== "") : []) };
}

export function pinVibeBin(homes: Homes, bin: string): void {
  const path = join(homes.state, "config.json");
  const config = z.record(z.string(), z.unknown()).parse(JSON.parse(readFileSync(path, "utf8")));
  writeFileSync(path, JSON.stringify({ ...config, vibeBin: bin }));
}

export function vibeEnv(homes: Homes, stub: MistralStub, input: { binDir: string; vibeHome?: string }): Record<string, string> {
  const env: Record<string, string> = { ...stubEnv(homes, stub.base), TOKENMAXXING_VIBE_API_URL: stub.apiUrl, PATH: `${input.binDir}:${process.env.PATH ?? ""}` };
  delete env.MISTRAL_API_KEY;
  delete env.VIBE_CLI_OIDC_ENABLED;
  if (input.vibeHome !== undefined) env.VIBE_HOME = input.vibeHome;
  return env;
}

export function writeVibeStore(homes: Homes, id: string, apiKey: string): void {
  writePrivate(join(storeDir(homes, "vibe", id), "auth.json"), JSON.stringify({ id, apiKey }));
}

export function vibeAccounts(homes: Homes): Account[] {
  const path = join(homes.state, "vibe-accounts.json");
  return existsSync(path) ? AccountsIndexSchema.parse(JSON.parse(readFileSync(path, "utf8"))).accounts : [];
}

export function vibeStore(homes: Homes, id: string): { doc: unknown; mode: number } | null {
  const path = join(storeDir(homes, "vibe", id), "auth.json");
  if (!existsSync(path)) return null;
  const doc: unknown = JSON.parse(readFileSync(path, "utf8"));
  return { doc, mode: statSync(path).mode & 0o777 };
}

export function vibeStoreDirs(homes: Homes): string[] {
  const dir = join(homes.state, "vibe-stores");
  return existsSync(dir) ? readdirSync(dir).toSorted() : [];
}

export function vibeOnboardLeft(homes: Homes): string[] {
  const dir = join(homes.state, "onboard");
  return existsSync(dir) ? readdirSync(dir).filter((name) => name.startsWith("vibe-")) : [];
}
