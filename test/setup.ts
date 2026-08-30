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
const mockPort = 20000 + ((process.pid * 2) % 30000);
export const MOCK_OAUTH_PORT = mockPort;
export const MOCK_CODEX_PORT = mockPort + 1;
process.env.TOKENMAXXING_OAUTH_TOKEN_URL = `http://127.0.0.1:${MOCK_OAUTH_PORT}/token`;
process.env.TOKENMAXXING_OAUTH_ROLES_URL = `http://127.0.0.1:${MOCK_OAUTH_PORT}/roles`;
process.env.TOKENMAXXING_KEYCHAIN_SERVICE = `tokenmaxxing-test-${process.pid}`;
process.env.TOKENMAXXING_KEYCHAIN_ACCOUNT = `tokenmaxxing-test-${process.pid}`;
process.env.TOKENMAXXING_SHELL_RC = join(base, "shellrc");
process.env.TOKENMAXXING_LAUNCHD_DIR = join(base, "LaunchAgents");
process.env.TOKENMAXXING_SYSTEMD_USER_DIR = join(base, "systemd-user");
mkdirSync(process.env.TOKENMAXXING_LAUNCHD_DIR, { recursive: true });
mkdirSync(process.env.TOKENMAXXING_SYSTEMD_USER_DIR, { recursive: true });
process.env.TOKENMAXXING_CODEX_HOME = join(base, "codexhome");
process.env.TOKENMAXXING_CODEX_TOKEN_URL = `http://127.0.0.1:${MOCK_CODEX_PORT}/codex-token`;
process.env.TOKENMAXXING_CODEX_USAGE_URL = `http://127.0.0.1:${MOCK_CODEX_PORT}/codex-usage`;
process.env.NO_COLOR = "1";

declare global {
  var __TM_TEST_BASE__: string | undefined;
}
globalThis.__TM_TEST_BASE__ = base;
