import {
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { pk } from "./helpers";
import { relations } from "drizzle-orm";
import { agents } from "./agents";

export const mcpCatalogEntries = pgTable(
  "mcp_catalog_entries",
  {
    id: pk(),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    description: text("description").notNull(),
    iconUrl: text("icon_url"),
    authType: text("auth_type").notNull(),
    oauthConfig: jsonb("oauth_config"),
    envSchema: jsonb("env_schema"),
    serverUrl: text("server_url").notNull(),
    docsUrl: text("docs_url"),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [uniqueIndex("mcp_catalog_entries_slug_idx").on(t.slug)]
);

export const orgMcpInstallations = pgTable(
  "org_mcp_installations",
  {
    id: pk(),
    orgId: text("org_id").notNull(),
    catalogEntryId: uuid("catalog_entry_id"),
    customUrl: text("custom_url"),
    customName: text("custom_name"),
    status: text("status").notNull().default("active"),
    activatedBy: text("activated_by").notNull(),
    activatedAt: timestamp("activated_at", {
      mode: "date",
      withTimezone: true,
    })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("org_mcp_installations_org_id_idx").on(t.orgId)]
);

export const orgMcpCredentials = pgTable(
  "org_mcp_credentials",
  {
    id: pk(),
    orgId: text("org_id").notNull(),
    installationId: uuid("installation_id").notNull(),
    encryptedOauthTokens: text("encrypted_oauth_tokens"),
    encryptedEnvVars: text("encrypted_env_vars"),
    tokenExpiresAt: timestamp("token_expires_at", {
      mode: "date",
      withTimezone: true,
    }),
    refreshTokenEncrypted: text("refresh_token_encrypted"),
    dekVersion: integer("dek_version").notNull(),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("org_mcp_credentials_org_id_idx").on(t.orgId)]
);

export const agentMcpAssignments = pgTable(
  "agent_mcp_assignments",
  {
    id: pk(),
    agentId: uuid("agent_id").notNull(),
    installationId: uuid("installation_id").notNull(),
  },
  (t) => [index("agent_mcp_assignments_agent_id_idx").on(t.agentId)]
);

export const agentMcpCredentialOverrides = pgTable(
  "agent_mcp_credential_overrides",
  {
    id: pk(),
    agentId: uuid("agent_id").notNull(),
    installationId: uuid("installation_id").notNull(),
    encryptedOauthTokens: text("encrypted_oauth_tokens"),
    encryptedEnvVars: text("encrypted_env_vars"),
    dekVersion: integer("dek_version").notNull(),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("agent_mcp_credential_overrides_agent_id_idx").on(t.agentId)]
);

export const mcpCatalogEntriesRelations = relations(
  mcpCatalogEntries,
  ({ many }) => ({
    installations: many(orgMcpInstallations),
  })
);

export const orgMcpInstallationsRelations = relations(
  orgMcpInstallations,
  ({ one, many }) => ({
    catalogEntry: one(mcpCatalogEntries, {
      fields: [orgMcpInstallations.catalogEntryId],
      references: [mcpCatalogEntries.id],
    }),
    credentials: many(orgMcpCredentials),
    agentAssignments: many(agentMcpAssignments),
  })
);

export const orgMcpCredentialsRelations = relations(
  orgMcpCredentials,
  ({ one }) => ({
    installation: one(orgMcpInstallations, {
      fields: [orgMcpCredentials.installationId],
      references: [orgMcpInstallations.id],
    }),
  })
);

export const agentMcpAssignmentsRelations = relations(
  agentMcpAssignments,
  ({ one }) => ({
    agent: one(agents, {
      fields: [agentMcpAssignments.agentId],
      references: [agents.id],
    }),
    installation: one(orgMcpInstallations, {
      fields: [agentMcpAssignments.installationId],
      references: [orgMcpInstallations.id],
    }),
  })
);

export const agentMcpCredentialOverridesRelations = relations(
  agentMcpCredentialOverrides,
  ({ one }) => ({
    agent: one(agents, {
      fields: [agentMcpCredentialOverrides.agentId],
      references: [agents.id],
    }),
    installation: one(orgMcpInstallations, {
      fields: [agentMcpCredentialOverrides.installationId],
      references: [orgMcpInstallations.id],
    }),
  })
);
