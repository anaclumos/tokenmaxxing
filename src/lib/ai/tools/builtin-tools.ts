import { tool } from "ai";
import { z } from "zod";
import { getDb } from "@/lib/db";
import { issues, issueComments } from "@/lib/db/schema";
import { eq, and, desc } from "drizzle-orm";

export function getBuiltinTools(orgId: string, agentId: string) {
  return {
    list_issues: tool({
      description: "List issues for the organization, optionally filtered by status",
      inputSchema: z.object({
        status: z.string().optional(),
        limit: z.number().default(20),
      }),
      execute: async ({ status, limit }) => {
        const db = getDb();
        const conditions = [eq(issues.orgId, orgId)];
        if (status) conditions.push(eq(issues.status, status));

        const rows = await db
          .select()
          .from(issues)
          .where(and(...conditions))
          .orderBy(desc(issues.createdAt))
          .limit(limit);

        return rows.map((r) => ({
          id: r.id,
          title: r.title,
          status: r.status,
          priority: r.priority,
          assigneeId: r.assigneeId,
          projectId: r.projectId,
          createdAt: r.createdAt.toISOString(),
        }));
      },
    }),

    get_issue: tool({
      description: "Get a single issue by ID with its comments",
      inputSchema: z.object({
        issueId: z.string().uuid(),
      }),
      execute: async ({ issueId }) => {
        const db = getDb();
        const [issue] = await db
          .select()
          .from(issues)
          .where(and(eq(issues.id, issueId), eq(issues.orgId, orgId)));

        if (!issue) return { error: "Issue not found" };

        const comments = await db
          .select()
          .from(issueComments)
          .where(
            and(
              eq(issueComments.issueId, issueId),
              eq(issueComments.orgId, orgId),
            ),
          )
          .orderBy(desc(issueComments.createdAt));

        return { ...issue, comments };
      },
    }),

    create_issue: tool({
      description: "Create a new issue",
      inputSchema: z.object({
        title: z.string(),
        description: z.string().optional(),
        priority: z.enum(["urgent", "high", "medium", "low"]).default("medium"),
        projectId: z.string().uuid().optional(),
      }),
      execute: async ({ title, description, priority, projectId }) => {
        const db = getDb();
        const [created] = await db
          .insert(issues)
          .values({
            orgId,
            title,
            description,
            priority,
            projectId,
            assigneeId: agentId,
          })
          .returning({ id: issues.id });

        return { id: created.id, title, status: "backlog" };
      },
    }),

    update_issue_status: tool({
      description: "Update the status of an issue",
      inputSchema: z.object({
        issueId: z.string().uuid(),
        status: z.enum([
          "backlog",
          "todo",
          "in_progress",
          "in_review",
          "done",
          "cancelled",
        ]),
      }),
      execute: async ({ issueId, status }) => {
        const db = getDb();
        const [updated] = await db
          .update(issues)
          .set({ status, updatedAt: new Date() })
          .where(and(eq(issues.id, issueId), eq(issues.orgId, orgId)))
          .returning({ id: issues.id, status: issues.status });

        if (!updated) return { error: "Issue not found" };
        return updated;
      },
    }),

    add_comment: tool({
      description: "Add a comment to an issue as this agent",
      inputSchema: z.object({
        issueId: z.string().uuid(),
        body: z.string(),
      }),
      execute: async ({ issueId, body }) => {
        const db = getDb();
        const [comment] = await db
          .insert(issueComments)
          .values({
            orgId,
            issueId,
            authorType: "agent",
            authorId: agentId,
            body,
          })
          .returning({ id: issueComments.id });

        return { id: comment.id, issueId };
      },
    }),

    list_my_issues: tool({
      description: "List issues assigned to this agent",
      inputSchema: z.object({
        status: z.string().optional(),
      }),
      execute: async ({ status }) => {
        const db = getDb();
        const conditions = [
          eq(issues.orgId, orgId),
          eq(issues.assigneeId, agentId),
        ];
        if (status) conditions.push(eq(issues.status, status));

        const rows = await db
          .select()
          .from(issues)
          .where(and(...conditions))
          .orderBy(desc(issues.createdAt));

        return rows.map((r) => ({
          id: r.id,
          title: r.title,
          status: r.status,
          priority: r.priority,
          createdAt: r.createdAt.toISOString(),
        }));
      },
    }),
  };
}
