// `tokenmaxxing config` - inspect, edit, and housekeep config.json (user ask
// 2026-07-16). Operates on the SPARSE file: config.json holds only overrides
// and loadConfig merges defaults at read time, so baking defaults into the
// file would freeze future default changes. `tidy` is the housekeeper: it
// drops keys the schema no longer knows (e.g. the pre-0.7 flat `threshold`)
// and normalizes switchModels casing; get/set/unset only ever report them.

import { existsSync, readFileSync } from "node:fs";
import { isPlainObject } from "es-toolkit";
import { get, set, unset } from "es-toolkit/compat";
import { z } from "zod";
import { paths, realClaudeBinFromEnv, realCodexBinFromEnv } from "../lib/paths.ts";
import { ConfigFileSchema, loadConfig } from "../lib/state.ts";
import { writeFileAtomic } from "../lib/atomic.ts";
import { c } from "./render.ts";

/** Hand-maintained mirror of ConfigFileSchema's dotted keys; an invariant test
 *  (test/config.test.ts) pins the two together so a new schema field cannot
 *  silently become invisible to get/set/tidy. */
export const KNOWN_KEYS = [
  "thresholds.session",
  "thresholds.weekly",
  "claudeBin",
  "codexBin",
  "policy.projectionMargin",
  "policy.greedySessionFloor",
  "policy.switchModels",
  "policy.usagePollTtlMs",
  "policy.maxWaitMs",
] as const;

const RawFileSchema = z.record(z.string(), z.unknown());

function readRawFile(): Record<string, unknown> {
  if (!existsSync(paths.configJson)) return {};
  return RawFileSchema.parse(JSON.parse(readFileSync(paths.configJson, "utf8")));
}

function writeRawFile(input: { raw: Record<string, unknown> }): void {
  writeFileAtomic(paths.configJson, JSON.stringify(input.raw, null, 2) + "\n");
}

/** Dotted keys in `obj` (two levels: this config nests exactly once). */
function dottedKeys(obj: Record<string, unknown>): string[] {
  const keys: string[] = [];
  for (const [key, value] of Object.entries(obj)) {
    if (isPlainObject(value)) {
      for (const nested of Object.keys(value)) keys.push(`${key}.${nested}`);
      continue;
    }
    keys.push(key);
  }
  return keys;
}

function unknownFileKeys(raw: Record<string, unknown>): string[] {
  const known = new Set<string>(KNOWN_KEYS);
  return dottedKeys(raw).filter((key) => !known.has(key));
}

function envSourceFor(key: string): string | null {
  if (key === "claudeBin" && realClaudeBinFromEnv()) return "TOKENMAXXING_CLAUDE_BIN";
  if (key === "codexBin" && realCodexBinFromEnv()) return "TOKENMAXXING_CODEX_BIN";
  return null;
}

function printEffective(): number {
  const effective = loadConfig();
  const raw = readRawFile();
  console.log(c.dim(`config.json: ${paths.configJson}`));
  for (const key of KNOWN_KEYS) {
    const env = envSourceFor(key);
    const source = env ? c.yellow(`env ${env}`) : get(raw, key) !== undefined ? c.green("file") : c.dim("default");
    console.log(`  ${key.padEnd(28)} ${JSON.stringify(get(effective, key))}  ${source}`);
  }
  const unknown = unknownFileKeys(raw);
  if (unknown.length > 0) {
    console.log();
    console.log(c.yellow(`unknown keys in the file (ignored by the loader): ${unknown.join(", ")}`));
    console.log(c.dim("run `tokenmaxxing config tidy` to drop them"));
  }
  return 0;
}

function cmdGet(key: string): number {
  if (!KNOWN_KEYS.some((known) => known === key)) {
    console.error(c.red(`unknown config key: ${key}`));
    console.error(c.dim(`known keys: ${KNOWN_KEYS.join(", ")}`));
    return 1;
  }
  console.log(JSON.stringify(get(loadConfig(), key)));
  return 0;
}

/** JSON when it parses (numbers, booleans, arrays), else the literal string. */
function parseValue(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function cmdSet(key: string, valueText: string): number {
  if (!KNOWN_KEYS.some((known) => known === key)) {
    console.error(c.red(`unknown config key: ${key}`));
    console.error(c.dim(`known keys: ${KNOWN_KEYS.join(", ")}`));
    return 1;
  }
  const raw = readRawFile();
  const next = structuredClone(raw);
  set(next, key, parseValue(valueText));
  const validated = ConfigFileSchema.safeParse(next);
  if (!validated.success) {
    console.error(c.red(`rejected: ${validated.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`));
    return 1;
  }
  writeRawFile({ raw: next });
  // Report the FILE-level change: with an env override in place, the effective
  // value would not move, and an unchanged-looking arrow would misrepresent
  // the write that just happened.
  const beforeFile = get(raw, key);
  console.log(
    `${key}: ${beforeFile === undefined ? "(default)" : JSON.stringify(beforeFile)} -> ${JSON.stringify(get(next, key))}`,
  );
  const env = envSourceFor(key);
  if (env) console.log(c.yellow(`note: ${env} is set and overrides the file value in this environment`));
  return 0;
}

/** Remove parents emptied by a deletion or a strip: the sparse file must not
 *  accumulate `{}` husks. */
function pruneEmptyParents(raw: Record<string, unknown>): void {
  for (const [topKey, value] of Object.entries(raw)) {
    if (isPlainObject(value) && Object.keys(value).length === 0) {
      delete raw[topKey];
    }
  }
}

function cmdUnset(key: string): number {
  if (!KNOWN_KEYS.some((known) => known === key)) {
    console.error(c.red(`unknown config key: ${key}`));
    return 1;
  }
  const raw = readRawFile();
  if (get(raw, key) === undefined) {
    console.log(c.dim(`${key} has no file override (default already applies)`));
    return 0;
  }
  const next = structuredClone(raw);
  unset(next, key);
  pruneEmptyParents(next);
  writeRawFile({ raw: next });
  console.log(`${key} unset -> ${JSON.stringify(get(loadConfig(), key))} (default)`);
  return 0;
}

function cmdTidy(): number {
  const raw = readRawFile();
  const dropped = unknownFileKeys(raw);
  // ConfigFileSchema strips unknown keys at both levels; switchModels casing
  // normalizes to what the loader would use anyway.
  const parsed = ConfigFileSchema.parse(raw);
  const next = RawFileSchema.parse(JSON.parse(JSON.stringify(parsed)));
  const models = get(next, "policy.switchModels");
  const normalized = Array.isArray(models) ? models.map((model) => String(model).toLowerCase()) : null;
  const casingChanged = normalized != null && JSON.stringify(normalized) !== JSON.stringify(models);
  if (normalized != null) set(next, "policy.switchModels", normalized);
  pruneEmptyParents(next);

  // Honest housekeeping: say exactly what changed, write only when something did.
  if (JSON.stringify(next) === JSON.stringify(raw)) {
    console.log(c.dim("nothing to tidy"));
    return 0;
  }
  writeRawFile({ raw: next });
  if (dropped.length > 0) console.log(`dropped unknown keys: ${dropped.join(", ")}`);
  if (casingChanged) console.log("normalized switchModels casing");
  if (dropped.length === 0 && !casingChanged) console.log("canonicalized file layout (pruned empty sections / key order)");
  return 0;
}

export function cmdConfig(args: string[]): number {
  const [sub, key, value] = args;
  try {
    if (sub === undefined) return printEffective();
    if (sub === "get" && key !== undefined) return cmdGet(key);
    if (sub === "set" && key !== undefined && value !== undefined) return cmdSet(key, value);
    if (sub === "unset" && key !== undefined) return cmdUnset(key);
    if (sub === "tidy") return cmdTidy();
  } catch (e) {
    // A corrupt config.json fails fast with a recovery step, not a stack trace.
    console.error(c.red(`config.json is unreadable: ${e instanceof Error ? e.message : String(e)}`));
    console.error(c.dim(`fix or delete ${paths.configJson} (defaults apply when it is absent), then re-run`));
    return 1;
  }
  console.error(c.red("usage: tokenmaxxing config [get <key> | set <key> <value> | unset <key> | tidy]"));
  return 2;
}
