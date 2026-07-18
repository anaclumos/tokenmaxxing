// Platform credential store - ONE backend per platform, selected when a target
// is constructed:
//   darwin : login-keychain generic-password via security(1)  (keychain.ts)
//   linux  : plaintext files, matching claude's own Linux store
//            (live = <configDir>/.credentials.json, mode 0600; verified 2.1.205:
//            the Linux build has no keyring path at all)
// Parked backups live in the keychain (darwin) or ~/.config/tokenmaxxing/creds
// (linux). Call sites never branch on platform - they pass targets around.

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

/** Read a target's credential blob. Returns null if it does not exist. */
export async function readItem(t: CredTarget): Promise<string | null> {
  if (t.kind === "keychain") return kc.readItem(t);
  try {
    return readFileSync(t.path, "utf8");
  } catch (e) {
    if (isEnoent(e)) return null;
    throw e;
  }
}

/** Create-or-update a target with `secret` as its blob. Throws on failure. */
export async function writeItem(t: CredTarget, secret: string): Promise<void> {
  if (t.kind === "keychain") return kc.writeItem(t, secret);
  mkdirSync(dirname(t.path), { recursive: true, mode: 0o700 });
  writeFileAtomic(t.path, secret, 0o600);
}

/** Delete a target. Returns true if it existed and was removed. */
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

/** The live default credential claude reads (`Claude Code-credentials` / $USER
 *  on darwin, `<credDir()>/.credentials.json` on linux). */
export function liveTarget(): CredTarget {
  return darwin
    ? { kind: "keychain", service: kcNames.service, account: kcNames.account }
    : { kind: "file", path: join(credDir(), ".credentials.json") };
}

/** A parked account's backup (`tokenmaxxing-cred-<uuid8>` item / .json file). */
export function parkedTarget(itemName: string): CredTarget {
  return darwin
    ? { kind: "keychain", service: itemName, account: kcNames.account }
    : { kind: "file", path: join(paths.credsDir, `${itemName}.json`) };
}

/** The credential claude uses under CLAUDE_CONFIG_DIR=`configDirRaw`: a
 *  hash-namespaced keychain service on darwin, the file inside the dir on linux.
 *  The dir string must be byte-stable on darwin (hash is over the RAW string). */
export function isolatedTarget(configDirRaw: string): CredTarget {
  return darwin
    ? { kind: "keychain", service: namespacedCredService(configDirRaw), account: kcNames.account }
    : { kind: "file", path: join(configDirRaw, ".credentials.json") };
}

/** Reduce a full credential blob to just `{claudeAiOauth}` - what parked items
 *  store (small → always the ps-safe keychain write path on darwin). */
export function claudeAiOauthOnly(fullBlobRaw: string): string {
  const b = CredentialBlobSchema.parse(JSON.parse(fullBlobRaw));
  return JSON.stringify({ claudeAiOauth: b.claudeAiOauth });
}

/** Merge a fresh `claudeAiOauth` into the CURRENT live blob, preserving every
 *  sibling key (MCP OAuth state, etc.). Returns the full blob string to install. */
export function mergeIntoLive(currentLiveRaw: string | null, freshClaudeAiOauth: unknown): string {
  const base = currentLiveRaw ? BlobRecordSchema.parse(JSON.parse(currentLiveRaw)) : {};
  base["claudeAiOauth"] = freshClaudeAiOauth;
  return JSON.stringify(base);
}
