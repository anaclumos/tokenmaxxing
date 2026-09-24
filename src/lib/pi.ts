import { rmSync } from "node:fs";
import { join } from "node:path";
import { claude, ensurePathAhead, pickSeat } from "./claude.ts";
import { MAX_WRAP_DEPTH, PI_BIN, WRAP_DEPTH_ENV, resolveRealBin, verifyRealBin } from "./claudebin.ts";
import { codex, pickCodexSeat } from "./codex.ts";
import { chatgptAccountIdOf } from "./codexauth.ts";
import { CHECK_JOB, installPiSupervisor, isBinDirAhead, jobHealthy, piSupervisorLink } from "./install.ts";
import { errorMessage, log } from "./log.ts";
import { fetchTokenIdentity } from "./oauth.ts";
import { claudePool, piPaths, type PiPool } from "./paths.ts";
import { linkSharedPiHome, piStoreUsable, readPiAuthAt, type PiOAuth } from "./piauth.ts";
import { StoreUnusableError, type Provider } from "./provider.ts";
import { loadAccounts, pinBinOverride } from "./state.ts";
import { restoreTermios, saveTermios } from "./tty.ts";
import type { Account, ModelInfo } from "./types.ts";
import { c } from "../cli/render.ts";

const PROVIDER_TITLE: Record<PiPool, string> = { claude: "Anthropic (Claude Pro/Max)", codex: "OpenAI (ChatGPT Plus/Pro)" };

export function piLoginStep(pool: PiPool): string {
  return `In the pi session that opens, run  ${c.bold("/login")} , pick ${c.bold(PROVIDER_TITLE[pool])}, and sign in with that account. It closes itself once you're in.`;
}

export type PiLogin = { id: string; email: string | null; cred: PiOAuth };

function landed(path: string, pool: PiPool): PiOAuth | null {
  try {
    return readPiAuthAt({ path, pool });
  } catch {
    return null;
  }
}

async function identityOf(pool: PiPool, cred: PiOAuth): Promise<{ id: string; email: string | null } | null> {
  if (pool === "codex") {
    const id = chatgptAccountIdOf({ jwt: cred.access });
    if (id == null) {
      console.error(c.red("the pi login's access token carries no ChatGPT account id - nothing changed."));
      return null;
    }
    return { id, email: null };
  }
  try {
    const identity = await fetchTokenIdentity(cred.access);
    return { id: identity.accountUuid, email: identity.email };
  } catch (e) {
    console.error(c.red(`could not verify which account the pi login belongs to (${errorMessage(e)}) - nothing changed.`));
    return null;
  }
}

export async function piLogin(pool: PiPool): Promise<PiLogin | null> {
  const real = resolveRealBin(PI_BIN);
  const onboardDir = piPaths.onboardDir;
  rmSync(onboardDir, { recursive: true, force: true });
  linkSharedPiHome(onboardDir);
  const authPath = join(onboardDir, "auth.json");

  const savedTermios = saveTermios();
  const p = Bun.spawn([real, "--no-session", "--no-approve"], {
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
    env: { ...process.env, PI_CODING_AGENT_DIR: onboardDir, TOKENMAXXING_PROBE: "1", [WRAP_DEPTH_ENV]: String(MAX_WRAP_DEPTH) },
  });

  try {
    let cred: PiOAuth | null = null;
    let exited = false;
    const onExit = p.exited.then(() => { exited = true; });
    while (!exited) {
      await Bun.sleep(400);
      cred = landed(authPath, pool);
      if (cred) {
        p.kill();
        break;
      }
    }
    await onExit;
    restoreTermios(savedTermios);
    cred ??= landed(authPath, pool);
    if (!cred) {
      console.error(c.red(`no ${PROVIDER_TITLE[pool]} login landed in the isolated pi home - nothing changed.`));
      return null;
    }
    const identity = await identityOf(pool, cred);
    return identity ? { ...identity, cred } : null;
  } finally {
    if (p.exitCode === null) {
      p.kill();
      await p.exited;
    }
    restoreTermios(savedTermios);
    rmSync(onboardDir, { recursive: true, force: true });
  }
}

function piMover(base: Provider, pool: PiPool): Provider {
  return {
    ...base,
    swap: async (target) => {
      if (!piStoreUsable(pool, target.id)) {
        throw new StoreUnusableError(`${target.label} has no pi login - run \`tokenmaxxing auth --pi${base.flag} ${target.label}\``);
      }
      log("move.prepared", { account: target.id.slice(0, 8), label: target.label, pi: true });
    },
    classifySwapError: (e) => (e instanceof StoreUnusableError ? "skip" : "fatal"),
  };
}

export const piMovers: Record<PiPool, Provider> = { claude: piMover(claude, "claude"), codex: piMover(codex, "codex") };

export function pickPiSeat(pool: PiPool, now: number, model: ModelInfo | null): Account | null {
  const eligible = (a: Account) => piStoreUsable(pool, a.id);
  return pool === "claude" ? pickSeat(now, model, eligible) : pickCodexSeat(now, eligible);
}

export function piPreflight(): void {
  const real = resolveRealBin(PI_BIN);
  const fail = verifyRealBin({ ...PI_BIN, bin: real });
  if (fail !== null) throw new Error(`pi binary failed verification: ${real}: ${fail}`);
  pinBinOverride({ key: "piBin", bin: real });
}

export function piInstall(): void {
  installPiSupervisor();
  console.log(`${c.green("✓")} pi supervisor installed at ${piSupervisorLink()}`);
  if (!isBinDirAhead(PI_BIN)) ensurePathAhead();
  if (loadAccounts(claudePool).accounts.length > 0 && !jobHealthy(CHECK_JOB)) {
    console.log(c.yellow("⚠ the check timer is not active, so pi seats on Claude accounts get no fresh usage - run `tokenmaxxing init`"));
  }
}
