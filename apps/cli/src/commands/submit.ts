import { defineCommand } from "citty";
import pc from "picocolors";
import type { SubmitResponse } from "@tokenmaxxing/shared/types";
import { totalTokens } from "@tokenmaxxing/shared/types";
import { discoverClients, parseAll } from "../parsers/registry";
import { calculateCost } from "../pricing";
import { getApiToken, getServerUrl } from "./login";

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
    console.log(pc.dim("Fetching model pricing..."));

    const records = await parseAll(filtered);

    // Fill in costs from LiteLLM pricing where missing
    for (const r of records) {
      if (r.costUsd === 0) {
        r.costUsd = await calculateCost(r.model, r.tokens);
      }
    }

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

    const token = getApiToken();
    if (!token) {
      console.log(pc.yellow("\nNot logged in. Run: tokenmaxxing login"));
      return;
    }

    // Upload in batches of 500
    const server = getServerUrl();
    let totalInserted = 0;
    let totalSkipped = 0;

    for (let i = 0; i < records.length; i += 500) {
      const batch = records.slice(i, i + 500);
      const res = await fetch(`${server}/api/submit`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ records: batch }),
      });

      if (!res.ok) {
        const err = await res.json();
        console.log(pc.red(`Upload failed: ${err.error ?? res.statusText}`));
        return;
      }

      const data = (await res.json()) as SubmitResponse;
      totalInserted += data.inserted;
      totalSkipped += data.skipped;
    }

    console.log(pc.green(`\nUploaded: ${totalInserted} new, ${totalSkipped} already submitted`));
  },
});
