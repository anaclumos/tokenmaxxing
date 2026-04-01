import { defineCommand } from "citty";
import pc from "picocolors";
import { CliStatusResponse, formatTokens } from "@tokenmaxxing/shared/types";
import { getApiToken, getServerUrl } from "../config";

export const status = defineCommand({
  meta: { name: "status", description: "Show your rank and stats" },
  async run() {
    const token = getApiToken();
    if (!token) {
      console.log(pc.yellow("Not logged in. Run: tokenmaxxing login"));
      return;
    }

    const server = getServerUrl();
    const res = await fetch(`${server}/api/me`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!res.ok) {
      console.log(pc.red(`Failed to fetch status: ${res.statusText}`));
      return;
    }

    const data = CliStatusResponse.parse(await res.json());

    const u = data.user;
    console.log(`\n  ${pc.bold(u.username)}`);
    console.log(`  Global Rank: ${data.ranks.global ? pc.bold(`#${data.ranks.global.rank}`) : pc.dim("--")}`);
    console.log(`  Tokens:      ${pc.bold(formatTokens(u.totalTokens))}`);
    console.log(`  Cost:        ${pc.bold("$" + u.totalCost.toFixed(2))}`);
    console.log(`  Streak:      ${pc.bold(u.streak + "d")} ${u.longestStreak > u.streak ? pc.dim(`(best: ${u.longestStreak}d)`) : ""}`);
    console.log();
  },
});
