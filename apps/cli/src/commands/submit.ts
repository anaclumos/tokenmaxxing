import { defineCommand } from "citty"
import pc from "picocolors"
import type { SubmitResponse } from "@tokenmaxxing/shared/types"
import { formatTokens } from "@tokenmaxxing/shared/types"

import { getApiToken, getServerUrl } from "../config"
import { loadLocalUsage, summarizeUsage } from "../local-usage"

export const submit = defineCommand({
  meta: {
    name: "submit",
    description: "Parse local usage data and upload to tokenmaxx.ing",
  },
  args: {
    "dry-run": {
      type: "boolean",
      description: "Parse and show summary without uploading",
    },
    client: { type: "string", description: "Only parse a specific client" },
  },
  async run({ args }) {
    const { clients, filteredClients, records } = await loadLocalUsage({
      client: args.client,
    })
    if (clients.length === 0) {
      console.log(pc.yellow("No AI coding agents detected on this machine."))
      return
    }

    console.log(
      pc.dim(`Detected: ${filteredClients.map((c) => c.client).join(", ")}`)
    )
    console.log(pc.dim("Fetching model pricing..."))
    const summary = summarizeUsage({ records })

    console.log(
      pc.green(
        `Parsed ${records.length} sessions from ${filteredClients.length} client(s)\n`
      )
    )
    for (const [name, stats] of summary.byClient) {
      console.log(
        `  ${pc.cyan(name.padEnd(16))} ${formatTokens(stats.tokens).padStart(8)} tokens  $${stats.cost.toFixed(2).padStart(8)}  ${pc.dim(`${stats.sessions} sessions`)}`
      )
    }
    console.log(
      `\n  ${pc.bold("Total")}           ${formatTokens(summary.tokenTotal).padStart(8)} tokens  $${summary.costTotal.toFixed(2).padStart(8)}`
    )

    if (args["dry-run"]) {
      console.log(pc.dim("\n--dry-run: skipping upload"))
      return
    }

    const token = getApiToken()
    if (!token) {
      console.log(pc.yellow("\nNot logged in. Run: tokenmaxxing login"))
      return
    }

    // Upload in batches of 500
    const server = getServerUrl()
    let totalInserted = 0
    let totalSkipped = 0

    for (let i = 0; i < records.length; i += 500) {
      const batch = records.slice(i, i + 500)
      const res = await fetch(`${server}/api/submit`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ records: batch }),
      })

      if (!res.ok) {
        const err = await res.json()
        console.log(pc.red(`Upload failed: ${err.error ?? res.statusText}`))
        return
      }

      const data = (await res.json()) as SubmitResponse
      totalInserted += data.inserted
      totalSkipped += data.skipped
    }

    console.log(
      pc.green(
        `\nUploaded: ${totalInserted} new, ${totalSkipped} already submitted`
      )
    )
  },
})
