import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { resolveRealClaude } from "../lib/claudebin.ts";
import { paths } from "../lib/paths.ts";
import { loadAccounts } from "../lib/state.ts";
import { scrubCredentialEnv } from "../lib/usage.ts";
import { CURSOR_SECRET_VALUE_CAP_BYTES, cursorSecretValue, loadSetupTokens, saveSetupTokens } from "../lib/setuptokens.ts";
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

function rmToken(label: string | undefined, json: boolean): number {
  if (!label) {
    emitError({ json, message: USAGE });
    return 2;
  }
  const store = loadSetupTokens();
  const remaining = store.tokens.filter((t) => t.label !== label);
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
  if (sub === "rm") return rmToken(label, json);
  const print = sub === "--print";
  if (sub !== undefined && !print) {
    emitError({ json, message: USAGE });
    return 2;
  }
  if (json && !print) {
    emitError({ json, message: "setup-token mints through a browser login flow and has no --json form; `setup-token --print --json` prints the stored set" });
    return 2;
  }
  const store = loadSetupTokens();
  if (!print) {
    const idx = loadAccounts();
    if (idx.accounts.length === 0) {
      emitError({ json, message: "no accounts in the pool - run `tokenmaxxing init` first" });
      return 1;
    }
    const real = resolveRealClaude();
    const missing = idx.accounts.filter((a) => !store.tokens.some((t) => t.label === a.label));
    if (missing.length === 0) console.log(c.dim("every pooled account already has a stored setup token (`setup-token rm <label>` drops one so it can be re-minted)"));
    for (const a of missing) {
      console.log();
      console.log(`${c.bold(a.label)} - sign into this account in the browser (${a.email})`);
      const token = await mint({ real, item: a.keychainItem });
      if (!token) return 1;
      store.tokens.push({ label: a.label, token, mintedAt: Date.now() });
      saveSetupTokens(store);
      console.log(`${c.green("✓")} stored the setup token for ${c.bold(a.label)} ${c.dim("(ownership not verified: an inference-only token cannot read the profile endpoint, so the label is the sign-in you chose)")}`);
    }
  }
  if (store.tokens.length === 0) {
    emitError({ json, message: "no setup tokens stored - run `tokenmaxxing setup-token` to mint them" });
    return 1;
  }
  const secret = cursorSecretValue(store.tokens);
  const bytes = Buffer.byteLength(secret);
  if (json) {
    emitJson({ ok: true, tokens: store.tokens.map(({ label: l, token }) => ({ label: l, token })), bytes, cap: CURSOR_SECRET_VALUE_CAP_BYTES });
    return 0;
  }
  console.log();
  console.log(`${c.bold("TOKENMAXXING_TOKENS")} ${c.dim("(user-scoped Runtime Secret at cursor.com/dashboard/cloud-agents)")}`);
  console.log(secret);
  if (bytes > CURSOR_SECRET_VALUE_CAP_BYTES) {
    console.log(c.yellow(`⚠ ${bytes} bytes: over the ${CURSOR_SECRET_VALUE_CAP_BYTES}-byte value cap Cursor documents for API-created environment variables`));
  }
  return 0;
}
