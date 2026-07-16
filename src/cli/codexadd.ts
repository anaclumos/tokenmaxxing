// `tokenmaxxing add --codex` - register an ADDITIONAL codex account. Runs
// `codex login` inside a throwaway CODEX_HOME pinned to file-mode credential
// storage (auto mode would keyring-namespace the login on macOS and leave
// nothing harvestable), then parks the resulting auth.json under the token's
// OWN identity and indexes it. The primary login is never touched.

import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { MAX_WRAP_DEPTH, WRAP_DEPTH_ENV } from "../lib/claudebin.ts";
import { resolveRealCodex } from "../lib/codexbin.ts";
import { codexIdentityOf, readCodexAuthAt, writeParkedCodexAuth } from "../lib/codexauth.ts";
import { CodexUsageReadError, fetchCodexUsage } from "../lib/codexusage.ts";
import { loadCodexAccounts, saveCodexAccounts } from "../lib/codexstate.ts";
import { saveTermios, restoreTermios } from "../lib/tty.ts";
import { withLock } from "../lib/lock.ts";
import { codexCredItemFor, codexPaths } from "../lib/paths.ts";
import { writeFileAtomic } from "../lib/atomic.ts";
import type { CodexAccount, CodexUsage } from "../lib/types.ts";
import { c, count } from "./render.ts";

export async function cmdCodexAdd(): Promise<number> {
  const real = resolveRealCodex();
  const onboardDir = codexPaths.onboardDir;
  // Deliberate hard delete (not trash; user decision 2026-07-16): the onboard
  // dir holds a plaintext live credential after login, and a trashed copy
  // would keep that token readable. The dir is tokenmaxxing's own transient
  // artifact; its one durable output is parked separately before cleanup.
  // Same rationale at the end-of-run cleanup below.
  rmSync(onboardDir, { recursive: true, force: true });
  mkdirSync(onboardDir, { recursive: true });
  writeFileAtomic(join(onboardDir, "config.toml"), 'cli_auth_credentials_store_mode = "file"\n');

  console.log(c.cyan("Opening an isolated codex login - your primary login is untouched."));
  console.log(c.dim("Complete the browser sign-in with the account to add; the command exits once you're in."));
  console.log();

  const savedTermios = saveTermios();
  const p = Bun.spawn([real, "login"], {
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

  const cleanup = () => rmSync(onboardDir, { recursive: true, force: true });

  const auth = readCodexAuthAt({ path: join(onboardDir, "auth.json") });
  if (p.exitCode !== 0 || !auth) {
    console.error(c.red("no codex login landed in the isolated home - nothing added."));
    cleanup();
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

  const { account, poolSize } = await withLock(codexPaths.lockFile, () => {
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
    saveCodexAccounts({ index });
    return { account: fresh, poolSize: index.accounts.length };
  });

  cleanup();

  console.log();
  console.log(`${c.green("✓")} added codex account ${c.bold(account.label)} (${account.planType ?? "?"}) - codex pool now has ${count({ n: poolSize, noun: "account" })}`);
  return 0;
}
