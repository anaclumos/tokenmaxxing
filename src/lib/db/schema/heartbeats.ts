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

export const heartbeatRuns = pgTable(
  "heartbeat_runs",
  {
    id: pk(),
    orgId: text("org_id").notNull(),
    agentId: uuid("agent_id").notNull(),
    workflowRunId: text("workflow_run_id").notNull(),
    status: text("status").notNull(),
    usage: jsonb("usage"),
    transcript: jsonb("transcript"),
    startedAt: timestamp("started_at", { mode: "date", withTimezone: true })
      .notNull()
      .defaultNow(),
    completedAt: timestamp("completed_at", {
      mode: "date",
      withTimezone: true,
    }),
  },
  (t) => [index("heartbeat_runs_org_id_idx").on(t.orgId)]
);

export const heartbeatRunsRelations = relations(heartbeatRuns, ({ one }) => ({
  agent: one(agents, {
    fields: [heartbeatRuns.agentId],
    references: [agents.id],
  }),
}));
