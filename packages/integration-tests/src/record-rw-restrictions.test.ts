import {
  type CredentialPolicy,
  McpPrimitiveResults,
  McpWorkflowResults,
  RecordWriteResponseSchema,
  isRecordWriteReceipt,
} from "@tila/schemas";
import { Hono } from "hono";
import {
  TilaClient,
  createClaimMethods,
  createRecordMethods,
  isTilaApiError,
} from "tila-sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createProjectRouter } from "../../worker/src/do/project-do-router";
import type { RouterDeps } from "../../worker/src/do/routes/types";
import { capabilityMiddleware } from "../../worker/src/middleware/capability";
import { errorHandler } from "../../worker/src/middleware/error";
import { claims } from "../../worker/src/routes/claims";
import { records } from "../../worker/src/routes/records";
import { search } from "../../worker/src/routes/search";
import type { Env, HonoVariables } from "../../worker/src/types";
import {
  type TestDb,
  createTestDb,
} from "../../worker/test/do/helpers/create-test-db";

// Record read and write restrictions through the Worker middleware, the real
// Durable Object router and the SDK client. Secrets are seeded under distinct
// markers so a leak through any response is a plain substring failure.

const PROJECT = "p1";
const CAPS = [
  "records:read",
  "records:write",
  "records:delete",
  "claims:read",
  "claims:acquire",
  "claims:renew",
  "claims:release",
  "search:read",
] as const;
const base = {
  role: "participant" as const,
  capabilities: [...CAPS],
};
const Q = [{ type: "question", key_prefixes: ["q1"] }];
const A = [{ type: "answer", key_prefixes: ["a1"] }];

// The issue's example: read answers, write questions, nothing else.
const POLICIES: Record<string, CredentialPolicy> = {
  full: { ...base },
  legacy: { ...base, restrictions: { records: [...Q, ...A] } },
  split: { ...base, restrictions: { records_read: A, records_write: Q } },
  "write-only": { ...base, restrictions: { records_write: Q } },
  "read-only": { ...base, restrictions: { records_read: A } },
  "empty-read": {
    ...base,
    restrictions: { records_read: [], records_write: Q },
  },
  "no-read-capability": {
    role: "participant",
    capabilities: CAPS.filter((cap) => cap !== "records:read"),
    restrictions: { records_read: Q, records_write: Q },
  },
  "write-ghost": {
    ...base,
    restrictions: { records_write: [{ type: "ghost" }] },
  },
  "legacy-ghost": { ...base, restrictions: { records: [{ type: "ghost" }] } },
};

const IDENT = {
  principal_id: "seed",
  participant_id: "seed",
  environment: {},
  actor: "seed",
};
const SECRETS = {
  answer: "ANSWER-SECRET-VALUE",
  question: "QUESTION-OLD-SECRET",
  archived: "ARCHIVED-SECRET",
  outside: "OUTSIDE-SECRET",
  tag: "stored-tag-secret",
};

let db: TestDb;
let doApp: ReturnType<typeof createProjectRouter>;
let app: Hono<{ Bindings: Env; Variables: HonoVariables }>;
const env = { ANALYTICS: { writeDataPoint: () => {} } } as unknown as Env;
const executionCtx = {
  waitUntil: vi.fn(),
  passThroughOnException: vi.fn(),
} as unknown as ExecutionContext;

function post(body: unknown): RequestInit {
  return {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}
async function seed(
  path: string,
  body: Record<string, unknown>,
): Promise<{ fence: number }> {
  const res = await doApp.request(path, post({ ...body, ...IDENT }));
  const json = (await res.json()) as { fence: number };
  expect(res.status, JSON.stringify(json)).toBeLessThan(300);
  return json;
}

beforeEach(async () => {
  db = createTestDb();
  const deps = {
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
  } as unknown as RouterDeps;
  doApp = createProjectRouter(deps);

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
  app.route("/projects/:projectId/claims", claims);
  app.route("/projects/:projectId/search", search);

  await seed("/record/answer/create", {
    key: "a1/x",
    value: { note: SECRETS.answer },
    tags: ["answer-tag"],
  });
  await seed("/record/question/create", {
    key: "q1/old",
    value: { note: SECRETS.question },
    tags: [SECRETS.tag],
  });
  const archived = await seed("/record/question/create", {
    key: "q1/arch",
    value: { note: SECRETS.archived },
    tags: [SECRETS.tag],
  });
  await seed("/record/question/q1/arch/archive", { fence: archived.fence });
  await seed("/record/question/create", {
    key: "q2/outside",
    value: { note: SECRETS.outside },
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
  return {
    records: createRecordMethods(client, PROJECT),
    claims: createClaimMethods(client, PROJECT),
  };
}
async function acquire(policy: string, resource: string) {
  const sdk = sdkAs(policy);
  return (await sdk.claims.acquire(resource, "exclusive", 60_000)).fence;
}
function leaks(text: string): string[] {
  return Object.values(SECRETS).filter((secret) => text.includes(secret));
}

describe("the split policy of the issue (read answers, write questions)", () => {
  it("reads an answer and refuses to write one", async () => {
    const read = await call("split", "GET", "/records/answer/a1/x");
    expect(read.status).toBe(200);
    expect(JSON.stringify(await read.json())).toContain(SECRETS.answer);

    const write = await call("split", "POST", "/records/answer", {
      key: "a1/new",
      value: { v: 1 },
    });
    expect(write.status).toBe(403);
  });

  it("writes a question and refuses to read one", async () => {
    const write = await call("split", "POST", "/records/question", {
      key: "q1/new",
      value: { v: 1 },
    });
    expect(write.status).toBe(201);

    for (const path of [
      "/records/question/q1/new",
      "/records/question/~/history/q1/new",
    ])
      expect((await call("split", "GET", path)).status, path).toBe(403);
  });

  it("learns nothing of the other side through list, catalog, search or history", async () => {
    const list = await call("split", "GET", "/records/question");
    const listBody = await list.json();
    expect(listBody).toMatchObject({ items: [], meta: { total: 0 } });

    const answers = await call("split", "GET", "/records/answer");
    const answerBody = (await answers.json()) as {
      items: { key: string }[];
    };
    expect(answerBody.items.map((i) => i.key)).toEqual(["a1/x"]);

    const catalog = await call("split", "GET", "/records/_types");
    const catalogBody = (await catalog.json()) as {
      types: string[];
      in_use_types: string[];
      entries: { type: string; count: number }[];
    };
    expect(catalogBody.types).toEqual(["answer"]);
    expect(catalogBody.entries.map((e) => e.type)).toEqual(["answer"]);

    for (const q of ["QUESTION", "ARCHIVED", "OUTSIDE", "ANSWER"]) {
      const found = await call(
        "split",
        "GET",
        `/search?q=${q}&kind=record&syntax=literal`,
      );
      const text = JSON.stringify(await found.json());
      expect(found.status, text).toBe(200);
      expect(leaks(text).filter((s) => s !== SECRETS.answer)).toEqual([]);
      expect(text.includes("question")).toBe(false);
    }
  });

  it("splits claim acquire/renew/release (write) from state/list (read)", async () => {
    // The write side acquires and releases a question claim ...
    const q = await call("split", "POST", "/claims/acquire", {
      resource: "record:question/q1/old",
      mode: "exclusive",
      ttl_ms: 60_000,
    });
    expect(q.status).toBe(200);
    const { fence } = (await q.json()) as { fence: number };
    // ... but cannot read its state nor see it in the listing.
    expect(
      (
        await call(
          "split",
          "GET",
          `/claims/state/${encodeURIComponent("record:question/q1/old")}`,
        )
      ).status,
    ).toBe(403);
    const listed = await call("split", "GET", "/claims");
    expect(JSON.stringify(await listed.json())).not.toContain("question");
    expect(
      (
        await call("split", "POST", "/claims/release", {
          resource: "record:question/q1/old",
          fence,
        })
      ).status,
    ).toBe(200);

    // The read side sees an answer claim held by someone else but cannot
    // take, renew or release it.
    const held = await call("full", "POST", "/claims/acquire", {
      resource: "record:answer/a1/x",
      mode: "exclusive",
      ttl_ms: 60_000,
    });
    const heldFence = ((await held.json()) as { fence: number }).fence;
    const state = await call(
      "split",
      "GET",
      `/claims/state/${encodeURIComponent("record:answer/a1/x")}`,
    );
    expect(state.status).toBe(200);
    expect(
      JSON.stringify(
        await call("split", "GET", "/claims").then((r) => r.json()),
      ),
    ).toContain("record:answer/a1/x");
    for (const [path, body] of [
      ["/claims/acquire", { mode: "exclusive", ttl_ms: 1000 }],
      ["/claims/renew", { fence: heldFence, ttl_ms: 1000 }],
      ["/claims/release", { fence: heldFence }],
    ] as const)
      expect(
        (
          await call("split", "POST", path, {
            resource: "record:answer/a1/x",
            ...body,
          })
        ).status,
        path,
      ).toBe(403);
  });
});

describe("a credential that may write a record but not read it", () => {
  it("gets only type, key and fence back from set and put on an existing record", async () => {
    const fence = await acquire("write-only", "record:question/q1/old");
    const sdk = sdkAs("write-only");

    const set = await sdk.records.set("question", "q1/old", {
      value: { note: "replaced" },
      fence,
    });
    // `tags` omitted on a record that stores one: the stored tag must not
    // come back, nor created_at / archived / any server-derived field.
    expect(set).toEqual({
      ok: true,
      receipt: true,
      type: "question",
      key: "q1/old",
      fence: expect.any(Number),
    });
    expect(Object.keys(set).sort()).toEqual(
      ["fence", "key", "ok", "receipt", "type"].sort(),
    );

    const put = await sdk.records.put("question", "q1/old", {
      value: { note: "replaced again" },
    });
    expect(put).toEqual({
      ok: true,
      receipt: true,
      type: "question",
      key: "q1/old",
      fence: expect.any(Number),
    });

    // put over an archived record leaves it archived, and says nothing of it.
    const archivedPut = await sdk.records.put("question", "q1/arch", {
      value: { note: "again" },
    });
    expect(Object.keys(archivedPut).sort()).toEqual(
      ["fence", "key", "ok", "receipt", "type"].sort(),
    );
    expect(leaks(JSON.stringify([set, put, archivedPut]))).toEqual([]);

    // The writes took effect and kept what they did not replace.
    const stored = await doApp.request("/record/question/q1/old");
    const body = (await stored.json()) as {
      record: { value: unknown; tags: string[] };
    };
    expect(body.record.value).toEqual({ note: "replaced again" });
    expect(body.record.tags).toEqual([SECRETS.tag]);
    const archived = (await (
      await doApp.request("/record/question/q1/arch")
    ).json()) as { record: { archived: number } };
    expect(archived.record.archived).toBe(1);
  });

  it("returns the same receipt shape for create, set and put on a new key", async () => {
    const sdk = sdkAs("write-only");
    const created = await sdk.records.create("question", {
      key: "q1/fresh",
      value: { v: 1 },
      tags: ["mine"],
    });
    expect(created).toEqual({
      ok: true,
      receipt: true,
      type: "question",
      key: "q1/fresh",
      fence: expect.any(Number),
    });
    const putNew = await sdk.records.put("question", "q1/fresh2", {
      value: { v: 1 },
    });
    expect(Object.keys(putNew).sort()).toEqual(Object.keys(created).sort());
  });

  it("parses through the SDK types, the response schema and the MCP result schemas", async () => {
    const sdk = sdkAs("write-only");
    const res = await sdk.records.put("question", "q1/old", {
      value: { v: 2 },
    });
    expect(isRecordWriteReceipt(res)).toBe(true);
    expect(RecordWriteResponseSchema.safeParse(res).success).toBe(true);
    expect(McpPrimitiveResults.tila_record_put.safeParse(res).success).toBe(
      true,
    );
    expect(McpPrimitiveResults.tila_record_set.safeParse(res).success).toBe(
      true,
    );
    expect(McpWorkflowResults.tila_publish.safeParse(res).success).toBe(true);
  });

  it("cannot read, list, search, see history, or take patch/archive/unarchive", async () => {
    const fence = await acquire("write-only", "record:question/q1/old");
    for (const [method, path, body] of [
      ["GET", "/records/question/q1/old"],
      ["HEAD", "/records/question/q1/old"],
      ["GET", "/records/question/~/history/q1/old"],
      ["PATCH", "/records/question/q1/old", { patch: { a: 1 }, fence }],
      ["POST", "/records/question/~/archive/q1/old", { fence }],
      ["POST", "/records/question/~/unarchive/q1/arch", { fence }],
    ] as const) {
      const res = await call("write-only", method, path, body);
      expect(res.status, `${method} ${path}`).toBe(403);
      expect(leaks(await res.text())).toEqual([]);
    }
    const list = await call("write-only", "GET", "/records/question");
    expect(await list.json()).toMatchObject({ items: [], meta: { total: 0 } });
    const found = await call(
      "write-only",
      "GET",
      "/search?q=QUESTION&kind=record&syntax=literal",
    );
    expect(JSON.stringify(await found.json())).not.toContain("question");
    const catalog = await call("write-only", "GET", "/records/_types");
    expect(await catalog.json()).toMatchObject({ types: [], entries: [] });
  });

  it("keeps stale-fence and unknown-type errors free of coordination and schema detail", async () => {
    const fence = await acquire("write-only", "record:question/q1/old");
    const stale = await call("write-only", "PUT", "/records/question/q1/old", {
      value: { v: 1 },
      fence: fence + 100,
    });
    expect(stale.status).toBe(409);
    const body = JSON.stringify(await stale.json());
    expect(body).not.toMatch(/current=|claimed=/);
    expect(leaks(body)).toEqual([]);

    // A credential allowed to write any `question/q1` key still gets only
    // what the request itself named when the key already exists.
    const exists = await call("write-only", "POST", "/records/question", {
      key: "q1/old",
      value: { v: 1 },
    });
    expect(exists.status).toBe(409);
    expect(leaks(await exists.text())).toEqual([]);
  });

  it("learns no revision from a write that names a stale expected_revision", async () => {
    // Bring the stored revision to a value the response must not reveal.
    for (let n = 0; n < 6; n++)
      await doApp.request(
        "/record/question/q1/old/put",
        post({ value: { n }, ...IDENT }),
      );
    const stored = (await (
      await doApp.request("/record/question/q1/old")
    ).json()) as { record: { revision: number } };
    expect(stored.record.revision).toBeGreaterThan(5);

    // Record writes carry no expected_revision: it is ignored, not enforced,
    // and nothing about the stored revision comes back.
    const fence = await acquire("write-only", "record:question/q1/old");
    for (const [method, path, body] of [
      [
        "PUT",
        "/records/question/q1/old",
        { value: { v: 1 }, fence, expected_revision: 0 },
      ],
      [
        "POST",
        "/records/question/~/put/q1/old",
        { value: { v: 2 }, expected_revision: 0 },
      ],
    ] as const) {
      const res = await call("write-only", method, path, body);
      const text = await res.text();
      expect(res.status, text).toBe(200);
      expect(Object.keys(JSON.parse(text)).sort()).toEqual(
        ["fence", "key", "ok", "receipt", "type"].sort(),
      );
      expect(text).not.toContain("revision");
      expect(text).not.toContain("updated_");
    }
    // The request reached the DO the same way, with the same outcome.
    const direct = await doApp.request("/record/question/q1/old/put", {
      ...post({ value: { v: 3 }, expected_revision: 0, ...IDENT }),
      headers: {
        "Content-Type": "application/json",
        "X-Tila-Credential-Policy": JSON.stringify(POLICIES["write-only"]),
      },
    });
    const directText = await direct.text();
    expect(direct.status, directText).toBe(200);
    expect(directText).not.toContain("revision");
  });

  it("leaves other declared record types out of an undeclared-type error", async () => {
    db.sqlite
      .prepare(
        "INSERT INTO _schema_history (version, definition, applied_at, applied_by) VALUES (?, ?, ?, ?)",
      )
      .run(
        1,
        [
          "schema_version = 1",
          "",
          "[records.question]",
          'format = "json"',
          'history = "revision"',
          "",
          "[records.hidden-type]",
          'format = "json"',
          'history = "revision"',
        ].join("\n"),
        Date.now(),
        "test",
      );
    for (const [name, listed] of [
      ["write-ghost", false],
      ["legacy-ghost", true],
    ] as const) {
      const res = await call(name, "POST", "/records/ghost", {
        key: "k",
        value: {},
      });
      const body = (await res.json()) as {
        error: { code: string; message: string };
      };
      expect(res.status).toBe(422);
      expect(body.error.code).toBe("constraint-violation");
      expect(body.error.message).toContain('Record type "ghost"');
      // A split policy that may not read learns no other type names; a legacy
      // policy keeps the message it always had.
      expect(body.error.message.includes("hidden-type")).toBe(listed);
    }
  });

  it("also gets a receipt when the read capability is missing", async () => {
    const sdk = sdkAs("no-read-capability");
    const fence = await acquire("no-read-capability", "record:question/q1/old");
    const res = await sdk.records.set("question", "q1/old", {
      value: { v: 3 },
      fence,
    });
    expect(isRecordWriteReceipt(res)).toBe(true);
  });

  it("treats an empty read list as no read access", async () => {
    const res = await call("empty-read", "GET", "/records/question/q1/old");
    expect(res.status).toBe(403);
  });
});

describe("credentials that may read what they write keep the full response", () => {
  it.each(["full", "legacy"])(
    "%s: set returns the whole record",
    async (name) => {
      const sdk = sdkAs(name);
      const fence = await acquire(name, "record:question/q1/old");
      const res = await sdk.records.set("question", "q1/old", {
        value: { note: "mine" },
        fence,
      });
      expect(isRecordWriteReceipt(res)).toBe(false);
      if (isRecordWriteReceipt(res)) return;
      expect(Object.keys(res.record).sort()).toEqual(
        [
          "archived",
          "created_at",
          "key",
          "revision",
          "schema_version",
          "tags",
          "type",
          "updated_at",
          "updated_by",
          "value",
          "value_sha256",
        ].sort(),
      );
      // The stored tags still come back when the request omitted them.
      expect(res.record.tags).toEqual([SECRETS.tag]);
      expect(res).not.toHaveProperty("receipt");
      expect(RecordWriteResponseSchema.safeParse(res).success).toBe(true);
    },
  );

  it("legacy: patch, archive and unarchive keep working", async () => {
    const sdk = sdkAs("legacy");
    let fence = await acquire("legacy", "record:question/q1/old");
    const patched = await sdk.records.patch("question", "q1/old", {
      patch: { extra: 1 },
      fence,
    });
    fence = patched.fence;
    const archived = await sdk.records.archive("question", "q1/old", { fence });
    expect(archived.record.archived).toBe(1);
    const unarchived = await sdk.records.unarchive("question", "q1/old", {
      fence: archived.fence,
    });
    expect(unarchived.record.archived).toBe(0);
  });
});

describe("a read-only credential", () => {
  it("reads its namespace and cannot write anywhere", async () => {
    expect(
      (await call("read-only", "GET", "/records/answer/a1/x")).status,
    ).toBe(200);
    expect(
      (await call("read-only", "HEAD", "/records/answer/a1/x")).status,
    ).toBe(200);
    for (const [method, path, body] of [
      ["POST", "/records/answer", { key: "a1/n", value: {} }],
      ["PUT", "/records/answer/a1/x", { value: {}, fence: 1 }],
      ["POST", "/records/answer/~/put/a1/x", { value: {} }],
    ] as const)
      expect(
        (await call("read-only", method, path, body)).status,
        `${method} ${path}`,
      ).toBe(403);
  });
});

describe("an error the SDK raises is typed, never a parse failure", () => {
  it("surfaces a denied write as a TilaApiError", async () => {
    const sdk = sdkAs("split");
    await expect(
      sdk.records.create("answer", { key: "a1/n", value: {} }),
    ).rejects.toSatisfy(
      (error) => isTilaApiError(error) && error.status === 403,
    );
  });
});
