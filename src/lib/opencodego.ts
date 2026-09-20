import { mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { writeFileAtomic } from "./atomic.ts";
import { opencodeGoAuthJsonFor, opencodeGoPaths, opencodeGoPool, opencodeGoStoreDirFor } from "./paths.ts";
import type { Provider } from "./provider.ts";
import { type Harvest } from "./state.ts";
import { statusOnlyProvider, type AuthEntry } from "./statusonly.ts";
import { c } from "../cli/render.ts";

const OpencodeAuthEntrySchema = z.looseObject({ type: z.string(), key: z.string().optional() });
const OpencodeAuthFileSchema = z.record(z.string(), z.unknown());

function dataHome(): string {
  return process.env.XDG_DATA_HOME && process.env.XDG_DATA_HOME.length > 0 ? process.env.XDG_DATA_HOME : join(homedir(), ".local", "share");
}

function liveAuthPath(): string {
  return join(dataHome(), "opencode", "auth.json");
}

function idOfKey(key: string): string {
  const h = new Bun.CryptoHasher("sha256");
  h.update(`opencode-go:${key}`);
  return h.digest("hex");
}

function harvestOf(key: string): Harvest {
  const id = idOfKey(key);
  return {
    id,
    email: null,
    tier: "go",
    sample: null,
    park: async () => {
      mkdirSync(opencodeGoStoreDirFor(id), { recursive: true });
      writeFileAtomic(opencodeGoAuthJsonFor(id), JSON.stringify({ "opencode-go": { type: "api", key } }, null, 2), 0o600);
    },
  };
}

function readAuth(path: string): AuthEntry[] {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return [];
  }
  const map = OpencodeAuthFileSchema.safeParse(raw);
  if (!map.success) return [];
  const entry = OpencodeAuthEntrySchema.safeParse(map.data["opencode-go"]);
  if (!entry.success || entry.data.type !== "api" || !entry.data.key) return [];
  return [{ id: idOfKey(entry.data.key), usable: true, harvest: harvestOf(entry.data.key) }];
}

export const opencodeGo: Provider = statusOnlyProvider({
  name: "opencode-go",
  flag: " --opencode-go",
  pool: opencodeGoPool,
  binName: "opencode",
  binKey: "opencodeBin",
  storeDirFor: opencodeGoStoreDirFor,
  authJsonFor: opencodeGoAuthJsonFor,
  onboardDir: opencodeGoPaths.onboardDir,
  homeEnv: "XDG_DATA_HOME",
  loginArgs: ["providers", "login", "-p", "opencode-go"],
  onboardAuthRel: join("opencode", "auth.json"),
  liveAuthPath,
  readAuth,
  liveId: () => null,
  versionOk: (out) => out.trim() !== "",
  importIntro: "Pooling your opencode-go API key - your existing opencode auth stays as it is.",
  foundLive: () => `found an opencode-go credential in ${liveAuthPath()} - pooling it; use \`tokenmaxxing add --opencode-go\` for more keys.`,
  installNotice: "opencode-go pool is status-only: no supervisor or hooks installed. Use `tokenmaxxing status` to view pooled keys.",
  loginStep: () => `Paste the opencode-go API key from ${c.bold("opencode.ai/zen")} when opencode asks for it.`,
});
