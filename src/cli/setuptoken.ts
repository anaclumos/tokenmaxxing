import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { resolveRealClaude } from "../lib/claudebin.ts";
import { withLock } from "../lib/lock.ts";
import { paths } from "../lib/paths.ts";
import { loadAccounts } from "../lib/state.ts";
import { scrubCredentialEnv } from "../lib/usage.ts";
import { CURSOR_SECRET_VALUE_CAP_BYTES, cursorSecretValue, loadSetupTokens, saveSetupTokens, type SetupToken } from "../lib/setuptokens.ts";
import type { Account } from "../lib/types.ts";
import { c, emitError, emitJson } from "./render.ts";

const TOKEN_BEGIN_MARKER = "Your OAuth token (valid for";
const TOKEN_END_MARKER = "Store this token securely";
const USAGE = "usage: tokenmaxxing setup-token [--print] | tokenmaxxing setup-token rm <label>";

export function extractSetupToken(output: string): string | null {
  const lines = Bun.stripANSI(output).split("\n").map((line) => line.trim());
  const end = lines.findLastIndex((line) => line.includes(TOKEN_END_MARKER));
  if (end < 0) return null;
  const begin = lines.slice(0, end).findLastIndex((line) => line.includes(TOKEN_BEGIN_MARKER));
  if (begin < 0) return null;
  const token = lines.slice(begin + 1, end).join("");
  return token === "" ? null : token;
}

async function mint(input: { real: string; item: string }): Promise<string | null> {
  const configDir = join(paths.setupTokenDir, input.item);
  rmSync(configDir, { recursive: true, force: true });
  mkdirSync(configDir, { recursive: true });
  const env = scrubCredentialEnv({ ...process.env, CLAUDE_CONFIG_DIR: configDir });
  const child = Bun.spawn([input.real, "setup-token"], { env, stdin: "inherit", stdout: "pipe", stderr: "inherit" });
  const decoder = new TextDecoder();
  let captured = "";
  for await (const chunk of child.stdout) {
    process.stdout.write(chunk);
    captured += decoder.decode(chunk, { stream: true });
  }
  await child.exited;
  rmSync(configDir, { recursive: true, force: true });
  if (child.exitCode !== 0) {
    console.error(c.red(`claude setup-token exited ${child.exitCode ?? "on signal"} - nothing stored`));
    return null;
  }
  const captureToken = extractSetupToken(captured);
  if (captureToken) return captureToken;
  const pasted = prompt("the token line was not captured from the output above - paste the token here:")?.trim() ?? "";
  if (pasted === "") {
    console.error(c.red("no token pasted - nothing stored"));
    return null;
  }
  return pasted;
}

function currentTokens(tokens: SetupToken[], accounts: Account[]): { label: string; token: string }[] {
  return accounts.flatMap((a) => {
    const stored = tokens.find((t) => t.accountUuid === a.accountUuid);
    return stored ? [{ label: a.label, token: stored.token }] : [];
  });
}

function rmToken(label: string, json: boolean): number {
  const store = loadSetupTokens();
  const accounts = loadAccounts().accounts;
  const pooled = accounts.find((a) => a.label === label);
  const remaining = store.tokens.filter((t) =>
    pooled ? t.accountUuid !== pooled.accountUuid : t.label !== label || accounts.some((a) => a.accountUuid === t.accountUuid),
  );
  if (remaining.length === store.tokens.length) {
    emitError({ json, message: `no setup token stored for "${label}"` });
    return 1;
  }
  saveSetupTokens({ ...store, tokens: remaining });
  if (json) {
    emitJson({ ok: true, removed: label, remaining: remaining.map((t) => t.label) });
    return 0;
  }
  console.log(`removed the setup token for ${label} (local only: Claude Code documents no revocation for setup tokens)`);
  return 0;
}

export async function cmdSetupToken(args: string[], json = false): Promise<number> {
  const [sub, label] = args;
  if (sub === "rm" && label !== undefined && args.length === 2) return rmToken(label, json);
  const print = sub === "--print" && args.length === 1;
  if (args.length > 0 && !print) {
    emitError({ json, message: USAGE });
    return 2;
  }
  if (json && !print) {
    emitError({ json, message: "setup-token mints through a browser login flow and has no --json form; `setup-token --print --json` prints the stored set" });
    return 2;
  }
  let store = loadSetupTokens();
  let idx = loadAccounts();
  if (!print) {
    if (idx.accounts.length === 0) {
      emitError({ json, message: "no accounts in the pool - run `tokenmaxxing init` first" });
      return 1;
    }
    const real = resolveRealClaude();
    const missing = idx.accounts.filter((a) => !store.tokens.some((t) => t.accountUuid === a.accountUuid));
    if (missing.length === 0) console.log(c.dim("every pooled account already has a stored setup token (`setup-token rm <label>` drops one so it can be re-minted)"));
    for (const a of missing) {
      console.log();
      console.log(`${c.bold(a.label)} - sign into this account in the browser (${a.email})`);
      const token = await mint({ real, item: a.keychainItem });
      if (!token) return 1;
      const stored = await withLock(paths.lockFile, async () => {
        if (!loadAccounts().accounts.some((x) => x.accountUuid === a.accountUuid)) return false;
        const fresh = loadSetupTokens();
        const tokens = fresh.tokens.filter((t) => t.accountUuid !== a.accountUuid);
        saveSetupTokens({ ...fresh, tokens: [...tokens, { accountUuid: a.accountUuid, label: a.label, token, mintedAt: Date.now() }] });
        return true;
      });
      if (!stored) {
        console.log(c.yellow(`${a.label} left the pool during the login - token discarded`));
        continue;
      }
      console.log(`${c.green("✓")} stored the setup token for ${c.bold(a.label)} ${c.dim("(ownership not verified: an inference-only token cannot read the profile endpoint, so the label is the sign-in you chose)")}`);
    }
    store = loadSetupTokens();
    idx = loadAccounts();
  }
  if (store.tokens.length === 0) {
    emitError({ json, message: "no setup tokens stored - run `tokenmaxxing setup-token` to mint them" });
    return 1;
  }
  const tokens = currentTokens(store.tokens, idx.accounts);
  const orphaned = store.tokens.filter((t) => !idx.accounts.some((a) => a.accountUuid === t.accountUuid)).map((t) => t.label);
  if (tokens.length === 0) {
    emitError({ json, message: "no stored setup token belongs to a pooled account - run `tokenmaxxing setup-token` to mint them" });
    return 1;
  }
  const secret = cursorSecretValue(tokens);
  const bytes = Buffer.byteLength(secret);
  if (json) {
    emitJson({ ok: true, tokens, orphaned, bytes, cap: CURSOR_SECRET_VALUE_CAP_BYTES });
    return 0;
  }
  console.log();
  if (orphaned.length > 0) console.log(c.dim(`left out of the secret (no longer in the pool): ${orphaned.join(", ")}; \`setup-token rm <label>\` drops one`));
  console.log(`${c.bold("TOKENMAXXING_TOKENS")} ${c.dim("(user-scoped Runtime Secret at cursor.com/dashboard/cloud-agents)")}`);
  console.log(secret);
  if (bytes > CURSOR_SECRET_VALUE_CAP_BYTES) {
    console.log(c.yellow(`⚠ ${bytes} bytes: over the ${CURSOR_SECRET_VALUE_CAP_BYTES}-byte value cap Cursor documents for API-created environment variables`));
  }
  return 0;
}
