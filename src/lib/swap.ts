import { clearDepletedWait, clearNextCheck, clearUsageSnapshots, loadAccounts, saveAccounts, saveLastSwapAt } from "./state.ts";
import { readItem, writeItem, liveTarget, parkedTarget, claudeAiOauthOnly, mergeIntoLive } from "./credstore.ts";
import { refreshCredential, isAccessTokenExpiring, fetchTokenIdentity, describeIdentity, InvalidGrantError } from "./oauth.ts";
import { swapOAuthAccount } from "./claudejson.ts";
import { withClaudeRefreshLock } from "./claudelock.ts";
import { log } from "./log.ts";
import { pickBest, type PickCtx } from "./picker.ts";
import { CredentialBlobSchema, type Account, type OAuthCreds } from "./types.ts";

function parseBlob(raw: string) {
  return CredentialBlobSchema.parse(JSON.parse(raw));
}

export async function performSwap(target: Account): Promise<void> {
  const idx = loadAccounts();

  const preLive = await readItem(liveTarget());
  let liveOwner: Account | null = null;
  let liveCreds: OAuthCreds | null = null;
  let expectedLiveToken: string | null = null;
  if (preLive) {
    liveCreds = parseBlob(preLive).claudeAiOauth;
    expectedLiveToken = liveCreds.accessToken;
    if (isAccessTokenExpiring(liveCreds, 60_000)) {
      try {
        await withClaudeRefreshLock(async (lock) => {
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
        liveCreds = null;
        log("swap.harvest_skipped_dead_live", {});
      }
    }
    if (liveCreds != null) {
      const identity = await fetchTokenIdentity(liveCreds.accessToken);
      liveOwner = idx.accounts.find((a) => a.accountUuid === identity.accountUuid) ?? null;
      if (!liveOwner) {
        throw new Error(
          `live credential belongs to ${describeIdentity(identity)}, which is not in the pool - refusing to swap over it; import it first with \`tokenmaxxing add\``,
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

  await withClaudeRefreshLock(async (lock) => {
    const currentLive = await readItem(liveTarget());
    if (lock.compromised()) throw new Error("refresh lock compromised - aborting the swap before any write");

    const currentToken = currentLive == null ? null : parseBlob(currentLive).claudeAiOauth.accessToken;
    if (currentToken !== expectedLiveToken) {
      throw new Error("live credential changed while unlocked (concurrent /login or refresh) - aborting this swap; the next check re-resolves the owner and retries");
    }

    if (liveOwner && currentLive) {
      await writeItem(parkedTarget(liveOwner.keychainItem), claudeAiOauthOnly(currentLive));
      log("swap.harvest", { account: liveOwner.accountUuid.slice(0, 8) });
    }

    if (fresh != null) {
      await writeItem(liveTarget(), mergeIntoLive(currentLive, fresh));
    }
    swapOAuthAccount(target.oauthAccount);
    idx.activeAccountUuid = target.accountUuid;
    const t2 = idx.accounts.find((a) => a.accountUuid === target.accountUuid);
    if (t2) { t2.needsReauth = false; }
    saveAccounts(idx);
    clearUsageSnapshots();
    clearDepletedWait();
    clearNextCheck();
    saveLastSwapAt(Date.now());
  });
  log("swap.done", { account: target.accountUuid.slice(0, 8), email: target.email });
}

export async function chooseAndSwap(ctx: PickCtx): Promise<Account | null> {
  const tried = new Set<string>();
  while (true) {
    const idx = loadAccounts();
    const candidates = idx.accounts.filter((a) => !tried.has(a.accountUuid));
    const best = pickBest(candidates, ctx);
    if (!best) return null;
    tried.add(best.accountUuid);
    try {
      await performSwap(best);
      return best;
    } catch (e) {
      if (e instanceof InvalidGrantError) continue;
      throw e;
    }
  }
}

