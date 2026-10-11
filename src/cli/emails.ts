import type { Provider } from "../lib/provider.ts";
import { loadAccounts } from "../lib/state.ts";
import { c, count } from "./render.ts";

export function cmdEmails(p: Provider): number {
  const accounts = loadAccounts(p.pool).accounts;
  const missing = accounts.filter((a) => a.email == null);
  for (const a of accounts) if (a.email != null) console.log(a.email);
  if (missing.length > 0) console.error(c.yellow(`${count({ n: missing.length, noun: "account" })} without a stored email left out: ${missing.map((a) => a.label).join(", ")}`));
  return 0;
}
