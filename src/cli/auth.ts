import { existsSync } from "node:fs";
import { countBy, partition, uniq } from "es-toolkit";
import { z } from "zod";
import { codexSupervisorLink, museSupervisorLink } from "../lib/install.ts";
import { withLock } from "../lib/lock.ts";
import { log } from "../lib/log.ts";
import { paths, type PiPool } from "../lib/paths.ts";
import { piLogin, piLoginStep } from "../lib/pi.ts";
import { piStoreUsable, writePiStore } from "../lib/piauth.ts";
import type { Provider } from "../lib/provider.ts";
import { loadAccounts, saveAccounts, upsertAccount } from "../lib/state.ts";
import { findAccount } from "./rename.ts";
import { poolHarvest, usageNote } from "./add.ts";
import { c, count } from "./render.ts";
import type { Account, AccountsIndex } from "../lib/types.ts";

const AUTH_USAGE =
  "usage: tokenmaxxing auth [--codex | --grok | --muse | --cursor] [<email|label|id> | --all]\n       tokenmaxxing auth [--codex | --grok | --muse | --cursor] --emails <email>...\n       tokenmaxxing auth --pi [--codex] [<email|label|id> | --all]";
const EMAILS_FLAG = "--emails";

const SUPERVISOR_LINKS: Partial<Record<Provider["name"], () => string>> = {
  claude: () => paths.supervisorLink,
  codex: codexSupervisorLink,
  muse: museSupervisorLink,
};

export type AuthPlan = { kind: "usage" } | { kind: "error"; message: string } | { kind: "pick" } | { kind: "targets"; ids: string[] };

export function planAuth(input: { p: Provider; accounts: Account[]; argv: string[]; needsAuth: Set<string> }): AuthPlan {
  const all = input.argv.includes("--all");
  const rest = input.argv.filter((a) => a !== "--all");
  if ((all && rest.length > 0) || rest.length > 1) return { kind: "usage" };
  if (input.accounts.length === 0) return { kind: "error", message: `no accounts in the pool - run \`tokenmaxxing init${input.p.flag}\` first` };
  if (all) {
    return { kind: "targets", ids: input.accounts.filter((a) => input.needsAuth.has(a.id)).map((a) => a.id) };
  }
  const selector = rest[0];
  if (selector !== undefined) {
    const found = findAccount(input.accounts, selector);
    if (!found) return { kind: "error", message: `no ${input.p.name} account matches "${selector}"` };
    return { kind: "targets", ids: [found.id] };
  }
  return { kind: "pick" };
}

export function pickerOrder(accounts: Account[], needsAuth: Set<string>): Account[] {
  const [flagged, healthy] = partition(accounts, (a) => needsAuth.has(a.id));
  return [...flagged, ...healthy];
}

function askWhichAccount(input: { idx: AccountsIndex; needsAuth: Set<string>; question: string; flags: (a: Account) => string[] }): Account | null {
  const ordered = pickerOrder(input.idx.accounts, input.needsAuth);
  console.log(input.question);
  for (const [i, a] of ordered.entries()) {
    const flags = input.flags(a);
    const labelNote = a.email != null && a.label !== a.email ? ` (${a.label})` : "";
    const tag = flags.length ? ` ${flags.join(" ")}` : "";
    console.log(`  ${i + 1}. ${c.bold(a.email ?? a.label)}${labelNote}${tag}`);
  }
  const answer = prompt("account (number, email, or label):")?.trim();
  if (!answer) {
    console.error(c.red("nothing selected"));
    return null;
  }
  const n = Number(answer);
  const byNumber = Number.isInteger(n) && n >= 1 && n <= ordered.length ? ordered[n - 1] : undefined;
  const chosen = byNumber ?? findAccount(ordered, answer);
  if (!chosen) {
    console.error(c.red(`no account matches "${answer}"`));
    return null;
  }
  return chosen;
}

async function reauthOne(p: Provider, target: Account): Promise<boolean> {
  console.log(c.cyan(`Reauthenticating ${c.bold(target.label)} - sign in as  ${c.bold(target.email ?? target.label)}.`));
  console.log(c.dim(p.loginStep("that account")));
  console.log();

  const harvested = await p.login();
  if (!harvested) return false;

  if (harvested.id !== target.id) {
    console.error(
      c.red(
        `that login is ${c.bold(harvested.email ?? harvested.id.slice(0, 8))}, but ${target.label} is ${c.bold(target.email ?? target.id.slice(0, 8))} - nothing changed. To pool it as its own account, run \`tokenmaxxing add${p.flag}\`.`,
      ),
    );
    return false;
  }

  const account = await withLock(p.pool.lockFile, async () => {
    const idx = loadAccounts(p.pool);
    if (!idx.accounts.some((a) => a.id === target.id)) {
      console.error(c.red(`${target.label} was removed from the pool while the login was open - nothing written; re-add it with \`tokenmaxxing add${p.flag}\` if wanted`));
      return null;
    }
    await harvested.park();
    const account = upsertAccount(idx, harvested, p.mergeWindows);
    saveAccounts(p.pool, idx);
    return account;
  });
  if (account === null) return false;

  const note = harvested.sample ? usageNote(p, account) : "";
  console.log(`${c.green("✓")} reauthed ${c.bold(account.email ?? account.label)} (${account.tier ?? "?"})${note}`);
  return true;
}

async function piLoginOne(p: Provider, pool: PiPool, target: Account): Promise<boolean> {
  console.log(c.cyan(`Logging ${c.bold(target.label)} into pi - sign in as  ${c.bold(target.email ?? target.label)}.`));
  console.log(c.dim(piLoginStep(pool)));
  console.log();

  const login = await piLogin(pool);
  if (!login) return false;

  if (login.id !== target.id) {
    const pooled = loadAccounts(p.pool).accounts.some((a) => a.id === login.id);
    const hint = pooled
      ? `run \`tokenmaxxing auth --pi${p.flag}\` for that account separately`
      : `a pi login attaches to an account already in the pool; pool that account first with \`tokenmaxxing add${p.flag}\``;
    console.error(
      c.red(
        `that login is ${c.bold(login.email ?? login.id.slice(0, 8))}, but ${target.label} is ${c.bold(target.email ?? target.id.slice(0, 8))} - nothing changed. To log that account into pi, ${hint}.`,
      ),
    );
    return false;
  }

  const written = await withLock(p.pool.lockFile, () => {
    if (!loadAccounts(p.pool).accounts.some((a) => a.id === target.id)) {
      console.error(c.red(`${target.label} was removed from the pool while the login was open - nothing written`));
      return false;
    }
    writePiStore(pool, target.id, login.cred);
    return true;
  });
  if (!written) return false;
  log("pi.login", { pool, account: target.id.slice(0, 8) });

  console.log(`${c.green("✓")} logged ${c.bold(target.email ?? target.label)} into pi`);
  return true;
}

async function loginEmails(p: Provider, argv: string[]): Promise<number> {
  const emails = argv.filter((a) => a !== EMAILS_FLAG).map((a) => a.toLowerCase());
  const invalid = uniq(emails.filter((e) => !z.email().safeParse(e).success));
  if (emails.length === 0 || invalid.length > 0) {
    if (invalid.length > 0) console.error(c.red(`not an email: ${invalid.join(", ")}`));
    console.error(AUTH_USAGE);
    return 2;
  }
  const accounts = loadAccounts(p.pool).accounts;
  const pooledIds = new Set(accounts.map((a) => a.id));
  const pooled = countBy(accounts, (a) => a.email?.toLowerCase() ?? "");
  const wanted = countBy(emails, (e) => e);
  const skipped = Object.keys(wanted).filter((e) => (pooled[e] ?? 0) >= (wanted[e] ?? 0));
  const targets = Object.keys(wanted).flatMap((e) => Array<string>(Math.max(0, (wanted[e] ?? 0) - (pooled[e] ?? 0))).fill(e));
  for (const email of skipped) console.log(c.dim(`skip ${email} - already in the ${p.name} pool`));

  let ok = 0;
  for (const [i, email] of targets.entries()) {
    console.log();
    if (targets.length > 1) console.log(c.bold(`[${i + 1}/${targets.length}]`));
    console.log(c.cyan(`Opening an isolated ${p.name} login - sign in as  ${c.bold(email)}.`));
    console.log(c.dim(p.loginStep("that account")));
    console.log();
    const harvested = await p.login();
    if (!harvested) continue;
    if (harvested.email?.toLowerCase() !== email) {
      console.error(c.red(`that login is ${c.bold(harvested.email ?? harvested.id.slice(0, 8))}, not ${c.bold(email)} - nothing changed.`));
      continue;
    }
    if (pooledIds.has(harvested.id)) {
      console.error(c.red(`that login is an account already in the pool - nothing changed. An email listed twice is a codex email with two workspaces: sign in to the workspace that is not pooled yet.`));
      continue;
    }
    await poolHarvest(p, harvested);
    pooledIds.add(harvested.id);
    ok += 1;
  }

  console.log();
  console.log(`added ${count({ n: ok, noun: "account" })} of ${targets.length}, skipped ${skipped.length} already pooled`);
  const link = SUPERVISOR_LINKS[p.name]?.();
  if (link != null && !existsSync(link) && loadAccounts(p.pool).accounts.length > 0) {
    console.log();
    console.log(c.cyan(`the ${p.name} pool has no supervisor yet - installing it, as \`tokenmaxxing init${p.flag}\` would`));
    p.preflight();
    p.install();
  }
  return ok === targets.length ? 0 : 1;
}

export async function cmdAuth(p: Provider, argv: string[], pi: PiPool | null): Promise<number> {
  if (argv.includes(EMAILS_FLAG)) {
    if (pi) {
      console.error(AUTH_USAGE);
      return 2;
    }
    return loginEmails(p, argv);
  }
  const idx = loadAccounts(p.pool);
  const needsAuth = new Set<string>();
  for (const a of idx.accounts) {
    const usable = pi ? piStoreUsable(pi, a.id) : a.needsReauth !== true && (await p.storeUsable(a));
    if (!usable) needsAuth.add(a.id);
  }
  const plan = planAuth({ p, accounts: idx.accounts, argv, needsAuth });
  if (plan.kind === "usage") {
    console.error(AUTH_USAGE);
    return 2;
  }
  if (plan.kind === "error") {
    console.error(c.red(plan.message));
    return 1;
  }

  const targets: Account[] = [];
  if (plan.kind === "pick") {
    const picked = askWhichAccount(
      pi
        ? { idx, needsAuth, question: "which account do you want to log into pi?", flags: (a) => (needsAuth.has(a.id) ? [c.red("no-pi-login")] : []) }
        : {
            idx,
            needsAuth,
            question: "which account do you want to reauthenticate?",
            flags: (a) => (a.needsReauth ? [c.red("needs-reauth")] : needsAuth.has(a.id) ? [c.red("no-credential")] : []),
          },
    );
    if (!picked) return 1;
    targets.push(picked);
  } else {
    for (const id of plan.ids) {
      const account = idx.accounts.find((a) => a.id === id);
      if (account) targets.push(account);
    }
    if (targets.length === 0) {
      console.log(`${c.green("✓")} ${pi ? "every account has a pi login" : "every account has a usable credential"}`);
      return 0;
    }
  }

  let ok = 0;
  for (const [i, target] of targets.entries()) {
    console.log();
    if (targets.length > 1) console.log(c.bold(`[${i + 1}/${targets.length}]`));
    if (await (pi ? piLoginOne(p, pi, target) : reauthOne(p, target))) ok += 1;
  }

  if (targets.length > 1) {
    console.log();
    console.log(`${pi ? "logged into pi" : "reauthed"} ${count({ n: ok, noun: "account" })} of ${targets.length}`);
  }
  return ok === targets.length ? 0 : 1;
}
