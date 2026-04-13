import { getDb } from "@/lib/db";
import { budgetReservations, costEvents, agents } from "@/lib/db/schema";
import { eq, and, sql } from "drizzle-orm";
import { getModelPricing } from "@/lib/ai/pricing";

export async function reserveBudget(params: {
  orgId: string;
  agentId: string;
  runId: string;
  estimatedCost: number;
}): Promise<string> {
  const db = getDb();

  const budget = await getAgentBudget(params.orgId, params.agentId);
  const spent = await getAccumulatedSpend(params.orgId, params.agentId);

  if (spent + params.estimatedCost > budget) {
    throw new Error(
      `Budget exceeded: ${spent + params.estimatedCost} > ${budget} cents`,
    );
  }

  const [reservation] = await db
    .insert(budgetReservations)
    .values({
      orgId: params.orgId,
      agentId: params.agentId,
      runId: params.runId,
      reservedAmount: String(params.estimatedCost),
      status: "reserved",
    })
    .returning({ id: budgetReservations.id });

  return reservation.id;
}

export async function settleBudget(
  reservationId: string,
  usage: { inputTokens: number; outputTokens: number },
  provider: string,
  model: string,
) {
  const db = getDb();

  const pricing = getModelPricing(provider, model);
  const inputCost = (usage.inputTokens / 1_000_000) * pricing.input;
  const outputCost = (usage.outputTokens / 1_000_000) * pricing.output;
  const totalCostDollars = inputCost + outputCost;
  const totalCostCents = Math.round(totalCostDollars * 100);

  const [reservation] = await db
    .select()
    .from(budgetReservations)
    .where(eq(budgetReservations.id, reservationId));

  if (!reservation) throw new Error(`Reservation ${reservationId} not found`);

  await db
    .update(budgetReservations)
    .set({
      settledAmount: String(totalCostCents),
      status: "settled",
    })
    .where(eq(budgetReservations.id, reservationId));

  await db.insert(costEvents).values({
    orgId: reservation.orgId,
    agentId: reservation.agentId,
    provider,
    model,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    estimatedCost: String(totalCostCents),
  });
}

export async function cancelReservation(reservationId: string) {
  const db = getDb();
  await db
    .update(budgetReservations)
    .set({ status: "cancelled" })
    .where(eq(budgetReservations.id, reservationId));
}

export async function getAccumulatedSpend(
  orgId: string,
  agentId: string,
): Promise<number> {
  const db = getDb();

  const [result] = await db
    .select({
      total: sql<string>`coalesce(
        sum(case when ${budgetReservations.status} = 'settled'
          then ${budgetReservations.settledAmount}
          else ${budgetReservations.reservedAmount}
        end), '0'
      )`,
    })
    .from(budgetReservations)
    .where(
      and(
        eq(budgetReservations.orgId, orgId),
        eq(budgetReservations.agentId, agentId),
        sql`${budgetReservations.status} in ('reserved', 'settled')`,
        sql`${budgetReservations.createdAt} >= date_trunc('month', now())`,
      ),
    );

  return Number(result.total);
}

export async function getAgentBudget(
  orgId: string,
  agentId: string,
): Promise<number> {
  const db = getDb();

  const [agent] = await db
    .select({ monthlyBudgetCents: agents.monthlyBudgetCents })
    .from(agents)
    .where(and(eq(agents.id, agentId), eq(agents.orgId, orgId)));

  if (!agent) throw new Error(`Agent ${agentId} not found`);

  return agent.monthlyBudgetCents ?? Infinity;
}
