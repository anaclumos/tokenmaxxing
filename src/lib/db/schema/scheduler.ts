import {
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { pk } from "./helpers";
import { relations } from "drizzle-orm";
import { agents } from "./agents";
import { routines } from "./routines";

export const dueRuns = pgTable(
  "due_runs",
  {
    id: pk(),
    orgId: text("org_id").notNull(),
    agentId: uuid("agent_id").notNull(),
    dueAt: timestamp("due_at", { mode: "date", withTimezone: true }).notNull(),
    claimedAt: timestamp("claimed_at", { mode: "date", withTimezone: true }),
    claimedBy: text("claimed_by"),
    status: text("status").notNull().default("pending"),
    idempotencyKey: text("idempotency_key").notNull(),
    runType: text("run_type").notNull(),
    routineId: uuid("routine_id"),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("due_runs_org_id_idx").on(t.orgId),
    uniqueIndex("due_runs_idempotency_key_idx").on(t.idempotencyKey),
  ]
);

export const dueRunsRelations = relations(dueRuns, ({ one }) => ({
  agent: one(agents, {
    fields: [dueRuns.agentId],
    references: [agents.id],
  }),
  routine: one(routines, {
    fields: [dueRuns.routineId],
    references: [routines.id],
  }),
}));
