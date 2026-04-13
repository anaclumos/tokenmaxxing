import {
  index,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { pk } from "./helpers";
import { relations } from "drizzle-orm";

export const goals = pgTable(
  "goals",
  {
    id: pk(),
    orgId: text("org_id").notNull(),
    title: text("title").notNull(),
    description: text("description"),
    status: text("status").notNull(),
    parentId: uuid("parent_id"),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("goals_org_id_idx").on(t.orgId)]
);

export const goalsRelations = relations(goals, ({ one, many }) => ({
  parent: one(goals, {
    fields: [goals.parentId],
    references: [goals.id],
    relationName: "goal_hierarchy",
  }),
  children: many(goals, { relationName: "goal_hierarchy" }),
}));
