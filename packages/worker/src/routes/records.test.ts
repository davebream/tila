/**
 * Route-level contract tests for GET /records/_types (#295).
 *
 * The listing merges declared types (schema TOML) with in-use types (DO). Each
 * half can fail independently; a failed half must be reported in `incomplete`
 * rather than silently becoming an empty list, "no schema configured" must stay
 * a complete answer, and credentials with namespace restrictions must never
 * learn about schema fetch/parse state.
 */
import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { _clearSchemaCacheForTest } from "../lib/schema-cache";
import type { Env, HonoVariables } from "../types";
import { records } from "./records";

type AppEnv = { Bindings: Env; Variables: HonoVariables };

const MOCK_ENV = {
  ANALYTICS: { writeDataPoint: () => {} },
} as unknown as Env;
const MOCK_CTX = {
  waitUntil: () => {},
  passThroughOnException: () => {},
} as unknown as ExecutionContext;

const PROJECT_ID = "proj-record-types";

const VALID_TOML = `
schema_version = 1

[records.deploy-config]
history = "revision"

[records.feature-flags]
history = "revision"
`;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const schemaOk = (definition = VALID_TOML) =>
  json({ ok: true, schema: { definition }, version: 1 });
const schemaAbsent = () => json({ ok: true, schema: null, version: null });
const inUseOk = (types: string[]) => json({ ok: true, types });
const doError = () =>
  json(
    {
      ok: false,
      error: { code: "internal", message: "boom", retryable: true },
    },
    500,
  );

type Part = () => Response | Promise<Response>;

/** Routes DO requests by path; each half answers independently. */
function makeStub(parts: { schema: Part; inUse: Part }): DurableObjectStub {
  return {
    fetch: vi.fn(async (req: Request | string) => {
      const url = typeof req === "string" ? req : req.url;
      if (url.includes("/schema/current")) return parts.schema();
      if (url.includes("/record/types-in-use")) return parts.inUse();
      throw new Error(`unexpected DO request: ${url}`);
    }),
  } as unknown as DurableObjectStub;
}

const FULL_TOKEN = {
  kind: "d1-token" as const,
  projectId: PROJECT_ID,
  name: "agent",
  tokenId: "tok_1",
  scopes: "full",
};

function scopedToken(restrictions: object) {
  return {
    kind: "d1-token" as const,
    projectId: PROJECT_ID,
    name: "restricted",
    tokenId: "tok_2",
    scopes: "scoped-v1",
    policy: {
      role: "participant",
      capabilities: ["records:read"],
      restrictions,
    },
  };
}

function createApp(
  stub: DurableObjectStub,
  tokenResult: object = FULL_TOKEN,
): Hono<AppEnv> {
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
  app.route("/", records);
  return app;
}

async function getTypes(app: Hono<AppEnv>) {
  const res = await app.request("/_types", undefined, MOCK_ENV, MOCK_CTX);
  const text = await res.text();
  return { status: res.status, text, body: JSON.parse(text) };
}

beforeEach(() => {
  _clearSchemaCacheForTest();
});

describe("GET /records/_types", () => {
  it("returns the exact legacy shape, with no `incomplete`, when nothing failed", async () => {
    const app = createApp(
      makeStub({
        schema: () => schemaOk(),
        inUse: () => inUseOk(["deploy-config", "runtime-flags"]),
      }),
    );

    const { status, text } = await getTypes(app);

    expect(status).toBe(200);
    expect(text).toBe(
      JSON.stringify({
        ok: true,
        types: ["deploy-config", "feature-flags", "runtime-flags"],
        declared_types: ["deploy-config", "feature-flags"],
        in_use_types: ["deploy-config", "runtime-flags"],
      }),
    );
  });

  it("treats a project with no schema as complete, not incomplete", async () => {
    const app = createApp(
      makeStub({ schema: schemaAbsent, inUse: () => inUseOk(["a"]) }),
    );

    const { body } = await getTypes(app);

    expect(body.declared_types).toEqual([]);
    expect(body.types).toEqual(["a"]);
    expect(body).not.toHaveProperty("incomplete");
  });

  it("reports an unavailable schema and still returns the in-use types", async () => {
    const app = createApp(
      makeStub({ schema: doError, inUse: () => inUseOk(["runtime-flags"]) }),
    );

    const { status, body } = await getTypes(app);

    expect(status).toBe(200);
    expect(body.incomplete).toEqual({ declared_types: "unavailable" });
    expect(body.declared_types).toEqual([]);
    expect(body.in_use_types).toEqual(["runtime-flags"]);
    expect(body.types).toEqual(["runtime-flags"]);
  });

  it("reports an unavailable schema when the DO stub throws", async () => {
    const app = createApp(
      makeStub({
        schema: () => {
          throw new Error("DO unreachable");
        },
        inUse: () => inUseOk([]),
      }),
    );

    const { body } = await getTypes(app);

    expect(body.incomplete).toEqual({ declared_types: "unavailable" });
  });

  it("reports a schema that does not parse as invalid", async () => {
    const app = createApp(
      makeStub({
        schema: () => schemaOk("<<< invalid toml >>>"),
        inUse: () => inUseOk(["a"]),
      }),
    );

    const { body } = await getTypes(app);

    expect(body.incomplete).toEqual({ declared_types: "invalid" });
    expect(body.types).toEqual(["a"]);
  });

  it("reports a schema that parses but fails validation as invalid", async () => {
    const app = createApp(
      makeStub({
        schema: () => schemaOk('schema_version = "not-a-number"'),
        inUse: () => inUseOk([]),
      }),
    );

    const { body } = await getTypes(app);

    expect(body.incomplete).toEqual({ declared_types: "invalid" });
  });

  it.each([
    ["a DO error status", () => doError()],
    [
      "a thrown DO error",
      () => {
        throw new Error("DO unreachable");
      },
    ],
    [
      "a non-JSON body",
      () => new Response("upstream exploded", { status: 200 }),
    ],
    ["a malformed success body", () => json({ ok: true })],
  ])(
    "reports unavailable in-use types on %s and keeps declared types",
    async (_name, inUse) => {
      const app = createApp(makeStub({ schema: () => schemaOk(), inUse }));

      const { status, body } = await getTypes(app);

      expect(status).toBe(200);
      expect(body.incomplete).toEqual({ in_use_types: "unavailable" });
      expect(body.in_use_types).toEqual([]);
      expect(body.declared_types).toEqual(["deploy-config", "feature-flags"]);
    },
  );

  it("reports both halves when both fail", async () => {
    const app = createApp(makeStub({ schema: doError, inUse: doError }));

    const { status, body } = await getTypes(app);

    expect(status).toBe(200);
    expect(body.types).toEqual([]);
    expect(body.incomplete).toEqual({
      declared_types: "unavailable",
      in_use_types: "unavailable",
    });
  });

  it("does not cache a failure: a later request after recovery is complete", async () => {
    let schemaUp = false;
    const app = createApp(
      makeStub({
        schema: () => (schemaUp ? schemaOk() : doError()),
        inUse: () => inUseOk([]),
      }),
    );

    const first = await getTypes(app);
    schemaUp = true;
    const second = await getTypes(app);

    expect(first.body.incomplete).toEqual({ declared_types: "unavailable" });
    expect(second.body).not.toHaveProperty("incomplete");
    expect(second.body.declared_types).toEqual([
      "deploy-config",
      "feature-flags",
    ]);
  });
});

describe("GET /records/_types for credentials with namespace restrictions", () => {
  it("filters types and never reports `incomplete` for a record-restricted credential", async () => {
    const app = createApp(
      makeStub({ schema: doError, inUse: doError }),
      scopedToken({ records: [{ type: "deploy-config" }] }),
    );

    const { status, body } = await getTypes(app);

    expect(status).toBe(200);
    expect(body).not.toHaveProperty("incomplete");
    expect(body.types).toEqual([]);
  });

  it("never reports `incomplete` for a task_types-only credential", async () => {
    const app = createApp(
      makeStub({ schema: doError, inUse: () => inUseOk(["a"]) }),
      scopedToken({ task_types: ["task"] }),
    );

    const { body } = await getTypes(app);

    expect(body).not.toHaveProperty("incomplete");
    expect(body.in_use_types).toEqual(["a"]);
  });

  it("still filters healthy results to the permitted types", async () => {
    const app = createApp(
      makeStub({
        schema: () => schemaOk(),
        inUse: () => inUseOk(["deploy-config", "runtime-flags"]),
      }),
      scopedToken({ records: [{ type: "deploy-config" }] }),
    );

    const { body } = await getTypes(app);

    expect(body.types).toEqual(["deploy-config"]);
    expect(body.declared_types).toEqual(["deploy-config"]);
    expect(body.in_use_types).toEqual(["deploy-config"]);
    expect(body).not.toHaveProperty("incomplete");
  });

  it("does not use an unrestricted scoped credential's policy to hide failures", async () => {
    const app = createApp(
      makeStub({ schema: doError, inUse: () => inUseOk([]) }),
      scopedToken({}),
    );

    const { body } = await getTypes(app);

    expect(body.incomplete).toEqual({ declared_types: "unavailable" });
  });
});
