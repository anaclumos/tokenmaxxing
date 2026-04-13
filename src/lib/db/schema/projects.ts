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
import { goals } from "./goals";

export const projects = pgTable(
  "projects",
  {
    id: pk(),
    orgId: text("org_id").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    repoUrl: text("repo_url"),
    config: jsonb("config"),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("projects_org_id_idx").on(t.orgId)]
);

export const projectGoals = pgTable(
  "project_goals",
  {
    id: pk(),
    orgId: text("org_id").notNull(),
    projectId: uuid("project_id").notNull(),
    goalId: uuid("goal_id").notNull(),
  },
  (t) => [index("project_goals_org_id_idx").on(t.orgId)]
);

export const projectsRelations = relations(projects, ({ many }) => ({
  projectGoals: many(projectGoals),
}));

export const projectGoalsRelations = relations(projectGoals, ({ one }) => ({
  project: one(projects, {
    fields: [projectGoals.projectId],
    references: [projects.id],
  }),
  goal: one(goals, {
    fields: [projectGoals.goalId],
    references: [goals.id],
  }),
}));
