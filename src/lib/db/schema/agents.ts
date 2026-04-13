import {
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { pk } from "./helpers";
import { relations } from "drizzle-orm";

export const agents = pgTable(
  "agents",
  {
    id: pk(),
    orgId: text("org_id").notNull(),
    name: text("name").notNull(),
    shortname: text("shortname").notNull(),
    model: text("model").notNull(),
    provider: text("provider").notNull(),
    role: text("role").notNull(),
    title: text("title").notNull(),
    systemPrompt: text("system_prompt"),
    reportsTo: uuid("reports_to"),
    config: jsonb("config"),
    status: text("status").notNull().default("active"),
    heartbeatCron: text("heartbeat_cron"),
    monthlyBudgetCents: integer("monthly_budget_cents"),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("agents_org_id_idx").on(t.orgId)]
);

export const agentsRelations = relations(agents, ({ one, many }) => ({
  parent: one(agents, {
    fields: [agents.reportsTo],
    references: [agents.id],
    relationName: "agent_hierarchy",
  }),
  directReports: many(agents, { relationName: "agent_hierarchy" }),
}));
