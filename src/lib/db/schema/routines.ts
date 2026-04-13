import {
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { pk } from "./helpers";
import { relations } from "drizzle-orm";
import { agents } from "./agents";

export const routines = pgTable(
  "routines",
  {
    id: pk(),
    orgId: text("org_id").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    agentId: uuid("agent_id").notNull(),
    status: text("status").notNull().default("active"),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("routines_org_id_idx").on(t.orgId)]
);

export const routineTriggers = pgTable(
  "routine_triggers",
  {
    id: pk(),
    orgId: text("org_id").notNull(),
    routineId: uuid("routine_id").notNull(),
    cronExpression: text("cron_expression").notNull(),
    variables: jsonb("variables"),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("routine_triggers_org_id_idx").on(t.orgId)]
);

export const routineRuns = pgTable(
  "routine_runs",
  {
    id: pk(),
    orgId: text("org_id").notNull(),
    routineId: uuid("routine_id").notNull(),
    triggerId: uuid("trigger_id"),
    agentId: uuid("agent_id").notNull(),
    workflowRunId: text("workflow_run_id"),
    status: text("status").notNull(),
    startedAt: timestamp("started_at", { mode: "date", withTimezone: true })
      .notNull()
      .defaultNow(),
    completedAt: timestamp("completed_at", {
      mode: "date",
      withTimezone: true,
    }),
  },
  (t) => [index("routine_runs_org_id_idx").on(t.orgId)]
);

export const routinesRelations = relations(routines, ({ one, many }) => ({
  agent: one(agents, {
    fields: [routines.agentId],
    references: [agents.id],
  }),
  triggers: many(routineTriggers),
  runs: many(routineRuns),
}));

export const routineTriggersRelations = relations(
  routineTriggers,
  ({ one }) => ({
    routine: one(routines, {
      fields: [routineTriggers.routineId],
      references: [routines.id],
    }),
  })
);

export const routineRunsRelations = relations(routineRuns, ({ one }) => ({
  routine: one(routines, {
    fields: [routineRuns.routineId],
    references: [routines.id],
  }),
  trigger: one(routineTriggers, {
    fields: [routineRuns.triggerId],
    references: [routineTriggers.id],
  }),
  agent: one(agents, {
    fields: [routineRuns.agentId],
    references: [agents.id],
  }),
}));
