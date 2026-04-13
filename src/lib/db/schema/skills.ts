import {
  index,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { pk } from "./helpers";

export const companySkills = pgTable(
  "company_skills",
  {
    id: pk(),
    orgId: text("org_id").notNull(),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    content: text("content").notNull(),
    sourceType: text("source_type").notNull(),
    sourceUrl: text("source_url"),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("company_skills_org_id_idx").on(t.orgId)]
);
