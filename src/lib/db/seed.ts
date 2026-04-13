import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import { sql } from "drizzle-orm";
import * as schema from "./schema";

const ORG_ID = "org_test";

const AGENT_IDS = {
  ceo: "00000000-0000-7000-0000-000000000001",
  cto: "00000000-0000-7000-0000-000000000002",
  frontend: "00000000-0000-7000-0000-000000000003",
  backend: "00000000-0000-7000-0000-000000000004",
  designer: "00000000-0000-7000-0000-000000000005",
};

const GOAL_IDS = {
  mission: "00000000-0000-7000-0000-000000000010",
  mvp: "00000000-0000-7000-0000-000000000011",
  hiring: "00000000-0000-7000-0000-000000000012",
};

const PROJECT_IDS = {
  mainApp: "00000000-0000-7000-0000-000000000020",
  docsSite: "00000000-0000-7000-0000-000000000021",
};

const ISSUE_IDS = {
  cicd: "00000000-0000-7000-0000-000000000030",
  onboarding: "00000000-0000-7000-0000-000000000031",
  auth: "00000000-0000-7000-0000-000000000032",
  landing: "00000000-0000-7000-0000-000000000033",
  apiDocs: "00000000-0000-7000-0000-000000000034",
  darkMode: "00000000-0000-7000-0000-000000000035",
  monitoring: "00000000-0000-7000-0000-000000000036",
  componentLib: "00000000-0000-7000-0000-000000000037",
  dbOptimize: "00000000-0000-7000-0000-000000000038",
  mobileLayout: "00000000-0000-7000-0000-000000000039",
};

const COMMENT_IDS = {
  c1: "00000000-0000-7000-0000-000000000040",
  c2: "00000000-0000-7000-0000-000000000041",
  c3: "00000000-0000-7000-0000-000000000042",
  c4: "00000000-0000-7000-0000-000000000043",
  c5: "00000000-0000-7000-0000-000000000044",
};

const COST_EVENT_IDS = {
  ce1: "00000000-0000-7000-0000-000000000050",
  ce2: "00000000-0000-7000-0000-000000000051",
  ce3: "00000000-0000-7000-0000-000000000052",
  ce4: "00000000-0000-7000-0000-000000000053",
  ce5: "00000000-0000-7000-0000-000000000054",
};

const ACTIVITY_IDS = {
  a1: "00000000-0000-7000-0000-000000000060",
  a2: "00000000-0000-7000-0000-000000000061",
  a3: "00000000-0000-7000-0000-000000000062",
  a4: "00000000-0000-7000-0000-000000000063",
  a5: "00000000-0000-7000-0000-000000000064",
};

const ROUTINE_IDS = {
  standup: "00000000-0000-7000-0000-000000000070",
  weekly: "00000000-0000-7000-0000-000000000071",
};

const TRIGGER_IDS = {
  standupTrigger: "00000000-0000-7000-0000-000000000080",
  weeklyTrigger: "00000000-0000-7000-0000-000000000081",
};

const MCP_CATALOG_IDS = {
  github: "00000000-0000-7000-0000-000000000090",
  linear: "00000000-0000-7000-0000-000000000091",
};

const TABLES_IN_TRUNCATE_ORDER = [
  "agent_mcp_credential_overrides",
  "agent_mcp_assignments",
  "org_mcp_credentials",
  "org_mcp_installations",
  "mcp_catalog_entries",
  "secret_access_log",
  "org_deks",
  "provider_keys",
  "plugin_state",
  "plugin_config",
  "plugins",
  "company_skills",
  "heartbeat_runs",
  "due_runs",
  "routine_runs",
  "routine_triggers",
  "routines",
  "budget_reservations",
  "cost_events",
  "activity_log",
  "approvals",
  "issue_comments",
  "issues",
  "project_goals",
  "projects",
  "goals",
  "agents",
];

async function seed() {
  const client = neon(process.env.DATABASE_URL!);
  const db = drizzle(client, { schema });

  console.log("Truncating tables...");
  for (const table of TABLES_IN_TRUNCATE_ORDER) {
    await db.execute(sql.raw(`TRUNCATE TABLE "${table}" CASCADE`));
  }

  console.log("Inserting agents...");
  await db.insert(schema.agents).values([
    {
      id: AGENT_IDS.ceo,
      orgId: ORG_ID,
      name: "CEO",
      shortname: "ceo",
      model: "gpt-5.4",
      provider: "openai",
      role: "executive",
      title: "Chief Executive Officer",
      reportsTo: null,
      monthlyBudgetCents: 50000,
      status: "active",
    },
    {
      id: AGENT_IDS.cto,
      orgId: ORG_ID,
      name: "CTO",
      shortname: "cto",
      model: "claude-sonnet-4.6",
      provider: "anthropic",
      role: "executive",
      title: "Chief Technology Officer",
      reportsTo: AGENT_IDS.ceo,
      monthlyBudgetCents: 30000,
      status: "active",
    },
    {
      id: AGENT_IDS.frontend,
      orgId: ORG_ID,
      name: "Frontend Engineer",
      shortname: "frontend",
      model: "claude-sonnet-4.6",
      provider: "anthropic",
      role: "engineer",
      title: "Senior Frontend Engineer",
      reportsTo: AGENT_IDS.cto,
      monthlyBudgetCents: 10000,
      status: "active",
    },
    {
      id: AGENT_IDS.backend,
      orgId: ORG_ID,
      name: "Backend Engineer",
      shortname: "backend",
      model: "gpt-5.4",
      provider: "openai",
      role: "engineer",
      title: "Senior Backend Engineer",
      reportsTo: AGENT_IDS.cto,
      monthlyBudgetCents: 10000,
      status: "active",
    },
    {
      id: AGENT_IDS.designer,
      orgId: ORG_ID,
      name: "Designer",
      shortname: "designer",
      model: "gemini-2.5-flash",
      provider: "google",
      role: "designer",
      title: "Lead Product Designer",
      reportsTo: AGENT_IDS.ceo,
      monthlyBudgetCents: 5000,
      status: "active",
    },
  ]);

  console.log("Inserting goals...");
  await db.insert(schema.goals).values([
    {
      id: GOAL_IDS.mission,
      orgId: ORG_ID,
      title: "Build the #1 AI note-taking app",
      description: "Company mission to build the best AI-powered note-taking application",
      status: "active",
      parentId: null,
    },
    {
      id: GOAL_IDS.mvp,
      orgId: ORG_ID,
      title: "Launch MVP by Q2 2026",
      description: "Ship the minimum viable product before end of Q2 2026",
      status: "active",
      parentId: GOAL_IDS.mission,
    },
    {
      id: GOAL_IDS.hiring,
      orgId: ORG_ID,
      title: "Hire 3 more AI agents",
      description: "Expand the team with 3 additional AI agents",
      status: "active",
      parentId: GOAL_IDS.mission,
    },
  ]);

  console.log("Inserting projects...");
  await db.insert(schema.projects).values([
    {
      id: PROJECT_IDS.mainApp,
      orgId: ORG_ID,
      name: "main-app",
      description: "The core note-taking application",
      repoUrl: "https://github.com/example/notes-app",
    },
    {
      id: PROJECT_IDS.docsSite,
      orgId: ORG_ID,
      name: "docs-site",
      description: "Public documentation site",
      repoUrl: "https://github.com/example/docs",
    },
  ]);

  console.log("Inserting issues...");
  await db.insert(schema.issues).values([
    {
      id: ISSUE_IDS.cicd,
      orgId: ORG_ID,
      title: "Set up CI/CD pipeline",
      description: "Configure GitHub Actions for automated testing and deployment",
      status: "in_progress",
      priority: "high",
      assigneeId: AGENT_IDS.backend,
      projectId: PROJECT_IDS.mainApp,
    },
    {
      id: ISSUE_IDS.onboarding,
      orgId: ORG_ID,
      title: "Design onboarding flow",
      description: "Create a user-friendly onboarding experience for new users",
      status: "todo",
      priority: "high",
      assigneeId: AGENT_IDS.designer,
      projectId: PROJECT_IDS.mainApp,
    },
    {
      id: ISSUE_IDS.auth,
      orgId: ORG_ID,
      title: "Build authentication system",
      description: "Implement OAuth and email/password authentication",
      status: "done",
      priority: "high",
      assigneeId: AGENT_IDS.backend,
      projectId: PROJECT_IDS.mainApp,
    },
    {
      id: ISSUE_IDS.landing,
      orgId: ORG_ID,
      title: "Create landing page",
      description: "Build a compelling landing page with feature highlights",
      status: "in_progress",
      priority: "medium",
      assigneeId: AGENT_IDS.frontend,
      projectId: PROJECT_IDS.docsSite,
    },
    {
      id: ISSUE_IDS.apiDocs,
      orgId: ORG_ID,
      title: "Write API documentation",
      description: "Document all REST API endpoints",
      status: "backlog",
      priority: "low",
      assigneeId: null,
      projectId: PROJECT_IDS.docsSite,
    },
    {
      id: ISSUE_IDS.darkMode,
      orgId: ORG_ID,
      title: "Implement dark mode",
      description: "Add dark mode toggle and theme switching",
      status: "todo",
      priority: "medium",
      assigneeId: AGENT_IDS.frontend,
      projectId: PROJECT_IDS.mainApp,
    },
    {
      id: ISSUE_IDS.monitoring,
      orgId: ORG_ID,
      title: "Set up monitoring",
      description: "Configure error tracking and performance monitoring",
      status: "backlog",
      priority: "medium",
      assigneeId: AGENT_IDS.backend,
      projectId: PROJECT_IDS.mainApp,
    },
    {
      id: ISSUE_IDS.componentLib,
      orgId: ORG_ID,
      title: "Design component library",
      description: "Create a reusable component library with design tokens",
      status: "in_review",
      priority: "high",
      assigneeId: AGENT_IDS.designer,
      projectId: PROJECT_IDS.mainApp,
    },
    {
      id: ISSUE_IDS.dbOptimize,
      orgId: ORG_ID,
      title: "Optimize database queries",
      description: "Profile and optimize slow database queries",
      status: "todo",
      priority: "low",
      assigneeId: AGENT_IDS.backend,
      projectId: PROJECT_IDS.mainApp,
    },
    {
      id: ISSUE_IDS.mobileLayout,
      orgId: ORG_ID,
      title: "Build mobile responsive layout",
      description: "Ensure all pages work well on mobile devices",
      status: "backlog",
      priority: "medium",
      assigneeId: AGENT_IDS.frontend,
      projectId: PROJECT_IDS.mainApp,
    },
  ]);

  console.log("Inserting issue comments...");
  await db.insert(schema.issueComments).values([
    {
      id: COMMENT_IDS.c1,
      orgId: ORG_ID,
      issueId: ISSUE_IDS.cicd,
      authorType: "agent",
      authorId: AGENT_IDS.backend,
      body: "I've set up the basic GitHub Actions workflow. Working on the deployment stage now.",
    },
    {
      id: COMMENT_IDS.c2,
      orgId: ORG_ID,
      issueId: ISSUE_IDS.cicd,
      authorType: "board",
      authorId: "user_test",
      body: "Make sure to include caching for node_modules to speed up builds.",
    },
    {
      id: COMMENT_IDS.c3,
      orgId: ORG_ID,
      issueId: ISSUE_IDS.auth,
      authorType: "agent",
      authorId: AGENT_IDS.backend,
      body: "Authentication system is complete. OAuth with Google and GitHub is working.",
    },
    {
      id: COMMENT_IDS.c4,
      orgId: ORG_ID,
      issueId: ISSUE_IDS.onboarding,
      authorType: "agent",
      authorId: AGENT_IDS.designer,
      body: "Initial wireframes are ready for review. Proposing a 3-step onboarding flow.",
    },
    {
      id: COMMENT_IDS.c5,
      orgId: ORG_ID,
      issueId: ISSUE_IDS.landing,
      authorType: "board",
      authorId: "user_test",
      body: "Let's prioritize the hero section and pricing table first.",
    },
  ]);

  console.log("Inserting cost events...");
  await db.insert(schema.costEvents).values([
    {
      id: COST_EVENT_IDS.ce1,
      orgId: ORG_ID,
      agentId: AGENT_IDS.ceo,
      issueId: null,
      provider: "openai",
      model: "gpt-5.4",
      inputTokens: 12500,
      outputTokens: 3200,
      estimatedCost: "0.48",
    },
    {
      id: COST_EVENT_IDS.ce2,
      orgId: ORG_ID,
      agentId: AGENT_IDS.backend,
      issueId: ISSUE_IDS.auth,
      provider: "openai",
      model: "gpt-5.4",
      inputTokens: 45000,
      outputTokens: 8700,
      estimatedCost: "1.62",
    },
    {
      id: COST_EVENT_IDS.ce3,
      orgId: ORG_ID,
      agentId: AGENT_IDS.frontend,
      issueId: ISSUE_IDS.landing,
      provider: "anthropic",
      model: "claude-sonnet-4.6",
      inputTokens: 28000,
      outputTokens: 6100,
      estimatedCost: "1.02",
    },
    {
      id: COST_EVENT_IDS.ce4,
      orgId: ORG_ID,
      agentId: AGENT_IDS.designer,
      issueId: ISSUE_IDS.componentLib,
      provider: "google",
      model: "gemini-2.5-flash",
      inputTokens: 15000,
      outputTokens: 4200,
      estimatedCost: "0.29",
    },
    {
      id: COST_EVENT_IDS.ce5,
      orgId: ORG_ID,
      agentId: AGENT_IDS.cto,
      issueId: null,
      provider: "anthropic",
      model: "claude-sonnet-4.6",
      inputTokens: 32000,
      outputTokens: 7500,
      estimatedCost: "1.19",
    },
  ]);

  console.log("Inserting activity log...");
  await db.insert(schema.activityLog).values([
    {
      id: ACTIVITY_IDS.a1,
      orgId: ORG_ID,
      actorType: "board",
      actorId: "user_test",
      action: "agent.created",
      resourceType: "agent",
      resourceId: AGENT_IDS.ceo,
      metadata: { name: "CEO" },
    },
    {
      id: ACTIVITY_IDS.a2,
      orgId: ORG_ID,
      actorType: "board",
      actorId: "user_test",
      action: "agent.created",
      resourceType: "agent",
      resourceId: AGENT_IDS.cto,
      metadata: { name: "CTO" },
    },
    {
      id: ACTIVITY_IDS.a3,
      orgId: ORG_ID,
      actorType: "agent",
      actorId: AGENT_IDS.backend,
      action: "issue.created",
      resourceType: "issue",
      resourceId: ISSUE_IDS.cicd,
      metadata: { title: "Set up CI/CD pipeline" },
    },
    {
      id: ACTIVITY_IDS.a4,
      orgId: ORG_ID,
      actorType: "agent",
      actorId: AGENT_IDS.backend,
      action: "issue.updated",
      resourceType: "issue",
      resourceId: ISSUE_IDS.auth,
      metadata: { field: "status", from: "in_progress", to: "done" },
    },
    {
      id: ACTIVITY_IDS.a5,
      orgId: ORG_ID,
      actorType: "board",
      actorId: "user_test",
      action: "issue.created",
      resourceType: "issue",
      resourceId: ISSUE_IDS.onboarding,
      metadata: { title: "Design onboarding flow" },
    },
  ]);

  console.log("Inserting routines...");
  await db.insert(schema.routines).values([
    {
      id: ROUTINE_IDS.standup,
      orgId: ORG_ID,
      name: "Daily standup review",
      description: "Review all in-progress issues and report blockers",
      agentId: AGENT_IDS.cto,
      status: "active",
    },
    {
      id: ROUTINE_IDS.weekly,
      orgId: ORG_ID,
      name: "Weekly progress report",
      description: "Compile weekly progress across all projects and agents",
      agentId: AGENT_IDS.ceo,
      status: "active",
    },
  ]);

  console.log("Inserting routine triggers...");
  await db.insert(schema.routineTriggers).values([
    {
      id: TRIGGER_IDS.standupTrigger,
      orgId: ORG_ID,
      routineId: ROUTINE_IDS.standup,
      cronExpression: "0 9 * * *",
    },
    {
      id: TRIGGER_IDS.weeklyTrigger,
      orgId: ORG_ID,
      routineId: ROUTINE_IDS.weekly,
      cronExpression: "0 17 * * 5",
    },
  ]);

  console.log("Inserting MCP catalog entries...");
  await db.insert(schema.mcpCatalogEntries).values([
    {
      id: MCP_CATALOG_IDS.github,
      name: "GitHub",
      slug: "github",
      description: "Access GitHub repositories, issues, and pull requests",
      authType: "oauth",
      serverUrl: "https://mcp.github.com/sse",
      docsUrl: "https://docs.github.com",
    },
    {
      id: MCP_CATALOG_IDS.linear,
      name: "Linear",
      slug: "linear",
      description: "Manage Linear issues, projects, and cycles",
      authType: "env_vars",
      serverUrl: "https://mcp.linear.app/sse",
      docsUrl: "https://linear.app/docs",
    },
  ]);

  console.log("Seed complete");
}

seed().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});
