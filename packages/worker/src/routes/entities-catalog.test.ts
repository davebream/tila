import type { WorkCatalogResponse } from "@tila/schemas";
import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { _clearSchemaCacheForTest } from "../lib/schema-cache";
import type { Env, HonoVariables } from "../types";
import { entities } from "./entities";

/** Route-level tests for the work type catalog (#300). */

type AppEnv = { Bindings: Env; Variables: HonoVariables };

const MOCK_ENV = {
  ANALYTICS: { writeDataPoint: () => {} },
} as unknown as Env;
const MOCK_CTX = {
  waitUntil: () => {},
  passThroughOnException: () => {},
} as unknown as ExecutionContext;

const PROJECT_ID = "proj-work-catalog";

const TOML = `
schema_version = 1

[work_units.story]
fields = [
  { name = "headline", type = "string" },
  { name = "state", type = "enum", values = ["queued", "shipped"] },
]
presentation = { title = "headline" }

[work_units.story.lifecycle]
field = "state"
dispatchable = ["queued"]
terminal = ["shipped"]
dependency_satisfied = ["shipped"]

[work_units.spike]
fields = []
`;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function makeStub(parts: {
  schema: () => Response;
  counts: () => Response;
  get?: (url: string) => Response;
}) {
  return {
    fetch: vi.fn(async (req: Request | string) => {
      const url = typeof req === "string" ? req : req.url;
      if (url.includes("/schema/current")) return parts.schema();
      if (url.includes("/entity/type-counts")) return parts.counts();
      if (parts.get && url.includes("/entity/get/")) return parts.get(url);
      throw new Error(`unexpected DO request: ${url}`);
    }),
  } as unknown as DurableObjectStub;
}

function createApp(stub: DurableObjectStub, tokenResult: object) {
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("doStub", stub);
    c.set("projectId", PROJECT_ID);
    c.set("tokenResult", tokenResult as never);
    c.set("principalId", "token:tok_test");
    c.set("participantId", "test-participant");
    c.set("environment", { client_name: "cli", client_version: "test" });
    await next();
  });
  app.route("/", entities);
  return app;
}

const FULL_TOKEN = {
  kind: "d1-token" as const,
  projectId: PROJECT_ID,
  name: "agent",
  tokenId: "tok_1",
  scopes: "full",
};

const schemaOk = () =>
  json({ ok: true, schema: { definition: TOML }, version: 1 });
const counts = (rows: object[]) => () => json({ ok: true, counts: rows });

beforeEach(() => {
  _clearSchemaCacheForTest();
});

describe("GET /tasks/~/types", () => {
  it("lists declared empty types and undeclared in-use types with definitions", async () => {
    const app = createApp(
      makeStub({
        schema: schemaOk,
        counts: counts([
          { type: "bug", count: 3, archived_count: 1 },
          { type: "story", count: 2, archived_count: 0 },
        ]),
      }),
      FULL_TOKEN,
    );
    const res = await app.request("/~/types", undefined, MOCK_ENV, MOCK_CTX);
    expect(res.status).toBe(200);
    const body = (await res.json()) as WorkCatalogResponse;
    expect(body.ok).toBe(true);
    expect(body.scope).toEqual({ restricted: false });
    expect(body).not.toHaveProperty("incomplete");
    expect(
      body.types.map(
        (t: { type: string; declaration: string; count: number }) => [
          t.type,
          t.declaration,
          t.count,
        ],
      ),
    ).toEqual([
      ["bug", "undeclared", 3],
      ["spike", "declared", 0],
      ["story", "declared", 2],
    ]);
    const story = body.types.find((t) => t.type === "story");
    expect(story?.definition?.presentation).toEqual({ title: "headline" });
    expect(story?.definition?.lifecycle?.field).toBe("state");
    expect(story?.definition?.fields.map((f) => f.name)).toEqual([
      "headline",
      "state",
    ]);
  });

  it("reports unavailable counts and an unavailable schema separately", async () => {
    const app = createApp(
      makeStub({
        schema: () => json({ ok: false }, 500),
        counts: () => json({ ok: false }, 500),
      }),
      FULL_TOKEN,
    );
    const body = (await (
      await app.request("/~/types", undefined, MOCK_ENV, MOCK_CTX)
    ).json()) as WorkCatalogResponse;
    expect(body.types).toEqual([]);
    expect(body.incomplete).toEqual({
      declared_types: "unavailable",
      in_use_types: "unavailable",
    });
  });

  it("hides forbidden declared types and schema state from a restricted credential", async () => {
    const app = createApp(
      makeStub({
        schema: schemaOk,
        counts: counts([{ type: "story", count: 1, archived_count: 0 }]),
      }),
      {
        ...FULL_TOKEN,
        scopes: "scoped-v1",
        policy: {
          role: "viewer",
          capabilities: ["tasks:read"],
          restrictions: { task_types: ["story"] },
        },
      },
    );
    const body = (await (
      await app.request("/~/types", undefined, MOCK_ENV, MOCK_CTX)
    ).json()) as WorkCatalogResponse;
    expect(body.types.map((t: { type: string }) => t.type)).toEqual(["story"]);
    expect(body.scope).toEqual({ restricted: true });
  });

  it("still routes a task whose id is `_types` to the task detail", async () => {
    const stub = makeStub({
      schema: schemaOk,
      counts: counts([]),
      get: (url) => json({ ok: true, entity: { id: url.split("/").pop() } }),
    });
    const app = createApp(stub, FULL_TOKEN);
    const res = await app.request("/_types", undefined, MOCK_ENV, MOCK_CTX);
    const body = (await res.json()) as { entity: { id: string } };
    expect(body.entity.id).toBe("_types");
  });
});
