import { existsSync, readFileSync } from "node:fs";
import { verifyRealClaude } from "../lib/claudebin.ts";
import { checkSettings, installedBin } from "../lib/settings.ts";
import { checkTimerHealthy, findClaudeShadowers, isBinDirAhead, shellRcPath, timerActivationHint } from "../lib/install.ts";
import { claudePool, paths } from "../lib/paths.ts";
import { loadAccounts, loadConfig } from "../lib/state.ts";
import { readStore } from "../lib/credstore.ts";
import { isAccessTokenExpiring, isDeadCredential, fetchTokenIdentity, describeIdentity } from "../lib/oauth.ts";
import { SETUP_TOKEN_STALE_MS, loadSetupTokens } from "../lib/setuptokens.ts";
import { c, fmtAgo } from "./render.ts";

export async function cmdDoctor(): Promise<number> {
  let failed = 0;
  const check = (cond: boolean, label: string, hint?: string) => {
    if (!cond) failed++;
    console.log(`${cond ? c.green("✓") : c.red("✗")} ${label}${!cond && hint ? c.dim(`  - ${hint}`) : ""}`);
  };
  const note = (text: string) => console.log(c.dim(`  - ${text}`));
  const warn = (text: string) => console.log(c.yellow(`⚠ ${text}`));

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

  const idx = loadAccounts(claudePool);
  check(idx.accounts.length > 0, "at least one account in the pool", "run `tokenmaxxing init`");

  for (const a of idx.accounts) {
    let creds;
    try {
      creds = await readStore(a.id);
    } catch (e) {
      check(false, `store credential readable for ${a.label}`, (e instanceof Error ? e.message : String(e)).slice(0, 100));
      continue;
    }
    check(creds != null, `store credential present for ${a.label}`, `run \`tokenmaxxing auth ${a.label}\``);
    if (creds) {
      if (isDeadCredential(creds)) check(false, `${a.label}'s store credential is usable`, `cleared after a failed refresh - run \`tokenmaxxing auth ${a.label}\``);
      else if (isAccessTokenExpiring(creds)) note(`${a.label} identity unverifiable (access token expired)`);
      else {
        try {
          const identity = await fetchTokenIdentity(creds.accessToken);
          check(identity.accountUuid === a.id, `store credential identity matches ${a.label}`, `token belongs to ${describeIdentity(identity)} - run \`tokenmaxxing auth ${a.label}\``);
        } catch (e) {
          check(false, `store credential identity matches ${a.label}`, (e instanceof Error ? e.message : String(e)).slice(0, 100));
        }
      }
    }
    if (a.needsReauth) check(false, `${a.label} needs re-auth`, `run \`tokenmaxxing auth ${a.label}\` to re-login`);
  }

  if (existsSync(paths.setupTokensJson)) {
    const setupTokens = loadSetupTokens().tokens;
    for (const a of idx.accounts) {
      const token = setupTokens.find((t) => t.accountUuid === a.id);
      if (!token) warn(`no setup token stored for ${a.label} - run \`tokenmaxxing setup-token\` to mint one for Cursor Cloud`);
      else if (Date.now() - token.mintedAt > SETUP_TOKEN_STALE_MS) warn(`the setup token for ${a.label} was minted ${fmtAgo(token.mintedAt)} and expires a year after minting - \`tokenmaxxing setup-token rm ${a.label}\` then \`tokenmaxxing setup-token\` re-mints it`);
    }
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
      if (s.kind === "shadow") warn(`${rc}: ${s.line.startsWith("alias ") ? "alias" : "function"} \`claude\` shadows the supervised claude wrapper - launches through it skip tokenmaxxing`);
      else warn(`${rc}: alias \`${s.name}\` hardcodes a claude path and bypasses the supervisor - use plain \`claude\` in its body instead`);
    }
  }

  console.log();
  console.log(failed === 0 ? c.green("all good ✓") : c.yellow("issues found - see above"));
  return failed === 0 ? 0 : 1;
}
