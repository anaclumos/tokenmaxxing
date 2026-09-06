import { mkdirSync, readFileSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import { writeFileAtomic } from "./atomic.ts";
import { errnoCode } from "./errors.ts";
import * as kc from "./keychain.ts";
import { credDir, keychainNames, namespacedCredService, paths } from "./paths.ts";
import { CredentialBlobSchema, type CredentialBlob } from "./types.ts";

export type CredTarget = { kind: "keychain"; service: string; account: string } | { kind: "file"; path: string };

const darwin = process.platform === "darwin";

const BlobRecordSchema = z.record(z.string(), z.unknown());

export async function readItem(t: CredTarget): Promise<string | null> {
  if (t.kind === "keychain") return kc.readItem(t);
  try {
    return readFileSync(t.path, "utf8");
  } catch (e) {
    if (errnoCode(e) === "ENOENT") return null;
    throw e;
  }
}

export async function writeItem(t: CredTarget, secret: string): Promise<void> {
  if (t.kind === "keychain") return kc.writeItem(t, secret);
  mkdirSync(dirname(t.path), { recursive: true, mode: 0o700 });
  writeFileAtomic(t.path, secret, 0o600);
}

export async function deleteItem(t: CredTarget): Promise<boolean> {
  if (t.kind === "keychain") return kc.deleteItem(t);
  try {
    unlinkSync(t.path);
    return true;
  } catch (e) {
    if (errnoCode(e) === "ENOENT") return false;
    throw e;
  }
}

export function liveTarget(): CredTarget {
  return darwin
    ? { kind: "keychain", ...keychainNames() }
    : { kind: "file", path: join(credDir(), ".credentials.json") };
}

export function parkedTarget(itemName: string): CredTarget {
  return darwin
    ? { kind: "keychain", service: itemName, account: keychainNames().account }
    : { kind: "file", path: join(paths.credsDir, `${itemName}.json`) };
}

export function isolatedTarget(configDirRaw: string): CredTarget {
  return darwin
    ? { kind: "keychain", service: namespacedCredService(configDirRaw), account: keychainNames().account }
    : { kind: "file", path: join(configDirRaw, ".credentials.json") };
}

export function parseBlob(raw: string): CredentialBlob {
  return CredentialBlobSchema.parse(JSON.parse(raw));
}

export function claudeAiOauthOnly(fullBlobRaw: string): string {
  return JSON.stringify({ claudeAiOauth: parseBlob(fullBlobRaw).claudeAiOauth });
}

export function mergeIntoLive(currentLiveRaw: string | null, freshClaudeAiOauth: unknown): string {
  const base = currentLiveRaw == null ? {} : BlobRecordSchema.parse(JSON.parse(currentLiveRaw));
  base["claudeAiOauth"] = freshClaudeAiOauth;
  return JSON.stringify(base);
}
