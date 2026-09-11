import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { writeFileAtomic } from "../lib/atomic.ts";
import { c, emitError, emitJson } from "./render.ts";

export const CLOUD_INSTALL_LINE =
  'curl -fsSL https://bun.sh/install | bash && curl -fsSL https://claude.ai/install.sh | bash && "$HOME/.bun/bin/bun" add -g tokenmaxxing';

export const CLOUD_RUN_COMMAND = 'TOKENMAXXING_CLAUDE_BIN="$HOME/.local/bin/claude" "$HOME/.bun/bin/tokenmaxxing" cloud run';

export const RELAY_AGENT = `---
name: claude
description: Runs a task in Claude Code on the owner's subscription accounts. Use proactively for substantial implementation, debugging, or research work that should not consume the parent's context.
model: inherit
readonly: false
---

You are a thin forwarding wrapper around Claude Code.

Your only job is to forward the task to the runner and return its output. Do not do anything else.

Rules:

- Use exactly one shell call. Pass the task on stdin through a quoted heredoc so its quoting survives:

\`\`\`sh
${CLOUD_RUN_COMMAND} <<'TASK'
<task>
TASK
\`\`\`

- When the task continues earlier Claude Code work, add \`--session <id>\` after \`cloud run\` with the session id from the previous output.
- Preserve the task text as given. Do not inspect the repository, read files, run other commands, or summarize.
- Return the command's stdout exactly as-is, including the trailing \`session <id>\` line.
- If the command fails, return its stderr as-is.
`;

const ENVIRONMENT_JSON = JSON.stringify({ install: CLOUD_INSTALL_LINE }, null, 2) + "\n";

const REPO_FILE_MODE = 0o644;

export function cmdCursorInit(args: string[], json = false): number {
  const dir = resolve(args[0] ?? ".");
  if (!existsSync(dir)) {
    emitError({ json, message: `no such directory: ${dir}` });
    return 1;
  }
  const agentFile = join(dir, ".cursor", "agents", "claude.md");
  const environmentFile = join(dir, ".cursor", "environment.json");
  const agent = existsSync(agentFile) && readFileSync(agentFile, "utf8") === RELAY_AGENT ? "unchanged" : "written";
  if (agent === "written") writeFileAtomic(agentFile, RELAY_AGENT, REPO_FILE_MODE);
  const environment = existsSync(environmentFile) ? "exists" : "written";
  if (environment === "written") writeFileAtomic(environmentFile, ENVIRONMENT_JSON, REPO_FILE_MODE);
  if (json) {
    emitJson({ ok: true, dir, agent, environment, install: CLOUD_INSTALL_LINE });
    return 0;
  }
  console.log(`${c.green("✓")} .cursor/agents/claude.md ${agent}`);
  if (environment === "written") {
    console.log(`${c.green("✓")} .cursor/environment.json written`);
  } else {
    console.log(c.yellow("⚠ .cursor/environment.json exists - left untouched; add this to its install command:"));
    console.log(`  ${CLOUD_INSTALL_LINE}`);
  }
  console.log(c.dim("next: commit both files, add the TOKENMAXXING_TOKENS user-scoped Runtime Secret at cursor.com/dashboard/cloud-agents, and start a cloud agent on the repo"));
  return 0;
}
