import {
  CAPABILITIES,
  type CredentialPolicy,
  type NamespaceRestrictions,
  canEchoStoredRecord,
  permitsRecordRead,
  permitsRecordWrite,
} from "@tila/schemas";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createProjectRouter } from "../../worker/src/do/project-do-router";
import type { RouterDeps } from "../../worker/src/do/routes/types";
import { capabilityMiddleware } from "../../worker/src/middleware/capability";
import type { Env, HonoVariables } from "../../worker/src/types";
import {
  type TestDb,
  createTestDb,
} from "../../worker/test/do/helpers/create-test-db";

// {method x path x policy shape}: the Worker middleware and the Durable Object
// request check must reach the same decision for every cell, and both must
// match the rule the cell is supposed to follow.

const Q = [{ type: "question", key_prefixes: ["q1"] }];
const A = [{ type: "answer", key_prefixes: ["a1"] }];

const SHAPES: Record<string, NamespaceRestrictions | undefined> = {
  unrestricted: undefined,
  "task-types-only": { task_types: ["task"] },
  legacy: { records: [...Q, ...A] },
  "legacy-empty": { records: [] },
  "legacy-type-wide": { records: [{ type: "question" }] },
  split: { records_read: A, records_write: Q },
  "split-reversed": { records_read: Q, records_write: A },
  "write-only": { records_write: Q },
  "read-only": { records_read: A },
  "split-empty-read": { records_read: [], records_write: Q },
  "split-empty-write": { records_read: A, records_write: [] },
  "split-both-empty": { records_read: [], records_write: [] },
  "split-overlap": { records_read: [...Q, ...A], records_write: Q },
};
const KEYS: [string, string][] = [
  ["question", "q1/k"],
  ["question", "q1"],
  ["question", "q2/k"],
  ["question", "q10"],
  ["answer", "a1/k"],
  ["answer", "a2/k"],
  ["other", "x"],
];
const enc = (key: string) => key.split("/").map(encodeURIComponent).join("/");

type Side = "read" | "write" | "none";
interface Cell {
  name: string;
  side: Side;
  /** The response is the stored record, so the read side is needed as well. */
  echoes?: boolean;
  /** `null`: the Worker has no route for this DO operation. */
  worker: ((type: string, key: string) => Req) | null;
  dO: (type: string, key: string) => Req;
}
interface Req {
  method: string;
  path: string;
  body?: Record<string, unknown>;
}
const IDENT = {
  principal_id: "p",
  participant_id: "pp",
  environment: {},
  actor: "a",
};
const claim = (type: string, key: string) => `record:${type}/${key}`;

const CELLS: Cell[] = [
  {
    name: "value read",
    side: "read",
    worker: (t, k) => ({ method: "GET", path: `/records/${t}/${enc(k)}` }),
    dO: (t, k) => ({ method: "GET", path: `/record/${t}/${enc(k)}` }),
  },
  {
    name: "value HEAD",
    side: "read",
    worker: (t, k) => ({ method: "HEAD", path: `/records/${t}/${enc(k)}` }),
    dO: (t, k) => ({ method: "HEAD", path: `/record/${t}/${enc(k)}` }),
  },
  {
    name: "history",
    side: "read",
    worker: (t, k) => ({
      method: "GET",
      path: `/records/${t}/~/history/${enc(k)}`,
    }),
    dO: (t, k) => ({ method: "GET", path: `/record/${t}/${enc(k)}/history` }),
  },
  {
    name: "history HEAD",
    side: "read",
    worker: (t, k) => ({
      method: "HEAD",
      path: `/records/${t}/~/history/${enc(k)}`,
    }),
    dO: (t, k) => ({ method: "HEAD", path: `/record/${t}/${enc(k)}/history` }),
  },
  {
    name: "create",
    side: "write",
    worker: (t, k) => ({
      method: "POST",
      path: `/records/${t}`,
      body: { key: k, value: {} },
    }),
    dO: (t, k) => ({
      method: "POST",
      path: `/record/${t}/create`,
      body: { key: k, value: {}, ...IDENT },
    }),
  },
  {
    name: "set",
    side: "write",
    worker: (t, k) => ({
      method: "PUT",
      path: `/records/${t}/${enc(k)}`,
      body: { value: {}, fence: 1 },
    }),
    dO: (t, k) => ({
      method: "POST",
      path: `/record/${t}/${enc(k)}/set`,
      body: { value: {}, fence: 1, ...IDENT },
    }),
  },
  {
    name: "put",
    side: "write",
    worker: (t, k) => ({
      method: "POST",
      path: `/records/${t}/~/put/${enc(k)}`,
      body: { value: {} },
    }),
    dO: (t, k) => ({
      method: "POST",
      path: `/record/${t}/${enc(k)}/put`,
      body: { value: {}, ...IDENT },
    }),
  },
  {
    name: "patch",
    side: "write",
    echoes: true,
    worker: (t, k) => ({
      method: "PATCH",
      path: `/records/${t}/${enc(k)}`,
      body: { patch: {}, fence: 1 },
    }),
    dO: (t, k) => ({
      method: "POST",
      path: `/record/${t}/${enc(k)}/patch`,
      body: { patch: {}, fence: 1, ...IDENT },
    }),
  },
  {
    name: "archive",
    side: "write",
    echoes: true,
    worker: (t, k) => ({
      method: "POST",
      path: `/records/${t}/~/archive/${enc(k)}`,
      body: { fence: 1 },
    }),
    dO: (t, k) => ({
      method: "POST",
      path: `/record/${t}/${enc(k)}/archive`,
      body: { fence: 1, ...IDENT },
    }),
  },
  {
    name: "unarchive",
    side: "write",
    echoes: true,
    worker: (t, k) => ({
      method: "POST",
      path: `/records/${t}/~/unarchive/${enc(k)}`,
      body: { fence: 1 },
    }),
    dO: (t, k) => ({
      method: "POST",
      path: `/record/${t}/${enc(k)}/unarchive`,
      body: { fence: 1, ...IDENT },
    }),
  },
  {
    name: "stamp-artifacts (internal follow-up of a write)",
    side: "write",
    worker: null,
    dO: (t, k) => ({
      method: "POST",
      path: `/record/${t}/${enc(k)}/stamp-artifacts`,
      body: {
        revision: 1,
        canonical_artifact_key: "k",
        sha256: "s",
        bytes: 1,
        ...IDENT,
      },
    }),
  },
  {
    name: "claim state",
    side: "read",
    worker: (t, k) => ({
      method: "GET",
      path: `/claims/state/${encodeURIComponent(claim(t, k))}`,
    }),
    dO: (t, k) => ({
      method: "GET",
      path: `/coord/state?resource=${encodeURIComponent(claim(t, k))}`,
    }),
  },
  ...(["acquire", "renew", "release"] as const).map(
    (op): Cell => ({
      name: `claim ${op}`,
      side: "write",
      worker: (t, k) => ({
        method: "POST",
        path: `/claims/${op}`,
        body: {
          resource: claim(t, k),
          mode: "exclusive",
          ttl_ms: 1000,
          fence: 1,
        },
      }),
      dO: (t, k) => ({
        method: "POST",
        path: `/coord/${op}`,
        body: {
          resource: claim(t, k),
          mode: "exclusive",
          ttl_ms: 1000,
          fence: 1,
          ...IDENT,
        },
      }),
    }),
  ),
];

/** Routes that filter rows themselves: always reachable, never a key check. */
const KEYLESS: { name: string; worker: Req; dO: Req }[] = [
  {
    name: "catalog",
    worker: { method: "GET", path: "/records/_types" },
    dO: { method: "GET", path: "/record/types-in-use" },
  },
  {
    name: "list",
    worker: { method: "GET", path: "/records/question" },
    dO: { method: "GET", path: "/record/question/list" },
  },
  {
    name: "claim listing",
    worker: { method: "GET", path: "/claims" },
    dO: { method: "GET", path: "/coord/claims" },
  },
  {
    name: "record search",
    worker: { method: "GET", path: "/search?q=x&kind=record" },
    dO: { method: "GET", path: "/search?q=x&kind=record" },
  },
];

function policyFor(restrictions?: NamespaceRestrictions): CredentialPolicy {
  return {
    role: "participant",
    capabilities: [...CAPABILITIES],
    ...(restrictions === undefined ? {} : { restrictions }),
  };
}
function expectedAllowed(
  cell: Pick<Cell, "side" | "echoes">,
  policy: CredentialPolicy,
  type: string,
  key: string,
): boolean {
  if (cell.side === "none") return true;
  if (cell.side === "read")
    return permitsRecordRead(policy.restrictions, type, key);
  const write = permitsRecordWrite(policy.restrictions, type, key);
  return cell.echoes ? write && canEchoStoredRecord(policy, type, key) : write;
}

let db: TestDb;
let doApp: ReturnType<typeof createProjectRouter>;
let workerApp: Hono<{ Bindings: Env; Variables: HonoVariables }>;
const env = { ANALYTICS: { writeDataPoint: () => {} } } as unknown as Env;

beforeEach(() => {
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

  // The Worker half alone: whatever the middleware lets through reaches the
  // terminal handler, so a 200 means "allowed" and a 403 means "denied here".
  workerApp = new Hono();
  workerApp.use("*", async (c, next) => {
    const shape = c.req.header("X-Test-Shape") ?? "";
    c.set("tokenResult", {
      kind: "d1-token",
      projectId: "p1",
      name: shape,
      tokenId: shape,
      scopes: "scoped-v1",
      policy: policyFor(SHAPES[shape]),
    });
    c.set("projectId", "p1");
    c.set("doStub", {
      fetch: async () => new Response("{}"),
    } as unknown as DurableObjectStub);
    await next();
  });
  workerApp.use("*", capabilityMiddleware());
  workerApp.all("*", (c) => c.json({ reached: true }));
});
afterEach(() => db.sqlite.close());

async function workerAllows(shape: string, req: Req): Promise<boolean> {
  const res = await workerApp.request(
    `/projects/p1${req.path}`,
    {
      method: req.method,
      headers: {
        "X-Test-Shape": shape,
        "Content-Type": "application/json",
      },
      ...(req.body === undefined ? {} : { body: JSON.stringify(req.body) }),
    },
    env,
  );
  return res.status !== 403;
}
async function doAllows(shape: string, req: Req): Promise<boolean> {
  const res = await doApp.request(req.path, {
    method: req.method,
    headers: {
      "X-Tila-Credential-Policy": JSON.stringify(policyFor(SHAPES[shape])),
      "Content-Type": "application/json",
    },
    ...(req.body === undefined ? {} : { body: JSON.stringify(req.body) }),
  });
  if (res.status !== 403) return true;
  // A HEAD response has no body; the only 403 the router produces is the denial.
  if (req.method === "HEAD") return false;
  const body = (await res.json()) as { error?: { code?: string } };
  return body.error?.code !== "permission-denied";
}

describe("record restriction matrix across Worker and Durable Object", () => {
  for (const cell of CELLS) {
    describe(cell.name, () => {
      for (const shape of Object.keys(SHAPES)) {
        it(`${shape}`, async () => {
          const policy = policyFor(SHAPES[shape]);
          for (const [type, key] of KEYS) {
            const expected = expectedAllowed(cell, policy, type, key);
            const where = `${cell.name} ${type}/${key} as ${shape}`;
            expect(
              await doAllows(shape, cell.dO(type, key)),
              `DO: ${where}`,
            ).toBe(expected);
            if (cell.worker)
              expect(
                await workerAllows(shape, cell.worker(type, key)),
                `Worker: ${where}`,
              ).toBe(expected);
          }
        });
      }
    });
  }

  describe("surfaces that filter rows themselves", () => {
    for (const cell of KEYLESS)
      for (const shape of Object.keys(SHAPES))
        it(`${cell.name} stays reachable as ${shape}`, async () => {
          expect(await workerAllows(shape, cell.worker)).toBe(true);
          expect(await doAllows(shape, cell.dO)).toBe(true);
        });
  });

  describe("fails closed", () => {
    it("denies a write whose key is not a string at the DO", async () => {
      for (const shape of ["legacy", "split", "write-only"])
        expect(
          await doAllows(shape, {
            method: "POST",
            path: "/record/question/create",
            body: { value: {}, ...IDENT },
          }),
          shape,
        ).toBe(false);
    });

    it("treats an unknown record mutation as a write, never a read", async () => {
      // `read-only` may read answers but must not pass an unknown mutation.
      expect(
        await doAllows("read-only", {
          method: "POST",
          path: "/record/answer/a1/k/rewrite",
          body: IDENT,
        }),
      ).toBe(false);
      expect(
        await doAllows("read-only", {
          method: "DELETE",
          path: "/record/answer/a1/k",
        }),
      ).toBe(false);
    });

    it("denies methods the Worker has no record route for", async () => {
      for (const shape of ["legacy", "split", "write-only"])
        expect(
          await workerAllows(shape, {
            method: "DELETE",
            path: "/records/question/q1/k",
          }),
          shape,
        ).toBe(false);
    });

    it("applies the same HEAD rule at both layers", async () => {
      // HEAD reads: allowed exactly where GET is, and never as a write.
      for (const shape of Object.keys(SHAPES))
        for (const [type, key] of KEYS) {
          const get = await doAllows(shape, {
            method: "GET",
            path: `/record/${type}/${enc(key)}`,
          });
          const head = await doAllows(shape, {
            method: "HEAD",
            path: `/record/${type}/${enc(key)}`,
          });
          const workerHead = await workerAllows(shape, {
            method: "HEAD",
            path: `/records/${type}/${enc(key)}`,
          });
          expect([shape, type, key, head, workerHead]).toEqual([
            shape,
            type,
            key,
            get,
            get,
          ]);
        }
    });
  });
});
