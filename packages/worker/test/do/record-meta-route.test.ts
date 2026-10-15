import type { CredentialPolicy } from "@tila/schemas";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createProjectRouter } from "../../src/do/project-do-router";
import type { RouterDeps } from "../../src/do/routes/types";
import { type TestDb, createTestDb } from "./helpers/create-test-db";

// `GET /record/:type/:key?meta=1` on the real DO router (credential middleware
// included): a metadata-only read of one record from one SQLite snapshot.

const IDENT = {
  principal_id: "test:records",
  participant_id: "participant-1",
  environment: {},
  actor: "writer",
};
const SECRET = "VALUE-SECRET";
const CAPS = ["records:read", "records:write"] as const;
const base = { role: "participant" as const, capabilities: [...CAPS] };
const POLICY: Record<string, CredentialPolicy> = {
  readAnswers: {
    ...base,
    restrictions: { records_read: [{ type: "answer", key_prefixes: ["a1"] }] },
  },
  writeAnswers: {
    ...base,
    restrictions: { records_write: [{ type: "answer", key_prefixes: ["a1"] }] },
  },
};

let fixture: TestDb;
let app: ReturnType<typeof createProjectRouter>;

beforeEach(async () => {
  fixture = createTestDb();
  app = createProjectRouter({
    db: fixture.db as RouterDeps["db"],
    ctx: {
      storage: {
        sql: {
          exec: (s: string, ...bindings: unknown[]) => ({
            toArray: () => fixture.sqlite.prepare(s).all(...bindings),
          }),
        },
        getAlarm: vi.fn(async () => null),
        setAlarm: vi.fn(async () => {}),
      },
    } as unknown as DurableObjectState,
    enrichOpts: vi.fn(),
  } as unknown as RouterDeps);

  await write("/record/answer/create", {
    key: "a1/x",
    value: { note: SECRET },
    tags: ["stored-tag"],
  });
  await write("/record/answer/create", { key: "z9/out", value: { v: 1 } });
});
afterEach(() => fixture.sqlite.close());

async function write(
  path: string,
  body: Record<string, unknown>,
): Promise<Response> {
  const res = await app.request(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...body, ...IDENT }),
  });
  expect(res.status, await res.clone().text()).toBeLessThan(300);
  return res;
}

function get(path: string, policy?: string): Promise<Response> {
  return Promise.resolve(
    app.request(path, {
      headers: policy
        ? { "X-Tila-Credential-Policy": JSON.stringify(POLICY[policy]) }
        : {},
    }),
  );
}

describe("GET /record/:type/:key?meta=1", () => {
  it("returns the metadata of the record and none of its value", async () => {
    const full = (await (await get("/record/answer/a1/x")).json()) as {
      record: Record<string, unknown>;
      fence: number;
    };

    const res = await get("/record/answer/a1/x?meta=1");
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
        archived: 0,
      },
    });
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain("stored-tag");
  });

  it("tracks a fenced write, an archive and an unarchive", async () => {
    const first = (await (await get("/record/answer/a1/x?meta=1")).json()) as {
      meta: { revision: number; fence: number; value_sha256: string };
    };

    await write("/record/answer/a1/x/set", {
      value: { note: "second" },
      fence: first.meta.fence,
    });
    const second = (await (await get("/record/answer/a1/x?meta=1")).json()) as {
      meta: { revision: number; fence: number; value_sha256: string };
    };
    expect(second.meta.revision).toBe(first.meta.revision + 1);
    expect(second.meta.fence).toBe(first.meta.fence + 1);
    expect(second.meta.value_sha256).not.toBe(first.meta.value_sha256);

    await write("/record/answer/a1/x/archive", { fence: second.meta.fence });
    const archived = (await (
      await get("/record/answer/a1/x?meta=1")
    ).json()) as {
      meta: { archived: number; revision: number; fence: number };
    };
    expect(archived.meta).toMatchObject({
      archived: 1,
      revision: second.meta.revision + 1,
      fence: second.meta.fence + 1,
    });

    await write("/record/answer/a1/x/unarchive", {
      fence: archived.meta.fence,
    });
    const restored = (await (
      await get("/record/answer/a1/x?meta=1")
    ).json()) as {
      meta: { archived: number; revision: number; fence: number };
    };
    expect(restored.meta).toMatchObject({
      archived: 0,
      revision: archived.meta.revision + 1,
      fence: archived.meta.fence + 1,
    });
  });

  it("answers 404 not-found exactly as the ordinary read does", async () => {
    const plain = await get("/record/answer/a1/absent");
    const meta = await get("/record/answer/a1/absent?meta=1");

    expect(meta.status).toBe(404);
    expect(await meta.json()).toEqual(await plain.json());
  });

  it("does not consult the schema, so a corrupt stored schema cannot fail it", async () => {
    // The ordinary read resolves the schema for legacy defaults and answers
    // 500 schema-corrupt here; the metadata read has no use for it.
    fixture.sqlite
      .prepare(
        "INSERT INTO _schema_history (version, definition, applied_at, applied_by) VALUES (?, ?, ?, ?)",
      )
      .run(1, "this is = not [valid toml", Date.now(), "test");

    const res = await get("/record/answer/a1/x?meta=1");

    expect(res.status, await res.clone().text()).toBe(200);
  });

  it.each([
    ["true", "meta=true"],
    ["0", "meta=0"],
    ["empty", "meta="],
    ["yes", "meta=yes"],
    ["2", "meta=2"],
    ["repeated", "meta=1&meta=1"],
    ["mixed repeat", "meta=1&meta=0"],
  ])("rejects meta that is not exactly 1 (%s)", async (_label, query) => {
    const res = await get(`/record/answer/a1/x?${query}`);
    const body = (await res.json()) as {
      ok: boolean;
      error: { code: string };
    };

    expect(res.status).toBe(400);
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("validation-error");
    expect(JSON.stringify(body)).not.toContain(SECRET);
  });
});

describe("GET /record/:type/:key without meta", () => {
  it("keeps the full response shape and ignores unrelated query parameters", async () => {
    const plain = await get("/record/answer/a1/x");
    const text = await plain.text();
    const withOther = await get("/record/answer/a1/x?cache=bust");

    expect(plain.status).toBe(200);
    expect(Object.keys(JSON.parse(text)).sort()).toEqual([
      "fence",
      "ok",
      "record",
    ]);
    expect(Object.keys(JSON.parse(text).record).sort()).toEqual([
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
    ]);
    expect(JSON.parse(text).record.value).toEqual({ note: SECRET });
    expect(await withOther.text()).toBe(text);
  });
});

describe("credential policy on the metadata read", () => {
  it("lets a read-allowed credential read the key's metadata", async () => {
    const res = await get("/record/answer/a1/x?meta=1", "readAnswers");

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      ok: true,
      meta: { key: "a1/x", revision: 1 },
    });
  });

  it("gives a write-only credential the same denial as the ordinary read", async () => {
    const plain = await get("/record/answer/a1/x", "writeAnswers");
    const meta = await get("/record/answer/a1/x?meta=1", "writeAnswers");
    const text = await meta.text();

    expect(plain.status).toBe(403);
    expect(meta.status).toBe(403);
    expect(JSON.parse(text)).toEqual(await plain.json());
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain("revision");
    expect(text).not.toContain("fence");
  });

  it("denies an existing and a missing key outside the read prefix identically", async () => {
    const existing = await get("/record/answer/z9/out?meta=1", "readAnswers");
    const missing = await get("/record/answer/z9/none?meta=1", "readAnswers");

    expect(existing.status).toBe(403);
    expect(missing.status).toBe(403);
    expect(await existing.json()).toEqual(await missing.json());
  });

  it("denies before validating the query, so a bad meta reveals nothing", async () => {
    const plain = await get("/record/answer/a1/x", "writeAnswers");
    const bad = await get("/record/answer/a1/x?meta=bogus", "writeAnswers");

    expect(bad.status).toBe(403);
    expect(await bad.json()).toEqual(await plain.json());
  });
});
