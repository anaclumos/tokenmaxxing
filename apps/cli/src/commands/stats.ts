import { defineCommand } from "citty";
import pc from "picocolors";
import { totalTokens, formatTokens } from "@tokenmaxxing/shared/types";
import { discoverClients, parseAll } from "../parsers/registry";
import { calculateCost } from "../pricing";

export const stats = defineCommand({
  meta: { name: "stats", description: "Show local usage stats without uploading" },
  args: {
    client: { type: "string", description: "Only show a specific client" },
  },
  async run({ args }) {
    const clients = await discoverClients();
    if (clients.length === 0) {
      console.log(pc.yellow("No AI coding agents detected on this machine."));
      return;
    }

    const filtered = args.client ? clients.filter((c) => c.client === args.client) : clients;
    console.log(pc.dim("Parsing local data..."));

    const records = await parseAll(filtered);
    if (records.length === 0) {
      console.log(pc.yellow("No usage records found."));
      return;
    }

    // Fill in costs
    for (const r of records) {
      if (r.costUsd === 0) r.costUsd = await calculateCost(r.model, r.tokens);
    }

    // Per-client breakdown
    const byClient = new Map<string, { sessions: number; tokens: number; cost: number }>();
    const byModel = new Map<string, { sessions: number; tokens: number; cost: number }>();

    for (const r of records) {
      const t = totalTokens(r.tokens);
      const c = byClient.get(r.client) ?? { sessions: 0, tokens: 0, cost: 0 };
      c.sessions++; c.tokens += t; c.cost += r.costUsd;
      byClient.set(r.client, c);

      const m = byModel.get(r.model) ?? { sessions: 0, tokens: 0, cost: 0 };
      m.sessions++; m.tokens += t; m.cost += r.costUsd;
      byModel.set(r.model, m);
    }

    // Sort by tokens descending
    const sortedClients = [...byClient.entries()].sort((a, b) => b[1].tokens - a[1].tokens);
    const sortedModels = [...byModel.entries()].sort((a, b) => b[1].tokens - a[1].tokens);

    console.log(`\n${pc.bold("By Client")}`);
    for (const [name, s] of sortedClients) {
      console.log(`  ${pc.cyan(name.padEnd(16))} ${formatTokens(s.tokens).padStart(8)} tokens  $${s.cost.toFixed(2).padStart(8)}  ${pc.dim(`${s.sessions} sessions`)}`);
    }

    console.log(`\n${pc.bold("By Model")}`);
    for (const [name, s] of sortedModels.slice(0, 15)) {
      console.log(`  ${pc.cyan(name.padEnd(40))} ${formatTokens(s.tokens).padStart(8)} tokens  $${s.cost.toFixed(2).padStart(8)}  ${pc.dim(`${s.sessions} sessions`)}`);
    }
    if (sortedModels.length > 15) {
      console.log(pc.dim(`  ... and ${sortedModels.length - 15} more models`));
    }

    // Totals
    let tokenSum = 0;
    let costSum = 0;
    for (const r of records) { tokenSum += totalTokens(r.tokens); costSum += r.costUsd; }

    console.log(`\n${pc.bold("Total")}`);
    console.log(`  Sessions: ${pc.bold(String(records.length))}`);
    console.log(`  Tokens:   ${pc.bold(formatTokens(tokenSum))}`);
    console.log(`  Cost:     ${pc.bold("$" + costSum.toFixed(2))}`);
    console.log();
  },
});
