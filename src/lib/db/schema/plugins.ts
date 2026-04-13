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

export const plugins = pgTable(
  "plugins",
  {
    id: pk(),
    orgId: text("org_id").notNull(),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    manifest: jsonb("manifest"),
    status: text("status").notNull().default("active"),
    installedAt: timestamp("installed_at", {
      mode: "date",
      withTimezone: true,
    })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("plugins_org_id_idx").on(t.orgId)]
);

export const pluginConfig = pgTable(
  "plugin_config",
  {
    id: pk(),
    orgId: text("org_id").notNull(),
    pluginId: uuid("plugin_id").notNull(),
    config: jsonb("config"),
    updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("plugin_config_org_id_idx").on(t.orgId)]
);

export const pluginState = pgTable(
  "plugin_state",
  {
    id: pk(),
    orgId: text("org_id").notNull(),
    pluginId: uuid("plugin_id").notNull(),
    state: jsonb("state"),
    updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("plugin_state_org_id_idx").on(t.orgId)]
);

export const pluginsRelations = relations(plugins, ({ many }) => ({
  configs: many(pluginConfig),
  states: many(pluginState),
}));

export const pluginConfigRelations = relations(pluginConfig, ({ one }) => ({
  plugin: one(plugins, {
    fields: [pluginConfig.pluginId],
    references: [plugins.id],
  }),
}));

export const pluginStateRelations = relations(pluginState, ({ one }) => ({
  plugin: one(plugins, {
    fields: [pluginState.pluginId],
    references: [plugins.id],
  }),
}));
