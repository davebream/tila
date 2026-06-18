import type { EnrichOpts, schema } from "@tila/ops-sqlite";
import type { DrizzleSqliteDODatabase } from "drizzle-orm/durable-sqlite";
import type { Hono } from "hono";

export type RouterDeps = {
  ctx: DurableObjectState;
  db: DrizzleSqliteDODatabase<typeof schema>;
  enrichOpts: () => EnrichOpts;
};

export type ProjectSubRouter = Hono;

/** Context variable key for the sanitized correlation id threaded by the DO router. */
export const CORRELATION_ID_KEY = "doCorrelationId";
