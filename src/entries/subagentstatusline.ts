import { z } from "zod";
import { makeColors, makeUsagePaint } from "../cli/render.ts";
import { readStdin } from "./statusline.ts";
import { SubagentStatusLineStdinSchema } from "../lib/types.ts";

const RowCtxSchema = z.object({ color: z.boolean(), truecolor: z.boolean() });
export type RowCtx = z.infer<typeof RowCtxSchema>;

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
  const raw = await readStdin();
  let obj: unknown = null;
  try {
    obj = JSON.parse(raw);
  } catch {
  }
  const colorterm = z.string().optional().parse(process.env.COLORTERM);
  const rows = renderSubagentRows(obj, {
    color: !process.env.NO_COLOR,
    truecolor: colorterm != null && (colorterm.includes("truecolor") || colorterm.includes("24bit")),
  });
  if (rows.length > 0) process.stdout.write(rows.join("\n") + "\n");
  return 0;
}
