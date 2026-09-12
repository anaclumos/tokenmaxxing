import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";
import { writeFileAtomic } from "../lib/atomic.ts";
import { c, emitError, emitJson } from "./render.ts";

export const CLOUD_INSTALL_LINE =
  'curl -fsSL https://bun.sh/install | bash && curl -fsSL https://claude.ai/install.sh | bash && "$HOME/.bun/bin/bun" add -g tokenmaxxing && test -x "$HOME/.bun/bin/bun" && test -x "$HOME/.local/bin/claude" && test -e "$HOME/.bun/bin/tokenmaxxing"';

export const CLOUD_RUN_COMMAND = 'TOKENMAXXING_CLAUDE_BIN="$HOME/.local/bin/claude" "$HOME/.bun/bin/bun" "$HOME/.bun/bin/tokenmaxxing" cloud run';

export const RELAY_AGENT = `---
name: claude
description: Runs a task in Claude Code on the owner's subscription accounts. Use proactively for substantial implementation, debugging, or research work that should not consume the parent's context.
model: inherit
readonly: false
---

You are a thin forwarding wrapper around Claude Code.

Your only job is to forward the task to the runner and return its output. Do not do anything else.

Rules:

- Use exactly one shell call. Pass the task on stdin through a quoted heredoc. Pick the delimiter fresh for every call as \`TASK_\` followed by eight random letters and digits, and check that no line of the task equals it; a quoted heredoc ends only on a line that matches the delimiter exactly, so the task text can never become shell commands.

\`\`\`sh
${CLOUD_RUN_COMMAND} <<'TASK_k3v9qx2m'
<task>
TASK_k3v9qx2m
\`\`\`

- When the task continues earlier Claude Code work, add \`--session <id>\` after \`cloud run\` with the session id from the previous output.
- Preserve the task text as given. Do not inspect the repository, read files, run other commands, or summarize.
- Return the command's stdout exactly as-is, including the trailing \`session <id>\` line.
- If the command fails, return its stderr as-is.
`;

const ENVIRONMENT_JSON = JSON.stringify({ install: CLOUD_INSTALL_LINE }, null, 2) + "\n";
const ExistingEnvironmentSchema = z.looseObject({ user: z.string().optional() });

const REPO_FILE_MODE = 0o644;
const USAGE = "usage: tokenmaxxing cursor init [dir]";

export function cmdCursorInit(args: string[], json = false): number {
  if (args.length > 1) {
    emitError({ json, message: USAGE });
    return 2;
  }
  const dir = resolve(args[0] ?? ".");
  if (!existsSync(dir)) {
    emitError({ json, message: `no such directory: ${dir}` });
    return 1;
  }
  const agentFile = join(dir, ".cursor", "agents", "claude.md");
  const environmentFile = join(dir, ".cursor", "environment.json");
  const existing = existsSync(environmentFile) ? ExistingEnvironmentSchema.parse(Bun.JSONC.parse(readFileSync(environmentFile, "utf8"))) : null;
  const agent = existsSync(agentFile) && readFileSync(agentFile, "utf8") === RELAY_AGENT ? "unchanged" : "written";
  if (agent === "written") writeFileAtomic(agentFile, RELAY_AGENT, REPO_FILE_MODE);
  const environment = existing == null ? "written" : "exists";
  const warnings: string[] = [];
  if (existing == null) {
    writeFileAtomic(environmentFile, ENVIRONMENT_JSON, REPO_FILE_MODE);
  } else if (existing.user === "root" || existing.user === "0") {
    warnings.push(".cursor/environment.json sets user to root; Claude Code refuses --dangerously-skip-permissions under root, so every relay call fails until user is a non-root account");
  }
  if (json) {
    emitJson({ ok: true, dir, agent, environment, install: CLOUD_INSTALL_LINE, warnings });
    return 0;
  }
  console.log(`${c.green("✓")} .cursor/agents/claude.md ${agent}`);
  if (environment === "written") {
    console.log(`${c.green("✓")} .cursor/environment.json written`);
  } else {
    console.log(c.yellow("⚠ .cursor/environment.json exists - left untouched; add this to its install command:"));
    console.log(`  ${CLOUD_INSTALL_LINE}`);
  }
  for (const warning of warnings) console.log(c.yellow(`⚠ ${warning}`));
  console.log(c.dim("next: commit both files, add the TOKENMAXXING_TOKENS user-scoped Runtime Secret at cursor.com/dashboard/cloud-agents, and start a cloud agent on the repo"));
  return 0;
}
