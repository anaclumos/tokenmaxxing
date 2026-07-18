// The serve plugin (src/serve-plugin/): layout invariants the SDK's local
// plugin loader relies on, and the per-turn relay context that carries the
// requester's mention token. The plugin ships inside the npm package via
// `files: ["src"]`, so a broken layout would only surface live in Slack.

import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { serveTurnContext } from "../src/lib/slackbridge.ts";

const pluginDir = join(import.meta.dir, "..", "src", "serve-plugin");

/** Parse SKILL.md frontmatter structurally: `---` fence, `key: value` lines. */
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

describe("serve plugin layout", () => {
  test("manifest names the plugin tokenmaxxing", () => {
    const manifest = JSON.parse(readFileSync(join(pluginDir, ".claude-plugin", "plugin.json"), "utf8"));
    expect(manifest.name).toBe("tokenmaxxing");
  });

  test("every skill dir has a SKILL.md whose name matches the dir", () => {
    const skillDirs = readdirSync(join(pluginDir, "skills"));
    expect(skillDirs.sort()).toEqual(["ask-the-user", "serve-session"]);
    for (const dir of skillDirs) {
      const fields = frontmatter(readFileSync(join(pluginDir, "skills", dir, "SKILL.md"), "utf8"));
      expect(fields.get("name")).toBe(dir);
      expect(fields.get("description")?.length ?? 0).toBeGreaterThan(20);
    }
  });

  test("skill files carry no em-dash or interpunct", () => {
    // built from code points so this file itself stays free of the banned bytes.
    const emDash = String.fromCodePoint(0x2014);
    const interpunct = String.fromCodePoint(0xb7);
    for (const dir of readdirSync(join(pluginDir, "skills"))) {
      const content = readFileSync(join(pluginDir, "skills", dir, "SKILL.md"), "utf8");
      expect(content.includes(emDash)).toBe(false);
      expect(content.includes(interpunct)).toBe(false);
    }
  });
});

describe("serveTurnContext", () => {
  test("carries the requester's raw mention token", () => {
    const ctx = serveTurnContext({ requesterIds: ["U0123ABC"] });
    expect(ctx).toContain("<@U0123ABC>");
    expect(ctx).toContain("Slack relay context");
    // every skill the context points at must exist in the plugin.
    for (const part of ctx.split(" ")) {
      if (!part.startsWith("tokenmaxxing:")) continue;
      const [name] = part.slice("tokenmaxxing:".length).split(".");
      if (!name) continue;
      expect(readdirSync(join(pluginDir, "skills"))).toContain(name);
    }
  });

  test("lists every folded sender's token so a decision reaches the right user", () => {
    const ctx = serveTurnContext({ requesterIds: ["U0123ABC", "UALICE99"] });
    expect(ctx).toContain("<@U0123ABC>");
    expect(ctx).toContain("<@UALICE99>");
  });

  test("an unknown requester yields no mention token, not a fake one", () => {
    const ctx = serveTurnContext({ requesterIds: [] });
    expect(ctx.includes("<@")).toBe(false);
    expect(ctx).toContain("unknown");
  });
});
