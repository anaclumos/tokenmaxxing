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
process.env.TOKENMAXXING_SHELL_RC = join(base, "shellrc");
process.env.NO_COLOR = "1";

// exposed for tests that want the sandbox root
(globalThis as any).__TM_TEST_BASE__ = base;
