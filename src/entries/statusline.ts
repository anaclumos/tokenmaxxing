// Native statusLine. Reads Claude's statusLine stdin, tees the rate-limit data
// to usage.json (write-on-change, O(ms)), then renders ONE line:
//   worktree name (linked worktrees only), model name painted by context fill
//   (effort in parens), +added/-removed, then quota as COLOR (user decisions
//   2026-07-18): each window is its time-to-reset painted on a continuous
//   green->yellow->red ramp by used% - "◆ 𝒇 2h 1d  ◇ 2d  ◇ full" - the
//   active account's windows after a green ◆ (per-model by bare initial
//   first, fable as 𝒇, other families uppercased; "𝒇?" unpainted when the
//   cap applies but is unmeasured, then session/5h, then week), then EVERY
//   parked account's week after its own cyan ◇ (red ✗ if needs-reauth),
//   sorted by earliest upcoming reset (needs-reauth last). A window with no
//   upcoming reset renders "0" (empty again); measured usage with an unknown
//   reset clock renders a painted "?". With color disabled the numeric format
//   returns ("2h5" = resets in 2h, 5 used; "ctx 42"): without color a drained
//   window must not look fresh. Blocks are joined by TWO spaces, tokens
//   within a block by one. Per-model resets are omitted (they match the
//   weekly reset).
// Must NEVER break the status line: render what parses, skip what doesn't.

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
  /** linked-worktree basename, null in a main checkout. */
  worktree: z.string().nullable(),
  /** the LIVE login's org from claude.json, the seat's identity - the
   *  activeAccountUuid label drifts after a manual /login (the same rule as
   *  decide.ts's seatOf; closing-review catch: the label-keyed split rendered
   *  the live account twice and hid the stale-labeled one). */
  liveOrg: z.string().nullable(),
  now: z.number(),
  color: z.boolean(),
  /** terminal advertises 24-bit color (COLORTERM); false steps the ramp to the 256-color cube. */
  truecolor: z.boolean(),
});
export type RenderCtx = z.infer<typeof RenderCtxSchema>;

export async function readStdin(): Promise<string> {
  const chunks: Uint8Array[] = [];
  for await (const c of Bun.stdin.stream()) chunks.push(c);
  return Buffer.concat(chunks).toString("utf8");
}

/** Pure renderer: statusLine stdin + tokenmaxxing state → the emitted line. */
export function renderStatusline(stdinObj: unknown, ctx: RenderCtx): string {
  const col = makeColors(ctx.color);
  const paint = makeUsagePaint({ enabled: ctx.color, truecolor: ctx.truecolor });
  // Used quota in a window; one whose reset has passed is empty again.
  const used = (w: UsageWindow) => (w.resetsAt != null && w.resetsAt <= ctx.now ? 0 : w.usedPercentage);
  const reset = (epochMs: number | null) => fmtResetShort(epochMs, ctx.now);

  const parsed = StatusLineStdinSchema.safeParse(stdinObj);
  const d = parsed.success ? parsed.data : null;

  // ---- info block: worktree, model, ctx, diff
  const info: string[] = [];
  if (ctx.worktree != null) info.push(ctx.worktree);
  // The model name carries the context-fill color (user rule 2026-07-18, no
  // ctx token); colorless mode keeps the numeric ctx token instead.
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
  // -removed stays unpainted: red means quota alarm and nothing else.
  if (added > 0 || removed > 0) info.push(`${col.green(`+${added}`)}/-${removed}`);

  // ---- active account block
  // A window token: color carries the used%, the text is the reset countdown
  // (or the bare per-model initial - per-model resets are omitted). "0" = no
  // upcoming reset (the window is empty again); a painted "?" = measured usage
  // whose reset clock is unknown. Colorless mode glues the number back on.
  const seg = (label: string, w: UsageWindow, resetAt: number | null) => {
    const u = used(w);
    if (!ctx.color) return `${label}${reset(resetAt)}${Math.round(u)}`;
    const body = label !== "" ? label : reset(resetAt);
    return col.bold(paint(u)(body !== "" ? body : u > 0 ? "?" : "0"));
  };
  // Per-model initial: fable renders 𝒇 (user rule 2026-07-18), family-matched
  // as always; other families keep their uppercased first letter.
  const initial = (name: string) => (familyTokens(name).includes("fable") ? "𝒇" : name.slice(0, 1).toUpperCase());
  const wins = parseStatusLineStdin(stdinObj);
  const windows: string[] = [];
  // A capacity-constrained model whose cap is unmeasured must not look safe.
  const family = matchedFamily(parseStatusLineModel(stdinObj), ctx.switchModels);
  if (family && !Object.keys(ctx.perModel).some((k) => familyTokens(k).includes(family))) {
    windows.push(`${initial(family)}?`);
  }
  for (const [name, w] of Object.entries(ctx.perModel)) windows.push(seg(initial(name), w, null));
  if (wins) {
    windows.push(seg("", wins.fiveHour, wins.fiveHour.resetsAt));
    windows.push(seg("", wins.sevenDay, wins.sevenDay.resetsAt));
  }
  // The seat: live-org first, stored label fallback (unknown live identity).
  const seatUuid =
    (ctx.liveOrg != null ? ctx.accounts.accounts.find((a) => a.organizationUuid === ctx.liveOrg)?.accountUuid : undefined) ??
    ctx.accounts.activeAccountUuid;
  const active =
    windows.length > 0
      ? `${col.green("◆")} ${windows.join(" ")}`
      : seatUuid != null
        ? `${col.green("◆")} ?`
        : "";

  // ---- parked accounts, earliest upcoming reset first (needs-reauth last)
  const parked = sortBy(
    ctx.accounts.accounts.filter((a) => a.accountUuid !== seatUuid),
    [(a) => (a.needsReauth ? 1 : 0), (a) => earliestReset(a, ctx.now)],
  );
  // Every parked account renders its own marker (user rule 2026-07-18: the
  // old counted collapse "◇ 3 full" hid the pool size and read as confusing).
  const poolSeg = (a: Account): string => {
    const marker = a.needsReauth ? col.red("✗") : col.cyan("◇");
    const week = a.lastUsage?.sevenDay;
    if (week == null) return `${marker} ?`;
    const weekUsed = used(week);
    if (Math.round(weekUsed) <= 0) return `${marker} ${paint(0)("full")}`;

    const parts: string[] = [];
    // A per-model weekly cap with more used than the aggregate is the binding constraint - surface it.
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
    // malformed stdin - render from state alone
  }
  const now = Date.now();

  // The stdin payload's own org label: those rate_limits and that
  // organizationUuid ride the SAME API response, so the label can never lie
  // about whose windows these are. claude.json's org is only the fallback -
  // it flips at the swap while a session that has made no post-swap request
  // keeps rendering the OLD account's windows indefinitely, and the 45s
  // ADOPTION_GRACE_MS bounds nothing for such a session (closing-review
  // catch: a stale-window tee labeled with the new org could hard-swap a
  // healthy account and stamp foreign usage into it). The render below uses
  // the same preference so the active ◆ seat matches the windows painted
  // beside it (PR #36 review catch). Trusted ONLY when the payload's windows
  // parsed too: an org label without windows would re-label state the payload
  // did not carry (second-round catch).
  let stdinOrg: string | null = null;

  // tee usage for the Stop hook / status - best effort, never blocks rendering.
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
    // skip the tee, still render below
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
    // Corrupt local state (the loaders throw on it) must stay VISIBLE: render
    // the failure as the statusline itself, never abort into a blank line.
    line = `tokenmaxxing: ${e instanceof Error ? e.message : String(e)}`;
  }
  process.stdout.write(line + "\n");
  return 0;
}
