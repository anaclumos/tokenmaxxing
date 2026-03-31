import { defineCommand } from "citty";
import pc from "picocolors";
import { getServerUrl, saveApiToken } from "../config";

export const login = defineCommand({
  meta: { name: "login", description: "Authenticate with tokenmaxx.ing" },
  args: {
    token: { type: "string", description: "API token (skip browser)" },
  },
  async run({ args }) {
    if (args.token) {
      saveApiToken(args.token);
      console.log(pc.green("Token saved."));
      return;
    }

    const server = getServerUrl();
    console.log(`\nOpen this URL to generate an API token:\n`);
    console.log(pc.bold(`  ${server}/settings\n`));
    console.log(`Then run: ${pc.cyan("tokenmaxxing login --token tmx_...")}\n`);
  },
});
