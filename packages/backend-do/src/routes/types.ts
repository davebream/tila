import type { EnrichOpts, schema } from "@tila/ops-sqlite";
import type { DrizzleSqliteDODatabase } from "drizzle-orm/durable-sqlite";
import type { Hono } from "hono";

export type RouterDeps = {
  ctx: DurableObjectState;
  db: DrizzleSqliteDODatabase<typeof schema>;
  enrichOpts: () => EnrichOpts;
};

export type ProjectSubRouter = Hono;
