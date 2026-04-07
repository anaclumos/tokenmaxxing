import { parseWrappedYear, renderWrappedSvg } from "@tokenmaxxing/shared/wrapped";
import { defineCommand } from "citty";
import pc from "picocolors";

import { loadLocalUsage } from "../local-usage";
import { buildLocalWrappedData, getWrappedOutputPath, getWrappedUsername } from "../wrapped-data";

export const wrapped = defineCommand({
  meta: {
    name: "wrapped",
    description: "Generate a local year-in-review SVG",
  },
  args: {
    year: { type: "string", description: "Wrapped year (default: current year)" },
    output: { type: "string", description: "Output SVG path" },
  },
  async run({ args }) {
    const { clients, records } = await loadLocalUsage({});
    if (clients.length === 0) {
      console.log(pc.yellow("No AI coding agents detected on this machine."));
      return;
    }

    const year = parseWrappedYear({ value: args.year });
    const username = getWrappedUsername();
    const data = buildLocalWrappedData({
      records,
      username,
      year,
    });
    if (!data) {
      console.log(pc.yellow(`No local usage records found for ${year}.`));
      return;
    }

    const outputPath = getWrappedOutputPath({
      output: args.output,
      username,
      year,
    });

    await Bun.write(outputPath, renderWrappedSvg({ data }));

    console.log(pc.green(`Wrapped SVG saved to ${outputPath}`));
  },
});
