import { existsSync, readFileSync } from "node:fs";
import { verifyRealClaude } from "../lib/claudebin.ts";
import { checkSettings, installedBin } from "../lib/settings.ts";
import { checkTimerHealthy, findClaudeShadowers, isBinDirAhead, shellRcPath, timerActivationHint } from "../lib/install.ts";
import { paths } from "../lib/paths.ts";
import { loadAccounts, loadConfig } from "../lib/state.ts";
import { readItem, liveTarget, parkedTarget } from "../lib/credstore.ts";
import { isAccessTokenExpiring, fetchTokenOrg } from "../lib/oauth.ts";
import { CredentialBlobSchema, type RolesResponse } from "../lib/types.ts";
import { c, emitJson } from "./render.ts";

async function blobOrg(raw: string): Promise<RolesResponse | null> {
  const creds = CredentialBlobSchema.parse(JSON.parse(raw)).claudeAiOauth;
  if (isAccessTokenExpiring(creds)) return null;
  return fetchTokenOrg(creds.accessToken);
}

export async function cmdDoctor(json = false): Promise<number> {
  const checks: { ok: boolean; label: string; hint: string | null }[] = [];
  const notes: string[] = [];
  const warnings: string[] = [];
  const check = (cond: boolean, label: string, hint?: string) => {
    checks.push({ ok: cond, label, hint: cond ? null : (hint ?? null) });
    if (!json) console.log(`${cond ? c.green("✓") : c.red("✗")} ${label}${!cond && hint ? c.dim(`  - ${hint}`) : ""}`);
  };
  const note = (text: string) => {
    notes.push(text);
    if (!json) console.log(c.dim(`  - ${text}`));
  };
  const warn = (text: string) => {
    warnings.push(text);
    if (!json) console.log(c.yellow(`⚠ ${text}`));
  };

  check(existsSync(paths.supervisorLink), "claude supervisor wrapper present", "run `tokenmaxxing init`");
  check(existsSync(installedBin()), "tokenmaxxing binary installed", "run `tokenmaxxing init`");
  check(isBinDirAhead(), `${paths.binDir} is ahead of the real claude on PATH`, `export PATH="${paths.binDir}:$PATH"`);

  const s = checkSettings();
  check(s.statusLineOk, "statusLine shim installed in settings.json", "run `tokenmaxxing init`");
  check(s.subagentStatusLineOk, "subagentStatusLine shim installed in settings.json", "run `tokenmaxxing init`");
  check(s.stopOk, "Stop hook installed in settings.json", "run `tokenmaxxing init`");
  check(s.stopFailureOk, "StopFailure hook installed in settings.json", "run `tokenmaxxing init`");
  check(s.sessionStartOk, "SessionStart hook installed in settings.json", "run `tokenmaxxing init`");
  check(checkTimerHealthy(), "periodic check timer active", timerActivationHint());

  const idx = loadAccounts();
  check(idx.accounts.length > 0, "at least one account in the pool", "run `tokenmaxxing init`");
  check(!!idx.activeAccountUuid, "an active account is set");

  const live = await readItem(liveTarget());
  check(!!live, "live credential readable");

  const active = idx.accounts.find((a) => a.accountUuid === idx.activeAccountUuid);
  if (live && active) {
    try {
      const org = await blobOrg(live);
      if (org) check(org.organization_uuid === active.organizationUuid, `live credential identity matches active (${active.email})`, `token belongs to ${org.organization_name} - run \`tokenmaxxing switch\``);
      else note("live credential identity unverifiable (access token expired)");
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
        else note(`${a.email} identity unverifiable (access token expired)`);
      } catch (e) {
        check(false, `parked credential identity matches ${a.email}`, (e instanceof Error ? e.message : String(e)).slice(0, 100));
      }
    }
    if (a.needsReauth) check(false, `${a.email} needs re-auth`, `run \`tokenmaxxing auth ${a.label}\` to re-login`);
  }

  const cfg = loadConfig();
  check(!!cfg.claudeBin && existsSync(cfg.claudeBin), "real claude binary resolved", "set claudeBin in config.json");
  if (cfg.claudeBin && existsSync(cfg.claudeBin)) {
    const fail = verifyRealClaude(cfg.claudeBin);
    check(fail === null, "claudeBin launches the real claude", fail ?? undefined);
  }

  const rc = shellRcPath();
  if (rc && existsSync(rc)) {
    for (const s of findClaudeShadowers(readFileSync(rc, "utf8"))) {
      if (s.kind === "shadow") warn(`${rc}: \`${s.line}\` shadows the supervised claude wrapper - launches through it skip tokenmaxxing`);
      else warn(`${rc}: alias \`${s.name}\` hardcodes a claude path and bypasses the supervisor - use plain \`claude\` in its body instead`);
    }
  }

  const ok = checks.every((entry) => entry.ok);
  if (json) {
    emitJson({ ok, checks, notes, warnings });
    return ok ? 0 : 1;
  }
  console.log();
  console.log(ok ? c.green("all good ✓") : c.yellow("issues found - see above"));
  return ok ? 0 : 1;
}
