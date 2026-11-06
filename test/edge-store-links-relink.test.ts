import { afterAll, expect, test } from "bun:test";
import { lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { scratchDir, useEnv, writePrivate } from "./edge-providers-fixtures.ts";

const CODEX_ID = "9c1e4b7a-2d5f-4e8c-a1b3-6f0d2c9e7a54";
const PI_ID = "7a2b5c8d-1e4f-4a7b-9c2d-5e8f1a4b7c03";
const codexHome = scratchDir("codex-home");
const piHome = scratchDir("pi-home");
const restoreEnv = useEnv({
  HOME: scratchDir("home"),
  TOKENMAXXING_HOME: scratchDir("state"),
  TOKENMAXXING_CODEX_HOME: codexHome,
  CODEX_HOME: undefined,
  PI_CODING_AGENT_DIR: piHome,
});
afterAll(restoreEnv);

const { codexStoreDirFor, piStoreDirFor } = await import("../src/lib/paths.ts");
const { ensureCodexStoreHome } = await import("../src/lib/codexauth.ts");
const { ensurePiStoreHome } = await import("../src/lib/piauth.ts");

function entries(dir: string): Record<string, string> {
  return Object.fromEntries(
    readdirSync(dir).map((name) => {
      const path = join(dir, name);
      const stat = lstatSync(path);
      return [name, stat.isSymbolicLink() ? `link ${readlinkSync(path)}` : stat.isFile() ? `file ${readFileSync(path, "utf8")}` : "dir"];
    }),
  );
}

test("relinking a Codex or pi store home links each new shared entry, keeps every entry the store already holds, and never links the login", () => {
  const stale = join(scratchDir("gone"), "history.jsonl");

  writeFileSync(join(codexHome, "config.toml"), 'model = "gpt-5"\n');
  writeFileSync(join(codexHome, "history.jsonl"), "");
  writePrivate(join(codexHome, "auth.json"), "{}");
  mkdirSync(join(codexHome, "skills"));
  const codexStore = codexStoreDirFor(CODEX_ID);
  mkdirSync(codexStore, { recursive: true });
  writeFileSync(join(codexStore, "config.toml"), 'model = "gpt-5-codex"\n');
  symlinkSync(stale, join(codexStore, "history.jsonl"));
  ensureCodexStoreHome(CODEX_ID);
  mkdirSync(join(codexHome, "rules"));
  ensureCodexStoreHome(CODEX_ID);

  mkdirSync(join(piHome, "extensions"));
  writePrivate(join(piHome, "auth.json"), "{}");
  writeFileSync(join(piHome, "auth.json.lock"), "");
  writeFileSync(join(piHome, "models.lock"), "");
  const piStore = piStoreDirFor("codex", PI_ID);
  mkdirSync(piStore, { recursive: true });
  writeFileSync(join(piStore, "settings.json"), '{"theme":"dark"}');
  ensurePiStoreHome("codex", PI_ID);
  mkdirSync(join(piHome, "prompts"));
  ensurePiStoreHome("codex", PI_ID);

  const linked = (home: string, name: string) => `link ${join(home, name)}`;
  expect({ codex: entries(codexStore), pi: entries(piStore) }).toEqual({
    codex: {
      "config.toml": 'file model = "gpt-5-codex"\n',
      "history.jsonl": `link ${stale}`,
      rules: linked(codexHome, "rules"),
      sessions: linked(codexHome, "sessions"),
      skills: linked(codexHome, "skills"),
    },
    pi: {
      bin: linked(piHome, "bin"),
      extensions: linked(piHome, "extensions"),
      "models-store.json": linked(piHome, "models-store.json"),
      prompts: linked(piHome, "prompts"),
      sessions: linked(piHome, "sessions"),
      "settings.json": 'file {"theme":"dark"}',
      "trust.json": linked(piHome, "trust.json"),
    },
  });
});
