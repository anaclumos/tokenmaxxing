import { partition } from "es-toolkit";
import { withLock } from "../lib/lock.ts";
import type { Provider } from "../lib/provider.ts";
import { loadAccounts, saveAccounts, upsertAccount } from "../lib/state.ts";
import { findAccount } from "./rename.ts";
import { usageNote } from "./add.ts";
import { c, count } from "./render.ts";
import type { Account, AccountsIndex } from "../lib/types.ts";

const AUTH_USAGE = "usage: tokenmaxxing auth [--codex | --grok | --opencode-go] [<email|label|id> | --all]";

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

function askWhichAccount(idx: AccountsIndex, needsAuth: Set<string>): Account | null {
  const ordered = pickerOrder(idx.accounts, needsAuth);
  console.log("which account do you want to reauthenticate?");
  for (const [i, a] of ordered.entries()) {
    const flags: string[] = [];
    if (a.needsReauth) flags.push(c.red("needs-reauth"));
    else if (needsAuth.has(a.id)) flags.push(c.red("no-credential"));
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

  const note = harvested.sample ? usageNote(account) : "";
  console.log(`${c.green("✓")} reauthed ${c.bold(account.email ?? account.label)} (${account.tier ?? "?"})${note}`);
  return true;
}

export async function cmdAuth(p: Provider, argv: string[]): Promise<number> {
  const idx = loadAccounts(p.pool);
  const needsAuth = new Set<string>();
  for (const a of idx.accounts) {
    if (a.needsReauth === true || !(await p.storeUsable(a))) needsAuth.add(a.id);
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
    const picked = askWhichAccount(idx, needsAuth);
    if (!picked) return 1;
    targets.push(picked);
  } else {
    for (const id of plan.ids) {
      const account = idx.accounts.find((a) => a.id === id);
      if (account) targets.push(account);
    }
    if (targets.length === 0) {
      console.log(`${c.green("✓")} every account has a usable credential`);
      return 0;
    }
  }

  let ok = 0;
  for (const [i, target] of targets.entries()) {
    console.log();
    if (targets.length > 1) console.log(c.bold(`[${i + 1}/${targets.length}]`));
    if (await reauthOne(p, target)) ok += 1;
  }

  if (targets.length > 1) {
    console.log();
    console.log(`reauthed ${count({ n: ok, noun: "account" })} of ${targets.length}`);
  }
  return ok === targets.length ? 0 : 1;
}
