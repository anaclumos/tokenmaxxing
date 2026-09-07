import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readItem, writeItem, deleteItem, liveTarget, parkedTarget, isolatedTarget, claudeAiOauthOnly, parseBlob } from "./credstore.ts";
import { credItemFor, paths } from "./paths.ts";
import { withClaudeRefreshLock } from "./claudelock.ts";
import { errorMessage } from "./errors.ts";
import { refreshCredential, isAccessTokenExpiring, isDeadCredential, fetchTokenIdentity, describeIdentity, IdentityUnavailableError, InvalidGrantError } from "./oauth.ts";
import { pingSession, probeUsage, type FullUsage } from "./usage.ts";
import { loadAccounts } from "./state.ts";
import { ensureLiveTokenFresh, keepRotatedPair } from "./swap.ts";
import { log } from "./log.ts";
import type { Account, OAuthCreds, TokenIdentity } from "./types.ts";

export type SampleOutcome =
  | { ok: true; usage: FullUsage; pingError?: string; pingRejected?: boolean }
  | { ok: false; reason: string; probeSilent?: boolean; pingError?: string; pingRejected?: boolean };

type IdentityCheck =
  | { status: "match" }
  | { status: "mismatch"; reason: string; owner: TokenIdentity }
  | { status: "unavailable"; reason: string; stale: boolean };

const NO_LIMIT_DATA: SampleOutcome = { ok: false, reason: "`/usage` returned no limit data (see log)", probeSilent: true };

async function checkIdentity(creds: OAuthCreds, account: Account): Promise<IdentityCheck> {
  let identity: TokenIdentity;
  try {
    identity = await fetchTokenIdentity(creds.accessToken);
  } catch (e) {
    return {
      status: "unavailable",
      reason: `credential identity check failed: ${errorMessage(e)}`,
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

function withPing(outcome: SampleOutcome, ping: { reason: string; rejected: boolean } | null): SampleOutcome {
  return ping == null ? outcome : { ...outcome, pingError: ping.reason, pingRejected: ping.rejected };
}

export async function probeParkedUsage(account: Account, opts: { ping?: boolean } = {}): Promise<SampleOutcome> {
  const backup = parkedTarget(account.keychainItem);
  const parkedRaw = await readItem(backup);
  if (!parkedRaw) return { ok: false, reason: "no parked credential - run `tokenmaxxing auth`" };

  let creds: OAuthCreds;
  try {
    creds = parseBlob(parkedRaw).claudeAiOauth;
  } catch (e) {
    return { ok: false, reason: `parked credential unreadable (${errorMessage(e).slice(0, 80)}) - run \`tokenmaxxing auth\`` };
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
      liveCreds = parseBlob(liveRaw).claudeAiOauth;
    } catch (e) {
      return { ok: false, reason: `cannot read the live credential (${errorMessage(e).slice(0, 80)}) - refusing to sample a possibly-live account` };
    }
    if (!isDeadCredential(liveCreds)) {
      liveToken = liveCreds.accessToken;
      try {
        liveAccount = (await fetchTokenIdentity(liveCreds.accessToken)).accountUuid;
      } catch (e) {
        return { ok: false, reason: `cannot verify the live credential's owner (${errorMessage(e).slice(0, 80)}) - refusing to sample a possibly-live account` };
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
    const rotate = async (): Promise<{ fresh: OAuthCreds } | { failed: SampleOutcome }> => {
      try {
        return { fresh: await refreshCredential(creds) };
      } catch (e) {
        if (e instanceof InvalidGrantError) {
          account.needsReauth = true;
          return { failed: { ok: false, reason: "refresh token dead - re-auth with `tokenmaxxing auth`" } };
        }
        return { failed: { ok: false, reason: `token refresh failed: ${errorMessage(e)}` } };
      }
    };
    let result: { fresh: OAuthCreds } | { failed: SampleOutcome };
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
        return { ok: false, reason: `cannot arbitrate a stale parked credential: ${errorMessage(e)}` };
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
  const isoTarget = isolatedTarget(dir);
  const installed = JSON.stringify({ claudeAiOauth: creds });

  try {
    await writeItem(isoTarget, installed);
    writeFileSync(join(dir, ".claude.json"), JSON.stringify({ oauthAccount: account.oauthAccount, hasCompletedOnboarding: true }));
    const ping = opts.ping ? await pingSession(dir) : null;
    const usage = await probeUsage(dir);
    return withPing(usage ? { ok: true, usage } : NO_LIMIT_DATA, ping);
  } finally {
    const afterIso = await readItem(isoTarget);
    if (afterIso && afterIso !== installed) await writeItem(backup, claudeAiOauthOnly(afterIso));
    await deleteItem(isoTarget);
    rmSync(dir, { recursive: true, force: true });
  }
}

export async function probeActiveUsage(account: Account, opts: { ping?: boolean } = {}): Promise<SampleOutcome> {
  try {
    await ensureLiveTokenFresh({ skewMs: 300_000 });
  } catch (e) {
    if (e instanceof InvalidGrantError) return { ok: false, reason: "live refresh token dead - run `claude` and `/login`" };
    return { ok: false, reason: `token refresh failed: ${errorMessage(e)}` };
  }
  const liveRaw = await readItem(liveTarget());
  if (!liveRaw) return { ok: false, reason: "no live credential - run `claude` and `/login`" };
  let creds: OAuthCreds;
  try {
    creds = parseBlob(liveRaw).claudeAiOauth;
  } catch (e) {
    return { ok: false, reason: `live credential blob unreadable (${errorMessage(e).slice(0, 80)})` };
  }

  const identity = await checkIdentity(creds, account);
  if (identity.status === "mismatch") return { ok: false, reason: `live ${identity.reason} - active label drifted; run \`tokenmaxxing switch\`` };
  if (identity.status === "unavailable") return { ok: false, reason: identity.reason };
  refreshPlanFields(account, creds);

  const ping = opts.ping ? await pingSession() : null;
  const usage = await probeUsage();
  return withPing(usage ? { ok: true, usage } : NO_LIMIT_DATA, ping);
}
