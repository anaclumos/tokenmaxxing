import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const pluginDir = join(import.meta.dir, "..", "agent-plugin");

const SKILL_DIRS = [
  "codex-pool",
  "credentials-hygiene",
  "doctor-diagnostics",
  "pool-status",
  "safe-contribution",
  "sdk-pairing",
  "switching-policy",
] as const;

function frontmatter(content: string): Map<string, string> {
  const lines = content.split("\n");
  expect(lines[0]).toBe("---");
  const close = lines.indexOf("---", 1);
  expect(close).toBeGreaterThan(0);
  const fields = new Map<string, string>();
  for (const line of lines.slice(1, close)) {
    const sep = line.indexOf(": ");
    if (sep > 0) fields.set(line.slice(0, sep), line.slice(sep + 2));
  }
  return fields;
}

describe("agent-plugin layout", () => {
  test("plugin.json targets Agent Plugins 1.0 and names tokenmaxxing", () => {
    const manifest = JSON.parse(readFileSync(join(pluginDir, "plugin.json"), "utf8"));
    expect(manifest.$schema).toBe("https://agent-plugins.org/schemas/1.0.0/plugin.schema.json");
    expect(manifest.name).toBe("tokenmaxxing");
    const pkg = JSON.parse(readFileSync(join(pluginDir, "..", "package.json"), "utf8"));
    expect(manifest.version).toBe(pkg.version);
  });

  test("mcp.json declares a stdio tokenmaxxing server with plugin-relative bin", () => {
    const mcp = JSON.parse(readFileSync(join(pluginDir, "mcp.json"), "utf8"));
    expect(mcp.$schema).toBe("https://agent-plugins.org/schemas/1.0.0/mcp.schema.json");
    expect(mcp.mcpServers.tokenmaxxing.type).toBe("stdio");
    expect(mcp.mcpServers.tokenmaxxing.command).toBe("./bin/tokenmaxxing-mcp");
    expect(mcp.mcpServers.tokenmaxxing.cwd).toBe("${PLUGIN_ROOT}");
    const bin = join(pluginDir, "bin", "tokenmaxxing-mcp");
    expect(statSync(bin).isFile()).toBe(true);
    expect((statSync(bin).mode & 0o111) !== 0).toBe(true);
  });

  test("every skill dir has a SKILL.md whose name matches the dir", () => {
    const skillDirs = readdirSync(join(pluginDir, "skills")).sort();
    expect(skillDirs).toEqual([...SKILL_DIRS].sort());
    for (const dir of skillDirs) {
      const fields = frontmatter(readFileSync(join(pluginDir, "skills", dir, "SKILL.md"), "utf8"));
      expect(fields.get("name")).toBe(dir);
      expect(fields.get("description")?.length ?? 0).toBeGreaterThan(20);
    }
  });

  test("skill files carry no em-dash or interpunct", () => {
    const emDash = String.fromCodePoint(0x2014);
    const interpunct = String.fromCodePoint(0xb7);
    for (const dir of readdirSync(join(pluginDir, "skills"))) {
      const root = join(pluginDir, "skills", dir);
      const walk = (path: string) => {
        for (const entry of readdirSync(path)) {
          const full = join(path, entry);
          if (statSync(full).isDirectory()) {
            walk(full);
            continue;
          }
          if (!full.endsWith(".md")) continue;
          const content = readFileSync(full, "utf8");
          expect(content.includes(emDash)).toBe(false);
          expect(content.includes(interpunct)).toBe(false);
        }
      };
      walk(root);
    }
  });
});
