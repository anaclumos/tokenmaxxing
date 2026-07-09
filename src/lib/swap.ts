// The account-switch sequence. Runs under the tokenmaxxing flock (held by the
// caller - the Stop hook or a CLI command). The keychain/json writes additionally
// run under claude's own refresh lock so they can't interleave with a token refresh.
//
//   refresh B (network, no lock)
//   resolve the live credential's TRUE owner (network, no lock)
//   ── under claude refresh lock ──
//     harvest live → its OWNER's backup (mandatory: refresh token rotates in place)
//     install B into the live item
//     persist B's rotated token into B's backup
//     rewrite oauthAccount in ~/.claude.json
//     mark B active (inside the lock: a crash before this write leaves a stale
//     active label, which is exactly what once made a harvest destroy a backup)

import { loadAccounts, saveAccounts } from "./state.ts";
import { readItem, writeItem, liveTarget, parkedTarget, claudeAiOauthOnly, mergeIntoLive } from "./credstore.ts";
import { refreshCredential, isAccessTokenExpiring, fetchTokenOrg, InvalidGrantError } from "./oauth.ts";
import { swapOAuthAccount } from "./claudejson.ts";
import { withLock } from "./lock.ts";
import { withClaudeRefreshLock } from "./claudelock.ts";
import { paths } from "./paths.ts";
import { log } from "./log.ts";
import { pickBest, type PickCtx } from "./picker.ts";
import { CredentialBlobSchema, type Account, type OAuthCreds } from "./types.ts";

function parseBlob(raw: string) {
  return CredentialBlobSchema.parse(JSON.parse(raw));
}

/**
 * Mechanically switch the LIVE credential to `target`. Assumes the caller holds
 * the tokenmaxxing flock. Throws InvalidGrantError (after marking needs_reauth)
 * when target's refresh token is dead.
 */
export async function performSwap(target: Account): Promise<void> {
  const idx = loadAccounts();

  // 1. refresh target's parked credential (network) BEFORE taking claude's lock.
  const parkedRaw = await readItem(parkedTarget(target.keychainItem));
  if (!parkedRaw) throw new Error(`no parked credential for ${target.email}`);
  let fresh: OAuthCreds;
  try {
    fresh = await refreshCredential(parseBlob(parkedRaw).claudeAiOauth);
  } catch (e) {
    if (e instanceof InvalidGrantError) {
      const t = idx.accounts.find((a) => a.accountUuid === target.accountUuid);
      if (t) { t.needsReauth = true; saveAccounts(idx); }
      log("swap.invalid_grant", { account: target.accountUuid.slice(0, 8) });
    }
    throw e;
  }
  // 2. resolve the live credential's TRUE owner - the harvest destination.
  //    activeAccountUuid is a label, and labels drift from the blob they describe
  //    (crash mid-swap, manual /login, historical re-init); harvesting by label is
  //    how a backup once got destroyed. The token itself cannot lie. A rotation
  //    between here and the harvest write keeps the same owner, so this can stay
  //    outside the (fast, local) critical section.
  const preLive = await readItem(liveTarget());
  let liveOwner: Account | null = null;
  if (preLive) {
    let liveCreds = parseBlob(preLive).claudeAiOauth;
    let identifiable = true;
    if (isAccessTokenExpiring(liveCreds, 60_000)) {
      try {
        liveCreds = await refreshCredential(liveCreds);
        await writeItem(liveTarget(), mergeIntoLive(preLive, liveCreds));
      } catch (e) {
        if (!(e instanceof InvalidGrantError)) throw e;
        // dead credential family: nothing worth preserving, skip the harvest.
        identifiable = false;
        log("swap.harvest_skipped_dead_live", {});
      }
    }
    if (identifiable) {
      const org = await fetchTokenOrg(liveCreds.accessToken);
      liveOwner = idx.accounts.find((a) => a.organizationUuid === org.organization_uuid) ?? null;
      if (!liveOwner) {
        throw new Error(
          `live credential belongs to ${org.organization_name} (org ${org.organization_uuid.slice(0, 8)}), which is not in the pool - refusing to swap over it; import it first with \`tokenmaxxing add\``,
        );
      }
      if (liveOwner.accountUuid !== idx.activeAccountUuid) {
        log("swap.harvest_drift", {
          labeled: idx.activeAccountUuid?.slice(0, 8) ?? null,
          actual: liveOwner.accountUuid.slice(0, 8),
        });
      }
    }
  }

  // 3. the fast, local, atomic-vs-claude-refresh critical section.
  await withClaudeRefreshLock(async () => {
    const currentLive = await readItem(liveTarget());

    // harvest the live claudeAiOauth into its OWNER's (small) backup item.
    if (liveOwner && currentLive) {
      await writeItem(parkedTarget(liveOwner.keychainItem), claudeAiOauthOnly(currentLive));
      log("swap.harvest", { account: liveOwner.accountUuid.slice(0, 8) });
    }

    // install B: merge B's fresh claudeAiOauth into the CURRENT live blob so all
    // sibling state (MCP OAuth tokens, etc.) is preserved across the swap.
    await writeItem(liveTarget(), mergeIntoLive(currentLive, fresh));
    // persist B's rotated token into its small backup item.
    await writeItem(parkedTarget(target.keychainItem), JSON.stringify({ claudeAiOauth: fresh }));
    swapOAuthAccount(target.oauthAccount);
    // record B as active INSIDE the critical section so a crash cannot leave the
    // installed credential and the active label pointing at different accounts.
    idx.activeAccountUuid = target.accountUuid;
    const t2 = idx.accounts.find((a) => a.accountUuid === target.accountUuid);
    if (t2) { t2.needsReauth = false; }
    saveAccounts(idx);
  });
  log("swap.done", { account: target.accountUuid.slice(0, 8), email: target.email });
}

/**
 * Pick the best candidate and swap to it, retrying past dead refresh tokens.
 * Assumes the caller holds the flock (does NOT lock - avoids same-process
 * flock self-deadlock). Returns the account landed on, or null if none usable.
 */
export async function chooseAndSwap(ctx: Omit<PickCtx, "currentAccountUuid">): Promise<Account | null> {
  const tried = new Set<string>();
  while (true) {
    const idx = loadAccounts();
    const candidates = idx.accounts.filter((a) => !tried.has(a.accountUuid));
    const best = pickBest(candidates, { ...ctx, currentAccountUuid: idx.activeAccountUuid });
    if (!best) return null;
    tried.add(best.accountUuid);
    try {
      await performSwap(best);
      return best;
    } catch (e) {
      if (e instanceof InvalidGrantError) continue; // dead token - next candidate
      throw e;
    }
  }
}

/** Standalone lock-taking variant for CLI/manual use (NEVER call under a held flock). */
export async function swapToBest(ctx: Omit<PickCtx, "currentAccountUuid">): Promise<Account | null> {
  return withLock(paths.lockFile, () => chooseAndSwap(ctx));
}
