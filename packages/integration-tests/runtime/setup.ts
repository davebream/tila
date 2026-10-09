import { type D1Migration, applyD1Migrations, reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, vi } from "vitest";

export const bindings = env as unknown as {
  PROJECT: DurableObjectNamespace;
  MIGRATION: DurableObjectNamespace;
  DB: D1Database;
  ARTIFACTS: R2Bucket;
  TEST_MIGRATIONS: D1Migration[];
  GITHUB_SESSION_HMAC_KEY: string;
  HASH_PEPPER: string;
};

beforeEach(async () => {
  await reset();
  vi.spyOn(globalThis, "fetch").mockRejectedValue(
    new Error("Unexpected outbound network call"),
  );
  await applyD1Migrations(bindings.DB, bindings.TEST_MIGRATIONS);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await reset();
});
