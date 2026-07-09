// Install/uninstall the on-PATH `claude` supervisor wrapper + settings entries.
// The wrapper is a 2-line `exec … __supervise "$@"` shim so dispatch never
// depends on argv0 semantics.

import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { z } from "zod";
import { HOME, paths } from "./paths.ts";
import { writeFileAtomic } from "./atomic.ts";
import { installedBin, installSettings, uninstallSettings } from "./settings.ts";
import { resolveRealClaude } from "./claudebin.ts";

const InstallOutcomeSchema = z.object({
  claudeWrapper: z.string(),
  installedBin: z.string(),
  priorStatusLine: z.string().nullable(),
  pathAhead: z.boolean(),
});
export type InstallOutcome = z.infer<typeof InstallOutcomeSchema>;

/** True if our binDir comes before the real claude's dir on PATH. */
export function isBinDirAhead(): boolean {
  const dirs = (process.env.PATH ?? "").split(":");
  const ourIdx = dirs.indexOf(paths.binDir);
  if (ourIdx < 0) return false;
  try {
    const realDir = dirname(resolveRealClaude());
    const realIdx = dirs.indexOf(realDir);
    return realIdx < 0 || ourIdx < realIdx;
  } catch {
    return ourIdx >= 0;
  }
}

export function installSupervisor(): InstallOutcome {
  mkdirSync(paths.binDir, { recursive: true });
  const target = installedBin(); // binDir/tokenmaxxing
  // Resolve the entry through the global-bin symlink (bun add -g links
  // ~/.bun/bin/tokenmaxxing → the package's src/main.ts) so the shim points
  // into the installed package tree, where its imports resolve.
  const entry = realpathSync(Bun.main);
  writeFileAtomic(target, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} run ${JSON.stringify(entry)} "$@"\n`, 0o755);

  // the on-PATH `claude` wrapper
  writeFileAtomic(paths.supervisorLink, `#!/bin/sh\nexec ${JSON.stringify(target)} __supervise "$@"\n`, 0o755);
  // the `xx` short alias → tokenmaxxing
  writeFileAtomic(join(paths.binDir, "xx"), `#!/bin/sh\nexec ${JSON.stringify(target)} "$@"\n`, 0o755);

  const { priorStatusLine } = installSettings();
  return {
    claudeWrapper: paths.supervisorLink,
    installedBin: target,
    priorStatusLine,
    pathAhead: isBinDirAhead(),
  };
}

/** The rc file of the user's login shell, or null when the shell is unknown.
 *  Overridable for hermetic tests. */
export function shellRcPath(): string | null {
  const override = process.env.TOKENMAXXING_SHELL_RC;
  if (override && override.length > 0) return override;
  const shell = basename(process.env.SHELL ?? "");
  if (shell === "zsh") return join(process.env.ZDOTDIR || HOME, ".zshrc");
  if (shell === "bash") return join(HOME, ".bashrc");
  return null;
}

const PATH_LINE_MARK = "# tokenmaxxing PATH";

/** Idempotently append the supervisor-bin PATH line to `rc` (created if absent).
 *  A pre-existing hand-added line for the bin dir also counts as present. */
export function ensurePathInRc(rc: string): "added" | "present" {
  const dir = paths.binDir.startsWith(`${HOME}/`) ? `$HOME${paths.binDir.slice(HOME.length)}` : paths.binDir;
  const current = existsSync(rc) ? readFileSync(rc, "utf8") : "";
  if (current.includes(PATH_LINE_MARK) || current.includes(`${paths.binDir}:`) || current.includes(`${dir}:`)) return "present";
  const sep = current === "" || current.endsWith("\n") ? "" : "\n";
  appendFileSync(rc, `${sep}export PATH="${dir}:$PATH" ${PATH_LINE_MARK}\n`);
  return "added";
}

export function uninstallSupervisor(): void {
  uninstallSettings();
  for (const f of [paths.supervisorLink, join(paths.binDir, "xx"), installedBin()]) {
    if (existsSync(f)) rmSync(f, { force: true });
  }
}
