import { SELF } from "cloudflare:test";
import { MAX_TASK_DATA_BYTES, taskDataBytes } from "@tila/schemas";
import { drizzle } from "drizzle-orm/d1";
import { beforeEach, describe, expect, it } from "vitest";
import { D1TokenStore } from "../../worker/src/d1";
import { projects } from "../../worker/src/d1/schema";
import { hashToken } from "../../worker/src/lib/hash";
import { bindings } from "./setup";

// A task's data is refused past MAX_TASK_DATA_BYTES, and a relationship to a
// task that does not exist is refused: both used to reach SQLite and answer a
// retryable 500. These run through the real Worker and Durable Object, where
// foreign keys and SQLite's value-size ceiling are enforced.

let project: string;
let token: string;

type Json = Record<string, unknown>;
type Failure = { error: { code: string; message: string; retryable: boolean } };

async function call(
  method: "GET" | "POST" | "PATCH",
  path: string,
  body?: unknown,
): Promise<{ status: number; json: Json }> {
  const response = await SELF.fetch(
    `https://worker/projects/${project}${path}`,
    {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "X-Tila-Participant-Id": "invalid-requests-runtime",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    },
  );
  return { status: response.status, json: (await response.json()) as Json };
}

function expectRefusal(
  result: { status: number; json: Json },
  status: number,
  code: string,
): Failure["error"] {
  const label = `${result.status} ${JSON.stringify(result.json).slice(0, 300)}`;
  expect(result.status, label).toBe(status);
  const { error } = result.json as unknown as Failure;
  expect(error.code, label).toBe(code);
  expect(error.retryable, label).toBe(false);
  return error;
}

async function createTask(id: string, data: Json = { title: id }) {
  return call("POST", "/tasks", { id, type: "task", data });
}

async function exists(id: string): Promise<boolean> {
  return (await call("GET", `/tasks/${id}`)).status === 200;
}

// The runtime setup resets all storage between tests, so every test seeds its
// own project.
beforeEach(async () => {
  project = `invalid-requests-${crypto.randomUUID()}`;
  await drizzle(bindings.DB).insert(projects).values({
    project_id: project,
    created_at: 0,
    created_by: "fixture",
    cloudflare_account_id: "local",
  });
  token = `tila_${crypto.randomUUID()}${crypto.randomUUID()}`;
  await new D1TokenStore(bindings.DB).issue({
    projectId: project,
    tokenHash: await hashToken(token, bindings.HASH_PEPPER),
    name: "owner",
    createdBy: "fixture",
    createdAt: 0,
  });
});

describe("task data bound", () => {
  it("refuses a 16 MiB create with 413, never a retryable 500", async () => {
    const result = await createTask("sixteen-mib", {
      description: "x".repeat(16 * 1024 * 1024),
    });

    const error = expectRefusal(result, 413, "payload-too-large");
    expect(error.message).toContain(String(MAX_TASK_DATA_BYTES));
    expect(await exists("sixteen-mib")).toBe(false);
    // The Durable Object is unaffected and keeps serving writes.
    expect((await createTask("after-sixteen-mib")).status).toBe(200);
  });

  it("accepts data exactly at the limit and refuses one byte more", async () => {
    const at = { d: "a".repeat(MAX_TASK_DATA_BYTES - 8) };
    expect(taskDataBytes(at)).toBe(MAX_TASK_DATA_BYTES);
    const created = await createTask("at-limit", at);
    expect(created.status, JSON.stringify(created.json).slice(0, 200)).toBe(
      200,
    );

    expectRefusal(
      await createTask("over-limit", {
        d: "a".repeat(MAX_TASK_DATA_BYTES - 7),
      }),
      413,
      "payload-too-large",
    );
    expect(await exists("over-limit")).toBe(false);
  });

  it("counts UTF-8 bytes at the boundary", async () => {
    // 87,378 three-byte characters plus two ASCII bytes fill the limit.
    const at = { d: `${"€".repeat(87_378)}aa` };
    expect(taskDataBytes(at)).toBe(MAX_TASK_DATA_BYTES);
    expect((await createTask("multibyte-at", at)).status).toBe(200);

    // One more three-byte character is under 262,144 characters, over in bytes.
    const over = { d: "€".repeat(87_379) };
    expect(over.d.length).toBeLessThan(MAX_TASK_DATA_BYTES);
    expectRefusal(
      await createTask("multibyte-over", over),
      413,
      "payload-too-large",
    );
  });

  it("checks the merged data of an update, not the patch", async () => {
    expect((await createTask("merge", { a: "e".repeat(200_000) })).status).toBe(
      200,
    );
    const claim = await call("POST", "/claims/acquire", {
      resource: "task:merge",
      mode: "exclusive",
      ttl_ms: 300_000,
    });
    expect(claim.status).toBe(200);
    const fence = claim.json.fence as number;

    // 100,000 bytes alone is well under the limit; merged it is over.
    const refused = await call("PATCH", "/tasks/merge", {
      data: { b: "p".repeat(100_000) },
      fence,
    });
    expectRefusal(refused, 413, "payload-too-large");

    const stored = await call("GET", "/tasks/merge");
    const entity = stored.json.entity as { data: Json };
    expect(Object.keys(entity.data)).toEqual(["a"]);

    // Same fence, small patch: the refused write did not disturb the claim.
    const ok = await call("PATCH", "/tasks/merge", {
      data: { a: "short" },
      fence,
    });
    expect(ok.status, JSON.stringify(ok.json).slice(0, 200)).toBe(200);
  });
});

describe("relationship endpoints", () => {
  const TYPES = [
    "parent-child",
    "blocks",
    "soft-blocks",
    "related",
    "discovered-from",
  ];

  beforeEach(async () => {
    expect((await createTask("rel-existing")).status).toBe(200);
    expect((await createTask("rel-other")).status).toBe(200);
  });

  it.each(TYPES)("%s: a missing to_id is a non-retryable 404", async (type) => {
    const result = await call("POST", "/tasks/relationships", {
      from_id: "rel-existing",
      to_id: "rel-no-such-task",
      type,
    });

    const error = expectRefusal(result, 404, "not-found");
    expect(error.message).toContain("rel-no-such-task");
  });

  it.each(TYPES)(
    "%s: a missing from_id is a non-retryable 404",
    async (type) => {
      const error = expectRefusal(
        await call("POST", "/tasks/relationships", {
          from_id: "rel-no-such-task",
          to_id: "rel-existing",
          type,
        }),
        404,
        "not-found",
      );
      expect(error.message).toContain("rel-no-such-task");
    },
  );

  it("names from_id when both are missing and writes nothing", async () => {
    const error = expectRefusal(
      await call("POST", "/tasks/relationships", {
        from_id: "rel-ghost-from",
        to_id: "rel-ghost-to",
        type: "blocks",
      }),
      404,
      "not-found",
    );
    expect(error.message).toContain("rel-ghost-from");

    const listed = await call(
      "GET",
      "/tasks/relationships?from_id=rel-existing",
    );
    expect(listed.json.relationships).toEqual([]);
  });

  it("keeps creating valid relationships and no-oping duplicates", async () => {
    const body = {
      from_id: "rel-existing",
      to_id: "rel-other",
      type: "blocks",
    };
    const first = await call("POST", "/tasks/relationships", body);
    expect(first.status).toBe(201);
    expect(first.json.created).toBe(true);

    const second = await call("POST", "/tasks/relationships", body);
    expect(second.status).toBe(200);
    expect(second.json.created).toBe(false);
  });
});
