import { loadAccounts } from "../lib/state.ts";
import { loadCodexAccounts } from "../lib/codexstate.ts";
import { liveCodexAccountId } from "../lib/codexsample.ts";
import { c, claudeTierLabel, emitJson } from "./render.ts";

export function cmdLs(json = false): number {
  const idx = loadAccounts();

  if (json) {
    const codex = loadCodexAccounts();
    const liveId = codex.accounts.length > 0 ? liveCodexAccountId() : null;
    emitJson({
      ok: true,
      claude: {
        activeAccountUuid: idx.activeAccountUuid,
        accounts: idx.accounts.map((a) => ({
          label: a.label,
          email: a.email,
          accountUuid: a.accountUuid,
          organizationUuid: a.organizationUuid,
          tier: claudeTierLabel(a),
          active: a.accountUuid === idx.activeAccountUuid,
          needsReauth: a.needsReauth === true,
          addedAt: a.addedAt,
        })),
      },
      codex: {
        activeAccountId: liveId,
        accounts: codex.accounts.map((account) => ({
          label: account.label,
          email: account.email,
          accountId: account.accountId,
          planType: account.planType,
          active: account.accountId === liveId,
          needsReauth: account.needsReauth === true,
          addedAt: account.addedAt,
        })),
      },
    });
    return 0;
  }

  if (idx.accounts.length === 0) {
    console.log(c.dim("no accounts yet - run `tokenmaxxing init` then `tokenmaxxing add`"));
  }
  for (const a of idx.accounts) {
    const active = a.accountUuid === idx.activeAccountUuid;
    const marker = active ? c.green("●") : c.dim("○");
    const flags: string[] = [];
    if (active) flags.push(c.green("active"));
    if (a.needsReauth) flags.push(c.red("needs-reauth"));
    const tag = flags.length ? ` ${flags.join(" ")}` : "";
    const label = a.label || a.email;
    console.log(`${marker} ${c.bold(label)}${tag}`);
    console.log(`  ${c.dim(`org ${a.organizationUuid.slice(0, 8)}, ${claudeTierLabel(a) ?? "?"}, uuid ${a.accountUuid.slice(0, 8)}`)}`);
  }

  const codex = loadCodexAccounts();
  if (codex.accounts.length > 0) {
    const liveId = liveCodexAccountId();
    console.log();
    console.log(c.dim("codex"));
    for (const account of codex.accounts) {
      const active = account.accountId === liveId;
      const marker = active ? c.green("●") : c.dim("○");
      const flags: string[] = [];
      if (active) flags.push(c.green("active"));
      if (account.needsReauth) flags.push(c.red("needs-reauth"));
      const tag = flags.length ? ` ${flags.join(" ")}` : "";
      console.log(`${marker} ${c.bold(account.label)}${tag}`);
      console.log(`  ${c.dim(`${account.planType ?? "?"}, id ${account.accountId.slice(0, 8)}`)}`);
    }
  }
  return 0;
}
