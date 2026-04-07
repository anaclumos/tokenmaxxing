import { defineCommand } from "citty";
import pc from "picocolors";
import { CliStatusResponse } from "@tokenmaxxing/shared/types";
import { getServerUrl, saveApiToken } from "../config";

export const login = defineCommand({
  meta: { name: "login", description: "Authenticate with tokenmaxx.ing" },
  args: {
    token: { type: "string", description: "API token (skip browser)" },
  },
  async run({ args }) {
    if (args.token) {
      const server = getServerUrl();
      const response = await fetch(`${server}/api/me`, {
        headers: { Authorization: `Bearer ${args.token}` },
      });

      if (!response.ok) {
        console.log(pc.red("Token validation failed."));
        return;
      }

      const status = CliStatusResponse.parse(await response.json());
      saveApiToken(args.token);
      console.log(pc.green(`Token saved for ${status.user.username}.`));
      return;
    }

    const server = getServerUrl();
    console.log(`\nOpen this URL to generate an API token:\n`);
    console.log(pc.bold(`  ${server}/app/settings\n`));
    console.log(`Then run: ${pc.cyan("tokenmaxxing login --token tmx_...")}\n`);
  },
});
