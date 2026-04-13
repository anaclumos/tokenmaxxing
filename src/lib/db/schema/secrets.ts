import {
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { pk } from "./helpers";

export const providerKeys = pgTable(
  "provider_keys",
  {
    id: pk(),
    orgId: text("org_id").notNull(),
    provider: text("provider").notNull(),
    encryptedKey: text("encrypted_key").notNull(),
    dekVersion: integer("dek_version").notNull(),
    validatedAt: timestamp("validated_at", {
      mode: "date",
      withTimezone: true,
    }),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("provider_keys_org_id_idx").on(t.orgId)]
);

export const orgDeks = pgTable(
  "org_deks",
  {
    id: pk(),
    orgId: text("org_id").notNull(),
    encryptedDek: text("encrypted_dek").notNull(),
    kekVersion: integer("kek_version").notNull(),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [uniqueIndex("org_deks_org_id_idx").on(t.orgId)]
);

export const secretAccessLog = pgTable(
  "secret_access_log",
  {
    id: pk(),
    orgId: text("org_id").notNull(),
    accessor: text("accessor").notNull(),
    resourceType: text("resource_type").notNull(),
    timestamp: timestamp("timestamp", { mode: "date", withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("secret_access_log_org_id_idx").on(t.orgId)]
);
