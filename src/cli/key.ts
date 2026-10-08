import { z } from "zod";
import { keySessions, loadApiKeys, removeApiKeySecret, saveApiKeys, writeApiKeySecret } from "../lib/apikeys.ts";
import { withLock } from "../lib/lock.ts";
import { claudePool } from "../lib/paths.ts";
import { readStdin } from "../lib/proc.ts";
import type { ApiKey } from "../lib/types.ts";
import { c, emitError, plain } from "./render.ts";

const USAGE = "usage: tokenmaxxing key add <label> [credit-usd] [workspace-id] (the key on stdin) | key credit <label> <usd> | key rm <label>";

const UsdSchema = z.coerce.number().finite().min(0);

const WorkspaceIdSchema = z
  .string()
  .min(1)
  .refine((id) => id.trim() === id && !id.includes("\n") && !id.includes("\r"), "a workspace id is one line with no surrounding whitespace");

export function usd(amount: number): string {
  return `$${amount.toFixed(2)}`;
}

function findKey(keys: ApiKey[], label: string): ApiKey | undefined {
  return keys.find((k) => k.label.toLowerCase() === label.toLowerCase());
}

function parseUsd(raw: string): number | null {
  const parsed = UsdSchema.safeParse(raw);
  if (parsed.success) return parsed.data;
  emitError({ message: `"${raw}" is not a dollar amount (a number at or above 0)` });
  return null;
}

async function add(args: string[]): Promise<number> {
  const [label, creditRaw, workspaceRaw] = args;
  if (!label) {
    emitError({ message: USAGE, paint: plain });
    return 2;
  }
  const credit = creditRaw == null ? undefined : parseUsd(creditRaw);
  if (credit === null) return 2;
  const workspace = workspaceRaw == null ? undefined : WorkspaceIdSchema.safeParse(workspaceRaw);
  if (workspace != null && !workspace.success) {
    emitError({ message: `"${workspaceRaw}" is not a workspace id: ${workspace.error.issues[0]?.message ?? "invalid"}` });
    return 2;
  }
  const workspaceId = workspace?.data;
  if (process.stdin.isTTY) {
    emitError({ message: "refusing to read the API key from a terminal, which would echo it - pipe it in: read -rs KEY && printf '%s' \"$KEY\" | tokenmaxxing key add <label> ...; unset KEY" });
    return 2;
  }
  const secret = (await readStdin()).trim();
  if (secret === "") {
    emitError({ message: "no API key on stdin - pipe the key in, for example from your password manager" });
    return 2;
  }
  if (secret.includes("\n") || secret.includes("\r")) {
    emitError({ message: "stdin holds more than one line - pass one API key per `key add`" });
    return 2;
  }
  if (secret.startsWith("sk-ant-admin")) {
    emitError({ message: "that is an Admin API key, which cannot run inference - create a regular API key in the Console" });
    return 2;
  }
  return withLock(claudePool.lockFile, () => {
    const idx = loadApiKeys();
    const taken = findKey(idx.keys, label);
    if (taken) {
      emitError({ message: `label "${label}" is already used by another API key - labels must be unique` });
      return 1;
    }
    let id = crypto.randomUUID().slice(0, 8);
    while (idx.keys.some((k) => k.id === id)) id = crypto.randomUUID().slice(0, 8);
    const now = Date.now();
    writeApiKeySecret(id, secret);
    idx.keys.push({
      id,
      label,
      ...(workspaceId != null ? { workspaceId } : {}),
      ...(credit != null ? { creditUsd: credit } : {}),
      spentUsd: 0,
      creditSetAt: now,
      addedAt: now,
    });
    saveApiKeys(idx);
    console.log(`added API key ${c.bold(label)} (${credit != null ? `credit ${usd(credit)}` : "credit unknown, ranks after keys with a balance"}${workspaceId != null ? `, workspace ${workspaceId}` : ""})`);
    return 0;
  });
}

async function credit(args: string[]): Promise<number> {
  const [label, amountRaw] = args;
  if (!label || amountRaw == null || args.length > 2) {
    emitError({ message: USAGE, paint: plain });
    return 2;
  }
  const amount = parseUsd(amountRaw);
  if (amount === null) return 2;
  return withLock(claudePool.lockFile, () => {
    const idx = loadApiKeys();
    const key = findKey(idx.keys, label);
    if (!key) {
      emitError({ message: `no API key is labeled "${label}"` });
      return 1;
    }
    key.creditUsd = amount;
    key.spentUsd = 0;
    key.creditSetAt = Date.now();
    key.refusedAt = undefined;
    saveApiKeys(idx);
    console.log(`set ${c.bold(key.label)} credit to ${usd(amount)}`);
    return 0;
  });
}

async function rm(args: string[]): Promise<number> {
  const [label] = args;
  if (!label || args.length > 1) {
    emitError({ message: USAGE, paint: plain });
    return 2;
  }
  return withLock(claudePool.lockFile, () => {
    const idx = loadApiKeys();
    const key = findKey(idx.keys, label);
    if (!key) {
      emitError({ message: `no API key is labeled "${label}"` });
      return 1;
    }
    if (keySessions().has(key.id)) {
      emitError({ message: `${key.label} is running in a live session - close that session before removing the key.` });
      return 1;
    }
    removeApiKeySecret(key.id);
    idx.keys = idx.keys.filter((k) => k.id !== key.id);
    saveApiKeys(idx);
    console.log(`removed API key ${c.bold(key.label)} (${idx.keys.length} left)`);
    return 0;
  });
}

export async function cmdKey(args: string[]): Promise<number> {
  const [action, ...rest] = args;
  if (action === "add") return add(rest);
  if (action === "credit") return credit(rest);
  if (action === "rm") return rm(rest);
  emitError({ message: USAGE, paint: plain });
  return 2;
}
