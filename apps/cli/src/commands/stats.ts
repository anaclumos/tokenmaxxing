import { defineCommand } from "citty"
import pc from "picocolors"
import { formatTokens } from "@tokenmaxxing/shared/types"

import { loadLocalUsage, summarizeUsage } from "../local-usage"

export const stats = defineCommand({
  meta: { name: "stats", description: "Show local usage stats without uploading" },
  args: {
    client: { type: "string", description: "Only show a specific client" },
  },
  async run({ args }) {
    const { clients, records } = await loadLocalUsage({ client: args.client })
    if (clients.length === 0) {
      console.log(pc.yellow("No AI coding agents detected on this machine."))
      return
    }

    console.log(pc.dim("Parsing local data..."))
    if (records.length === 0) {
      console.log(pc.yellow("No usage records found."))
      return
    }
    const summary = summarizeUsage({ records })

    console.log(`\n${pc.bold("By Client")}`);
    for (const [name, stats] of summary.byClient) {
      console.log(
        `  ${pc.cyan(name.padEnd(16))} ${formatTokens(stats.tokens).padStart(8)} tokens  $${stats.cost.toFixed(2).padStart(8)}  ${pc.dim(`${stats.sessions} sessions`)}`
      )
    }

    console.log(`\n${pc.bold("By Model")}`);
    for (const [name, stats] of summary.byModel.slice(0, 15)) {
      console.log(
        `  ${pc.cyan(name.padEnd(40))} ${formatTokens(stats.tokens).padStart(8)} tokens  $${stats.cost.toFixed(2).padStart(8)}  ${pc.dim(`${stats.sessions} sessions`)}`
      )
    }
    if (summary.byModel.length > 15) {
      console.log(pc.dim(`  ... and ${summary.byModel.length - 15} more models`))
    }

    if (summary.byProject.length > 0) {
      console.log(`\n${pc.bold("By Project")}`);
      for (const [name, stats] of summary.byProject.slice(0, 15)) {
        console.log(
          `  ${pc.cyan(name.padEnd(40))} ${formatTokens(stats.tokens).padStart(8)} tokens  $${stats.cost.toFixed(2).padStart(8)}  ${pc.dim(`${stats.sessions} sessions`)}`
        )
      }
      if (summary.byProject.length > 15) {
        console.log(pc.dim(`  ... and ${summary.byProject.length - 15} more projects`))
      }
    }

    console.log(`\n${pc.bold("Total")}`);
    console.log(`  Sessions: ${pc.bold(String(records.length))}`)
    console.log(`  Tokens:   ${pc.bold(formatTokens(summary.tokenTotal))}`)
    console.log(`  Cost:     ${pc.bold("$" + summary.costTotal.toFixed(2))}`)
    console.log()
  },
})
