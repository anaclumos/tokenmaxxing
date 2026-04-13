import { generateText, stepCountIs, type ModelMessage } from "ai";
import { createProviderForOrg } from "./provider-factory";
import { getBuiltinTools } from "./tools/builtin-tools";
import { getDb } from "@/lib/db";
import { agents } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import { resolveOrgKeys } from "@/lib/services/keys";
import {
  reserveBudget,
  settleBudget,
  cancelReservation,
} from "@/lib/services/costs";

interface RunContext {
  orgId: string;
  agentId: string;
  issueId?: string;
  messages: ModelMessage[];
  maxSteps?: number;
}

interface RunResult {
  messages: ModelMessage[];
  usage: { inputTokens: number; outputTokens: number; totalTokens: number };
  status: "completed" | "error";
}

export async function runAgent(ctx: RunContext): Promise<RunResult> {
  const db = getDb();

  const [agent] = await db
    .select()
    .from(agents)
    .where(and(eq(agents.id, ctx.agentId), eq(agents.orgId, ctx.orgId)));

  if (!agent) throw new Error(`Agent ${ctx.agentId} not found`);

  const orgKeys = await resolveOrgKeys(ctx.orgId);
  const apiKey = orgKeys[agent.provider];
  if (!apiKey) {
    throw new Error(`No API key configured for provider: ${agent.provider}`);
  }

  const providerInstance = createProviderForOrg(agent.provider, apiKey) as {
    (modelId: string): Parameters<typeof generateText>[0]["model"];
  };

  const runId = crypto.randomUUID();
  const reservationId = await reserveBudget({
    orgId: ctx.orgId,
    agentId: ctx.agentId,
    runId,
    estimatedCost: 50,
  });

  try {
    const tools = getBuiltinTools(ctx.orgId, ctx.agentId);

    const result = await generateText({
      model: providerInstance(agent.model),
      system: agent.systemPrompt ?? undefined,
      messages: ctx.messages,
      tools,
      stopWhen: stepCountIs(ctx.maxSteps ?? 10),
    });

    const usage = {
      inputTokens: result.totalUsage.inputTokens ?? 0,
      outputTokens: result.totalUsage.outputTokens ?? 0,
      totalTokens: result.totalUsage.totalTokens ?? 0,
    };

    await settleBudget(reservationId, usage, agent.provider, agent.model);

    return {
      messages: result.response.messages as ModelMessage[],
      usage,
      status: "completed",
    };
  } catch (error) {
    await cancelReservation(reservationId);
    throw error;
  }
}
