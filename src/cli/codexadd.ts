import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { MAX_WRAP_DEPTH, WRAP_DEPTH_ENV, resolveRealCodex } from "../lib/claudebin.ts";
import { codexIdentityOf, readCodexAuthAt, writeParkedCodexAuth } from "../lib/codexauth.ts";
import { CodexUsageReadError, fetchCodexUsage } from "../lib/codexusage.ts";
import { importedCodexAccount, loadCodexAccounts, saveCodexAccounts, upsertCodexAccount } from "../lib/codexstate.ts";
import { saveTermios, restoreTermios } from "../lib/tty.ts";
import { withLock } from "../lib/lock.ts";
import { codexCredItemFor, codexPaths } from "../lib/paths.ts";
import { writeFileAtomic } from "../lib/atomic.ts";
import type { CodexAccount, CodexUsage } from "../lib/types.ts";
import { c, count } from "./render.ts";

export async function cmdCodexAdd(): Promise<number> {
  const real = resolveRealCodex();
  const onboardDir = codexPaths.onboardDir;
  rmSync(onboardDir, { recursive: true, force: true });
  mkdirSync(onboardDir, { recursive: true });
  writeFileAtomic(join(onboardDir, "config.toml"), 'cli_auth_credentials_store = "file"\n');

  console.log(c.cyan("Opening an isolated codex login - your primary login is untouched."));
  console.log(c.dim("Open the URL codex prints, enter the code, and sign in with the account to add; the command exits once you're in."));
  console.log();

  const savedTermios = saveTermios();
  const p = Bun.spawn([real, "login", "--device-auth"], {
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
    env: {
      ...process.env,
      CODEX_HOME: onboardDir,
      TOKENMAXXING_PROBE: "1",
      [WRAP_DEPTH_ENV]: String(MAX_WRAP_DEPTH),
    },
  });
  await p.exited;
  restoreTermios(savedTermios);

  let account: CodexAccount;
  let poolSize: number;
  try {
    const auth = readCodexAuthAt({ path: join(onboardDir, "auth.json") });
    if (p.exitCode !== 0 || !auth) {
      console.error(c.red("no codex login landed in the isolated home - nothing added."));
      return 1;
    }

    const identity = codexIdentityOf({ auth });
    console.log(c.dim("sampling usage..."));
    let usage: CodexUsage | null = null;
    try {
      usage = await fetchCodexUsage({ auth });
    } catch (e) {
      if (!(e instanceof CodexUsageReadError)) throw e;
      console.log(c.yellow("could not sample usage now - it will fill in on first use."));
    }

    const credFile = codexCredItemFor(identity.accountId);
    writeParkedCodexAuth({ credFile, auth });

    ({ account, poolSize } = await withLock(codexPaths.lockFile, () => {
      const index = loadCodexAccounts();
      const fresh = importedCodexAccount({ existing: index.accounts.find((entry) => entry.accountId === identity.accountId), identity, usage, credFile });
      upsertCodexAccount(index, fresh);
      saveCodexAccounts({ index });
      return { account: fresh, poolSize: index.accounts.length };
    }));
  } finally {
    rmSync(onboardDir, { recursive: true, force: true });
  }

  console.log();
  console.log(`${c.green("✓")} added codex account ${c.bold(account.label)} (${account.planType ?? "?"}) - codex pool now has ${count({ n: poolSize, noun: "account" })}`);
  return 0;
}
