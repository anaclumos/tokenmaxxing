import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { minBy } from "es-toolkit";
import { z } from "zod";
import { readItem, writeItem, deleteItem, liveTarget, parkedTarget, isolatedTarget, claudeAiOauthOnly, mergeIntoLive } from "./credstore.ts";
import { credItemFor, paths } from "./paths.ts";
import { withClaudeRefreshLock } from "./claudelock.ts";
import { withLock } from "./lock.ts";
import { readOAuthAccount } from "./claudejson.ts";
import { refreshCredential, isAccessTokenExpiring, isDeadCredential, fetchTokenIdentity, describeIdentity, IdentityUnavailableError, InvalidGrantError } from "./oauth.ts";
import { FullUsageSchema, pingSession, probeUsage } from "./usage.ts";
import { POST_SWAP_COOLDOWN_MS, loadAccounts, loadLastSwapAt, saveAccounts } from "./state.ts";
import { keepRotatedPair } from "./swap.ts";
import { log } from "./log.ts";
import { CredentialBlobSchema, TokenIdentitySchema, type Account, type Config, type OAuthCreds, type TokenIdentity } from "./types.ts";

const SampleOutcomeSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), usage: FullUsageSchema, pingError: z.string().optional(), pingRejected: z.boolean().optional() }),
  z.object({ ok: z.literal(false), reason: z.string(), pingError: z.string().optional(), pingRejected: z.boolean().optional() }),
]);
export type SampleOutcome = z.infer<typeof SampleOutcomeSchema>;

const IdentityCheckSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("match") }),
  z.object({ status: z.literal("mismatch"), reason: z.string(), owner: TokenIdentitySchema }),
  z.object({ status: z.literal("unavailable"), reason: z.string(), stale: z.boolean() }),
]);
type IdentityCheck = z.infer<typeof IdentityCheckSchema>;

async function checkIdentity(creds: OAuthCreds, account: Account): Promise<IdentityCheck> {
  let identity: TokenIdentity;
  try {
    identity = await fetchTokenIdentity(creds.accessToken);
  } catch (e) {
    return {
      status: "unavailable",
      reason: `credential identity check failed: ${e instanceof Error ? e.message : String(e)}`,
      stale: e instanceof IdentityUnavailableError && e.status === 401,
    };
  }
  if (identity.accountUuid === account.accountUuid) return { status: "match" };
  return { status: "mismatch", reason: `credential actually belongs to ${describeIdentity(identity)}`, owner: identity };
}

function refreshPlanFields(account: Account, creds: OAuthCreds): void {
  if (creds.subscriptionType != null) account.subscriptionType = creds.subscriptionType;
  if (creds.rateLimitTier != null) account.rateLimitTier = creds.rateLimitTier;
}

const ProbeFailureSchema = z.object({ ok: z.literal(false), reason: z.string() });
type ProbeFailure = z.infer<typeof ProbeFailureSchema>;
const PreparedProbeSchema = z.discriminatedUnion("ok", [z.object({ ok: z.literal(true), dir: z.string(), installed: z.string() }), ProbeFailureSchema]);
type PreparedProbe = z.infer<typeof PreparedProbeSchema>;

async function prepareParkedProbe(account: Account): Promise<PreparedProbe> {
  const backup = parkedTarget(account.keychainItem);
  const parkedRaw = await readItem(backup);
  if (!parkedRaw) return { ok: false, reason: "no parked credential - run `tokenmaxxing auth`" };

  let creds: OAuthCreds;
  try {
    creds = CredentialBlobSchema.parse(JSON.parse(parkedRaw)).claudeAiOauth;
  } catch (e) {
    return { ok: false, reason: `parked credential unreadable (${(e instanceof Error ? e.message : String(e)).slice(0, 80)}) - run \`tokenmaxxing auth\`` };
  }
  if (isDeadCredential(creds)) {
    account.needsReauth = true;
    return { ok: false, reason: "parked credential was cleared after a failed refresh - re-auth with `tokenmaxxing auth`" };
  }

  const liveRaw = await readItem(liveTarget());
  let liveAccount: string | null = null;
  let liveToken: string | null = null;
  if (liveRaw != null) {
    let liveCreds: OAuthCreds;
    try {
      liveCreds = CredentialBlobSchema.parse(JSON.parse(liveRaw)).claudeAiOauth;
    } catch (e) {
      return { ok: false, reason: `cannot read the live credential (${(e instanceof Error ? e.message : String(e)).slice(0, 80)}) - refusing to sample a possibly-live account` };
    }
    if (!isDeadCredential(liveCreds)) {
      liveToken = liveCreds.accessToken;
      try {
        liveAccount = (await fetchTokenIdentity(liveCreds.accessToken)).accountUuid;
      } catch (e) {
        return { ok: false, reason: `cannot verify the live credential's owner (${(e instanceof Error ? e.message : String(e)).slice(0, 80)}) - refusing to sample a possibly-live account` };
      }
      if (liveAccount === account.accountUuid) {
        return { ok: false, reason: "this account holds the LIVE login (active label drifted) - run `tokenmaxxing switch` to reconcile" };
      }
    }
  }

  const relocate = async (owner: TokenIdentity): Promise<string> => {
    const pooled = loadAccounts().accounts.find((a) => a.accountUuid === owner.accountUuid) ?? null;
    if (pooled == null || pooled.accountUuid === liveAccount) return "was left in place";
    await writeItem(parkedTarget(pooled.keychainItem), JSON.stringify({ claudeAiOauth: creds }));
    log("swap.parked_relocated", { account: pooled.accountUuid.slice(0, 8) });
    return "was copied to that account's slot";
  };

  if (isAccessTokenExpiring(creds, 300_000)) {
    const owner = await checkIdentity(creds, account);
    if (owner.status === "mismatch") {
      const kept = await relocate(owner.owner);
      account.needsReauth = true;
      return { ok: false, reason: `${owner.reason} - refusing to spend another account's grant; the pair ${kept}; re-auth with \`tokenmaxxing auth\`` };
    }
    if (owner.status === "unavailable" && !owner.stale) {
      return { ok: false, reason: `${owner.reason} - refusing to refresh a parked credential whose owner cannot be verified` };
    }
    const rotate = async (): Promise<{ fresh: OAuthCreds } | { failed: ProbeFailure }> => {
      try {
        return { fresh: await refreshCredential(creds) };
      } catch (e) {
        if (e instanceof InvalidGrantError) {
          account.needsReauth = true;
          return { failed: { ok: false, reason: "refresh token dead - re-auth with `tokenmaxxing auth`" } };
        }
        return { failed: { ok: false, reason: `token refresh failed: ${e instanceof Error ? e.message : String(e)}` } };
      }
    };
    let result: { fresh: OAuthCreds } | { failed: ProbeFailure };
    if (owner.status === "match") {
      result = await rotate();
    } else {
      try {
        result = await withClaudeRefreshLock(async (lock) => {
          const rotated = await rotate();
          if ("failed" in rotated) return rotated;
          const verified = await checkIdentity(rotated.fresh, account);
          if (verified.status !== "mismatch") return rotated;
          const trueOwner = loadAccounts().accounts.find((a) => a.accountUuid === verified.owner.accountUuid) ?? null;
          const kept = await keepRotatedPair({ fresh: rotated.fresh, owner: trueOwner, fallback: account, liveOwnerUuid: liveAccount, expectedLiveToken: liveToken, lock });
          account.needsReauth = true;
          return { failed: { ok: false, reason: `${verified.reason}, whose grant this refresh rotated - the rotated token ${kept}; re-auth with \`tokenmaxxing auth\`` } };
        });
      } catch (e) {
        return { ok: false, reason: `cannot arbitrate a stale parked credential: ${e instanceof Error ? e.message : String(e)}` };
      }
    }
    if ("failed" in result) return result.failed;
    creds = result.fresh;
    await writeItem(backup, JSON.stringify({ claudeAiOauth: creds }));
  }

  const identity = await checkIdentity(creds, account);
  if (identity.status === "mismatch") {
    const kept = await relocate(identity.owner);
    account.needsReauth = true;
    return { ok: false, reason: `${identity.reason} - this account's own credential is gone; the pair ${kept}; re-auth with \`tokenmaxxing auth\`` };
  }
  if (identity.status === "unavailable") {
    return { ok: false, reason: identity.reason };
  }
  refreshPlanFields(account, creds);

  const dir = join(paths.sampleDir, credItemFor(account.accountUuid));
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const installed = JSON.stringify({ claudeAiOauth: creds });
  try {
    await writeItem(isolatedTarget(dir), installed);
    writeFileSync(join(dir, ".claude.json"), JSON.stringify({ oauthAccount: account.oauthAccount, hasCompletedOnboarding: true }));
  } catch (e) {
    await finishParkedProbe(account, { dir, installed });
    throw e;
  }
  return { ok: true, dir, installed };
}

async function runParkedProbe(dir: string, opts: { ping?: boolean }): Promise<SampleOutcome> {
  const ping = opts.ping ? await pingSession(dir) : null;
  const usage = await probeUsage(dir, Date.now());
  const outcome: SampleOutcome = usage
    ? { ok: true, usage }
    : { ok: false, reason: "`/usage` returned no limit data (see log)" };
  if (ping != null) {
    outcome.pingError = ping.reason;
    outcome.pingRejected = ping.rejected;
  }
  return outcome;
}

async function finishParkedProbe(account: Account, prepared: { dir: string; installed: string }): Promise<void> {
  const isoTarget = isolatedTarget(prepared.dir);
  try {
    const afterIso = await readItem(isoTarget);
    if (afterIso && afterIso !== prepared.installed) await writeItem(parkedTarget(account.keychainItem), claudeAiOauthOnly(afterIso));
  } finally {
    await deleteItem(isoTarget);
    rmSync(prepared.dir, { recursive: true, force: true });
  }
}

export async function probeParkedUsage(account: Account, opts: { ping?: boolean } = {}): Promise<SampleOutcome> {
  const prepared = await prepareParkedProbe(account);
  if (!prepared.ok) return prepared;
  try {
    return await runParkedProbe(prepared.dir, opts);
  } finally {
    await finishParkedProbe(account, prepared);
  }
}

export async function sampleOldestParked(input: { cfg: Config; now: number }): Promise<void> {
  const { cfg, now } = input;
  const reserved = await withLock(paths.lockFile, async () => {
    const lastSwapAt = loadLastSwapAt();
    if (lastSwapAt != null && now - lastSwapAt < POST_SWAP_COOLDOWN_MS) return null;
    const idx = loadAccounts();
    const live = readOAuthAccount()?.accountUuid ?? null;
    const sampledAt = (a: Account) => Math.max(a.lastUsageAt ?? 0, a.lastProbeAt ?? 0);
    const stale = idx.accounts.filter((a) => a.accountUuid !== live && a.needsReauth !== true && now - sampledAt(a) > cfg.policy.usagePollTtlMs);
    const target = minBy(stale, sampledAt);
    if (!target) return null;
    target.lastProbeAt = now;
    const prepared = await prepareParkedProbe(target);
    saveAccounts(idx);
    if (!prepared.ok) {
      log("sample.parked_failed", { account: target.accountUuid.slice(0, 8), reason: prepared.reason.slice(0, 200) });
      return null;
    }
    return { account: target, prepared };
  });
  if (!reserved) return;
  const { account, prepared } = reserved;
  let outcome: SampleOutcome | null = null;
  try {
    outcome = await runParkedProbe(prepared.dir, {});
  } finally {
    await withLock(paths.lockFile, async () => {
      await finishParkedProbe(account, prepared);
      if (outcome == null) return;
      const idx = loadAccounts();
      const stored = idx.accounts.find((a) => a.accountUuid === account.accountUuid);
      if (stored && outcome.ok) {
        const at = Date.now();
        stored.lastUsage = { fiveHour: outcome.usage.session, sevenDay: outcome.usage.weekAll };
        stored.lastUsageAt = at;
        if (Object.keys(outcome.usage.perModel).length > 0) {
          stored.lastPerModel = outcome.usage.perModel;
          stored.lastPerModelAt = at;
        }
        saveAccounts(idx);
      }
      log(outcome.ok ? "sample.parked_ok" : "sample.parked_failed", {
        account: account.accountUuid.slice(0, 8),
        ...(outcome.ok ? {} : { reason: outcome.reason.slice(0, 200) }),
      });
    });
  }
}

export async function ensureLiveTokenFresh(): Promise<void> {
  const liveRaw = await readItem(liveTarget());
  if (!liveRaw) return;
  let creds: OAuthCreds;
  try {
    creds = CredentialBlobSchema.parse(JSON.parse(liveRaw)).claudeAiOauth;
  } catch {
    return;
  }
  if (isDeadCredential(creds)) throw new InvalidGrantError("live credential was cleared after a failed refresh");
  if (!isAccessTokenExpiring(creds, 300_000)) return;
  await withClaudeRefreshLock(async (lock) => {
    const raw2 = await readItem(liveTarget());
    if (raw2 == null) throw new Error("live credential vanished while waiting for the refresh lock");
    const current = CredentialBlobSchema.parse(JSON.parse(raw2)).claudeAiOauth;
    if (isDeadCredential(current)) throw new InvalidGrantError("live credential was cleared after a failed refresh");
    const next = isAccessTokenExpiring(current, 300_000) ? await refreshCredential(current) : current;
    if (next === current) return;
    if (lock.compromised()) throw new Error("refresh lock compromised mid-refresh - discarding the live rewrite");
    await writeItem(liveTarget(), mergeIntoLive(raw2, next));
  });
}

export async function probeActiveUsage(account: Account, opts: { ping?: boolean } = {}): Promise<SampleOutcome> {
  try {
    await ensureLiveTokenFresh();
  } catch (e) {
    if (e instanceof InvalidGrantError) return { ok: false, reason: "live refresh token dead - run `claude` and `/login`" };
    return { ok: false, reason: `token refresh failed: ${e instanceof Error ? e.message : String(e)}` };
  }
  const liveRaw = await readItem(liveTarget());
  if (!liveRaw) return { ok: false, reason: "no live credential - run `claude` and `/login`" };
  let creds: OAuthCreds;
  try {
    creds = CredentialBlobSchema.parse(JSON.parse(liveRaw)).claudeAiOauth;
  } catch (e) {
    return { ok: false, reason: `live credential blob unreadable (${(e instanceof Error ? e.message : String(e)).slice(0, 80)})` };
  }

  const identity = await checkIdentity(creds, account);
  if (identity.status === "mismatch") return { ok: false, reason: `live ${identity.reason} - active label drifted; run \`tokenmaxxing switch\`` };
  if (identity.status === "unavailable") return { ok: false, reason: identity.reason };
  refreshPlanFields(account, creds);

  const ping = opts.ping ? await pingSession() : null;
  const usage = await probeUsage();
  const outcome: SampleOutcome = usage ? { ok: true, usage } : { ok: false, reason: "`/usage` returned no limit data (see log)" };
  if (ping != null) {
    outcome.pingError = ping.reason;
    outcome.pingRejected = ping.rejected;
  }
  return outcome;
}
