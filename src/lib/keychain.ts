export type KeychainTarget = { service: string; account: string };

const SECURITY = "/usr/bin/security";
const INTERACTIVE_MAX_LINE = 4000;

function quoteDouble(s: string): string {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function quoteValue(s: string): string {
  return s.includes("'") ? quoteDouble(s) : `'${s}'`;
}

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
  return out.replace(/\n$/, "");
}

function interactiveLine(t: KeychainTarget, secret: string): string {
  return (
    `add-generic-password -U -a ${quoteDouble(t.account)} -s ${quoteDouble(t.service)} ` +
    `-w ${quoteValue(secret)}\n`
  );
}

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

async function writeViaArgv(t: KeychainTarget, secret: string): Promise<void> {
  const p = Bun.spawn([SECURITY, "add-generic-password", "-U", "-a", t.account, "-s", t.service, "-w", secret], {
    stdout: "ignore",
    stderr: "pipe",
  });
  const err = await new Response(p.stderr).text();
  await p.exited;
  if (p.exitCode !== 0) throw new Error(`keychain write (argv) failed (exit ${p.exitCode}): ${err.trim()}`);
}

export async function writeItem(t: KeychainTarget, secret: string): Promise<void> {
  const encoded = new TextEncoder().encode(interactiveLine(t, secret));
  if (encoded.length <= INTERACTIVE_MAX_LINE) return writeViaInteractive(encoded);
  return writeViaArgv(t, secret);
}

export async function deleteItem(t: KeychainTarget): Promise<boolean> {
  const p = Bun.spawn([SECURITY, "delete-generic-password", "-s", t.service, "-a", t.account], {
    stdout: "ignore",
    stderr: "ignore",
  });
  await p.exited;
  return p.exitCode === 0;
}
