import { existsSync, readFileSync } from "node:fs";
import { isPlainObject } from "es-toolkit";
import { get, set, unset } from "es-toolkit/compat";
import { z } from "zod";
import { paths, realClaudeBinFromEnv, realCodexBinFromEnv } from "../lib/paths.ts";
import { ConfigFileSchema, loadConfig, mergeConfigFile } from "../lib/state.ts";
import { writeFileAtomic } from "../lib/atomic.ts";
import { c, emitError, emitJson } from "./render.ts";

export const KNOWN_KEYS = [
  "thresholds.session",
  "thresholds.weekly",
  "hardThresholds.session",
  "hardThresholds.weekly",
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

function isKnownKey(key: string): boolean {
  return KNOWN_KEYS.some((known) => known === key);
}

function envSourceFor(key: string): string | null {
  if (key === "claudeBin" && realClaudeBinFromEnv()) return "TOKENMAXXING_CLAUDE_BIN";
  if (key === "codexBin" && realCodexBinFromEnv()) return "TOKENMAXXING_CODEX_BIN";
  return null;
}

function sourceOf(input: { key: string; raw: Record<string, unknown> }): { source: "env" | "file" | "default"; env: string | null } {
  const env = envSourceFor(input.key);
  if (env) return { source: "env", env };
  return { source: get(input.raw, input.key) !== undefined ? "file" : "default", env: null };
}

function unknownKey(input: { key: string; json: boolean }): number {
  emitError({
    json: input.json,
    message: `unknown config key: ${input.key}`,
    notes: [`known keys: ${KNOWN_KEYS.join(", ")}`],
    extra: { knownKeys: KNOWN_KEYS },
  });
  return 1;
}

function printEffective(json: boolean): number {
  const effective = loadConfig();
  const raw = readRawFile();
  const unknown = unknownFileKeys(raw);
  if (json) {
    const sources: Record<string, string> = {};
    const envOverrides: Record<string, string> = {};
    for (const key of KNOWN_KEYS) {
      const { source, env } = sourceOf({ key, raw });
      sources[key] = source;
      if (env) envOverrides[key] = env;
    }
    emitJson({ ok: true, path: paths.configJson, config: effective, sources, envOverrides, unknownKeys: unknown });
    return 0;
  }
  console.log(c.dim(`config.json: ${paths.configJson}`));
  for (const key of KNOWN_KEYS) {
    const { source, env } = sourceOf({ key, raw });
    const painted = source === "env" ? c.yellow(`env ${env}`) : source === "file" ? c.green("file") : c.dim("default");
    console.log(`  ${key.padEnd(28)} ${JSON.stringify(get(effective, key))}  ${painted}`);
  }
  if (unknown.length > 0) {
    console.log();
    console.log(c.yellow(`unknown keys in the file (ignored by the loader): ${unknown.join(", ")}`));
    console.log(c.dim("run `tokenmaxxing config tidy` to drop them"));
  }
  return 0;
}

function cmdGet(key: string, json: boolean): number {
  if (!isKnownKey(key)) return unknownKey({ key, json });
  const value = get(loadConfig(), key);
  if (json) {
    emitJson({ ok: true, key, value, source: sourceOf({ key, raw: readRawFile() }).source });
    return 0;
  }
  console.log(JSON.stringify(value));
  return 0;
}

function parseValue(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function cmdSet(key: string, valueText: string, json: boolean): number {
  if (!isKnownKey(key)) return unknownKey({ key, json });
  const raw = readRawFile();
  const next = structuredClone(raw);
  set(next, key, parseValue(valueText));
  const validated = ConfigFileSchema.safeParse(next);
  if (!validated.success) {
    emitError({ json, message: `rejected: ${validated.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")}` });
    return 1;
  }
  const mergedCheck = mergeConfigFile(validated.data);
  if (!mergedCheck.ok) {
    emitError({ json, message: `rejected: ${mergedCheck.detail}` });
    return 1;
  }
  writeRawFile({ raw: next });
  const beforeFile = get(raw, key);
  const env = envSourceFor(key);
  if (json) {
    emitJson({ ok: true, key, before: beforeFile === undefined ? null : beforeFile, after: get(next, key), envOverride: env });
    return 0;
  }
  console.log(
    `${key}: ${beforeFile === undefined ? "(default)" : JSON.stringify(beforeFile)} -> ${JSON.stringify(get(next, key))}`,
  );
  if (env) console.log(c.yellow(`note: ${env} is set and overrides the file value in this environment`));
  return 0;
}

function pruneEmptyParents(raw: Record<string, unknown>): void {
  for (const [topKey, value] of Object.entries(raw)) {
    if (isPlainObject(value) && Object.keys(value).length === 0) {
      delete raw[topKey];
    }
  }
}

function cmdUnset(key: string, json: boolean): number {
  if (!isKnownKey(key)) return unknownKey({ key, json });
  const raw = readRawFile();
  if (get(raw, key) === undefined) {
    if (json) emitJson({ ok: true, key, unset: false, value: get(loadConfig(), key) });
    else console.log(c.dim(`${key} has no file override (default already applies)`));
    return 0;
  }
  const next = structuredClone(raw);
  unset(next, key);
  pruneEmptyParents(next);
  const validated = ConfigFileSchema.safeParse(next);
  if (!validated.success) {
    emitError({ json, message: `rejected: ${validated.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")}` });
    return 1;
  }
  const mergedCheck = mergeConfigFile(validated.data);
  if (!mergedCheck.ok) {
    emitError({ json, message: `rejected: ${mergedCheck.detail} (adjust the conflicting override before unsetting ${key})` });
    return 1;
  }
  writeRawFile({ raw: next });
  const value = get(loadConfig(), key);
  if (json) {
    emitJson({ ok: true, key, unset: true, value });
    return 0;
  }
  console.log(`${key} unset -> ${JSON.stringify(value)} (default)`);
  return 0;
}

function cmdTidy(json: boolean): number {
  const raw = readRawFile();
  const dropped = unknownFileKeys(raw);
  const parsed = ConfigFileSchema.parse(raw);
  const next = RawFileSchema.parse(JSON.parse(JSON.stringify(parsed)));
  const models = get(next, "policy.switchModels");
  const normalized = Array.isArray(models) ? models.map((model) => String(model).toLowerCase()) : null;
  const casingChanged = normalized != null && JSON.stringify(normalized) !== JSON.stringify(models);
  if (normalized != null) set(next, "policy.switchModels", normalized);
  pruneEmptyParents(next);

  const changed = JSON.stringify(next) !== JSON.stringify(raw);
  if (changed) writeRawFile({ raw: next });
  if (json) {
    emitJson({ ok: true, changed, droppedKeys: dropped, casingNormalized: casingChanged });
    return 0;
  }
  if (!changed) {
    console.log(c.dim("nothing to tidy"));
    return 0;
  }
  if (dropped.length > 0) console.log(`dropped unknown keys: ${dropped.join(", ")}`);
  if (casingChanged) console.log("normalized switchModels casing");
  if (dropped.length === 0 && !casingChanged) console.log("canonicalized file layout (pruned empty sections / key order)");
  return 0;
}

export function cmdConfig(args: string[], json = false): number {
  const [sub, key, value] = args;
  try {
    if (sub === undefined) return printEffective(json);
    if (sub === "get" && key !== undefined) return cmdGet(key, json);
    if (sub === "set" && key !== undefined && value !== undefined) return cmdSet(key, value, json);
    if (sub === "unset" && key !== undefined) return cmdUnset(key, json);
    if (sub === "tidy") return cmdTidy(json);
  } catch (e) {
    emitError({
      json,
      message: `config.json is unreadable: ${e instanceof Error ? e.message : String(e)}`,
      notes: [`fix or delete ${paths.configJson} (defaults apply when it is absent), then re-run`],
      extra: { path: paths.configJson },
    });
    return 1;
  }
  emitError({ json, message: "usage: tokenmaxxing config [get <key> | set <key> <value> | unset <key> | tidy]" });
  return 2;
}
