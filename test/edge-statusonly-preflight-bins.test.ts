import { afterAll, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fakeBin, scratchDir, useEnv } from "./edge-providers-fixtures.ts";

const onPath = scratchDir("bin-on-path");
const restoreEnv = useEnv({
  HOME: scratchDir("home"),
  TOKENMAXXING_HOME: scratchDir("state"),
  XDG_CONFIG_HOME: scratchDir("config"),
  GROK_HOME: scratchDir("grok-home"),
  KIMI_CODE_HOME: scratchDir("kimi-home"),
  VIBE_HOME: scratchDir("vibe-home"),
  TOKENMAXXING_GROK_BIN: undefined,
  TOKENMAXXING_MUSE_BIN: undefined,
  TOKENMAXXING_KIMI_BIN: undefined,
  TOKENMAXXING_VIBE_BIN: undefined,
  TOKENMAXXING_CURSOR_BIN: undefined,
  PATH: `${onPath}:${process.env.PATH ?? ""}`,
});
afterAll(restoreEnv);

const { paths } = await import("../src/lib/paths.ts");
const { loadConfig } = await import("../src/lib/state.ts");
const { grok } = await import("../src/lib/grok.ts");
const { muse } = await import("../src/lib/muse.ts");
const { kimi } = await import("../src/lib/kimi.ts");
const { cursor } = await import("../src/lib/cursor.ts");
const { vibe } = await import("../src/lib/vibe.ts");

const BINS = [
  { provider: grok, key: "grokBin", bin: "grok", good: "grok 0.1.5", bad: "Muse Code 1.4.0" },
  { provider: muse, key: "museBin", bin: "muse", good: "Muse Code 1.4.0", bad: "grok 0.1.5" },
  { provider: kimi, key: "kimiBin", bin: "kimi", good: "2.3.1", bad: "1.9.0" },
  { provider: cursor, key: "cursorBin", bin: "cursor-agent", good: "2026.01.15-a1b2c3d", bad: "2.3.1" },
  { provider: vibe, key: "vibeBin", bin: "vibe", good: "vibe 3.1.0", bad: "2.3.1" },
] as const;

function refusal(run: () => void): string {
  try {
    run();
    return "accepted";
  } catch (e) {
    return e instanceof Error ? (e.message.split(":")[0] ?? e.message) : String(e);
  }
}

test("each status-only provider's preflight records the binary on PATH that names itself and refuses a configured one that does not", () => {
  for (const b of BINS) fakeBin(onPath, b.bin, `echo "${b.good}"`);
  for (const b of BINS) b.provider.preflight();
  const cfg = loadConfig();
  const recorded = { grokBin: cfg.grokBin, museBin: cfg.museBin, kimiBin: cfg.kimiBin, cursorBin: cfg.cursorBin, vibeBin: cfg.vibeBin };

  const wrong = scratchDir("bin-wrong");
  writeFileSync(paths.configJson, JSON.stringify(Object.fromEntries(BINS.map((b) => [b.key, fakeBin(wrong, b.bin, `echo "${b.bad}"`)]))));
  const refusals = Object.fromEntries(BINS.map((b) => [b.provider.name, refusal(() => b.provider.preflight())]));

  expect({ recorded, refusals }).toEqual({
    recorded: { grokBin: join(onPath, "grok"), museBin: join(onPath, "muse"), kimiBin: join(onPath, "kimi"), cursorBin: join(onPath, "cursor-agent"), vibeBin: join(onPath, "vibe") },
    refusals: {
      grok: "grok binary failed verification",
      muse: "muse binary failed verification",
      kimi: "kimi binary failed verification",
      cursor: "cursor-agent binary failed verification",
      vibe: "vibe binary failed verification",
    },
  });
}, 30_000);
