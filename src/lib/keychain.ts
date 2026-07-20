// macOS login-keychain generic-password I/O, ps-safe. The darwin backend of
// credstore.ts - construct targets there, not here.
//   READ  : `security find-generic-password -w`  → secret only ever in stdout.
//   WRITE : pipe an `add-generic-password -U ... -w <secret>` line into `security -i`
//           over STDIN - the secret never appears in any process's argv (verified).
// The service/account are non-secret and may sit in argv.

import { z } from "zod";

const KeychainTargetSchema = z.object({ service: z.string(), account: z.string() });
export type KeychainTarget = z.infer<typeof KeychainTargetSchema>;

const SECURITY = "/usr/bin/security";
// security(1) interactive mode has a 4096-byte line buffer. The gate below
// measures the ASSEMBLED line against this (with margin), never the raw
// secret: quoteDouble expansion (one byte per `"`/`\` when the blob contains
// an apostrophe) once pushed a raw-length-passing line over the buffer, which
// SPLITS the line - the write exits 1 ("unknown command" for the spilled
// remainder) AND the item is left holding a TRUNCATED secret (empirically
// verified 2026-07-20: a 3667-byte secret assembling to a 5574-byte line
// corrupted the item to its first 2682 bytes before the error surfaced).
const INTERACTIVE_MAX_LINE = 4000;

/** Double-quote + backslash-escape for security(1)'s interactive tokenizer. */
function quoteDouble(s: string): string {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** Wrap a value for the `-i` line. Single-quote when possible (blob has no `'`). */
function quoteValue(s: string): string {
  return s.includes("'") ? quoteDouble(s) : `'${s}'`;
}

/** Read an item's password blob. Returns null ONLY when the item verifiably
 *  does not exist (exit 44, errSecItemNotFound - empirically pinned on this
 *  Mac 2026-07-20). Every other failure THROWS: a locked keychain or denied
 *  ACL prompt reading as "absent" silently disarmed every fail-closed
 *  live-owner guard and the mandatory pre-swap harvest, all of which key off
 *  a null read (closing-review catch). stderr never carries the secret. */
export async function readItem(t: KeychainTarget): Promise<string | null> {
  const p = Bun.spawn([SECURITY, "find-generic-password", "-s", t.service, "-a", t.account, "-w"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  await p.exited;
  if (p.exitCode === 44) return null;
  if (p.exitCode !== 0) {
    throw new Error(`keychain read failed (exit ${p.exitCode}): ${err.trim().slice(0, 200)} - a locked keychain or denied ACL must fail loudly, never read as absent`);
  }
  return out.replace(/\n$/, ""); // security appends exactly one trailing newline
}

/** The full `security -i` line for a write; its LENGTH is the argv-fallback
 *  gate, so it is assembled once, here. */
function interactiveLine(t: KeychainTarget, secret: string): string {
  return (
    `add-generic-password -U -a ${quoteDouble(t.account)} -s ${quoteDouble(t.service)} ` +
    `-w ${quoteValue(secret)}\n`
  );
}

/** ps-safe write: the command line + secret arrive on stdin, never in argv.
 *  The caller guarantees the encoded line fits the interactive buffer. */
async function writeViaInteractive(encodedLine: Uint8Array): Promise<void> {
  const p = Bun.spawn([SECURITY, "-i"], {
    stdin: encodedLine,
    stdout: "ignore",
    stderr: "pipe",
  });
  const err = await new Response(p.stderr).text();
  await p.exited;
  if (p.exitCode !== 0) throw new Error(`keychain write (interactive) failed (exit ${p.exitCode}): ${err.trim()}`);
}

/** Fallback for blobs over the interactive line limit. The secret is briefly
 *  visible in `ps` for this one short-lived process - used only when the payload
 *  (e.g. a live blob with lots of MCP OAuth state) exceeds ~4KB. */
async function writeViaArgv(t: KeychainTarget, secret: string): Promise<void> {
  const p = Bun.spawn([SECURITY, "add-generic-password", "-U", "-a", t.account, "-s", t.service, "-w", secret], {
    stdout: "ignore",
    stderr: "pipe",
  });
  const err = await new Response(p.stderr).text();
  await p.exited;
  if (p.exitCode !== 0) throw new Error(`keychain write (argv) failed (exit ${p.exitCode}): ${err.trim()}`);
}

/** Create-or-update an item (`-U`) with `secret` as its password. Prefers the
 *  ps-safe stdin path; falls back to argv when the ASSEMBLED interactive line
 *  would exceed the buffer (see INTERACTIVE_MAX_LINE - gating on the raw
 *  secret length let quote expansion corrupt the item). Throws on failure. */
export async function writeItem(t: KeychainTarget, secret: string): Promise<void> {
  // measured in UTF-8 BYTES, the unit the stdin buffer actually consumes:
  // String.length counts UTF-16 code units and under-counts multibyte
  // characters (cubic review catch, PR #35).
  const encoded = new TextEncoder().encode(interactiveLine(t, secret));
  if (encoded.length <= INTERACTIVE_MAX_LINE) return writeViaInteractive(encoded);
  return writeViaArgv(t, secret);
}

/** Delete an item. Returns true if it existed and was removed. */
export async function deleteItem(t: KeychainTarget): Promise<boolean> {
  const p = Bun.spawn([SECURITY, "delete-generic-password", "-s", t.service, "-a", t.account], {
    stdout: "ignore",
    stderr: "ignore",
  });
  await p.exited;
  return p.exitCode === 0;
}
