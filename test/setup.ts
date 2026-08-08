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
// Instance-unique mock ports: two concurrent `bun test` runs (parallel
// worktrees are this repo's standard flow) once collided on fixed 8791/8792
// (closing-review catch). Test files must read these ports from the env URLs,
// never hardcode them.
// stride 2 so adjacent pids cannot collide: with +1 alone, run A's codex
// port equaled run B's oauth port whenever pidB = pidA + 1 (closing-review
// catch reopening the very collision this scheme fixes).
const mockPort = 20000 + ((process.pid * 2) % 30000);
export const MOCK_OAUTH_PORT = mockPort;
export const MOCK_CODEX_PORT = mockPort + 1;
process.env.TOKENMAXXING_OAUTH_TOKEN_URL = `http://127.0.0.1:${MOCK_OAUTH_PORT}/token`;
process.env.TOKENMAXXING_OAUTH_ROLES_URL = `http://127.0.0.1:${MOCK_OAUTH_PORT}/roles`;
// Sandbox the darwin keychain identifiers too: performSwap resolves the LIVE
// credential's owner first, and without this the suite would read the user's
// real `Claude Code-credentials` item (and hit the real roles endpoint).
// BOTH halves carry the pid: keychain items are machine-global, and a fixed
// account string let one run's cleanup delete another's just-seeded items
// (the parked services are fixed names like "tokenmaxxing-cred-A").
process.env.TOKENMAXXING_KEYCHAIN_SERVICE = `tokenmaxxing-test-${process.pid}`;
process.env.TOKENMAXXING_KEYCHAIN_ACCOUNT = `tokenmaxxing-test-${process.pid}`;
process.env.TOKENMAXXING_SHELL_RC = join(base, "shellrc");
// Keep installSupervisor's timer units out of the real user service manager
// (a test that forgets TOKENMAXXING_SKIP_TIMER must not bootstrap launchd /
// systemd against the live Mac/Linux session).
process.env.TOKENMAXXING_LAUNCHD_DIR = join(base, "LaunchAgents");
process.env.TOKENMAXXING_SYSTEMD_USER_DIR = join(base, "systemd-user");
mkdirSync(process.env.TOKENMAXXING_LAUNCHD_DIR, { recursive: true });
mkdirSync(process.env.TOKENMAXXING_SYSTEMD_USER_DIR, { recursive: true });
process.env.TOKENMAXXING_CODEX_HOME = join(base, "codexhome");
process.env.TOKENMAXXING_CODEX_TOKEN_URL = `http://127.0.0.1:${MOCK_CODEX_PORT}/codex-token`;
process.env.TOKENMAXXING_CODEX_USAGE_URL = `http://127.0.0.1:${MOCK_CODEX_PORT}/codex-usage`;
process.env.NO_COLOR = "1";

// exposed for tests that want the sandbox root
declare global {
  var __TM_TEST_BASE__: string | undefined;
}
globalThis.__TM_TEST_BASE__ = base;
