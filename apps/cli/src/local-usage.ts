import type { UsageRecord } from "@tokenmaxxing/shared/types"
import { totalTokens } from "@tokenmaxxing/shared/types"

import { discoverClients, parseAll } from "./parsers/registry"
import { calculateCost } from "./pricing"

type UsageSummaryRow = {
  sessions: number
  tokens: number
  cost: number
}

export async function loadLocalUsage({
  client,
}: {
  client?: string
}) {
  const clients = await discoverClients()
  const filteredClients = client
    ? clients.filter((entry) => entry.client === client)
    : clients
  const records = await parseAll(filteredClients)

  for (const record of records) {
    if (record.costUsd === 0) {
      record.costUsd = await calculateCost(record.model, record.tokens)
    }
  }

  return { clients, filteredClients, records }
}

export function summarizeUsage({
  records,
}: {
  records: UsageRecord[]
}) {
  const byClient = new Map<string, UsageSummaryRow>()
  const byModel = new Map<string, UsageSummaryRow>()
  let tokenTotal = 0
  let costTotal = 0

  const byProject = new Map<string, UsageSummaryRow>()

  for (const record of records) {
    const tokens = totalTokens(record.tokens)
    tokenTotal += tokens
    costTotal += record.costUsd

    const client = byClient.get(record.client) ?? { sessions: 0, tokens: 0, cost: 0 }
    client.sessions++
    client.tokens += tokens
    client.cost += record.costUsd
    byClient.set(record.client, client)

    const model = byModel.get(record.model) ?? { sessions: 0, tokens: 0, cost: 0 }
    model.sessions++
    model.tokens += tokens
    model.cost += record.costUsd
    byModel.set(record.model, model)

    if (record.project) {
      const proj = byProject.get(record.project) ?? { sessions: 0, tokens: 0, cost: 0 }
      proj.sessions++
      proj.tokens += tokens
      proj.cost += record.costUsd
      byProject.set(record.project, proj)
    }
  }

  return {
    byClient: [...byClient.entries()].sort((a, b) => b[1].tokens - a[1].tokens),
    byModel: [...byModel.entries()].sort((a, b) => b[1].tokens - a[1].tokens),
    byProject: [...byProject.entries()].sort((a, b) => b[1].cost - a[1].cost),
    tokenTotal,
    costTotal,
  }
}
