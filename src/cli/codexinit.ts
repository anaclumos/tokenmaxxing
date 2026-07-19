// `tokenmaxxing init --codex` - bring the codex side up: verify + pin the real
// codex binary, import the existing live login as codex account #1, install
// the on-PATH codex supervisor shim and the Stop hook declaration, and tell
// the user about the one step tokenmaxxing cannot do for them: codex skips
// hooks it has not been TRUSTED to run (trust is recorded against the hook's
// hash via /hooks in the codex TUI), so auto-switching stays inert until then.

import { existsSync, readFileSync } from "node:fs";
import { resolveRealCodex, verifyRealCodex } from "../lib/codexbin.ts";
import { codexIdentityOf, readLiveCodexAuth, writeParkedCodexAuth } from "../lib/codexauth.ts";
import { CodexUsageReadError, fetchCodexUsage } from "../lib/codexusage.ts";
import { loadCodexAccounts, saveCodexAccounts } from "../lib/codexstate.ts";
import { loadConfig, saveConfig } from "../lib/state.ts";
import { installCodexSupervisor, codexSupervisorLink, ensurePathInRc, shellRcPath } from "../lib/install.ts";
import { withLock } from "../lib/lock.ts";
import { codexCredItemFor, codexPaths } from "../lib/paths.ts";
import type { CodexAccount, CodexUsage } from "../lib/types.ts";
import { c } from "./render.ts";

/** Fail fast when config.toml pins the credential store away from the plain
 *  file tokenmaxxing swaps (structural line scan: the repo ships no TOML
 *  parser, and this single key is the only one we ever inspect). The real key
 *  is `cli_auth_credentials_store` (binary-verified 0.144.5; an earlier
 *  verification misread the enum TYPE name as a `_mode` key). An ABSENT key is
 *  allowed: the DEFAULT at 0.144.5 is `file` itself (source-verified:
 *  AuthCredentialsStoreMode derives Default on the File variant), and init
 *  separately verifies a harvestable auth.json.
 *  Any EXPLICIT non-file pin (keyring, auto, ephemeral) is a deliberate store
 *  choice tokenmaxxing cannot honor. */
function storePinnedAwayFromFile(): boolean {
  const configToml = `${codexPaths.home}/config.toml`;
  if (!existsSync(configToml)) return false;
  for (const rawLine of readFileSync(configToml, "utf8").split("\n")) {
    const line = rawLine.trim();
    if (!line.startsWith("cli_auth_credentials_store")) continue;
    const rest = line.slice("cli_auth_credentials_store".length).trimStart();
    if (!rest.startsWith("=")) continue;
    // Value only: strip an inline TOML comment and the quotes structurally so
    // a comment mentioning "keyring" never false-positives the fail-fast.
    const beforeComment = rest.slice(1).split("#", 1)[0]!;
    const value = beforeComment.replaceAll('"', "").replaceAll("'", "").trim();
    return value !== "file";
  }
  return false;
}

export async function cmdCodexInit(): Promise<number> {
  const real = resolveRealCodex();
  const fail = verifyRealCodex({ bin: real });
  if (fail !== null) {
    console.error(c.red(`codex binary failed verification: ${real}: ${fail}`));
    return 1;
  }
  const cfg = loadConfig();
  cfg.codexBin = real;
  saveConfig(cfg);

  if (storePinnedAwayFromFile()) {
    console.error(c.red("codex config.toml pins cli_auth_credentials_store away from the plain auth.json file tokenmaxxing swaps."));
    console.error(c.dim('recovery: set cli_auth_credentials_store = "file" in ~/.codex/config.toml, run `codex login`, then re-run this.'));
    return 1;
  }

  const live = readLiveCodexAuth();
  if (!live) {
    console.error(c.red(`no codex login found at ${codexPaths.authJson} - run \`codex login\` first, then re-run this.`));
    return 1;
  }
  const identity = codexIdentityOf({ auth: live });

  console.log(c.dim("sampling usage..."));
  let usage: CodexUsage | null = null;
  try {
    usage = await fetchCodexUsage({ auth: live });
  } catch (e) {
    if (!(e instanceof CodexUsageReadError)) throw e;
    console.log(c.yellow("could not sample usage now - it will fill in on first use."));
  }

  const credFile = codexCredItemFor(identity.accountId);
  writeParkedCodexAuth({ credFile, auth: live });

  const account = await withLock(codexPaths.lockFile, () => {
    const index = loadCodexAccounts();
    const existing = index.accounts.find((entry) => entry.accountId === identity.accountId);
    const fresh: CodexAccount = {
      accountId: identity.accountId,
      email: usage?.email ?? identity.email,
      label: existing?.label ?? usage?.email ?? identity.email ?? identity.accountId.slice(0, 8),
      planType: usage?.planType ?? identity.planType,
      credFile,
      addedAt: existing?.addedAt ?? new Date().toISOString(),
      needsReauth: false,
      lastUsage: usage ? { aggregate: usage.aggregate, perLimit: usage.perLimit } : existing?.lastUsage,
      lastUsageAt: usage ? Date.now() : existing?.lastUsageAt,
    };
    if (existing) Object.assign(existing, fresh);
    else index.accounts.push(fresh);
    index.activeAccountId = identity.accountId;
    saveCodexAccounts({ index });
    return fresh;
  });

  installCodexSupervisor();
  const rc = shellRcPath();
  if (rc) ensurePathInRc(rc);

  console.log();
  console.log(`${c.green("✓")} imported codex account ${c.bold(account.label)} (${account.planType ?? "?"})`);
  console.log(`${c.green("✓")} codex supervisor installed at ${codexSupervisorLink()}`);
  console.log(`${c.green("✓")} Stop hook declared in ${codexPaths.hooksJson}`);
  console.log();
  console.log(c.bold(c.yellow("one manual step: codex skips untrusted hooks.")));
  console.log(c.yellow("open codex, run /hooks, and trust the tokenmaxxing Stop hook - auto-switching is inert until then."));
  console.log(c.dim("then add more accounts with `tokenmaxxing add --codex`."));
  return 0;
}
