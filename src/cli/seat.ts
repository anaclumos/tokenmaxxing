import { borrowClaudeSeat } from "../lib/claude.ts";
import { borrowCodexSeat } from "../lib/codex.ts";
import { emitError } from "./render.ts";

const STORE_FLAG = "--store";

const POOLS = {
  claude: {
    usage: "usage: tokenmaxxing seat <pid> [--store <id>] - print the CLAUDE_SECURESTORAGE_CONFIG_DIR of one pooled claude account, lent to <pid> until it exits and shared with host sessions and other borrowers; --store grants the store with that 8-character id instead of the ranked pick, checking only that it is pooled, holds a usable credential, and is not flagged for reauthentication (bars, credits, and holds are the caller's job); exit 0 = granted, 1 = none usable or the named store unusable, 2 = unknown store, a pid that holds another store, or bad usage",
    none: "no usable claude account (pool empty, or every account at a limit or flagged for reauthentication)",
  },
  codex: {
    usage: "usage: tokenmaxxing seat --codex <pid> - print the CODEX_HOME of one pooled account, lent to <pid> until it exits and shared with codex sessions and other borrowers; codex processes that share one auth.json can lose a refresh race that signs the account out until `tokenmaxxing auth --codex` runs again",
    none: "no usable codex account (pool empty, or every account at a limit, flagged for reauthentication, held by a pi session, or held by the supervised codex session this runs in) - use the ambient codex login",
  },
};

export async function cmdSeat(pool: keyof typeof POOLS, rest: string[]): Promise<number> {
  const seat = POOLS[pool];
  const at = rest.indexOf(STORE_FLAG);
  const named = at < 0 ? undefined : rest[at + 1];
  const operands = at < 0 ? rest : rest.filter((_, i) => i !== at && i !== at + 1);
  const pidRaw = operands[0];
  const pid = operands.length === 1 && pidRaw != null && /^(0|[1-9][0-9]*)$/.test(pidRaw) ? Number(pidRaw) : NaN;
  if (!Number.isSafeInteger(pid) || pid < 2 || (at >= 0 && (pool !== "claude" || named == null || named.startsWith("-")))) {
    emitError({ message: seat.usage });
    return 2;
  }
  const granted = await (pool === "claude" ? borrowClaudeSeat(pid, named) : borrowCodexSeat(pid));
  if (!granted) {
    emitError({ message: seat.none });
    return 1;
  }
  if ("invalid" in granted) {
    emitError({ message: granted.invalid });
    return 2;
  }
  if ("denied" in granted) {
    emitError({ message: granted.denied });
    return 1;
  }
  console.log(granted.store);
  return 0;
}
