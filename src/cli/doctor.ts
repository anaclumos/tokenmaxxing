// `tokenmaxxing doctor` - verify the supervisor + three settings entries survived
// and the pool is healthy.

import { existsSync, readFileSync } from "node:fs";
import { verifyRealClaude } from "../lib/claudebin.ts";
import { checkSettings, installedBin } from "../lib/settings.ts";
import { checkTimerHealthy, findClaudeShadowers, isBinDirAhead, shellRcPath, timerActivationHint } from "../lib/install.ts";
import { paths } from "../lib/paths.ts";
import { loadAccounts, loadConfig } from "../lib/state.ts";
import { readItem, liveTarget, parkedTarget } from "../lib/credstore.ts";
import { isAccessTokenExpiring, fetchTokenOrg } from "../lib/oauth.ts";
import { CredentialBlobSchema, type RolesResponse } from "../lib/types.ts";
import { c } from "./render.ts";

/** The org a stored blob's token truly belongs to; null = expired (unverifiable
 *  read-only - doctor never refreshes). Throws on unreadable blob / API failure. */
async function blobOrg(raw: string): Promise<RolesResponse | null> {
  const creds = CredentialBlobSchema.parse(JSON.parse(raw)).claudeAiOauth;
  if (isAccessTokenExpiring(creds)) return null;
  return fetchTokenOrg(creds.accessToken);
}

export async function cmdDoctor(): Promise<number> {
  let ok = true;
  const check = (cond: boolean, label: string, hint?: string) => {
    console.log(`${cond ? c.green("✓") : c.red("✗")} ${label}${!cond && hint ? c.dim(`  - ${hint}`) : ""}`);
    if (!cond) ok = false;
  };

  check(existsSync(paths.supervisorLink), "claude supervisor wrapper present", "run `tokenmaxxing init`");
  check(existsSync(installedBin()), "tokenmaxxing binary installed", "run `tokenmaxxing init`");
  check(isBinDirAhead(), `${paths.binDir} is ahead of the real claude on PATH`, `export PATH="${paths.binDir}:$PATH"`);

  const s = checkSettings();
  check(s.statusLineOk, "statusLine shim installed in settings.json", "run `tokenmaxxing init`");
  check(s.subagentStatusLineOk, "subagentStatusLine shim installed in settings.json", "run `tokenmaxxing init`");
  check(s.stopOk, "Stop hook installed in settings.json", "run `tokenmaxxing init`");
  check(s.sessionStartOk, "SessionStart hook installed in settings.json", "run `tokenmaxxing init`");
  check(checkTimerHealthy(), "periodic check timer active", timerActivationHint());

  const idx = loadAccounts();
  check(idx.accounts.length > 0, "at least one account in the pool", "run `tokenmaxxing init`");
  check(!!idx.activeAccountUuid, "an active account is set");

  const live = await readItem(liveTarget());
  check(!!live, "live credential readable");

  // Identity agreement: a stored credential must belong to the account it is
  // filed under - a mislabeled blob once made every consumer of a backup
  // (sampling, swap) silently act on another account.
  const active = idx.accounts.find((a) => a.accountUuid === idx.activeAccountUuid);
  if (live && active) {
    try {
      const org = await blobOrg(live);
      if (org) check(org.organization_uuid === active.organizationUuid, `live credential identity matches active (${active.email})`, `token belongs to ${org.organization_name} - run \`tokenmaxxing switch\``);
      else console.log(c.dim(`  - live credential identity unverifiable (access token expired)`));
    } catch (e) {
      check(false, `live credential identity matches active (${active.email})`, (e instanceof Error ? e.message : String(e)).slice(0, 100));
    }
  }

  for (const a of idx.accounts) {
    const parked = await readItem(parkedTarget(a.keychainItem));
    check(!!parked, `parked credential present for ${a.email}`, `run \`tokenmaxxing auth ${a.label}\``);
    if (parked) {
      try {
        const org = await blobOrg(parked);
        if (org) check(org.organization_uuid === a.organizationUuid, `parked credential identity matches ${a.email}`, `token belongs to ${org.organization_name} - run \`tokenmaxxing auth ${a.label}\``);
        else console.log(c.dim(`  - ${a.email} identity unverifiable (access token expired)`));
      } catch (e) {
        check(false, `parked credential identity matches ${a.email}`, (e instanceof Error ? e.message : String(e)).slice(0, 100));
      }
    }
    if (a.needsReauth) check(false, `${a.email} needs re-auth`, `run \`tokenmaxxing auth ${a.label}\` to re-login`);
  }

  const cfg = loadConfig();
  check(!!cfg.claudeBin && existsSync(cfg.claudeBin), "real claude binary resolved", "set claudeBin in config.json");
  if (cfg.claudeBin && existsSync(cfg.claudeBin)) {
    // Behavioral: the pin must answer --version without re-entering the wrapper.
    // Catches a poisoned pin (a shim that resolves `claude` back to us) that
    // existence checks cannot - the 2026-07-12 recursive-spawn incident.
    const fail = verifyRealClaude(cfg.claudeBin);
    check(fail === null, "claudeBin launches the real claude", fail ?? undefined);
  }

  // Warnings only: an interactive alias/function can shadow or bypass the
  // wrapper in ways PATH checks cannot see (`alias claude=...`, or a `cc`-style
  // alias hardcoding an absolute path to the real binary).
  const rc = shellRcPath();
  if (rc && existsSync(rc)) {
    for (const s of findClaudeShadowers(readFileSync(rc, "utf8"))) {
      if (s.kind === "shadow") console.log(c.yellow(`⚠ ${rc}: \`${s.line}\` shadows the supervised claude wrapper - launches through it skip tokenmaxxing`));
      else console.log(c.yellow(`⚠ ${rc}: alias \`${s.name}\` hardcodes a claude path and bypasses the supervisor - use plain \`claude\` in its body instead`));
    }
  }

  console.log();
  console.log(ok ? c.green("all good ✓") : c.yellow("issues found - see above"));
  return ok ? 0 : 1;
}
