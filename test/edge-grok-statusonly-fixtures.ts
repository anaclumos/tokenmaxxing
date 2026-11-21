import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { AccountsIndexSchema, type Account } from "../src/lib/types.ts";
import { stubEnv } from "./edge-async-sweep-fixtures.ts";
import { storeDir } from "./edge-cli-surface-fixtures.ts";
import { fakeBin, scratchDir, serve, writePrivate } from "./edge-providers-fixtures.ts";
import type { Homes } from "./edge-telemetry-fixtures.ts";

const DAY_MS = 86_400_000;
const MAIN = join(import.meta.dir, "..", "src", "main.ts");
export const WEEK_S = 7 * 86_400;
export const ISOLATED_HOME = "<state>/onboard/grok-*";

type CreditsAnswer = { percent: number | null } | { status: number };

type CreditsStub = { base: string; url: string; periodEnd: number; bearers: string[]; stop: () => void };

export function serveGrokCredits(tokens: Record<string, CreditsAnswer>): CreditsStub {
  const periodStart = Math.floor(Date.now() / 1000) * 1000 - 2 * DAY_MS;
  const periodEnd = periodStart + 7 * DAY_MS;
  const bearers: string[] = [];
  const stub = serve((req) => {
    const url = new URL(req.url);
    if (url.pathname !== "/v1/billing" || url.searchParams.get("format") !== "credits") return Response.json({ error: "not_found" }, { status: 404 });
    const token = (req.headers.get("authorization") ?? "").replace(/^Bearer /, "");
    bearers.push(token);
    const answer = tokens[token] ?? { status: 401 };
    if ("status" in answer) return Response.json({ error: "unauthorized", error_description: "The access token was revoked." }, { status: answer.status });
    const currentPeriod = { start: new Date(periodStart).toISOString(), end: new Date(periodEnd).toISOString() };
    return Response.json({ config: answer.percent === null ? { currentPeriod } : { currentPeriod, creditUsagePercent: answer.percent } });
  });
  return { ...stub, url: `${stub.base}/v1/billing?format=credits`, periodEnd, bearers };
}

export function grokEnv(homes: Homes, stub: { base: string; url: string }, extra: Record<string, string> = {}): Record<string, string> {
  return { ...stubEnv(homes, stub.base), TOKENMAXXING_GROK_USAGE_URL: stub.url, ...extra };
}

export function grokEntry(id: string, input: { email?: string; key?: string; refresh?: string; expiresAt?: number } = {}): Record<string, unknown> {
  return {
    user_id: id,
    ...(input.email === undefined ? {} : { email: input.email, first_name: "Dev" }),
    key: input.key ?? `key-${id.slice(0, 8)}`,
    refresh_token: input.refresh ?? `refresh-${id.slice(0, 8)}`,
    ...(input.expiresAt === undefined ? {} : { expires_at: new Date(input.expiresAt).toISOString() }),
  };
}

type FakeGrok = { bin: string; dir: string; runs: () => { grokHome: string; args: string }[] };

export function installGrok(input: { login?: Record<string, unknown>; exitCode?: number } = {}): FakeGrok {
  const dir = scratchDir("grok-bin");
  const log = join(dir, "runs.log");
  const login = join(dir, "login.json");
  if (input.login !== undefined) writeFileSync(login, JSON.stringify(input.login, null, 2));
  const bin = fakeBin(
    dir,
    "grok",
    [
      'if [ "$1" = "--version" ]; then echo "grok 0.1.5"; exit 0; fi',
      `printf '%s\\t%s\\n' "\${GROK_HOME-<unset>}" "$*" >> '${log}'`,
      `if [ "$1" = "login" ] && [ -f '${login}' ]; then cp '${login}' "$GROK_HOME/auth.json"; fi`,
      `exit ${input.exitCode ?? 0}`,
    ].join("\n"),
  );
  const runs = () =>
    (existsSync(log) ? readFileSync(log, "utf8").split("\n") : [])
      .filter((line) => line !== "")
      .map((line) => ({ grokHome: line.slice(0, line.indexOf("\t")), args: line.slice(line.indexOf("\t") + 1) }));
  return { bin, dir, runs };
}

export function loginRuns(homes: Homes, grok: FakeGrok): { grokHome: string; args: string }[] {
  const isolated = join(homes.state, "onboard", "grok-");
  return grok.runs().map((r) => ({ grokHome: r.grokHome.startsWith(isolated) ? ISOLATED_HOME : r.grokHome, args: r.args }));
}

export function pinGrokBin(homes: Homes, bin: string): void {
  const path = join(homes.state, "config.json");
  const config = z.record(z.string(), z.unknown()).parse(JSON.parse(readFileSync(path, "utf8")));
  writeFileSync(path, JSON.stringify({ ...config, grokBin: bin }));
}

export function withPath(dir: string): { PATH: string } {
  return { PATH: `${dir}:${process.env.PATH ?? ""}` };
}

export function grokAuthText(logins: Record<string, unknown>): string {
  return JSON.stringify(logins, null, 2);
}

export function writeGrokAuth(dir: string, logins: Record<string, unknown>): void {
  writePrivate(join(dir, "auth.json"), grokAuthText(logins));
}

export function storeGrokLogin(homes: Homes, id: string, entry: Record<string, unknown>): void {
  writeGrokAuth(storeDir(homes, "grok", id), { [id]: entry });
}

export function pooledGrok(id: string, email: string): Account {
  return { id, label: email, email, tier: null, addedAt: new Date(0).toISOString(), windows: [] };
}

export function grokStore(homes: Homes, id: string): { doc: unknown; mode: number } | null {
  const path = join(storeDir(homes, "grok", id), "auth.json");
  if (!existsSync(path)) return null;
  const doc: unknown = JSON.parse(readFileSync(path, "utf8"));
  return { doc, mode: statSync(path).mode & 0o777 };
}

export function grokAccounts(homes: Homes): { id: string; label: string; email: string | null }[] {
  const path = join(homes.state, "grok-accounts.json");
  if (!existsSync(path)) return [];
  return AccountsIndexSchema.parse(JSON.parse(readFileSync(path, "utf8"))).accounts.map((a) => ({ id: a.id, label: a.label, email: a.email }));
}

export function listed(dir: string): string[] {
  return existsSync(dir) ? readdirSync(dir).toSorted() : [];
}

export function fileTree(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of listed(root)) {
    const path = join(root, name);
    if (statSync(path).isFile()) out[name] = readFileSync(path, "utf8");
    else for (const [inner, text] of Object.entries(fileTree(path))) out[`${name}/${inner}`] = text;
  }
  return out;
}

const WindowSchema = z.object({ usedPercentage: z.number(), bufferedPercentage: z.number(), resetsAt: z.number().nullable(), windowSeconds: z.number().nullable() });
const GrokAccountReportSchema = z.looseObject({
  id: z.string(),
  active: z.boolean(),
  sessions: z.number(),
  needsReauth: z.boolean(),
  exhausted: z.boolean(),
  usage: z.object({ fiveHour: WindowSchema.nullable(), week: WindowSchema.nullable(), limits: z.array(z.unknown()) }).nullable(),
  sample: z.union([z.object({ ok: z.literal(true), source: z.string() }), z.object({ ok: z.literal(false), reason: z.string() })]),
});
const GrokReportSchema = z.object({ accounts: z.array(GrokAccountReportSchema) });
type GrokAccountReport = z.infer<typeof GrokAccountReportSchema>;

export function grokReport(doc: Record<string, unknown> | null, id: string): Pick<GrokAccountReport, "active" | "sessions" | "needsReauth" | "exhausted" | "usage" | "sample"> | null {
  const report = GrokReportSchema.safeParse(doc?.grok);
  const account = report.success ? report.data.accounts.find((a) => a.id === id) : undefined;
  if (account === undefined) return null;
  return { active: account.active, sessions: account.sessions, needsReauth: account.needsReauth, exhausted: account.exhausted, usage: account.usage, sample: account.sample };
}

export function grokCards(stdout: string): { header: string | null; cards: Record<string, string[]> } {
  const lines = stdout.split("\n");
  const start = lines.findIndex((line) => line.startsWith("grok  ("));
  if (start === -1) return { header: null, cards: {} };
  const cards: Record<string, string[]> = {};
  let card: string[] | null = null;
  for (const line of lines.slice(start + 1)) {
    if (/^\S+ {2}\(/.test(line)) break;
    if (line.trim() === "") card = null;
    else if (line.startsWith(" ")) card?.push(line.trim());
    else {
      card = [];
      cards[line.split(" ")[1] ?? ""] = card;
    }
  }
  return { header: lines[start] ?? null, cards };
}

export function barRows(card: string[] | undefined): string[] {
  return (card ?? []).flatMap((line) => {
    const bar = /^(\S+)\s+\S+\s+(\d+)%$/.exec(line);
    return bar ? [`${bar[1]} ${bar[2]}%`] : [];
  });
}

export function writeLeftoverGrokPresence(homes: Homes, input: { sessionId: string; accountId: string; pid: number }): string {
  const ps = Bun.spawnSync(["ps", "-p", String(input.pid), "-o", "lstart="], { env: { ...process.env, LC_ALL: "C" } });
  const startedAt = ps.stdout.toString().trim();
  const dir = join(homes.state, "grok-live");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, input.sessionId), JSON.stringify({ accountId: input.accountId, pid: input.pid, startedAt }));
  return startedAt;
}

export function installLeftoverGrokWrapper(homes: Homes): { binDir: string; wrapper: string } {
  const binDir = join(homes.state, "bin");
  const entry = join(binDir, "tokenmaxxing");
  const wrapper = join(binDir, "grok");
  mkdirSync(binDir, { recursive: true });
  writeFileSync(entry, `#!/bin/sh\nexec '${process.execPath}' --no-env-file run '${MAIN}' "$@"\n`, { mode: 0o755 });
  writeFileSync(join(binDir, "claude"), `#!/bin/sh\nexec '${entry}' __supervise "$@"\n`, { mode: 0o755 });
  writeFileSync(wrapper, `#!/bin/sh\nexec '${entry}' __supervise-grok "$@"\n`, { mode: 0o755 });
  return { binDir, wrapper };
}

export async function runBin(bin: string, args: string[], env: Record<string, string>, cwd: string): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn([bin, ...args], { env, cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { exitCode, stdout, stderr };
}
