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
import { FullUsageSchema, probeUsage } from "./usage.ts";
import { POST_SWAP_COOLDOWN_MS, loadAccounts, loadLastSwapAt, saveAccounts } from "./state.ts";
import { keepRotatedPair } from "./swap.ts";
import { log } from "./log.ts";
import { CredentialBlobSchema, TokenIdentitySchema, type Account, type Config, type OAuthCreds, type TokenIdentity } from "./types.ts";

const SampleOutcomeSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), usage: FullUsageSchema }),
  z.object({ ok: z.literal(false), reason: z.string() }),
]);
export type SampleOutcome = z.infer<typeof SampleOutcomeSchema>;

const IdentityCheckSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("match") }),
  z.object({ status: z.literal("mismatch"), reason: z.string(), owner: TokenIdentitySchema }),
  z.object({ status: z.literal("unavailable"), reason: z.string(), stale: z.boolean() }),
]);
type IdentityCheck = z.infer<typeof IdentityCheckSchema>;

async function checkIdentity(creds: OAuthCreds, account: Account, signal?: AbortSignal): Promise<IdentityCheck> {
  let identity: TokenIdentity;
  try {
    identity = await fetchTokenIdentity(creds.accessToken, signal);
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

async function prepareParkedProbe(account: Account, dir: string, signal?: AbortSignal): Promise<PreparedProbe> {
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
  let liveRefresh: string | null = null;
  if (liveRaw != null) {
    let liveCreds: OAuthCreds;
    try {
      liveCreds = CredentialBlobSchema.parse(JSON.parse(liveRaw)).claudeAiOauth;
    } catch (e) {
      return { ok: false, reason: `cannot read the live credential (${(e instanceof Error ? e.message : String(e)).slice(0, 80)}) - refusing to sample a possibly-live account` };
    }
    if (!isDeadCredential(liveCreds)) {
      liveToken = liveCreds.accessToken;
      liveRefresh = liveCreds.refreshToken;
      try {
        liveAccount = (await fetchTokenIdentity(liveCreds.accessToken, signal)).accountUuid;
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
    const owner = await checkIdentity(creds, account, signal);
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
        return { fresh: await refreshCredential(creds, Date.now(), signal) };
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
      if (liveRefresh != null && creds.refreshToken === liveRefresh) {
        return { ok: false, reason: "this slot holds a copy of the LIVE login's grant - refusing to rotate it from a parked slot; run `tokenmaxxing switch` to reconcile" };
      }
      try {
        signal?.throwIfAborted();
        result = await withClaudeRefreshLock(async (lock) => {
          const rotated = await rotate();
          if ("failed" in rotated) return rotated;
          const verified = await checkIdentity(rotated.fresh, account, signal);
          if (verified.status === "match") return rotated;
          if (verified.status === "unavailable") {
            await writeItem(backup, JSON.stringify({ claudeAiOauth: rotated.fresh }));
            return { failed: { ok: false, reason: `${verified.reason} - the rotated pair stays in this slot unverified until the next pass` } };
          }
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

  const identity = await checkIdentity(creds, account, signal);
  if (identity.status === "mismatch") {
    const kept = await relocate(identity.owner);
    account.needsReauth = true;
    return { ok: false, reason: `${identity.reason} - this account's own credential is gone; the pair ${kept}; re-auth with \`tokenmaxxing auth\`` };
  }
  if (identity.status === "unavailable") {
    return { ok: false, reason: identity.reason };
  }
  refreshPlanFields(account, creds);

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

async function runParkedProbe(dir: string, opts: { retries?: number }): Promise<SampleOutcome> {
  const usage = await probeUsage(dir, Date.now(), { retries: opts.retries });
  return usage ? { ok: true, usage } : { ok: false, reason: "`/usage` returned no limit data (see log)" };
}

async function finishParkedProbe(account: Account, prepared: { dir: string; installed: string }): Promise<void> {
  const isoTarget = isolatedTarget(prepared.dir);
  const backup = parkedTarget(account.keychainItem);
  try {
    const afterIso = await readItem(isoTarget);
    if (afterIso && afterIso !== prepared.installed) {
      const parkedNow = await readItem(backup);
      const installedToken = CredentialBlobSchema.parse(JSON.parse(prepared.installed)).claudeAiOauth.accessToken;
      const parkedToken = parkedNow == null ? null : CredentialBlobSchema.parse(JSON.parse(parkedNow)).claudeAiOauth.accessToken;
      if (parkedToken === installedToken) await writeItem(backup, claudeAiOauthOnly(afterIso));
      else log("sample.harvest_skipped", { account: account.accountUuid.slice(0, 8) });
    }
  } finally {
    await deleteItem(isoTarget);
    rmSync(prepared.dir, { recursive: true, force: true });
  }
}

export async function probeParkedUsage(account: Account): Promise<SampleOutcome> {
  const prepared = await prepareParkedProbe(account, join(paths.sampleDir, credItemFor(account.accountUuid)));
  if (!prepared.ok) return prepared;
  try {
    return await runParkedProbe(prepared.dir, {});
  } finally {
    await finishParkedProbe(account, prepared);
  }
}

const PREPARE_DEADLINE_MS = 20_000;

export async function sampleOldestParked(cfg: Config): Promise<void> {
  const reserved = await withLock(paths.lockFile, async () => {
    const now = Date.now();
    const lastSwapAt = loadLastSwapAt();
    if (lastSwapAt != null && now - lastSwapAt < POST_SWAP_COOLDOWN_MS) return null;
    const idx = loadAccounts();
    const live = readOAuthAccount()?.accountUuid ?? null;
    const sampledAt = (a: Account) => Math.max(a.lastUsageAt ?? 0, a.lastProbeAt ?? 0);
    const stale = idx.accounts.filter((a) => a.accountUuid !== live && a.needsReauth !== true && now - sampledAt(a) > cfg.policy.usagePollTtlMs);
    const target = minBy(stale, sampledAt);
    if (!target) return null;
    target.lastProbeAt = now;
    const prepared = await prepareParkedProbe(target, join(paths.sampleDir, `${credItemFor(target.accountUuid)}-tick`), AbortSignal.timeout(PREPARE_DEADLINE_MS));
    saveAccounts(idx);
    if (!prepared.ok) {
      log("sample.parked_failed", { account: target.accountUuid.slice(0, 8), reason: prepared.reason.slice(0, 200) });
      return null;
    }
    return { account: target, prepared };
  });
  if (!reserved) return;
  const { account, prepared } = reserved;
  const startedAt = Date.now();
  let outcome: SampleOutcome | null = null;
  try {
    outcome = await runParkedProbe(prepared.dir, { retries: 0 });
  } finally {
    await withLock(paths.lockFile, async () => {
      await finishParkedProbe(account, prepared);
      if (outcome == null) return;
      const idx = loadAccounts();
      const stored = idx.accounts.find((a) => a.accountUuid === account.accountUuid);
      if (stored && outcome.ok && (stored.lastUsageAt == null || startedAt > stored.lastUsageAt)) {
        stored.lastUsage = { fiveHour: outcome.usage.session, sevenDay: outcome.usage.weekAll };
        stored.lastUsageAt = startedAt;
        if (Object.keys(outcome.usage.perModel).length > 0) {
          stored.lastPerModel = outcome.usage.perModel;
          stored.lastPerModelAt = startedAt;
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

export async function probeActiveUsage(account: Account): Promise<SampleOutcome> {
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

  const usage = await probeUsage();
  return usage ? { ok: true, usage } : { ok: false, reason: "`/usage` returned no limit data (see log)" };
}
