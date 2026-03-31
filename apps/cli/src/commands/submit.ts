import { defineCommand } from "citty";
import pc from "picocolors";
import { totalTokens } from "@tokenmaxxing/shared/types";
import { discoverClients, parseAll } from "../parsers/registry";

export const submit = defineCommand({
  meta: { name: "submit", description: "Parse local usage data and upload to tokenmaxx.ing" },
  args: {
    "dry-run": { type: "boolean", description: "Parse and show summary without uploading" },
    client: { type: "string", description: "Only parse a specific client" },
  },
  async run({ args }) {
    const clients = await discoverClients();
    if (clients.length === 0) {
      console.log(pc.yellow("No AI coding agents detected on this machine."));
      return;
    }

    const filtered = args.client
      ? clients.filter((c) => c.client === args.client)
      : clients;

    console.log(pc.dim(`Detected: ${filtered.map((c) => c.client).join(", ")}`));

    const records = await parseAll(filtered);
    console.log(pc.green(`Parsed ${records.length} sessions from ${filtered.length} client(s)`));

    let tokenSum = 0;
    let costSum = 0;
    for (const r of records) {
      tokenSum += totalTokens(r.tokens);
      costSum += r.costUsd;
    }

    console.log(`  Tokens: ${pc.bold(tokenSum.toLocaleString())}`);
    console.log(`  Cost:   ${pc.bold("$" + costSum.toFixed(2))}`);

    if (args["dry-run"]) {
      console.log(pc.dim("\n--dry-run: skipping upload"));
      return;
    }

    // TODO: implement upload to API (#25)
    console.log(pc.dim("\nUpload not yet implemented. Use --dry-run for now."));
  },
});
