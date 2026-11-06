import { expect, test } from "bun:test";
import { run } from "./edge-telemetry-fixtures.ts";
import { pooledClaude } from "./fixtures.ts";
import { logTail, parseJson, preparedHomes, startStub, stubEnv, writeClaudePool, writeClaudeStore, writeCodexPool, writeCodexStore } from "./edge-async-sweep-fixtures.ts";
import { activeIds, labeled, storeDir, writePool } from "./edge-cli-surface-fixtures.ts";

const CLAUDE = ["c79ace4d-7c59-45a4-9d38-e9acf5b17e62", "d8abdf5e-8d6a-46b5-8e49-fabd06c28f73"] as const;
const CODEX = ["e9bce06f-9e7b-47c6-9f5a-0bce17d39a84", "facdf17a-af8c-48d7-8a6b-1cdf28e4ab95"] as const;
const GROK = ["0bde028b-b09d-49e8-9b7c-2de039f5bca6", "1cef139c-c1ae-4af9-8c8d-3ef14a06cdb7"] as const;
const MUSE = ["2df024ad-d2bf-4b0a-9d9e-4f025b17dec8", "3e0135be-e3c0-4c1b-8eaf-50136c28efd9"] as const;

test("status --json marks as active exactly the account whose store each pool's seat variable names (CLAUDE_SECURESTORAGE_CONFIG_DIR, CODEX_HOME, GROK_HOME, XDG_CONFIG_HOME)", async () => {
  const homes = preparedHomes();
  writeClaudePool(homes, CLAUDE.map((id) => pooledClaude(id)));
  for (const id of CLAUDE) writeClaudeStore(homes, id, `sk-ant-oat01-edge-${id.slice(0, 8)}`);
  writeCodexPool(homes, CODEX.map((id) => labeled(id, `codex-${id.slice(0, 4)}`, "pro")));
  for (const id of CODEX) writeCodexStore(homes, id);
  writePool(homes, "grok", GROK.map((id) => labeled(id, `grok-${id.slice(0, 4)}`, "supergrok")));
  writePool(homes, "muse", MUSE.map((id) => labeled(id, `muse-${id.slice(0, 4)}`, "pro")));
  const stub = startStub({ gated: [] });
  try {
    const env = {
      ...stubEnv(homes, stub.base),
      CLAUDE_SECURESTORAGE_CONFIG_DIR: storeDir(homes, "claude", CLAUDE[1]),
      CODEX_HOME: storeDir(homes, "codex", CODEX[1]),
      GROK_HOME: storeDir(homes, "grok", GROK[1]),
      XDG_CONFIG_HOME: storeDir(homes, "muse", MUSE[1]),
    };
    const result = await run(["status", "--json"], env);
    const doc = parseJson(result.stdout);
    expect({
      exitCode: result.exitCode,
      active: { claude: activeIds(doc, "claude"), codex: activeIds(doc, "codex"), grok: activeIds(doc, "grok"), muse: activeIds(doc, "muse") },
      stdout: result.stdout.slice(0, 2000),
      stderr: result.stderr,
      log: logTail(homes),
    }).toMatchObject({
      exitCode: 0,
      active: { claude: [CLAUDE[1]], codex: [CODEX[1]], grok: [GROK[1]], muse: [MUSE[1]] },
    });
  } finally {
    stub.stop();
  }
}, 30_000);
