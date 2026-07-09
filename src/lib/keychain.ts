// macOS login-keychain generic-password I/O, ps-safe. The darwin backend of
// credstore.ts - construct targets there, not here.
//   READ  : `security find-generic-password -w`  → secret only ever in stdout.
//   WRITE : pipe an `add-generic-password -U … -w <secret>` line into `security -i`
//           over STDIN - the secret never appears in any process's argv (verified).
// The service/account are non-secret and may sit in argv.

import { z } from "zod";

const KeychainTargetSchema = z.object({ service: z.string(), account: z.string() });
export type KeychainTarget = z.infer<typeof KeychainTargetSchema>;

const SECURITY = "/usr/bin/security";
// security(1) interactive mode has a ~4KB line buffer; above this we must use argv.
const INTERACTIVE_MAX = 3800;

/** Double-quote + backslash-escape for security(1)'s interactive tokenizer. */
function quoteDouble(s: string): string {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** Wrap a value for the `-i` line. Single-quote when possible (blob has no `'`). */
function quoteValue(s: string): string {
  return s.includes("'") ? quoteDouble(s) : `'${s}'`;
}

/** Read an item's password blob. Returns null if the item does not exist. */
export async function readItem(t: KeychainTarget): Promise<string | null> {
  const p = Bun.spawn([SECURITY, "find-generic-password", "-s", t.service, "-a", t.account, "-w"], {
    stdout: "pipe",
    stderr: "ignore",
  });
  const out = await new Response(p.stdout).text();
  await p.exited;
  if (p.exitCode !== 0) return null; // 44 = not found
  return out.replace(/\n$/, ""); // security appends exactly one trailing newline
}

/** ps-safe write: the command line + secret arrive on stdin, never in argv.
 *  Bounded by security(1)'s ~4KB interactive line buffer. */
async function writeViaInteractive(t: KeychainTarget, secret: string): Promise<void> {
  const line =
    `add-generic-password -U -a ${quoteDouble(t.account)} -s ${quoteDouble(t.service)} ` +
    `-w ${quoteValue(secret)}\n`;
  const p = Bun.spawn([SECURITY, "-i"], {
    stdin: new TextEncoder().encode(line),
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
 *  ps-safe stdin path; falls back to argv only when the blob exceeds the ~4KB
 *  interactive line limit. Throws on failure. */
export async function writeItem(t: KeychainTarget, secret: string): Promise<void> {
  if (secret.length <= INTERACTIVE_MAX) return writeViaInteractive(t, secret);
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
