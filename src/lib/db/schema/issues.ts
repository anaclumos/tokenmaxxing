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
import { projects } from "./projects";
import { goals } from "./goals";

export const issues = pgTable(
  "issues",
  {
    id: pk(),
    orgId: text("org_id").notNull(),
    title: text("title").notNull(),
    description: text("description"),
    status: text("status").notNull().default("backlog"),
    priority: text("priority").notNull().default("medium"),
    assigneeId: uuid("assignee_id"),
    projectId: uuid("project_id"),
    goalId: uuid("goal_id"),
    executionState: jsonb("execution_state"),
    executionPolicy: jsonb("execution_policy"),
    parentId: uuid("parent_id"),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("issues_org_id_idx").on(t.orgId)]
);

export const issueComments = pgTable(
  "issue_comments",
  {
    id: pk(),
    orgId: text("org_id").notNull(),
    issueId: uuid("issue_id").notNull(),
    authorType: text("author_type").notNull(),
    authorId: text("author_id").notNull(),
    body: text("body").notNull(),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("issue_comments_org_id_idx").on(t.orgId)]
);

export const issuesRelations = relations(issues, ({ one, many }) => ({
  assignee: one(agents, {
    fields: [issues.assigneeId],
    references: [agents.id],
  }),
  project: one(projects, {
    fields: [issues.projectId],
    references: [projects.id],
  }),
  goal: one(goals, {
    fields: [issues.goalId],
    references: [goals.id],
  }),
  parent: one(issues, {
    fields: [issues.parentId],
    references: [issues.id],
    relationName: "issue_hierarchy",
  }),
  children: many(issues, { relationName: "issue_hierarchy" }),
  comments: many(issueComments),
}));

export const issueCommentsRelations = relations(issueComments, ({ one }) => ({
  issue: one(issues, {
    fields: [issueComments.issueId],
    references: [issues.id],
  }),
}));
