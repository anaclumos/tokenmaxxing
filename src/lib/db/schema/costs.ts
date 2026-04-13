import {
  index,
  integer,
  numeric,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { pk } from "./helpers";
import { relations } from "drizzle-orm";
import { agents } from "./agents";

export const costEvents = pgTable(
  "cost_events",
  {
    id: pk(),
    orgId: text("org_id").notNull(),
    agentId: uuid("agent_id").notNull(),
    externalIssueId: text("external_issue_id"),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    inputTokens: integer("input_tokens").notNull(),
    outputTokens: integer("output_tokens").notNull(),
    estimatedCost: numeric("estimated_cost").notNull(),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("cost_events_org_id_idx").on(t.orgId)],
);

export const budgetReservations = pgTable(
  "budget_reservations",
  {
    id: pk(),
    orgId: text("org_id").notNull(),
    agentId: uuid("agent_id").notNull(),
    runId: text("run_id").notNull(),
    reservedAmount: numeric("reserved_amount").notNull(),
    settledAmount: numeric("settled_amount"),
    status: text("status").notNull().default("reserved"),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("budget_reservations_org_id_idx").on(t.orgId)],
);

export const costEventsRelations = relations(costEvents, ({ one }) => ({
  agent: one(agents, {
    fields: [costEvents.agentId],
    references: [agents.id],
  }),
}));

export const budgetReservationsRelations = relations(
  budgetReservations,
  ({ one }) => ({
    agent: one(agents, {
      fields: [budgetReservations.agentId],
      references: [agents.id],
    }),
  }),
);
