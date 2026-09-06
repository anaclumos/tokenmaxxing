import { z } from "zod";
import { makeColors, makeUsagePaint } from "../cli/render.ts";
import { tryParseJson } from "../lib/json.ts";
import { terminalPalette } from "./statusline.ts";
import { SubagentStatusLineStdinSchema } from "../lib/types.ts";

export type RowCtx = { color: boolean; truecolor: boolean };

function modelFamily(id: string): string {
  const [head, family] = id.split("-");
  return head === "claude" && family ? family : id;
}

export function renderSubagentRows(stdinObj: unknown, ctx: RowCtx): string[] {
  const parsed = SubagentStatusLineStdinSchema.safeParse(stdinObj);
  if (!parsed.success) return [];
  const col = makeColors(ctx.color);
  const paint = makeUsagePaint({ enabled: ctx.color, truecolor: ctx.truecolor });

  const rows: string[] = [];
  for (const t of parsed.data.tasks ?? []) {
    if (t.id == null) continue;
    const pct =
      t.tokenCount != null && t.contextWindowSize != null && t.contextWindowSize > 0
        ? Math.round((t.tokenCount / t.contextWindowSize) * 100)
        : null;
    const info: string[] = [];
    if (t.model != null) {
      const family = modelFamily(t.model);
      const body = pct != null ? col.bold(paint(pct)(family)) : col.bold(family);
      info.push(body + (t.effort ? ` (${t.effort})` : ""));
    }
    if (!ctx.color && pct != null) info.push(`ctx ${pct}`);

    const label = t.label ?? t.description ?? t.name;
    const parts: string[] = [];
    if (info.length > 0) parts.push(info.join(" "));
    if (label != null && label !== "") parts.push(label);
    if (parts.length === 0) continue;
    rows.push(JSON.stringify({ id: t.id, content: parts.join("  ") }));
  }
  return rows;
}

export async function runSubagentStatusline(): Promise<number> {
  const obj = tryParseJson(z.unknown(), await Bun.stdin.text());
  const rows = renderSubagentRows(obj, terminalPalette());
  if (rows.length > 0) process.stdout.write(rows.join("\n") + "\n");
  return 0;
}
