import { mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { paths } from "./paths.ts";
import { pidExists } from "./proc.ts";

export type OnboardPool = "claude" | "codex" | "pi" | "grok" | "muse";

export async function onboardHome(pool: OnboardPool, onStale?: (dir: string) => Promise<unknown>): Promise<string> {
  mkdirSync(paths.onboardDir, { recursive: true, mode: 0o700 });
  for (const name of readdirSync(paths.onboardDir)) {
    const [owner, pidText] = name.split("-");
    const pid = Number(pidText);
    if (owner !== pool || (Number.isSafeInteger(pid) && pid > 0 && pidExists(pid))) continue;
    const dir = join(paths.onboardDir, name);
    await onStale?.(dir);
    rmSync(dir, { recursive: true, force: true });
  }
  return mkdtempSync(join(paths.onboardDir, `${pool}-${process.pid}-`));
}
