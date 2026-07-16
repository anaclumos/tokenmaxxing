// Native statusLine. Reads Claude's statusLine stdin, tees the rate-limit data
// to usage.json (write-on-change, O(ms)), then renders ONE line:
//   worktree name (linked worktrees only), model (effort), ctx used,
//   +added/-removed, then quota as USED percent (bold, severity-colored)
//   glued after its time-to-reset: "◆ F26 2h5 1d38  ◇ F67 2d40  ◇ 2 full"
//   ("2h5" = resets in 2h, 5 used) - the active account's windows after a
//   green ◆ (per-model by initial first, "F?" when the cap applies but is
//   unmeasured, then session/5h, then week), then each parked account's week
//   after a cyan ◇, in swap-preference order so the first usable ◇ is where
//   the next swap lands. Adjacent untouched (or unsampled) parked accounts
//   collapse into one counted token. Blocks are joined by TWO spaces, tokens
//   within a block by one. Per-model resets are omitted (they match the
//   weekly reset).
// Must NEVER break the status line: render what parses, skip what doesn't.

import { sortBy } from "es-toolkit";
import { z } from "zod";
import { readOAuthAccount } from "../lib/claudejson.ts";
import { loadAccounts, loadConfig, loadLastSwapAt, loadModelUsage, writeUsage } from "../lib/state.ts";
import { familyTokens, gatedFamilies, matchedFamily, parseStatusLineStdin, parseStatusLineModel } from "../lib/usage.ts";
import { effectiveBars, isExhausted, swapPreference, weeklyExpiry } from "../lib/picker.ts";
import { worktreeName } from "../lib/worktree.ts";
import { fmtResetShort, makeColors } from "../cli/render.ts";
import {
  AccountsIndexSchema,
  StatusLineStdinSchema,
  ThresholdsSchema,
  UsageWindowSchema,
  type Account,
  type UsageState,
  type UsageWindow,
} from "../lib/types.ts";

/** A session that hasn't adopted a fresh swap yet (<=30s keychain cache) pushes
 *  the OLD account's windows while ~/.claude.json already names the NEW org.
 *  Suppress the tee for this long after a swap so that mislabel never lands. */
const ADOPTION_GRACE_MS = 45_000;

const RenderCtxSchema = z.object({
  accounts: AccountsIndexSchema,
  /** active account's per-model weekly windows ({} unless fresh for the live org). */
  perModel: z.record(z.string(), UsageWindowSchema),
  /** families (lowercased) whose per-model weekly cap gates a switch. */
  switchModels: z.array(z.string()),
  thresholds: ThresholdsSchema,
  /** linked-worktree basename, null in a main checkout. */
  worktree: z.string().nullable(),
  now: z.number(),
  color: z.boolean(),
});
export type RenderCtx = z.infer<typeof RenderCtxSchema>;

async function readStdin(): Promise<string> {
  const chunks: Uint8Array[] = [];
  for await (const c of Bun.stdin.stream()) chunks.push(c);
  return Buffer.concat(chunks).toString("utf8");
}

/** Pure renderer: statusLine stdin + tokenmaxxing state → the emitted line. */
export function renderStatusline(stdinObj: unknown, ctx: RenderCtx): string {
  const col = makeColors(ctx.color);
  const severity = (u: number) => (u >= 95 ? col.red : u >= 75 ? col.yellow : col.green);
  const gauge = (u: number) => col.bold(severity(u)(`${Math.round(u)}`));
  // Used quota in a window; one whose reset has passed is empty again.
  const used = (w: UsageWindow) => (w.resetsAt != null && w.resetsAt <= ctx.now ? 0 : w.usedPercentage);
  const reset = (epochMs: number | null) => fmtResetShort(epochMs, ctx.now);

  const parsed = StatusLineStdinSchema.safeParse(stdinObj);
  const d = parsed.success ? parsed.data : null;

  // ---- info block: worktree, model, ctx, diff
  const info: string[] = [];
  if (ctx.worktree != null) info.push(ctx.worktree);
  const modelName = d?.model?.display_name ?? d?.model?.id;
  if (modelName) {
    const effort = d?.effort?.level;
    info.push(col.bold(modelName) + (effort ? ` (${effort})` : ""));
  }
  const ctxUsed = d?.context_window?.used_percentage;
  if (ctxUsed != null) info.push(`ctx ${gauge(ctxUsed)}`);
  const added = d?.cost?.total_lines_added ?? 0;
  const removed = d?.cost?.total_lines_removed ?? 0;
  // -removed stays unpainted: red means quota alarm and nothing else.
  if (added > 0 || removed > 0) info.push(`${col.green(`+${added}`)}/-${removed}`);

  // ---- active account block
  const seg = (label: string, w: UsageWindow, resetAt: number | null) =>
    `${label}${reset(resetAt)}${gauge(used(w))}`;
  const wins = parseStatusLineStdin(stdinObj);
  const windows: string[] = [];
  // A capacity-constrained model whose cap is unmeasured must not look safe.
  const family = matchedFamily(parseStatusLineModel(stdinObj), ctx.switchModels);
  if (family && !Object.keys(ctx.perModel).some((k) => familyTokens(k).includes(family))) {
    windows.push(`${family[0]!.toUpperCase()}?`);
  }
  for (const [name, w] of Object.entries(ctx.perModel)) windows.push(seg(name.slice(0, 1), w, null));
  if (wins) {
    windows.push(seg("", wins.fiveHour, wins.fiveHour.resetsAt));
    windows.push(seg("", wins.sevenDay, wins.sevenDay.resetsAt));
  }
  const active =
    windows.length > 0
      ? `${col.green("◆")} ${windows.join(" ")}`
      : ctx.accounts.activeAccountUuid != null
        ? `${col.green("◆")} ?`
        : "";

  // ---- parked accounts, in swap order: the first usable ◇ is the next target
  const pickCtx = {
    now: ctx.now,
    thresholds: ctx.thresholds,
    currentAccountUuid: ctx.accounts.activeAccountUuid,
    switchFamilies: gatedFamilies(parseStatusLineModel(stdinObj), ctx.switchModels),
  };
  const parked = sortBy(
    ctx.accounts.accounts.filter((a) => a.accountUuid !== ctx.accounts.activeAccountUuid),
    [(a) => (a.needsReauth || isExhausted(a, pickCtx) ? 1 : 0), ...swapPreference(ctx.now)],
  );
  const poolSeg = (a: Account): { kind: "full" | "unknown" | "other"; text: string } => {
    const marker = a.needsReauth ? col.red("✗") : col.cyan("◇");
    const mergeable = !a.needsReauth;

    const week = a.lastUsage?.sevenDay;
    if (week == null) return { kind: mergeable ? "unknown" : "other", text: `${marker} ?` };
    const weekUsed = used(week);
    if (Math.round(weekUsed) <= 0) return { kind: mergeable ? "full" : "other", text: `${marker} ${col.green("full")}` };

    const parts: string[] = [];
    // A per-model weekly cap with more used than the aggregate is the binding constraint - surface it.
    for (const [name, w] of Object.entries(a.lastPerModel ?? {})) {
      if (used(w) > weekUsed) parts.push(seg(name.slice(0, 1), w, null));
    }
    const expiry = weeklyExpiry(a, ctx.now);
    parts.push(seg("", week, Number.isFinite(expiry) ? expiry : null));
    return { kind: "other", text: `${marker} ${parts.join(" ")}` };
  };

  // Adjacent identical bare tokens collapse into one counted token ("◇ 3 full").
  const pool: string[] = [];
  const segs = parked.map(poolSeg);
  for (let i = 0; i < segs.length; ) {
    const s = segs[i]!;
    let j = i + 1;
    while (s.kind !== "other" && j < segs.length && segs[j]!.kind === s.kind) j++;
    if (j - i >= 2) pool.push(`${col.cyan("◇")} ${j - i} ${s.kind === "full" ? col.green("full") : "?"}`);
    else pool.push(s.text);
    i = j;
  }

  return [info.join(" "), active, ...pool].filter((l) => l !== "").join("  ");
}

export async function runStatusline(): Promise<number> {
  const raw = await readStdin();
  let obj: unknown = null;
  try {
    obj = JSON.parse(raw);
  } catch {
    // malformed stdin - render from state alone
  }
  const now = Date.now();

  // tee usage for the Stop hook / status - best effort, never blocks rendering.
  let org: string | null = null;
  try {
    org = readOAuthAccount()?.organizationUuid ?? null;
    const windows = obj == null ? null : parseStatusLineStdin(obj);
    const lastSwapAt = loadLastSwapAt();
    if (windows && (lastSwapAt == null || now - lastSwapAt >= ADOPTION_GRACE_MS)) {
      const state: UsageState = { ...windows, org, ts: now, model: parseStatusLineModel(obj) };
      writeUsage(state);
    }
  } catch {
    // skip the tee, still render below
  }

  const cfg = loadConfig();
  const modelUsage = loadModelUsage();
  const stdin = StatusLineStdinSchema.safeParse(obj);
  const dir = stdin.success ? (stdin.data.workspace?.current_dir ?? stdin.data.workspace?.project_dir ?? null) : null;
  const ctx: RenderCtx = {
    accounts: loadAccounts(),
    perModel: modelUsage && modelUsage.org === org ? modelUsage.perModel : {},
    switchModels: cfg.policy.switchModels,
    thresholds: effectiveBars(cfg),
    worktree: dir == null ? null : worktreeName(dir),
    now,
    color: !process.env.NO_COLOR,
  };
  process.stdout.write(renderStatusline(obj, ctx) + "\n");
  return 0;
}
