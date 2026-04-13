import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { sql } from "drizzle-orm";
import * as schema from "./schema";

const ORG_ID = "org_test";

const AGENT_IDS = {
  ceo: "00000000-0000-7000-8000-000000000001",
  cto: "00000000-0000-7000-8000-000000000002",
  frontend: "00000000-0000-7000-8000-000000000003",
  backend: "00000000-0000-7000-8000-000000000004",
  designer: "00000000-0000-7000-8000-000000000005",
};

const COST_EVENT_IDS = {
  ce1: "00000000-0000-7000-8000-000000000050",
  ce2: "00000000-0000-7000-8000-000000000051",
  ce3: "00000000-0000-7000-8000-000000000052",
  ce4: "00000000-0000-7000-8000-000000000053",
  ce5: "00000000-0000-7000-8000-000000000054",
};

const ACTIVITY_IDS = {
  a1: "00000000-0000-7000-8000-000000000060",
  a2: "00000000-0000-7000-8000-000000000061",
  a3: "00000000-0000-7000-8000-000000000062",
  a4: "00000000-0000-7000-8000-000000000063",
  a5: "00000000-0000-7000-8000-000000000064",
};

const ROUTINE_IDS = {
  standup: "00000000-0000-7000-8000-000000000070",
  weekly: "00000000-0000-7000-8000-000000000071",
};

const TRIGGER_IDS = {
  standupTrigger: "00000000-0000-7000-8000-000000000080",
  weeklyTrigger: "00000000-0000-7000-8000-000000000081",
};

const MCP_CATALOG_IDS = {
  github: "00000000-0000-7000-8000-000000000090",
  linear: "00000000-0000-7000-8000-000000000091",
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
  "heartbeat_runs",
  "due_runs",
  "routine_runs",
  "routine_triggers",
  "routines",
  "budget_reservations",
  "cost_events",
  "activity_log",
  "agents",
];

async function seed() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const db = drizzle(pool, { schema });

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

  console.log("Inserting cost events...");
  await db.insert(schema.costEvents).values([
    {
      id: COST_EVENT_IDS.ce1,
      orgId: ORG_ID,
      agentId: AGENT_IDS.ceo,
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
      actorType: "board",
      actorId: "user_test",
      action: "agent.created",
      resourceType: "agent",
      resourceId: AGENT_IDS.frontend,
      metadata: { name: "Frontend Engineer" },
    },
    {
      id: ACTIVITY_IDS.a4,
      orgId: ORG_ID,
      actorType: "board",
      actorId: "user_test",
      action: "agent.created",
      resourceType: "agent",
      resourceId: AGENT_IDS.backend,
      metadata: { name: "Backend Engineer" },
    },
    {
      id: ACTIVITY_IDS.a5,
      orgId: ORG_ID,
      actorType: "board",
      actorId: "user_test",
      action: "agent.created",
      resourceType: "agent",
      resourceId: AGENT_IDS.designer,
      metadata: { name: "Designer" },
    },
  ]);

  console.log("Inserting routines...");
  await db.insert(schema.routines).values([
    {
      id: ROUTINE_IDS.standup,
      orgId: ORG_ID,
      name: "Daily standup review",
      description: "Review all in-progress work and report blockers",
      agentId: AGENT_IDS.cto,
      status: "active",
    },
    {
      id: ROUTINE_IDS.weekly,
      orgId: ORG_ID,
      name: "Weekly progress report",
      description: "Compile weekly progress across all agents",
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
  await pool.end();
}

seed().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});
