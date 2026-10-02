import { borrowClaudeSeat } from "../lib/claude.ts";
import { borrowCodexSeat } from "../lib/codex.ts";
import { borrowOpencodeGoSeat } from "../lib/opencodego.ts";
import { emitError } from "./render.ts";

const POOLS = {
  claude: {
    borrow: borrowClaudeSeat,
    usage: "usage: tokenmaxxing seat <pid> - print the CLAUDE_SECURESTORAGE_CONFIG_DIR of one pooled claude account, lent to <pid> until it exits and shared with host sessions and other borrowers",
    none: "no usable claude account (pool empty, or every account at a limit or flagged for reauthentication)",
  },
  codex: {
    borrow: borrowCodexSeat,
    usage: "usage: tokenmaxxing seat --codex <pid> - print the CODEX_HOME of one pooled account, reserved to <pid> alone until it exits, because one codex auth.json serves one machine or one serialized job stream (https://learn.chatgpt.com/docs/auth/ci-cd-auth)",
    none: "no usable codex account (pool empty, every account live in another session, or every account at a limit) - use the ambient codex login",
  },
  "opencode-go": {
    borrow: borrowOpencodeGoSeat,
    usage: "usage: tokenmaxxing seat --opencode-go <pid> - print the store directory of one pooled opencode-go key, whose auth.json is an opencode auth file, lent to <pid> until it exits and shared with other borrowers",
    none: "no usable opencode-go key (pool empty, or no store holds a usable key)",
  },
};

export async function cmdSeat(pool: keyof typeof POOLS, pidRaw: string | undefined, extra: string[]): Promise<number> {
  const seat = POOLS[pool];
  const pid = pidRaw != null && /^(0|[1-9][0-9]*)$/.test(pidRaw) ? Number(pidRaw) : NaN;
  if (!Number.isSafeInteger(pid) || pid < 2 || extra.length > 0) {
    emitError({ message: seat.usage });
    return 2;
  }
  const granted = await seat.borrow(pid);
  if (!granted) {
    emitError({ message: seat.none });
    return 1;
  }
  if ("denied" in granted) {
    emitError({ message: granted.denied });
    return 1;
  }
  console.log(granted.store);
  return 0;
}
