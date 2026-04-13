import { uuid } from "drizzle-orm/pg-core";
import { v7 as uuidv7 } from "uuid";

export const pk = () =>
  uuid("id")
    .primaryKey()
    .notNull()
    .$defaultFn(() => uuidv7());
