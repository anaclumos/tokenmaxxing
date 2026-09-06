import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { resolveRealCodex, verifyRealBin } from "../lib/claudebin.ts";
import { codexIdentityOf, readLiveCodexAuth, writeParkedCodexAuth } from "../lib/codexauth.ts";
import { CodexUsageReadError, fetchCodexUsage } from "../lib/codexusage.ts";
import { importedCodexAccount, loadCodexAccounts, saveCodexAccounts, upsertCodexAccount } from "../lib/codexstate.ts";
import { errnoCode } from "../lib/errors.ts";
import { loadConfig, pinBinOverride } from "../lib/state.ts";
import { installCodexSupervisor, codexSupervisorLink, ensurePathInRc, managedShellRcSkipLines, shellRcPath } from "../lib/install.ts";
import { withLock } from "../lib/lock.ts";
import { presentCodexAccountIds } from "../lib/codexpresence.ts";
import { codexCredItemFor, codexPaths } from "../lib/paths.ts";
import type { CodexUsage } from "../lib/types.ts";
import { c } from "./render.ts";

const CodexConfigTomlSchema = z.looseObject({ cli_auth_credentials_store: z.string().optional() });

function storePinnedAwayFromFile(): boolean {
  const configToml = join(codexPaths.home, "config.toml");
  let text: string;
  try {
    text = readFileSync(configToml, "utf8");
  } catch (e) {
    if (errnoCode(e) === "ENOENT") return false;
    throw e;
  }
  const store = CodexConfigTomlSchema.parse(Bun.TOML.parse(text)).cli_auth_credentials_store;
  return store !== undefined && store !== "file";
}

export async function cmdCodexInit(): Promise<number> {
  loadConfig();
  const real = resolveRealCodex();
  const fail = verifyRealBin({ name: "codex", bin: real });
  if (fail !== null) {
    console.error(c.red(`codex binary failed verification: ${real}: ${fail}`));
    return 1;
  }
  pinBinOverride({ key: "codexBin", bin: real });

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

  if (presentCodexAccountIds().has(identity.accountId)) {
    console.error(c.red("a live supervised codex session is running this account - its token rotates under us, so parking a snapshot now could poison the backup."));
    console.error(c.dim("close that codex session (or let it exit) and re-run `tokenmaxxing init --codex`."));
    return 1;
  }

  const account = await withLock(codexPaths.lockFile, () => {
    if (presentCodexAccountIds().has(identity.accountId)) {
      throw new Error("a live supervised codex session started running this account mid-init - close it and re-run `tokenmaxxing init --codex`");
    }
    const fresh2 = readLiveCodexAuth();
    if (!fresh2 || codexIdentityOf({ auth: fresh2 }).accountId !== identity.accountId) {
      throw new Error("the live codex login changed while init was running (a concurrent swap?) - re-run `tokenmaxxing init --codex`");
    }
    writeParkedCodexAuth({ credFile, auth: fresh2 });
    const index = loadCodexAccounts();
    const fresh = importedCodexAccount({ existing: index.accounts.find((entry) => entry.accountId === identity.accountId), identity, usage, credFile });
    upsertCodexAccount(index, fresh);
    index.activeAccountId = identity.accountId;
    saveCodexAccounts({ index });
    return fresh;
  });

  installCodexSupervisor();
  const rc = shellRcPath();
  if (rc) {
    const pathOutcome = ensurePathInRc(rc);
    if (pathOutcome === "skipped") {
      const hint = managedShellRcSkipLines();
      console.log();
      console.log(c.yellow(`⚠ ${hint.headline}`));
      console.log(c.yellow(`  ${hint.detail}`));
      console.log(c.yellow(`  ${hint.exportLine}`));
    }
  }

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
