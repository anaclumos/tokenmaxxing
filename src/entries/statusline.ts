import { sortBy } from "es-toolkit";
import { claudePool, seatFromEnv } from "../lib/paths.ts";
import { errorMessage } from "../lib/log.ts";
import { loadAccounts, loadConfig, writeUsage } from "../lib/state.ts";
import { familyTokens, matchedFamily, parseStatusLineStdin, parseStatusLineModel } from "../lib/usage.ts";
import { earliestReset, limitWindows, weeklyExpiry, weeklyWindow } from "../lib/picker.ts";
import { readStdin } from "../lib/proc.ts";
import { worktreeName } from "../lib/worktree.ts";
import { fmtResetShort, makeColors, makeUsagePaint, statuslineColor } from "../cli/render.ts";
import {
  JsonTextSchema,
  StatusLineStdinSchema,
  type Account,
  type AccountsIndex,
  type UsageState,
  type UsageWindow,
  type Window,
} from "../lib/types.ts";

export type RenderCtx = {
  accounts: AccountsIndex;
  perModel: Record<string, Window>;
  switchModels: string[];
  worktree: string | null;
  liveAccount: string | null;
  now: number;
  color: boolean;
  truecolor: boolean;
};

export function renderStatusline(stdinObj: unknown, ctx: RenderCtx): string {
  const col = makeColors(ctx.color);
  const paint = makeUsagePaint({ enabled: ctx.color, truecolor: ctx.truecolor });
  const used = (w: UsageWindow) => (w.resetsAt != null && w.resetsAt <= ctx.now ? 0 : w.usedPercentage);
  const reset = (epochMs: number | null) => fmtResetShort(epochMs, ctx.now);

  const parsed = StatusLineStdinSchema.safeParse(stdinObj);
  const d = parsed.success ? parsed.data : null;

  const info: string[] = [];
  if (ctx.worktree != null) info.push(ctx.worktree);
  const modelName = d?.model?.display_name ?? d?.model?.id;
  const ctxUsed = d?.context_window?.used_percentage;
  if (modelName) {
    const effort = d?.effort?.level;
    const body = ctxUsed != null ? col.bold(paint(ctxUsed)(modelName)) : col.bold(modelName);
    info.push(body + (effort ? ` (${effort})` : ""));
  }
  if (!ctx.color && ctxUsed != null) info.push(`ctx ${Math.round(ctxUsed)}`);
  const added = d?.cost?.total_lines_added ?? 0;
  const removed = d?.cost?.total_lines_removed ?? 0;
  if (added > 0 || removed > 0) info.push(`${col.green(`+${added}`)}/-${removed}`);

  const seg = (label: string, w: UsageWindow, resetAt: number | null) => {
    const u = used(w);
    if (!ctx.color) return `${label}${reset(resetAt)}${Math.round(u)}`;
    const body = label !== "" ? label : reset(resetAt);
    return col.bold(paint(u)(body !== "" ? body : u > 0 ? "?" : "0"));
  };
  const initial = (name: string) => (familyTokens(name).includes("fable") ? "𝒇" : name.slice(0, 1).toUpperCase());
  const wins = parseStatusLineStdin(stdinObj);
  const windows: string[] = [];
  const family = matchedFamily(parseStatusLineModel(stdinObj), ctx.switchModels);
  if (family && !Object.keys(ctx.perModel).some((k) => familyTokens(k).includes(family))) {
    windows.push(`${initial(family)}?`);
  }
  for (const [name, w] of Object.entries(ctx.perModel)) windows.push(seg(initial(name), w, null));
  if (wins) {
    windows.push(seg("", wins.fiveHour, wins.fiveHour.resetsAt));
    windows.push(seg("", wins.sevenDay, wins.sevenDay.resetsAt));
  }
  const seatUuid = ctx.liveAccount;
  const walled = (a: Account) => a.enforcedUntil != null && a.enforcedUntil > ctx.now;
  const wallSeg = (wall: number) => seg("", { usedPercentage: 100, resetsAt: wall }, wall);
  const seat = ctx.accounts.accounts.find((a) => a.id === seatUuid);
  if (seat?.enforcedUntil != null && walled(seat)) windows.push(wallSeg(seat.enforcedUntil));
  const seatMarker = seat && walled(seat) ? paint(100)("◆") : col.green("◆");
  const active =
    windows.length > 0
      ? `${seatMarker} ${windows.join(" ")}`
      : seatUuid != null
        ? `${seatMarker} ?`
        : "";

  const parked = sortBy(
    ctx.accounts.accounts.filter((a) => a.id !== seatUuid),
    [(a) => (a.needsReauth ? 1 : 0), (a) => earliestReset(a, ctx.now)],
  );
  const poolSeg = (a: Account): string => {
    const marker = a.needsReauth ? col.red("✗") : walled(a) ? paint(100)("◇") : col.cyan("◇");
    if (a.enforcedUntil != null && walled(a)) return `${marker} ${wallSeg(a.enforcedUntil)}`;
    const week = weeklyWindow(a);
    if (week == null) return `${marker} ?`;
    const weekUsed = used(week);
    if (Math.round(weekUsed) <= 0) return `${marker} ${paint(0)("full")}`;

    const parts: string[] = [];
    for (const w of limitWindows(a)) {
      if (used(w) > weekUsed) parts.push(seg(initial(w.name ?? ""), w, null));
    }
    const expiry = weeklyExpiry(a, ctx.now);
    parts.push(seg("", week, Number.isFinite(expiry) ? expiry : null));
    return `${marker} ${parts.join(" ")}`;
  };

  return [info.join(" "), active, ...parked.map(poolSeg)].filter((l) => l !== "").join("  ");
}

export async function runStatusline(): Promise<number> {
  const obj = JsonTextSchema.safeParse(await readStdin()).data ?? null;
  const now = Date.now();

  let account: string | null = null;
  try {
    account = seatFromEnv(loadAccounts(claudePool).accounts.map((a) => a.id));
    const windows = obj == null ? null : parseStatusLineStdin(obj);
    if (windows && account != null) {
      const state: UsageState = { fiveHour: windows.fiveHour, sevenDay: windows.sevenDay, account, ts: now, model: parseStatusLineModel(obj) };
      writeUsage(state);
    }
  } catch {
  }

  let line: string;
  try {
    const cfg = loadConfig();
    const accounts = loadAccounts(claudePool);
    const stdin = StatusLineStdinSchema.safeParse(obj);
    const dir = stdin.success ? (stdin.data.workspace?.current_dir ?? stdin.data.workspace?.project_dir ?? null) : null;
    const live = accounts.accounts.find((a) => a.id === account);
    const ctx: RenderCtx = {
      accounts,
      perModel: Object.fromEntries((live ? limitWindows(live) : []).map((w) => [w.name ?? "", w])),
      switchModels: cfg.policy.switchModels,
      worktree: dir == null ? null : worktreeName(dir),
      liveAccount: account,
      now,
      ...statuslineColor(),
    };
    line = renderStatusline(obj, ctx);
  } catch (e) {
    line = `tokenmaxxing: ${errorMessage(e)}`;
  }
  process.stdout.write(line + "\n");
  return 0;
}
