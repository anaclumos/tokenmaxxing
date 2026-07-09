// Install/uninstall the on-PATH `claude` supervisor wrapper + settings entries.
// The wrapper is a 2-line `exec … __supervise "$@"` shim so dispatch never
// depends on argv0 semantics.

import { appendFileSync, chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { z } from "zod";
import { HOME, paths } from "./paths.ts";
import { writeFileAtomic } from "./atomic.ts";
import { installedBin, installSettings, uninstallSettings } from "./settings.ts";
import { resolveRealClaude } from "./claudebin.ts";

/** The compiled single-file exe to install, or null when running via `bun run`. */
export function selfBinary(): string | null {
  const exe = process.execPath;
  if (exe && !/(?:^|\/)bun(?:-\w+)?$/.test(exe)) return exe; // not `bun run` dev mode
  return null;
}

const InstallOutcomeSchema = z.object({
  claudeWrapper: z.string(),
  installedBin: z.string(),
  priorStatusLine: z.string().nullable(),
  devMode: z.boolean(),
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
  const self = selfBinary();
  const devMode = !self;

  if (self) {
    // Skip the copy when we ARE the installed binary (re-running `init` from the
    // installed path) - copying a file onto itself truncates it to nothing.
    const sameFile = existsSync(target) && realpathSync(self) === realpathSync(target);
    if (!sameFile) {
      copyFileSync(self, target);
      chmodSync(target, 0o755);
      // macOS AMFI SIGKILLs a copied ad-hoc-signed Mach-O (the copy picks up a
      // com.apple.provenance xattr and the signature no longer validates). Clear
      // the xattr and ad-hoc re-sign the copy so it runs. Fail loud if signing
      // fails, otherwise we would install a binary macOS immediately kills.
      if (process.platform === "darwin") {
        Bun.spawnSync(["xattr", "-c", target], { stdout: "ignore", stderr: "ignore" });
        const signed = Bun.spawnSync(["codesign", "--force", "--sign", "-", target], { stdout: "ignore", stderr: "pipe" });
        if (signed.exitCode !== 0) {
          throw new Error(`codesign failed for ${target}: ${signed.stderr?.toString().trim()} (macOS would kill the unsigned copy)`);
        }
      }
    }
  } else {
    // dev: run the repo entry through bun
    const repoMain = `${process.cwd()}/src/main.ts`;
    writeFileAtomic(target, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} run ${JSON.stringify(repoMain)} "$@"\n`, 0o755);
  }

  // the on-PATH `claude` wrapper
  writeFileAtomic(paths.supervisorLink, `#!/bin/sh\nexec ${JSON.stringify(target)} __supervise "$@"\n`, 0o755);
  // the `xx` short alias → tokenmaxxing
  writeFileAtomic(join(paths.binDir, "xx"), `#!/bin/sh\nexec ${JSON.stringify(target)} "$@"\n`, 0o755);

  const { priorStatusLine } = installSettings();
  return {
    claudeWrapper: paths.supervisorLink,
    installedBin: target,
    priorStatusLine,
    devMode,
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
