import { expect, test } from "bun:test";
import { join } from "node:path";
import { preparedHomes } from "./edge-async-sweep-fixtures.ts";
import { writePool } from "./edge-cli-surface-fixtures.ts";
import { scratchDir } from "./edge-providers-fixtures.ts";
import { fileTree, grokAuthText, grokEntry, grokEnv, installGrok, installLeftoverGrokWrapper, listed, pinGrokBin, pooledGrok, runBin, serveGrokCredits, storeGrokLogin, withPath, writeGrokAuth } from "./edge-grok-statusonly-fixtures.ts";

const POOLED = "179a28e4-7ce9-4af4-8cd8-e9acf5b17e63";

test("the grok wrapper an older version left on PATH runs the real grok once on the caller's GROK_HOME with its arguments and exit code, seats nothing, and removes itself while the claude shim stays", async () => {
  const homes = preparedHomes();
  const grok = installGrok({ exitCode: 7 });
  pinGrokBin(homes, grok.bin);
  const pooled = grokEntry(POOLED, { email: "pooled@example.com" });
  const ambient = scratchDir("grok-home");
  writeGrokAuth(ambient, { [POOLED]: pooled });
  writePool(homes, "grok", [pooledGrok(POOLED, "pooled@example.com")]);
  storeGrokLogin(homes, POOLED, pooled);
  const { binDir, wrapper } = installLeftoverGrokWrapper(homes);
  const stub = serveGrokCredits({});
  try {
    const env = grokEnv(homes, stub, { ...withPath(`${binDir}:${grok.dir}`), GROK_HOME: ambient });
    const result = await runBin(wrapper, ["-p", "fix the failing test"], env, homes.home);
    expect({
      exitCode: result.exitCode,
      runs: grok.runs(),
      shimsLeft: listed(binDir),
      presence: listed(join(homes.state, "grok-live")),
      ambient: fileTree(ambient),
      usageReads: stub.bearers,
      stderr: result.stderr,
    }).toEqual({
      exitCode: 7,
      runs: [{ grokHome: ambient, args: "-p fix the failing test" }],
      shimsLeft: ["claude", "tokenmaxxing"],
      presence: [],
      ambient: { "auth.json": grokAuthText({ [POOLED]: pooled }) },
      usageReads: [],
      stderr: "",
    });
  } finally {
    stub.stop();
  }
}, 30_000);
