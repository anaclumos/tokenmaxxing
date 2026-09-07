import { partition } from "es-toolkit";
import { withLock } from "../lib/lock.ts";
import { loadAccounts, saveAccounts } from "../lib/state.ts";
import { paths } from "../lib/paths.ts";
import { writeItem, parkedTarget, claudeAiOauthOnly } from "../lib/credstore.ts";
import { findAccount } from "./rename.ts";
import { harvestIsolatedLogin } from "./onboard.ts";
import { c, claudeTierLabel, count } from "./render.ts";
import type { Account, AccountsIndex } from "../lib/types.ts";

const AUTH_USAGE = "usage: tokenmaxxing auth [<email|label|id> | --all]";

export type AuthPlan =
  | { kind: "usage" }
  | { kind: "error"; message: string }
  | { kind: "pick" }
  | { kind: "targets"; uuids: string[] };

export function planAuth(input: { accounts: Account[]; all: boolean; rest: string[] }): AuthPlan {
  const { all, rest } = input;
  if ((all && rest.length > 0) || rest.length > 1) return { kind: "usage" };
  if (input.accounts.length === 0) return { kind: "error", message: "no accounts in the pool - run `tokenmaxxing init` first" };
  if (all) {
    const flagged = input.accounts.filter((a) => a.needsReauth === true);
    return { kind: "targets", uuids: flagged.map((a) => a.accountUuid) };
  }
  const selector = rest[0];
  if (selector !== undefined) {
    const found = findAccount(input.accounts, selector);
    if (!found) return { kind: "error", message: `no claude account matches "${selector}"` };
    return { kind: "targets", uuids: [found.accountUuid] };
  }
  return { kind: "pick" };
}

export function pickerOrder(accounts: Account[]): Account[] {
  const [flagged, healthy] = partition(accounts, (a) => a.needsReauth === true);
  return [...flagged, ...healthy];
}

function askWhichAccount(idx: AccountsIndex): Account | null {
  const ordered = pickerOrder(idx.accounts);
  console.log("which account do you want to reauthenticate?");
  for (const [i, a] of ordered.entries()) {
    const flags: string[] = [];
    if (a.accountUuid === idx.activeAccountUuid) flags.push(c.green("active"));
    if (a.needsReauth) flags.push(c.red("needs-reauth"));
    const labelNote = a.label && a.label !== a.email ? ` (${a.label})` : "";
    const tag = flags.length ? ` ${flags.join(" ")}` : "";
    console.log(`  ${i + 1}. ${c.bold(a.email)}${labelNote}${tag}`);
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

async function reauthOne(target: Account): Promise<boolean> {
  console.log(c.cyan(`Reauthenticating ${c.bold(target.label)} - sign in as  ${c.bold(target.email)}.`));
  console.log(c.dim(`In the session that opens, run  ${c.bold("/login")}  with that account. It closes itself once you're in.`));
  console.log();

  const harvested = await harvestIsolatedLogin();
  if (!harvested) return false;
  const { blobRaw, blob, oauthAccount, sampled } = harvested;

  if (oauthAccount.accountUuid !== target.accountUuid) {
    console.error(
      c.red(
        `that login is ${c.bold(oauthAccount.emailAddress)}, but ${target.label} is ${c.bold(target.email)} - nothing changed. To pool it as its own account, run \`tokenmaxxing add\`.`,
      ),
    );
    return false;
  }

  const isActive = await withLock(paths.lockFile, async () => {
    const idx = loadAccounts();
    const account = idx.accounts.find((a) => a.accountUuid === target.accountUuid);
    if (!account) {
      console.error(c.red(`${target.label} was removed from the pool while the login was open - nothing written; re-add it with \`tokenmaxxing add\` if wanted`));
      return null;
    }
    await writeItem(parkedTarget(target.keychainItem), claudeAiOauthOnly(blobRaw));
    account.email = oauthAccount.emailAddress;
    account.organizationUuid = oauthAccount.organizationUuid;
    account.oauthAccount = oauthAccount;
    account.subscriptionType = blob.claudeAiOauth.subscriptionType;
    account.rateLimitTier = blob.claudeAiOauth.rateLimitTier;
    account.needsReauth = false;
    if (sampled) {
      account.lastUsage = { fiveHour: sampled.session, sevenDay: sampled.weekAll };
      account.lastUsageAt = Date.now();
      if (Object.keys(sampled.perModel).length > 0) {
        account.lastPerModel = sampled.perModel;
        account.lastPerModelAt = account.lastUsageAt;
      }
    }
    saveAccounts(idx);
    return idx.activeAccountUuid === target.accountUuid;
  });
  if (isActive === null) return false;

  const usageNote = sampled ? ` (session ${sampled.session.usedPercentage}% / week ${sampled.weekAll.usedPercentage}%)` : "";
  const tier = claudeTierLabel(blob.claudeAiOauth) ?? "?";
  console.log(`${c.green("✓")} reauthed ${c.bold(oauthAccount.emailAddress)} (${tier})${usageNote}`);
  if (isActive) {
    console.log(c.dim("this account is the active one: the fresh credential is parked as its backup; the live session keeps its current token until the next swap."));
  }
  return true;
}

export async function cmdAuth(input: { all: boolean; rest: string[] }): Promise<number> {
  const idx = loadAccounts();
  const plan = planAuth({ accounts: idx.accounts, all: input.all, rest: input.rest });
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
    const picked = askWhichAccount(idx);
    if (!picked) return 1;
    targets.push(picked);
  } else {
    for (const uuid of plan.uuids) {
      const account = idx.accounts.find((a) => a.accountUuid === uuid);
      if (account) targets.push(account);
    }
    if (targets.length === 0) {
      console.log(`${c.green("✓")} no account needs reauth`);
      return 0;
    }
  }

  let ok = 0;
  for (const [i, target] of targets.entries()) {
    console.log();
    if (targets.length > 1) console.log(c.bold(`[${i + 1}/${targets.length}]`));
    if (await reauthOne(target)) ok += 1;
  }

  if (targets.length > 1) {
    console.log();
    console.log(`reauthed ${count({ n: ok, noun: "account" })} of ${targets.length}`);
  }
  return ok === targets.length ? 0 : 1;
}
