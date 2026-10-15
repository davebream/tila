import type { CredentialPolicy, RecordMetaResponse } from "@tila/schemas";
import { RecordMetaResponseSchema } from "@tila/schemas";
import { Hono } from "hono";
import { TilaClient, createRecordMethods, isTilaApiError } from "tila-sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createProjectRouter } from "../../worker/src/do/project-do-router";
import type { RouterDeps } from "../../worker/src/do/routes/types";
import { capabilityMiddleware } from "../../worker/src/middleware/capability";
import { errorHandler } from "../../worker/src/middleware/error";
import { records } from "../../worker/src/routes/records";
import type { Env, HonoVariables } from "../../worker/src/types";
import {
  type TestDb,
  createTestDb,
} from "../../worker/test/do/helpers/create-test-db";

// Metadata-only record reads (`GET /records/:type/:key?meta=1`) through the
// Worker middleware, the real Durable Object router and the SDK client. The
// stored value and tag are seeded under distinct markers so a leak through any
// response is a plain substring failure.

const PROJECT = "p1";
const CAPS = ["records:read", "records:write", "records:delete"] as const;
const base = { role: "participant" as const, capabilities: [...CAPS] };
const Q = [{ type: "question", key_prefixes: ["q1"] }];
const A = [{ type: "answer", key_prefixes: ["a1"] }];

const POLICIES: Record<string, CredentialPolicy> = {
  full: { ...base },
  // Read answers, write questions.
  split: { ...base, restrictions: { records_read: A, records_write: Q } },
  "write-only": { ...base, restrictions: { records_write: Q } },
  "read-only": { ...base, restrictions: { records_read: A } },
  legacy: { ...base, restrictions: { records: [...Q, ...A] } },
  "no-read-capability": {
    role: "participant",
    capabilities: CAPS.filter((cap) => cap !== "records:read"),
    restrictions: { records_read: A, records_write: A },
  },
};

const IDENT = {
  principal_id: "seed",
  participant_id: "seed",
  environment: {},
  actor: "seed",
};
const SECRETS = {
  value: "ANSWER-SECRET-VALUE",
  tag: "stored-tag-secret",
  question: "QUESTION-SECRET-VALUE",
};
const SLASH_KEY = "a1/Deep.er/k_e-y/v1.2";

let db: TestDb;
let doApp: ReturnType<typeof createProjectRouter>;
let app: Hono<{ Bindings: Env; Variables: HonoVariables }>;
const env = { ANALYTICS: { writeDataPoint: () => {} } } as unknown as Env;
const executionCtx = {
  waitUntil: vi.fn(),
  passThroughOnException: vi.fn(),
} as unknown as ExecutionContext;

async function seed(
  path: string,
  body: Record<string, unknown>,
): Promise<{ fence: number; revision: number }> {
  const res = await doApp.request(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...body, ...IDENT }),
  });
  const json = (await res.json()) as { fence: number; revision: number };
  expect(res.status, JSON.stringify(json)).toBeLessThan(300);
  return json;
}

beforeEach(async () => {
  db = createTestDb();
  doApp = createProjectRouter({
    db: db.db as RouterDeps["db"],
    ctx: {
      storage: {
        sql: {
          exec: (s: string, ...bindings: unknown[]) => ({
            toArray: () => db.sqlite.prepare(s).all(...bindings),
          }),
        },
        getAlarm: vi.fn(async () => null),
        setAlarm: vi.fn(async () => {}),
      },
    } as unknown as DurableObjectState,
    enrichOpts: vi.fn(),
  } as unknown as RouterDeps);

  app = new Hono();
  app.onError(errorHandler);
  app.use("*", async (c, next) => {
    const name = (c.req.header("Authorization") ?? "Bearer full").slice(7);
    const policy = POLICIES[name];
    if (!policy) return c.json({ error: `unknown test policy ${name}` }, 500);
    c.set("tokenResult", {
      kind: "d1-token",
      projectId: PROJECT,
      name,
      tokenId: name,
      scopes: "scoped-v1",
      policy,
    });
    c.set("projectId", PROJECT);
    c.set("principalId", `token:${name}`);
    c.set("participantId", `participant-${name}`);
    c.set("environment", {});
    c.set("doStub", {
      fetch: (request: Request) => doApp.fetch(request),
    } as DurableObjectStub);
    await next();
  });
  app.use("*", capabilityMiddleware());
  app.route("/projects/:projectId/records", records);

  await seed("/record/answer/create", {
    key: "a1/x",
    value: { note: SECRETS.value },
    tags: [SECRETS.tag],
  });
  await seed("/record/answer/create", {
    key: SLASH_KEY,
    value: { note: SECRETS.value },
  });
  await seed("/record/answer/create", { key: "z9/out", value: { v: 1 } });
  await seed("/record/question/create", {
    key: "q1/old",
    value: { note: SECRETS.question },
    tags: [SECRETS.tag],
  });
});
afterEach(() => db.sqlite.close());

async function call(
  policy: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<Response> {
  return app.request(
    `/projects/${PROJECT}${path}`,
    {
      method,
      headers: {
        Authorization: `Bearer ${policy}`,
        "Content-Type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
    env,
    executionCtx,
  );
}

async function metaOf(
  policy: string,
  path: string,
): Promise<RecordMetaResponse["meta"]> {
  const res = await call(policy, "GET", `${path}?meta=1`);
  const text = await res.text();
  expect(res.status, text).toBe(200);
  return RecordMetaResponseSchema.parse(JSON.parse(text)).meta;
}

function sdkAs(policy: string) {
  const client = new TilaClient({
    baseUrl: "http://tila.test",
    token: policy,
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(
        typeof input === "string" || input instanceof URL
          ? input.toString()
          : input.url,
      );
      return app.request(
        `${url.pathname}${url.search}`,
        {
          ...init,
          headers: {
            ...(init?.headers as Record<string, string>),
            Authorization: `Bearer ${policy}`,
          },
        },
        env,
        executionCtx,
      );
    }) as typeof fetch,
  });
  return createRecordMethods(client, PROJECT);
}

function leaks(text: string): string[] {
  return Object.values(SECRETS).filter((secret) => text.includes(secret));
}

describe("metadata-only read", () => {
  it("returns revision, fence, hash, update time and archived state without the value", async () => {
    const full = (await (
      await call("full", "GET", "/records/answer/a1/x")
    ).json()) as {
      record: {
        revision: number;
        value_sha256: string;
        updated_at: number;
        archived: number;
      };
      fence: number;
    };

    const res = await call("full", "GET", "/records/answer/a1/x?meta=1");
    const text = await res.text();

    expect(res.status, text).toBe(200);
    expect(JSON.parse(text)).toEqual({
      ok: true,
      meta: {
        type: "answer",
        key: "a1/x",
        revision: full.record.revision,
        fence: full.fence,
        value_sha256: full.record.value_sha256,
        updated_at: full.record.updated_at,
        archived: full.record.archived,
      },
    });
    expect(leaks(text)).toEqual([]);
    expect(text).not.toContain('"value"');
    expect(text).not.toContain('"tags"');
  });

  it("leaves the ordinary read byte-identical, with or without unrelated query parameters", async () => {
    const plain = await call("full", "GET", "/records/answer/a1/x");
    const plainText = await plain.text();
    const withQuery = await call(
      "full",
      "GET",
      "/records/answer/a1/x?unrelated=1",
    );

    expect(plain.status).toBe(200);
    const body = JSON.parse(plainText) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["fence", "ok", "record"]);
    expect(body).not.toHaveProperty("meta");
    expect(plainText).toContain(SECRETS.value);
    expect(await withQuery.text()).toBe(plainText);
  });

  it("never pairs an old revision with a new fence across a run of fenced writes", async () => {
    let meta = await metaOf("full", "/records/answer/a1/x");
    expect(meta.fence).toBe(meta.revision);
    const seen = [meta];

    for (const note of ["one", "two", "three"]) {
      const put = await call("full", "PUT", "/records/answer/a1/x", {
        value: { note },
        fence: meta.fence,
      });
      expect(put.status, await put.clone().text()).toBe(200);
      const next = await metaOf("full", "/records/answer/a1/x");
      expect(next.revision).toBe(meta.revision + 1);
      expect(next.fence).toBe(meta.fence + 1);
      expect(next.value_sha256).not.toBe(meta.value_sha256);
      expect(next.updated_at).toBeGreaterThanOrEqual(meta.updated_at);
      meta = next;
      seen.push(meta);
    }

    expect(seen.map((m) => [m.revision, m.fence])).toEqual([
      [1, 1],
      [2, 2],
      [3, 3],
      [4, 4],
    ]);
  });

  it("returns the fence a fenced write accepts and refuses the one it superseded", async () => {
    const before = await metaOf("full", "/records/answer/a1/x");
    const ok = await call("full", "PUT", "/records/answer/a1/x", {
      value: { note: "next" },
      fence: before.fence,
    });
    expect(ok.status).toBe(200);

    const stale = await call("full", "PUT", "/records/answer/a1/x", {
      value: { note: "late" },
      fence: before.fence,
    });
    expect(stale.status).toBe(409);
    expect((await metaOf("full", "/records/answer/a1/x")).fence).toBe(
      before.fence + 1,
    );
  });

  it("reflects an archive and an unarchive", async () => {
    const created = await metaOf("full", "/records/question/q1/old");
    expect(created.archived).toBe(0);

    const archive = await call(
      "full",
      "POST",
      "/records/question/~/archive/q1/old",
      { fence: created.fence },
    );
    expect(archive.status, await archive.clone().text()).toBe(200);
    const archived = await metaOf("full", "/records/question/q1/old");
    expect(archived).toMatchObject({
      archived: 1,
      revision: created.revision + 1,
      fence: created.fence + 1,
      value_sha256: created.value_sha256,
    });

    const unarchive = await call(
      "full",
      "POST",
      "/records/question/~/unarchive/q1/old",
      { fence: archived.fence },
    );
    expect(unarchive.status, await unarchive.clone().text()).toBe(200);
    expect(await metaOf("full", "/records/question/q1/old")).toMatchObject({
      archived: 0,
      revision: archived.revision + 1,
      fence: archived.fence + 1,
    });
  });

  it("answers a missing record exactly as the ordinary read does", async () => {
    const plain = await call("full", "GET", "/records/answer/a1/absent");
    const meta = await call("full", "GET", "/records/answer/a1/absent?meta=1");

    expect(meta.status).toBe(404);
    expect(plain.status).toBe(404);
    expect(await meta.json()).toEqual(await plain.json());
  });

  it.each(["meta=true", "meta=0", "meta=", "meta=1&meta=1"])(
    "rejects %s with a 400 that carries no record data",
    async (query) => {
      const res = await call("full", "GET", `/records/answer/a1/x?${query}`);
      const text = await res.text();

      expect(res.status, text).toBe(400);
      expect(JSON.parse(text)).toMatchObject({
        ok: false,
        error: { code: "validation-error" },
      });
      expect(leaks(text)).toEqual([]);
    },
  );
});

describe("read-side authorization of the metadata read", () => {
  it.each(["split", "read-only", "legacy", "full"])(
    "lets %s read the metadata of an answer it may read",
    async (policy) => {
      const meta = await metaOf(policy, "/records/answer/a1/x");
      expect(meta).toMatchObject({ type: "answer", key: "a1/x", revision: 1 });
    },
  );

  it.each([
    ["write-only", "/records/question/q1/old"],
    ["split", "/records/question/q1/old"],
    ["read-only", "/records/question/q1/old"],
    ["read-only", "/records/answer/z9/out"],
    ["legacy", "/records/answer/z9/out"],
    ["no-read-capability", "/records/answer/a1/x"],
  ])(
    "gives %s the same denial as the ordinary read on %s, leaking nothing",
    async (policy, path) => {
      const plain = await call(policy, "GET", path);
      const meta = await call(policy, "GET", `${path}?meta=1`);
      const text = await meta.text();

      expect(plain.status).toBe(403);
      expect(meta.status).toBe(403);
      expect(JSON.parse(text)).toEqual(await plain.json());
      expect(leaks(text)).toEqual([]);
      expect(text).not.toContain("revision");
      expect(text).not.toContain("fence");
      expect(text).not.toContain("value_sha256");
    },
  );

  it("does not let a write-only credential tell a missing key from an existing one", async () => {
    const existing = await call(
      "write-only",
      "GET",
      "/records/question/q1/old?meta=1",
    );
    const missing = await call(
      "write-only",
      "GET",
      "/records/question/q1/none?meta=1",
    );

    expect(existing.status).toBe(403);
    expect(missing.status).toBe(403);
    expect(await existing.json()).toEqual(await missing.json());
  });

  it("does not let an out-of-prefix key reveal existence either", async () => {
    const existing = await call(
      "read-only",
      "GET",
      "/records/answer/z9/out?meta=1",
    );
    const missing = await call(
      "read-only",
      "GET",
      "/records/answer/z9/gone?meta=1",
    );

    expect(existing.status).toBe(403);
    expect(await existing.json()).toEqual(await missing.json());
  });

  it("authorizes before validating, so an invalid meta from a denied key is a 403", async () => {
    const plain = await call("write-only", "GET", "/records/question/q1/old");
    const bad = await call(
      "write-only",
      "GET",
      "/records/question/q1/old?meta=bogus",
    );

    expect(bad.status).toBe(403);
    expect(await bad.json()).toEqual(await plain.json());
  });
});

describe("SDK records.meta", () => {
  it("returns the typed metadata for a plain key", async () => {
    const result = await sdkAs("full").meta("answer", "a1/x");

    expect(result.ok).toBe(true);
    expect(result.meta).toMatchObject({
      type: "answer",
      key: "a1/x",
      revision: 1,
      fence: 1,
      archived: 0,
    });
    expect(result.meta.value_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(RecordMetaResponseSchema.parse(result)).toEqual(result);
    expect(leaks(JSON.stringify(result))).toEqual([]);
  });

  it("works for a key with several slash segments and dots", async () => {
    const result = await sdkAs("full").meta("answer", SLASH_KEY);

    expect(result.meta).toMatchObject({
      type: "answer",
      key: SLASH_KEY,
      revision: 1,
    });
  });

  it("raises the ordinary 404 for a missing record", async () => {
    const error = await sdkAs("full")
      .meta("answer", "a1/absent")
      .catch((e: unknown) => e);

    expect(isTilaApiError(error)).toBe(true);
    expect(error).toMatchObject({ status: 404, code: "not-found" });
  });

  it("raises the ordinary 403 for a write-only credential", async () => {
    const records = sdkAs("write-only");
    const plain = await records
      .get("question", "q1/old")
      .catch((e: unknown) => e);
    const meta = await records
      .meta("question", "q1/old")
      .catch((e: unknown) => e);

    expect(isTilaApiError(meta)).toBe(true);
    expect(meta).toMatchObject({ status: 403 });
    expect(meta).toMatchObject({
      status: (plain as { status: number }).status,
      code: (plain as { code: string }).code,
      message: (plain as { message: string }).message,
    });
  });
});
