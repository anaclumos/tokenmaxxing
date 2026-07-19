// Runs before any test module loads, so paths.ts / oauth.ts capture hermetic env
// and never touch the real ~/.config, ~/.claude, keychain, or platform.claude.com.

import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const base = join(tmpdir(), `tm-test-${process.pid}`);
rmSync(base, { recursive: true, force: true });
mkdirSync(join(base, "home"), { recursive: true });
mkdirSync(join(base, "claudedir"), { recursive: true });

process.env.TOKENMAXXING_HOME = join(base, "home");
process.env.CLAUDE_CONFIG_DIR = join(base, "claudedir");
process.env.TOKENMAXXING_CLAUDE_JSON = join(base, "claude.json");
process.env.TOKENMAXXING_CLAUDE_SETTINGS = join(base, "settings.json");
process.env.TOKENMAXXING_OAUTH_TOKEN_URL = "http://127.0.0.1:8791/token";
process.env.TOKENMAXXING_OAUTH_ROLES_URL = "http://127.0.0.1:8791/roles";
// Sandbox the darwin keychain identifiers too: performSwap resolves the LIVE
// credential's owner first, and without this the suite would read the user's
// real `Claude Code-credentials` item (and hit the real roles endpoint).
process.env.TOKENMAXXING_KEYCHAIN_SERVICE = `tokenmaxxing-test-${process.pid}`;
process.env.TOKENMAXXING_KEYCHAIN_ACCOUNT = "tokenmaxxing-test";
process.env.TOKENMAXXING_SHELL_RC = join(base, "shellrc");
process.env.TOKENMAXXING_CODEX_HOME = join(base, "codexhome");
process.env.TOKENMAXXING_CODEX_TOKEN_URL = "http://127.0.0.1:8792/codex-token";
process.env.TOKENMAXXING_CODEX_USAGE_URL = "http://127.0.0.1:8792/codex-usage";
process.env.NO_COLOR = "1";

// exposed for tests that want the sandbox root
declare global {
  var __TM_TEST_BASE__: string | undefined;
}
globalThis.__TM_TEST_BASE__ = base;
