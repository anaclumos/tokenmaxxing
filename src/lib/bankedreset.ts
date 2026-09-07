import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import { MAX_WRAP_DEPTH, WRAP_DEPTH_ENV, resolveRealClaude } from "./claudebin.ts";
import { liveTarget, readItem } from "./credstore.ts";
import { http, safeErrorDetail } from "./http.ts";
import { log } from "./log.ts";
import { InvalidGrantError, fetchTokenIdentity } from "./oauth.ts";
import { ensureLiveTokenFresh } from "./sample.ts";
import { clearDepletedWait, clearNextCheck, loadAccounts, loadUsage, saveAccounts, saveLastResetAt, writeUsage } from "./state.ts";
import { normalizeResetsAt } from "./usage.ts";
import { CredentialBlobSchema, type Account, type BankedResetOutcome, type BankedResetRecord } from "./types.ts";

const EnvOverrideSchema = z.string().min(1).optional().catch(undefined);
const API_BASE_URL = EnvOverrideSchema.parse(process.env.TOKENMAXXING_OAUTH_API_BASE_URL) ?? "https://api.anthropic.com";
const OAUTH_BETA = "oauth-2025-04-20";
const RESET_PROGRAM = "juniper_tide";
const CLAIM_TIMEOUT_MS = 25_000;
const VERSION_PROBE_TIMEOUT_MS = 5_000;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const INELIGIBLE_TTL_MS = 24 * 60 * 60 * 1000;

const ClaimResponseSchema = z.looseObject({
  result: z.enum(["reset", "already_used", "not_limited", "ineligible", "unavailable"]).catch("unavailable"),
  next_available_at: z.union([z.string(), z.number()]).nullable().optional().catch(null),
});

const ClaimSchema = z.object({ outcome: z.enum(["reset", "pass"]) });
export type Claim = z.infer<typeof ClaimSchema>["outcome"];

export function bankedResetBelievedAvailable(account: Account, now: number): boolean {
  const rec = account.bankedReset;
  if (!rec) return true;
  if (rec.nextAvailableAt != null) return rec.nextAvailableAt <= now;
  if (rec.outcome === "reset" || rec.outcome === "already_used") return now - rec.at >= WEEK_MS;
  if (rec.outcome === "ineligible") return now - rec.at >= INELIGIBLE_TTL_MS;
  return true;
}

const VersionSchema = z.string().regex(/^\d+\.\d+\.\d+\S*$/);
const PackageJsonSchema = z.looseObject({ version: VersionSchema });

function claudeVersion(): string | undefined {
  let bin: string;
  try {
    bin = resolveRealClaude();
  } catch {
    return undefined;
  }
  const fromPath = VersionSchema.safeParse(bin.match(/\/versions\/(\d+\.\d+\.\d+[^/]*)$/)?.[1]);
  if (fromPath.success) return fromPath.data;
  try {
    const pkg = PackageJsonSchema.safeParse(JSON.parse(readFileSync(join(dirname(bin), "package.json"), "utf8")));
    if (pkg.success) return pkg.data.version;
  } catch {
  }
  try {
    const r = Bun.spawnSync([bin, "--version"], {
      env: { ...process.env, TOKENMAXXING_PROBE: "1", [WRAP_DEPTH_ENV]: String(MAX_WRAP_DEPTH) },
      stdout: "pipe",
      stderr: "pipe",
      timeout: VERSION_PROBE_TIMEOUT_MS,
    });
    const spawned = VersionSchema.safeParse(r.stdout.toString("utf8").trim().match(/^(\d+\.\d+\.\d+\S*)/)?.[1]);
    if (spawned.success) return spawned.data;
  } catch {
  }
  return undefined;
}

function claudeUserAgent(): string {
  const version = claudeVersion();
  return version ? `claude-cli/${version} (external, cli)` : "claude-cli (external, cli)";
}

const LiveTokenSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), accessToken: z.string(), organizationUuid: z.string() }),
  z.object({ ok: z.literal(false), outcome: z.enum(["auth_error", "error"]), detail: z.string() }),
]);
type LiveToken = z.infer<typeof LiveTokenSchema>;

async function liveTokenFor(account: Account): Promise<LiveToken> {
  try {
    await ensureLiveTokenFresh();
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    return { ok: false, outcome: e instanceof InvalidGrantError ? "auth_error" : "error", detail };
  }
  const raw = await readItem(liveTarget());
  if (!raw) return { ok: false, outcome: "auth_error", detail: "no live credential" };
  let accessToken: string;
  try {
    accessToken = CredentialBlobSchema.parse(JSON.parse(raw)).claudeAiOauth.accessToken;
  } catch (e) {
    return { ok: false, outcome: "error", detail: `live credential blob unreadable (${(e instanceof Error ? e.message : String(e)).slice(0, 80)})` };
  }
  let identity;
  try {
    identity = await fetchTokenIdentity(accessToken);
  } catch (e) {
    return { ok: false, outcome: "error", detail: e instanceof Error ? e.message : String(e) };
  }
  if (identity.accountUuid !== account.accountUuid) {
    return { ok: false, outcome: "error", detail: `live credential belongs to account ${identity.accountUuid.slice(0, 8)}, not the seat` };
  }
  return { ok: true, accessToken, organizationUuid: identity.organizationUuid };
}

const PostResultSchema = z.object({ outcome: z.enum(["reset", "already_used", "not_limited", "ineligible", "unavailable", "rate_limited", "auth_error", "error"]), nextAvailableAt: z.number().nullable(), detail: z.string() });
type PostResult = z.infer<typeof PostResultSchema>;

async function postClaim(input: { accessToken: string; organizationUuid: string }): Promise<PostResult> {
  const url = `${API_BASE_URL}/api/organizations/${input.organizationUuid}/reset_rate_limits`;
  let res: Response;
  try {
    res = await http.post(url, {
      headers: {
        Authorization: `Bearer ${input.accessToken}`,
        "anthropic-beta": OAUTH_BETA,
        "Content-Type": "application/json",
        "User-Agent": claudeUserAgent(),
      },
      body: JSON.stringify({ program: RESET_PROGRAM }),
      timeout: CLAIM_TIMEOUT_MS,
    });
  } catch (e) {
    return { outcome: "error", nextAvailableAt: null, detail: `reset endpoint unreachable: ${e instanceof Error ? e.message : String(e)}` };
  }
  const text = await res.text();
  if (!res.ok) {
    const detail = `HTTP ${res.status}: ${safeErrorDetail({ text })}`;
    if (res.status === 429) return { outcome: "rate_limited", nextAvailableAt: null, detail };
    if (res.status === 401 || res.status === 403) return { outcome: "auth_error", nextAvailableAt: null, detail };
    return { outcome: "error", nextAvailableAt: null, detail };
  }
  const parsed = ClaimResponseSchema.safeParse((() => {
    try { return JSON.parse(text); } catch { return null; }
  })());
  if (!parsed.success) return { outcome: "error", nextAvailableAt: null, detail: `reset endpoint returned an unrecognized body (${text.length} bytes, withheld)` };
  return { outcome: parsed.data.result, nextAvailableAt: normalizeResetsAt(parsed.data.next_available_at), detail: parsed.data.result };
}

function record(accountUuid: string, rec: BankedResetRecord, reset: boolean, now: number): void {
  const idx = loadAccounts();
  const account = idx.accounts.find((a) => a.accountUuid === accountUuid);
  if (!account) return;
  account.bankedReset = rec;
  if (reset) {
    delete account.enforcedUntil;
    if (account.lastUsage) {
      account.lastUsage = { ...account.lastUsage, fiveHour: { usedPercentage: 0, resetsAt: null } };
      account.lastUsageAt = now;
    }
  }
  saveAccounts(idx);
  if (!reset) return;
  const u = loadUsage();
  if (u && u.account === accountUuid) {
    writeUsage({ ...u, fiveHour: { usedPercentage: 0, resetsAt: null }, ts: now }, { stamp: true });
  }
  saveLastResetAt(now);
  clearDepletedWait();
  clearNextCheck();
}

export async function claimBankedReset(input: { account: Account; now: number }): Promise<Claim> {
  const { account, now } = input;
  const short = account.accountUuid.slice(0, 8);
  const token = await liveTokenFor(account);
  let result: PostResult;
  if (!token.ok) {
    result = { outcome: token.outcome, nextAvailableAt: null, detail: token.detail };
  } else {
    result = await postClaim({ accessToken: token.accessToken, organizationUuid: token.organizationUuid });
  }
  const outcome: BankedResetOutcome = result.outcome;
  const reset = outcome === "reset";
  record(account.accountUuid, { outcome, at: now, nextAvailableAt: result.nextAvailableAt }, reset, now);
  log(reset ? "bankedreset.claimed" : "bankedreset.refused", {
    account: short,
    outcome,
    nextAvailableAt: result.nextAvailableAt,
    detail: reset ? undefined : result.detail.slice(0, 200),
  });
  return reset ? "reset" : "pass";
}
