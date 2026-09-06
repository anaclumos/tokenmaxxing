import { clearDepletedWait, clearNextCheck, clearUsageSnapshots, loadAccounts, saveAccounts, saveLastSwapAt } from "./state.ts";
import { readItem, writeItem, liveTarget, parkedTarget, claudeAiOauthOnly, mergeIntoLive } from "./credstore.ts";
import { refreshCredential, isAccessTokenExpiring, isDeadCredential, fetchTokenIdentity, describeIdentity, IdentityUnavailableError, InvalidGrantError, RefreshRejectedError } from "./oauth.ts";
import { swapOAuthAccount } from "./claudejson.ts";
import { withClaudeRefreshLock } from "./claudelock.ts";
import { log } from "./log.ts";
import { pickBest, type PickCtx } from "./picker.ts";
import { CredentialBlobSchema, type Account, type OAuthCreds, type TokenIdentity } from "./types.ts";

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
    if (isDeadCredential(liveCreds)) {
      liveCreds = null;
      log("swap.live_dead", {});
    } else if (isAccessTokenExpiring(liveCreds, 60_000)) {
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
      let identity: TokenIdentity;
      try {
        identity = await fetchTokenIdentity(liveCreds.accessToken);
      } catch (e) {
        throw new Error(`cannot resolve the live credential's owner (${e instanceof Error ? e.message : String(e)}) - refusing to swap over it; the next check retries`);
      }
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
    const parked = parseBlob(parkedRaw).claudeAiOauth;
    const markDead = (detail: string): InvalidGrantError => {
      const t = idx.accounts.find((a) => a.accountUuid === target.accountUuid);
      if (t) { t.needsReauth = true; saveAccounts(idx); }
      log("swap.invalid_grant", { account: target.accountUuid.slice(0, 8), detail });
      return new InvalidGrantError(detail);
    };
    if (isDeadCredential(parked)) throw markDead("parked credential was cleared after a failed refresh - re-auth with `tokenmaxxing auth`");
    let parkedOwner: TokenIdentity | null = null;
    try {
      parkedOwner = await fetchTokenIdentity(parked.accessToken);
    } catch (e) {
      if (!(e instanceof IdentityUnavailableError && e.status === 401)) throw e;
      log("swap.parked_token_stale", { account: target.accountUuid.slice(0, 8) });
    }
    if (parkedOwner != null && parkedOwner.accountUuid !== target.accountUuid) {
      throw markDead(`parked credential belongs to ${describeIdentity(parkedOwner)} - refusing to spend another account's grant; re-auth with \`tokenmaxxing auth ${target.label}\``);
    }
    try {
      fresh = await refreshCredential(parked);
    } catch (e) {
      if (e instanceof InvalidGrantError) throw markDead(e.detail);
      if (e instanceof RefreshRejectedError) log("swap.refresh_rejected", { account: target.accountUuid.slice(0, 8), status: e.status, detail: e.detail });
      throw e;
    }
    if (parkedOwner == null) {
      let freshOwner: TokenIdentity;
      try {
        freshOwner = await fetchTokenIdentity(fresh.accessToken);
      } catch (e) {
        await writeItem(parkedTarget(target.keychainItem), JSON.stringify({ claudeAiOauth: fresh }));
        throw new Error(`refreshed the parked credential but cannot verify its owner (${e instanceof Error ? e.message : String(e)}) - kept the rotated token parked; the next check retries`);
      }
      if (freshOwner.accountUuid !== target.accountUuid) {
        const owner = idx.accounts.find((a) => a.accountUuid === freshOwner.accountUuid) ?? null;
        let kept = "could not be kept because that account is not in the pool";
        if (owner != null && liveOwner?.accountUuid === owner.accountUuid) {
          try {
            await withClaudeRefreshLock(async (lock) => {
              const currentLive = await readItem(liveTarget());
              if (lock.compromised()) throw new Error("refresh lock compromised");
              if (currentLive == null || parseBlob(currentLive).claudeAiOauth.accessToken !== expectedLiveToken) throw new Error("live credential changed while unlocked");
              await writeItem(liveTarget(), mergeIntoLive(currentLive, fresh));
            });
            kept = "was installed into the live store so that account's sessions continue";
            log("swap.rotated_live_rescued", { account: owner.accountUuid.slice(0, 8) });
          } catch (e) {
            await writeItem(parkedTarget(owner.keychainItem), JSON.stringify({ claudeAiOauth: fresh }));
            kept = `was parked under that account (${e instanceof Error ? e.message : String(e)})`;
            log("swap.rotated_parked_rescued", { account: owner.accountUuid.slice(0, 8) });
          }
        } else if (owner != null) {
          await writeItem(parkedTarget(owner.keychainItem), JSON.stringify({ claudeAiOauth: fresh }));
          kept = "was parked under that account";
          log("swap.rotated_parked_rescued", { account: owner.accountUuid.slice(0, 8) });
        }
        throw markDead(`parked credential belongs to ${describeIdentity(freshOwner)}, whose grant this refresh rotated - the rotated token ${kept}; re-auth with \`tokenmaxxing auth ${target.label}\``);
      }
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

export function isSkippableSwapError(e: unknown): boolean {
  return e instanceof InvalidGrantError || e instanceof RefreshRejectedError || e instanceof IdentityUnavailableError;
}

export async function chooseAndSwap(ctx: PickCtx, exclude: ReadonlySet<string> = new Set()): Promise<Account | null> {
  const tried = new Set<string>(exclude);
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
      if (isSkippableSwapError(e)) continue;
      throw e;
    }
  }
}

