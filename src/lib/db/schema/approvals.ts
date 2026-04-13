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
import { issues } from "./issues";
import { agents } from "./agents";

export const approvals = pgTable(
  "approvals",
  {
    id: pk(),
    orgId: text("org_id").notNull(),
    issueId: uuid("issue_id").notNull(),
    agentId: uuid("agent_id").notNull(),
    type: text("type").notNull(),
    status: text("status").notNull().default("pending"),
    payload: jsonb("payload"),
    decidedBy: text("decided_by"),
    decidedAt: timestamp("decided_at", { mode: "date", withTimezone: true }),
    workflowHookToken: text("workflow_hook_token"),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("approvals_org_id_idx").on(t.orgId)]
);

export const approvalsRelations = relations(approvals, ({ one }) => ({
  issue: one(issues, {
    fields: [approvals.issueId],
    references: [issues.id],
  }),
  agent: one(agents, {
    fields: [approvals.agentId],
    references: [agents.id],
  }),
}));
