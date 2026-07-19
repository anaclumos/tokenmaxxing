// The account-switch sequence. Runs under the tokenmaxxing flock (held by the
// caller - the Stop hook or a CLI command). The keychain/json writes additionally
// run under claude's own refresh lock so they can't interleave with a token refresh.
//
//   resolve the live credential's TRUE owner (network, no lock; an expiring
//     live credential refreshes under claude's refresh lock first)
//   refresh B's parked credential (network, no lock), persisting the rotation
//     at once - UNLESS B IS the live owner (label drift): then the live blob is
//     already the newest rotation and the parked copy must not be refreshed
//   ── under claude refresh lock ──
//     verify the live item still holds the token the owner was resolved from
//     (a concurrent /login or refresh in the unlocked gap aborts the swap)
//     harvest live → its OWNER's backup (mandatory: refresh token rotates in
//     place; when the owner IS the target this repairs its stale backup)
//     install B into the live item
//     rewrite oauthAccount in ~/.claude.json
//     mark B active (kept adjacent to the identity write: the files cannot be
//     crash-atomic together, but the next swap's true-owner resolution catches
//     and logs any crash drift - swap.harvest_drift)

import { clearUsageSnapshots, loadAccounts, saveAccounts, saveLastSwapAt } from "./state.ts";
import { readItem, writeItem, liveTarget, parkedTarget, claudeAiOauthOnly, mergeIntoLive } from "./credstore.ts";
import { refreshCredential, isAccessTokenExpiring, fetchTokenOrg, InvalidGrantError } from "./oauth.ts";
import { swapOAuthAccount } from "./claudejson.ts";
import { withClaudeRefreshLock } from "./claudelock.ts";
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

  // 1. resolve the live credential's TRUE owner - the harvest destination -
  //    BEFORE any rotation. activeAccountUuid is a label, and labels drift from
  //    the blob they describe (crash mid-swap, manual /login, historical
  //    re-init); harvesting by label is how a backup once got destroyed, and
  //    refreshing the target's parked copy while the target is secretly the
  //    LIVE account would rotate a superseded grant and flag a healthy account
  //    needs-reauth (review catch, iteration 3). The token itself cannot lie.
  const preLive = await readItem(liveTarget());
  let liveOwner: Account | null = null;
  let liveCreds: OAuthCreds | null = null;
  // What the live item's accessToken must still be when the critical section
  // below re-reads it: the owner resolution here happens UNLOCKED, so a change
  // in between means the resolved owner may describe a different credential.
  let expectedLiveToken: string | null = null;
  if (preLive) {
    liveCreds = parseBlob(preLive).claudeAiOauth;
    expectedLiveToken = liveCreds.accessToken;
    if (isAccessTokenExpiring(liveCreds, 60_000)) {
      try {
        await withClaudeRefreshLock(async (lock) => {
          // re-read inside the lock: claude may have rotated it while we waited.
          const raw2 = await readItem(liveTarget());
          if (raw2 == null) throw new Error("live credential vanished while waiting for the refresh lock");
          const current = parseBlob(raw2).claudeAiOauth;
          const next = isAccessTokenExpiring(current, 60_000) ? await refreshCredential(current) : current;
          liveCreds = next;
          expectedLiveToken = next.accessToken;
          if (next === current) return;
          if (lock.compromised()) throw new Error("refresh lock compromised mid-refresh - discarding the live rewrite");
          await writeItem(liveTarget(), mergeIntoLive(raw2, next));
        });
      } catch (e) {
        if (!(e instanceof InvalidGrantError)) throw e;
        // dead credential family: nothing worth preserving, skip the harvest.
        // expectedLiveToken keeps the on-disk token - the failed refresh wrote
        // nothing, so the blob is unchanged until someone else changes it.
        liveCreds = null;
        log("swap.harvest_skipped_dead_live", {});
      }
    }
    if (liveCreds != null) {
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

  // 2. the credential to install. When the target IS the live owner (label
  //    drift made us "swap onto" the account already live), the live item holds
  //    the newest rotation and NOTHING must be installed over it - refreshing
  //    the parked copy would rotate a superseded grant, and installing any
  //    pre-lock snapshot could clobber a rotation claude makes meanwhile; the
  //    harvest below repairs the stale backup and the label commit repairs the
  //    drift. Otherwise refresh the parked credential and persist the rotation
  //    before ANY later step can fail (mirrors codexswap).
  const selfSwap = liveOwner != null && liveOwner.accountUuid === target.accountUuid;
  let fresh: OAuthCreds | null = null;
  if (!selfSwap) {
    const parkedRaw = await readItem(parkedTarget(target.keychainItem));
    if (!parkedRaw) throw new Error(`no parked credential for ${target.email}`);
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
    await writeItem(parkedTarget(target.keychainItem), JSON.stringify({ claudeAiOauth: fresh }));
  }

  // 3. the fast, local, atomic-vs-claude-refresh critical section.
  await withClaudeRefreshLock(async (lock) => {
    const currentLive = await readItem(liveTarget());
    if (lock.compromised()) throw new Error("refresh lock compromised - aborting the swap before any write");

    // The owner above was resolved UNLOCKED (network calls must not sit inside
    // claude's refresh lock), so a manual /login or a claude refresh can have
    // replaced the live item since. Harvesting the replaced blob under the
    // stale owner would corrupt that owner's only backup - the exact incident
    // class the owner-first order exists to prevent (review catch, PR #31).
    // Any change aborts before a single write; the next check re-resolves the
    // true owner and retries.
    const currentToken = currentLive == null ? null : parseBlob(currentLive).claudeAiOauth.accessToken;
    if (currentToken !== expectedLiveToken) {
      throw new Error("live credential changed while unlocked (concurrent /login or refresh) - aborting this swap; the next check re-resolves the owner and retries");
    }

    // harvest the live claudeAiOauth into its OWNER's (small) backup item.
    // When the owner IS the target (label drift), the live blob is the newest
    // rotation - the parked refresh was skipped above - so this same write is
    // exactly the repair of a stale or dead parked backup.
    if (liveOwner && currentLive) {
      await writeItem(parkedTarget(liveOwner.keychainItem), claudeAiOauthOnly(currentLive));
      log("swap.harvest", { account: liveOwner.accountUuid.slice(0, 8) });
    }

    // install B: merge B's fresh claudeAiOauth into the CURRENT live blob so all
    // sibling state (MCP OAuth tokens, etc.) is preserved across the swap.
    // (B's rotation was already persisted to its backup right after the refresh.)
    // A self-swap installs NOTHING: the live item already holds the newest
    // rotation, re-read under this lock; only the label below needs repair.
    if (fresh != null) {
      await writeItem(liveTarget(), mergeIntoLive(currentLive, fresh));
    }
    swapOAuthAccount(target.oauthAccount);
    // record B as active immediately after the identity write. These separate
    // files cannot be crash-atomic together, so a crash may leave intermediate
    // state; the next swap resolves the live owner from the token itself and
    // logs any drift (swap.harvest_drift).
    idx.activeAccountUuid = target.accountUuid;
    const t2 = idx.accounts.find((a) => a.accountUuid === target.accountUuid);
    if (t2) { t2.needsReauth = false; }
    saveAccounts(idx);
    // the snapshots on disk still describe the pre-swap account; under the new
    // org label they'd trigger a bogus switch off the account just installed.
    clearUsageSnapshots();
    saveLastSwapAt(Date.now());
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

