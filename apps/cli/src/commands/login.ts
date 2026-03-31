import { defineCommand } from "citty";
import pc from "picocolors";
import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";

const CONFIG_DIR = join(homedir(), ".config", "tokenmaxxing");
const CONFIG_FILE = join(CONFIG_DIR, "config.json");

export function getApiToken(): string | null {
  if (!existsSync(CONFIG_FILE)) return null;
  const config = JSON.parse(readFileSync(CONFIG_FILE, "utf-8"));
  return config.token ?? null;
}

export function getServerUrl(): string {
  if (existsSync(CONFIG_FILE)) {
    const config = JSON.parse(readFileSync(CONFIG_FILE, "utf-8"));
    if (config.server) return config.server;
  }
  return "https://tokenmaxx.ing";
}

export const login = defineCommand({
  meta: { name: "login", description: "Authenticate with tokenmaxx.ing" },
  args: {
    token: { type: "string", description: "API token (skip browser)" },
  },
  async run({ args }) {
    if (args.token) {
      mkdirSync(CONFIG_DIR, { recursive: true });
      writeFileSync(CONFIG_FILE, JSON.stringify({ token: args.token }, null, 2));
      console.log(pc.green("Token saved."));
      return;
    }

    const server = getServerUrl();
    console.log(`\nOpen this URL to generate an API token:\n`);
    console.log(pc.bold(`  ${server}/settings\n`));
    console.log(`Then run: ${pc.cyan("tokenmaxxing login --token tmx_...")}\n`);
  },
});
