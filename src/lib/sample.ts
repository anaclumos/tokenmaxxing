import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { readItem, writeItem, deleteItem, liveTarget, parkedTarget, isolatedTarget, claudeAiOauthOnly, mergeIntoLive } from "./credstore.ts";
import { credItemFor, paths } from "./paths.ts";
import { withClaudeRefreshLock } from "./claudelock.ts";
import { refreshCredential, isAccessTokenExpiring, isDeadCredential, fetchTokenIdentity, describeIdentity, IdentityUnavailableError, InvalidGrantError } from "./oauth.ts";
import { FullUsageSchema, pingSession, probeUsage } from "./usage.ts";
import { loadAccounts } from "./state.ts";
import { keepRotatedPair } from "./swap.ts";
import { CredentialBlobSchema, TokenIdentitySchema, type Account, type OAuthCreds, type TokenIdentity } from "./types.ts";

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

export async function probeParkedUsage(account: Account, opts: { ping?: boolean } = {}): Promise<SampleOutcome> {
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

  if (isAccessTokenExpiring(creds, 300_000)) {
    const owner = await checkIdentity(creds, account);
    if (owner.status === "mismatch") {
      account.needsReauth = true;
      return { ok: false, reason: `${owner.reason} - refusing to spend another account's grant; re-auth with \`tokenmaxxing auth\`` };
    }
    if (owner.status === "unavailable" && !owner.stale) {
      return { ok: false, reason: `${owner.reason} - refusing to refresh a parked credential whose owner cannot be verified` };
    }
    let fresh: OAuthCreds;
    try {
      fresh = await refreshCredential(creds);
    } catch (e) {
      if (e instanceof InvalidGrantError) {
        account.needsReauth = true;
        return { ok: false, reason: "refresh token dead - re-auth with `tokenmaxxing auth`" };
      }
      return { ok: false, reason: `token refresh failed: ${e instanceof Error ? e.message : String(e)}` };
    }
    if (owner.status === "unavailable") {
      const verified = await checkIdentity(fresh, account);
      if (verified.status === "mismatch") {
        const trueOwner = loadAccounts().accounts.find((a) => a.accountUuid === verified.owner.accountUuid) ?? null;
        const kept = trueOwner == null
          ? "could not be kept because that account is not in the pool"
          : await keepRotatedPair({ fresh, owner: trueOwner, liveOwnerUuid: liveAccount, expectedLiveToken: liveToken });
        account.needsReauth = true;
        return { ok: false, reason: `${verified.reason}, whose grant this refresh rotated - the rotated token ${kept}; re-auth with \`tokenmaxxing auth\`` };
      }
    }
    creds = fresh;
    await writeItem(backup, JSON.stringify({ claudeAiOauth: creds }));
  }

  const identity = await checkIdentity(creds, account);
  if (identity.status === "mismatch") {
    account.needsReauth = true;
    return { ok: false, reason: `${identity.reason} - this account's own credential is gone; re-auth with \`tokenmaxxing auth\`` };
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
    const outcome: SampleOutcome = usage
      ? { ok: true, usage }
      : { ok: false, reason: "`/usage` returned no limit data (see log)" };
    if (ping != null) {
      outcome.pingError = ping.reason;
      outcome.pingRejected = ping.rejected;
    }
    return outcome;
  } finally {
    const afterIso = await readItem(isoTarget);
    if (afterIso && afterIso !== installed) await writeItem(backup, claudeAiOauthOnly(afterIso));
    await deleteItem(isoTarget);
    rmSync(dir, { recursive: true, force: true });
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
