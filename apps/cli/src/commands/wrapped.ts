import { resolve } from "node:path";

import { CliStatusResponse } from "@tokenmaxxing/shared/types";
import { defineCommand } from "citty";
import pc from "picocolors";

import { getApiToken, getServerUrl } from "../config";

function parseWrappedYear({ value }: { value?: string }) {
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : new Date().getFullYear();
}

function getWrappedOutputPath({
  output,
  username,
  year,
}: {
  output?: string;
  username: string;
  year: number;
}) {
  return resolve(output ?? `${username}-wrapped-${year}.svg`);
}

export const wrapped = defineCommand({
  meta: {
    name: "wrapped",
    description: "Download your year-in-review SVG locally",
  },
  args: {
    year: { type: "string", description: "Wrapped year (default: current year)" },
    output: { type: "string", description: "Output SVG path" },
  },
  async run({ args }) {
    const token = getApiToken();
    if (!token) {
      console.log(pc.yellow("Not logged in. Run: tokenmaxxing login"));
      return;
    }

    const year = parseWrappedYear({ value: args.year });
    const server = getServerUrl();

    const statusResponse = await fetch(`${server}/api/me`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!statusResponse.ok) {
      console.log(pc.red(`Failed to fetch current user: ${statusResponse.statusText}`));
      return;
    }

    const status = CliStatusResponse.parse(await statusResponse.json());
    const outputPath = getWrappedOutputPath({
      output: args.output,
      username: status.user.username,
      year,
    });

    const wrappedResponse = await fetch(
      `${server}/api/wrapped/${status.user.username}?year=${year}`,
      {
        headers: { Authorization: `Bearer ${token}` },
      }
    );

    if (!wrappedResponse.ok) {
      console.log(
        pc.red(`Failed to fetch wrapped image: ${wrappedResponse.statusText}`)
      );
      return;
    }

    await Bun.write(outputPath, await wrappedResponse.text());

    console.log(pc.green(`Wrapped SVG saved to ${outputPath}`));
  },
});
