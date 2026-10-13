import { Hono } from "hono";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { installProjectErrorHandlers } from "../../src/do/routes/errors";
import { createSchemaRoutes } from "../../src/do/routes/schema-routes";
import type { RouterDeps } from "../../src/do/routes/types";
import { type TestDb, createTestDb } from "./helpers/create-test-db";

let fixture: TestDb;
let app: Hono;
beforeEach(() => {
  fixture = createTestDb();
  app = new Hono();
  installProjectErrorHandlers(app);
  app.route(
    "/",
    createSchemaRoutes({
      db: fixture.db as RouterDeps["db"],
      ctx: {} as DurableObjectState,
      enrichOpts: vi.fn(),
    }),
  );
});
afterEach(() => fixture.sqlite.close());

const INVALID = `
schema_version = 1
[work_units.task]
fields = [{ name = "title", type = "string" }]
[templates.release.entities.root]
id_suffix = "root"
type = "missing"
`;

function post(path: string, body: unknown) {
  return app.request(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

it.each([
  ["/schema/preview", { definition: INVALID }],
  [
    "/schema/apply",
    {
      definition: INVALID,
      applied_by: "test",
      principal_id: "maintainer",
      participant_id: "maintainer-ui",
    },
  ],
])("%s returns each definition error with its path", async (path, body) => {
  const response = await post(path, body);
  expect(response.status).toBe(400);
  const json = (await response.json()) as {
    error: { code: string; errors: { path?: string; message: string }[] };
  };
  expect(json.error.code).toBe("schema-parse-error");
  expect(json.error.errors).toContainEqual({
    message: 'references unknown work-unit type "missing"',
    path: "templates.release.entities.root.type",
  });
});

it("returns the TOML position of a syntax error", async () => {
  const response = await post("/schema/preview", {
    definition: "schema_version = \n",
  });
  const json = (await response.json()) as {
    error: { errors: { line?: number }[] };
  };
  expect(json.error.errors[0].line).toBeGreaterThan(0);
});
