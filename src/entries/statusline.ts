import { sortBy } from "es-toolkit";
import { z } from "zod";
import { readOAuthAccount } from "../lib/claudejson.ts";
import { loadAccounts, loadConfig, loadLastSwapAt, loadModelUsage, writeUsage } from "../lib/state.ts";
import { familyTokens, matchedFamily, parseStatusLineStdin, parseStatusLineModel } from "../lib/usage.ts";
import { earliestReset, weeklyExpiry } from "../lib/picker.ts";
import { worktreeName } from "../lib/worktree.ts";
import { makeColors, makeUsagePaint } from "../cli/render.ts";
import { fmtResetShort } from "../lib/usage.ts";
import {
  AccountsIndexSchema,
  RateLimitsStdinSchema,
  StatusLineStdinSchema,
  UsageWindowSchema,
  type Account,
  type UsageState,
  type UsageWindow,
} from "../lib/types.ts";

const ADOPTION_GRACE_MS = 45_000;

const RenderCtxSchema = z.object({
  accounts: AccountsIndexSchema,
  perModel: z.record(z.string(), UsageWindowSchema),
  switchModels: z.array(z.string()),
  worktree: z.string().nullable(),
  liveOrg: z.string().nullable(),
  now: z.number(),
  color: z.boolean(),
  truecolor: z.boolean(),
});
export type RenderCtx = z.infer<typeof RenderCtxSchema>;

export async function readStdin(): Promise<string> {
  const chunks: Uint8Array[] = [];
  for await (const c of Bun.stdin.stream()) chunks.push(c);
  return Buffer.concat(chunks).toString("utf8");
}

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
  const seatUuid =
    (ctx.liveOrg != null ? ctx.accounts.accounts.find((a) => a.organizationUuid === ctx.liveOrg)?.accountUuid : undefined) ??
    ctx.accounts.activeAccountUuid;
  const active =
    windows.length > 0
      ? `${col.green("◆")} ${windows.join(" ")}`
      : seatUuid != null
        ? `${col.green("◆")} ?`
        : "";

  const parked = sortBy(
    ctx.accounts.accounts.filter((a) => a.accountUuid !== seatUuid),
    [(a) => (a.needsReauth ? 1 : 0), (a) => earliestReset(a, ctx.now)],
  );
  const poolSeg = (a: Account): string => {
    const marker = a.needsReauth ? col.red("✗") : col.cyan("◇");
    const week = a.lastUsage?.sevenDay;
    if (week == null) return `${marker} ?`;
    const weekUsed = used(week);
    if (Math.round(weekUsed) <= 0) return `${marker} ${paint(0)("full")}`;

    const parts: string[] = [];
    for (const [name, w] of Object.entries(a.lastPerModel ?? {})) {
      if (used(w) > weekUsed) parts.push(seg(initial(name), w, null));
    }
    const expiry = weeklyExpiry(a, ctx.now);
    parts.push(seg("", week, Number.isFinite(expiry) ? expiry : null));
    return `${marker} ${parts.join(" ")}`;
  };

  return [info.join(" "), active, ...parked.map(poolSeg)].filter((l) => l !== "").join("  ");
}

export async function runStatusline(): Promise<number> {
  const raw = await readStdin();
  let obj: unknown = null;
  try {
    obj = JSON.parse(raw);
  } catch {
  }
  const now = Date.now();

  let stdinOrg: string | null = null;

  let org: string | null = null;
  try {
    org = readOAuthAccount()?.organizationUuid ?? null;
    const windows = obj == null ? null : parseStatusLineStdin(obj);
    const lastSwapAt = loadLastSwapAt();
    stdinOrg = windows != null ? (RateLimitsStdinSchema.safeParse(obj).data?.organizationUuid ?? null) : null;
    const teeOrg = stdinOrg ?? org;
    if (windows && (stdinOrg != null || lastSwapAt == null || now - lastSwapAt >= ADOPTION_GRACE_MS)) {
      const state: UsageState = { ...windows, org: teeOrg, ts: now, model: parseStatusLineModel(obj) };
      writeUsage(state);
    }
  } catch {
  }

  let line: string;
  try {
    const cfg = loadConfig();
    const modelUsage = loadModelUsage();
    const stdin = StatusLineStdinSchema.safeParse(obj);
    const dir = stdin.success ? (stdin.data.workspace?.current_dir ?? stdin.data.workspace?.project_dir ?? null) : null;
    const colorterm = z.string().optional().parse(process.env.COLORTERM);
    const ctx: RenderCtx = {
      accounts: loadAccounts(),
      perModel: modelUsage && modelUsage.org === (stdinOrg ?? org) ? modelUsage.perModel : {},
      switchModels: cfg.policy.switchModels,
      worktree: dir == null ? null : worktreeName(dir),
      liveOrg: stdinOrg ?? org,
      now,
      color: !process.env.NO_COLOR,
      truecolor: colorterm != null && (colorterm.includes("truecolor") || colorterm.includes("24bit")),
    };
    line = renderStatusline(obj, ctx);
  } catch (e) {
    line = `tokenmaxxing: ${e instanceof Error ? e.message : String(e)}`;
  }
  process.stdout.write(line + "\n");
  return 0;
}
