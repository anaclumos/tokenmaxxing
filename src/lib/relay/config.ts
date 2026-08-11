// $TOKENMAXXING_HOME/relay.json - sparse overrides merged with defaults.

import { existsSync, readFileSync } from "node:fs";
import { z } from "zod";
import { paths } from "../paths.ts";
import { writeFileAtomic } from "../atomic.ts";
import { ClaudePermissionModeSchema } from "./modes.ts";

const WorkerSchema = z.enum(["claude", "codex"]);
export type RelayWorker = z.infer<typeof WorkerSchema>;

const HostsSchema = z.object({
  cursor: z.object({ model: z.string().min(1).optional() }).default({}),
  claude: z.object({ model: z.string().min(1).optional() }).default({}),
}).default({ cursor: {}, claude: {} });

export const RelayConfigFileSchema = z.object({
  defaultWorker: WorkerSchema.optional(),
  defaultPermissionMode: ClaudePermissionModeSchema.optional(),
  turnTimeoutMs: z.number().int().positive().optional(),
  decideTimeoutMs: z.number().int().positive().optional(),
  idleTtlMs: z.number().int().positive().optional(),
  sameSessionBusyMs: z.number().int().positive().optional(),
  sessionPrefix: z.string().min(1).optional(),
  hosts: HostsSchema.optional(),
});
export type RelayConfigFile = z.infer<typeof RelayConfigFileSchema>;

export const RelayConfigSchema = z.object({
  defaultWorker: WorkerSchema,
  defaultPermissionMode: ClaudePermissionModeSchema,
  turnTimeoutMs: z.number().int().positive(),
  decideTimeoutMs: z.number().int().positive(),
  idleTtlMs: z.number().int().positive(),
  sameSessionBusyMs: z.number().int().positive(),
  sessionPrefix: z.string().min(1),
  hosts: z.object({
    cursor: z.object({ model: z.string().min(1).optional() }),
    claude: z.object({ model: z.string().min(1).optional() }),
  }),
});
export type RelayConfig = z.infer<typeof RelayConfigSchema>;

export const DEFAULT_RELAY_CONFIG: RelayConfig = {
  defaultWorker: "claude",
  defaultPermissionMode: "auto",
  turnTimeoutMs: 30 * 60 * 1000,
  decideTimeoutMs: 30 * 60 * 1000,
  idleTtlMs: 60 * 60 * 1000,
  sameSessionBusyMs: 50,
  sessionPrefix: "xx-relay-",
  hosts: { cursor: {}, claude: {} },
};

export function loadRelayConfig(): RelayConfig {
  if (!existsSync(paths.relayJson)) return DEFAULT_RELAY_CONFIG;
  const raw = RelayConfigFileSchema.parse(JSON.parse(readFileSync(paths.relayJson, "utf8")));
  return RelayConfigSchema.parse({
    ...DEFAULT_RELAY_CONFIG,
    ...raw,
    hosts: {
      cursor: { ...DEFAULT_RELAY_CONFIG.hosts.cursor, ...raw.hosts?.cursor },
      claude: { ...DEFAULT_RELAY_CONFIG.hosts.claude, ...raw.hosts?.claude },
    },
    defaultPermissionMode: raw.defaultPermissionMode ?? DEFAULT_RELAY_CONFIG.defaultPermissionMode,
  });
}

export function writeRelayConfig(input: { file: RelayConfigFile }): void {
  const validated = RelayConfigFileSchema.parse(input.file);
  writeFileAtomic(paths.relayJson, JSON.stringify(validated, null, 2) + "\n");
}

export function mergeRelayConfigFile(input: { patch: RelayConfigFile }): RelayConfig {
  const existing = existsSync(paths.relayJson)
    ? RelayConfigFileSchema.parse(JSON.parse(readFileSync(paths.relayJson, "utf8")))
    : {};
  const next = RelayConfigFileSchema.parse({ ...existing, ...input.patch, hosts: {
    cursor: { ...existing.hosts?.cursor, ...input.patch.hosts?.cursor },
    claude: { ...existing.hosts?.claude, ...input.patch.hosts?.claude },
  } });
  writeRelayConfig({ file: next });
  return loadRelayConfig();
}
