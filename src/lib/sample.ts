// Live-sample a PARKED account's `/usage` without disturbing the live login.
// `/usage` is free (0 tokens), so `status` can show every account's real usage.
// We install the account's parked credential into a throwaway CLAUDE_CONFIG_DIR
// (the isolated credential claude reads for that dir), run `claude -p /usage`
// against it, then tear the item down.
//
// Contamination guards (the incident that motivated these):
//   1. probeUsage scrubs every ambient credential-override env var, so an
//      inherited CLAUDE_CODE_OAUTH_TOKEN can't hijack the isolated probe.
//   2. before trusting a backup we verify (roles endpoint) that its token really
//      belongs to this account - a mislabeled backup (drifted harvest) surfaces
//      as an explicit error, never as another account's bars.
//
// Refresh tokens rotate single-use, so the one hazard is a rotation we fail to
// capture. Two guards: refresh an expiring token OURSELVES up front, and
// capture-before-delete the isolated item in case claude rotated it anyway.
//
// The caller MUST hold the tokenmaxxing flock so a parked refresh cannot collide
// with an in-flight performSwap refreshing the same account.

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { readItem, writeItem, deleteItem, liveTarget, parkedTarget, isolatedTarget, claudeAiOauthOnly, mergeIntoLive } from "./credstore.ts";
import { credItemFor, paths } from "./paths.ts";
import { withClaudeRefreshLock } from "./claudelock.ts";
import { refreshCredential, isAccessTokenExpiring, fetchTokenOrg, InvalidGrantError } from "./oauth.ts";
import { FullUsageSchema, pingSession, probeUsage } from "./usage.ts";
import { CredentialBlobSchema, type Account, type OAuthCreds, type RolesResponse } from "./types.ts";

/** Result of a live sample: the fresh usage, or why it could not be taken.
 *  `pingError` is set only when a requested ping (status --force) failed - the
 *  account's 5h timer may not have started even if the sample itself succeeded. */
export const SampleOutcomeSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), usage: FullUsageSchema, pingError: z.string().optional() }),
  z.object({ ok: z.literal(false), reason: z.string(), pingError: z.string().optional() }),
]);
export type SampleOutcome = z.infer<typeof SampleOutcomeSchema>;

/** Verify `creds` belongs to `account`; null on match, else the mismatch reason. */
async function identityMismatch(creds: OAuthCreds, account: Account): Promise<string | null> {
  let org: RolesResponse;
  try {
    org = await fetchTokenOrg(creds.accessToken);
  } catch (e) {
    return `credential identity check failed: ${String((e as Error).message ?? e)}`;
  }
  if (org.organization_uuid === account.organizationUuid) return null;
  return `credential actually belongs to ${org.organization_name} (org ${org.organization_uuid.slice(0, 8)})`;
}

/** Stamp the blob's plan fields onto the account (caller persists). Runs only
 *  after the identity check passed, so a drifted credential can never write
 *  another account's tier. Absent blob fields keep the last-known values. */
function refreshPlanFields(account: Account, creds: OAuthCreds): void {
  if (creds.subscriptionType != null) account.subscriptionType = creds.subscriptionType;
  if (creds.rateLimitTier != null) account.rateLimitTier = creds.rateLimitTier;
}

/**
 * Live-sample `account`'s `/usage` in isolation. On a dead refresh token or a
 * mislabeled credential it sets `account.needsReauth` in place (the caller
 * persists accounts.json). Mutates only the passed object and keychain items.
 * With `ping`, one minimal metered request runs first (through the same
 * isolated credential) so the account's 5h session window starts now and the
 * sample that follows reports the freshly opened window.
 */
export async function probeParkedUsage(account: Account, opts: { ping?: boolean } = {}): Promise<SampleOutcome> {
  const backup = parkedTarget(account.keychainItem);
  const parkedRaw = await readItem(backup);
  if (!parkedRaw) return { ok: false, reason: "no parked credential - run `tokenmaxxing auth`" };

  let creds: OAuthCreds;
  try {
    creds = CredentialBlobSchema.parse(JSON.parse(parkedRaw)).claudeAiOauth;
  } catch (e) {
    return { ok: false, reason: `parked credential unreadable (${String((e as Error).message ?? e).slice(0, 80)}) - run \`tokenmaxxing auth\`` };
  }

  // Hand claude a token with comfortable headroom so it won't run its own refresh
  // (which claude does within 120s of expiry). Refresh + persist ourselves first.
  if (isAccessTokenExpiring(creds, 300_000)) {
    try {
      creds = await refreshCredential(creds);
      await writeItem(backup, JSON.stringify({ claudeAiOauth: creds }));
    } catch (e) {
      if (e instanceof InvalidGrantError) {
        account.needsReauth = true;
        return { ok: false, reason: "refresh token dead - re-auth with `tokenmaxxing add`" };
      }
      return { ok: false, reason: `token refresh failed: ${String((e as Error).message ?? e)}` };
    }
  }

  const mismatch = await identityMismatch(creds, account);
  if (mismatch) {
    account.needsReauth = true;
    return { ok: false, reason: `${mismatch} - this account's own credential is gone; re-auth with \`tokenmaxxing add\`` };
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
    const pingError = opts.ping ? await pingSession(dir) : null;
    const usage = await probeUsage(dir);
    const outcome: SampleOutcome = usage
      ? { ok: true, usage }
      : { ok: false, reason: "`/usage` returned no limit data (see log)" };
    if (pingError != null) outcome.pingError = pingError;
    return outcome;
  } finally {
    // capture-before-delete: never discard a rotation claude may have performed.
    const afterIso = await readItem(isoTarget);
    if (afterIso && afterIso !== installed) await writeItem(backup, claudeAiOauthOnly(afterIso));
    await deleteItem(isoTarget);
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Live-sample the ACTIVE account off the live login, verifying the live
 * credential belongs to it. `/usage` with no CLAUDE_CONFIG_DIR meters the live
 * keychain item. A drifted active label surfaces as an error, not another
 * account's bars. With `ping`, one minimal metered request runs first (after
 * the identity check - never spend quota on a drifted credential).
 */
export async function probeActiveUsage(account: Account, opts: { ping?: boolean } = {}): Promise<SampleOutcome> {
  const liveRaw = await readItem(liveTarget());
  if (!liveRaw) return { ok: false, reason: "no live credential - run `claude` and `/login`" };
  let creds: OAuthCreds;
  try {
    creds = CredentialBlobSchema.parse(JSON.parse(liveRaw)).claudeAiOauth;
  } catch (e) {
    return { ok: false, reason: `live credential blob unreadable (${String((e as Error).message ?? e).slice(0, 80)})` };
  }

  // A running claude keeps the live token fresh; after long idle it may not have.
  if (isAccessTokenExpiring(creds, 300_000)) {
    try {
      await withClaudeRefreshLock(async (lock) => {
        const raw2 = await readItem(liveTarget());
        if (raw2 == null) throw new Error("live credential vanished while waiting for the refresh lock");
        const current = CredentialBlobSchema.parse(JSON.parse(raw2)).claudeAiOauth;
        creds = isAccessTokenExpiring(current, 300_000) ? await refreshCredential(current) : current;
        if (creds === current) return;
        if (lock.compromised()) throw new Error("refresh lock compromised mid-refresh - discarding the live rewrite");
        await writeItem(liveTarget(), mergeIntoLive(raw2, creds));
      });
    } catch (e) {
      if (e instanceof InvalidGrantError) return { ok: false, reason: "live refresh token dead - run `claude` and `/login`" };
      return { ok: false, reason: `token refresh failed: ${String((e as Error).message ?? e)}` };
    }
  }

  const mismatch = await identityMismatch(creds, account);
  if (mismatch) return { ok: false, reason: `live ${mismatch} - active label drifted; run \`tokenmaxxing switch\`` };
  refreshPlanFields(account, creds);

  const pingError = opts.ping ? await pingSession() : null;
  const usage = await probeUsage();
  const outcome: SampleOutcome = usage ? { ok: true, usage } : { ok: false, reason: "`/usage` returned no limit data (see log)" };
  if (pingError != null) outcome.pingError = pingError;
  return outcome;
}
