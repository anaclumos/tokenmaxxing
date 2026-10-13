import { mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { paths } from "./paths.ts";
import { pidExists } from "./proc.ts";

const POOLS = ["claude", "codex", "pi", "grok", "muse"] as const;

export type OnboardPool = (typeof POOLS)[number];

const HOME_NAME = new RegExp(`^(${POOLS.join("|")})-([1-9]\\d*)-`);

export async function onboardHome(pool: OnboardPool, onStale?: (dir: string) => Promise<unknown>): Promise<string> {
  mkdirSync(paths.onboardDir, { recursive: true, mode: 0o700 });
  for (const name of readdirSync(paths.onboardDir)) {
    const match = HOME_NAME.exec(name);
    if (match && (match[1] !== pool || pidExists(Number(match[2])))) continue;
    const dir = join(paths.onboardDir, name);
    if (match) await onStale?.(dir);
    rmSync(dir, { recursive: true, force: true });
  }
  return mkdtempSync(join(paths.onboardDir, `${pool}-${process.pid}-`));
}
