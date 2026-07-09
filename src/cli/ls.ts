// `tokenmaxxing ls` - compact list of pooled accounts.

import { loadAccounts } from "../lib/state.ts";
import { c } from "./render.ts";

export function cmdLs(): number {
  const idx = loadAccounts();
  if (idx.accounts.length === 0) {
    console.log(c.dim("no accounts yet - run `tokenmaxxing init` then `tokenmaxxing add`"));
    return 0;
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
    console.log(`  ${c.dim(`org ${a.organizationUuid.slice(0, 8)} · ${a.subscriptionType ?? "?"} · uuid ${a.accountUuid.slice(0, 8)}`)}`);
  }
  return 0;
}
