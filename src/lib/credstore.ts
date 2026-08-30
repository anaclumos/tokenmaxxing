import { mkdirSync, readFileSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import { writeFileAtomic } from "./atomic.ts";
import * as kc from "./keychain.ts";
import { credDir, keychain as kcNames, namespacedCredService, paths } from "./paths.ts";
import { CredentialBlobSchema } from "./types.ts";

const CredTargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("keychain"), service: z.string(), account: z.string() }),
  z.object({ kind: z.literal("file"), path: z.string() }),
]);
export type CredTarget = z.infer<typeof CredTargetSchema>;

const darwin = process.platform === "darwin";

const BlobRecordSchema = z.record(z.string(), z.unknown());

function isEnoent(e: unknown): boolean {
  return e instanceof Error && "code" in e && e.code === "ENOENT";
}

export async function readItem(t: CredTarget): Promise<string | null> {
  if (t.kind === "keychain") return kc.readItem(t);
  try {
    return readFileSync(t.path, "utf8");
  } catch (e) {
    if (isEnoent(e)) return null;
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
    if (isEnoent(e)) return false;
    throw e;
  }
}

export function liveTarget(): CredTarget {
  return darwin
    ? { kind: "keychain", service: kcNames.service, account: kcNames.account }
    : { kind: "file", path: join(credDir(), ".credentials.json") };
}

export function parkedTarget(itemName: string): CredTarget {
  return darwin
    ? { kind: "keychain", service: itemName, account: kcNames.account }
    : { kind: "file", path: join(paths.credsDir, `${itemName}.json`) };
}

export function isolatedTarget(configDirRaw: string): CredTarget {
  return darwin
    ? { kind: "keychain", service: namespacedCredService(configDirRaw), account: kcNames.account }
    : { kind: "file", path: join(configDirRaw, ".credentials.json") };
}

export function claudeAiOauthOnly(fullBlobRaw: string): string {
  const b = CredentialBlobSchema.parse(JSON.parse(fullBlobRaw));
  return JSON.stringify({ claudeAiOauth: b.claudeAiOauth });
}

export function mergeIntoLive(currentLiveRaw: string | null, freshClaudeAiOauth: unknown): string {
  const base = currentLiveRaw == null ? {} : BlobRecordSchema.parse(JSON.parse(currentLiveRaw));
  base["claudeAiOauth"] = freshClaudeAiOauth;
  return JSON.stringify(base);
}
