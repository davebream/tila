import { CREDENTIAL_PRESETS, type ProjectRole } from "@tila/schemas";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCustomJournalRoutes } from "../../src/do/routes/custom-journal-routes";
import { installProjectErrorHandlers } from "../../src/do/routes/errors";
import type { RouterDeps } from "../../src/do/routes/types";
import { type TestDb, createTestDb } from "./helpers/create-test-db";

const report = {
  event_name: "pipeline.tests_passed",
  event_version: 1,
  target: { kind: "project" },
  data: { passed: 87 },
};
let fixture: TestDb;
let app: Hono;
beforeEach(() => {
  fixture = createTestDb();
  const { sqlite } = fixture;
  const ctx = {
    storage: {
      sql: {
        exec(statement: string, ...bindings: unknown[]) {
          return {
            toArray: () => sqlite.prepare(statement).all(...bindings),
          };
        },
      },
    },
  } as unknown as DurableObjectState;
  app = new Hono();
  installProjectErrorHandlers(app);
  app.route(
    "/",
    createCustomJournalRoutes({
      db: fixture.db as RouterDeps["db"],
      ctx,
      enrichOpts: vi.fn(),
    }),
  );
});
afterEach(() => fixture.sqlite.close());

type Caller = {
  principal: string;
  role?: ProjectRole;
  /** Credential ceiling sent by the Worker, as `X-Tila-Credential-Policy`. */
  policyRole?: ProjectRole;
};
function append(
  caller: Caller,
  key: string,
  input: Record<string, unknown> = report,
) {
  return app.request("/journal/append", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(caller.policyRole
        ? {
            "X-Tila-Credential-Policy": JSON.stringify({
              ...CREDENTIAL_PRESETS.worker,
              role: caller.policyRole,
            }),
          }
        : {}),
    },
    body: JSON.stringify({
      principal_id: caller.principal,
      participant_id: `${caller.principal}-process`,
      environment: {},
      actor_token_id: null,
      project_id: "project",
      authorized_role: caller.role ?? "participant",
      input,
      idempotency_key: key,
    }),
  });
}
const rows = () =>
  fixture.sqlite
    .prepare("SELECT seq FROM journal WHERE kind = 'custom.reported'")
    .all() as { seq: number }[];
const counters = () =>
  fixture.sqlite
    .prepare("SELECT key, count FROM journal_report_rates ORDER BY key")
    .all();
const receipts = () =>
  fixture.sqlite.prepare("SELECT key FROM journal_report_receipts").all();

describe("DO report correction routes", () => {
  it("refuses an unrelated participant with a stable non-retryable code and no writes", async () => {
    expect((await append({ principal: "reporter" }, "root")).status).toBe(200);
    const before = {
      rows: rows(),
      counters: counters(),
      receipts: receipts(),
    };
    for (const key of ["first", "again"]) {
      const response = await append({ principal: "other" }, key, {
        ...report,
        corrects_seq: 1,
      });
      expect(response.status).toBe(403);
      expect(response.headers.get("Retry-After")).toBeNull();
      expect(await response.json()).toMatchObject({
        ok: false,
        error: { code: "report-correction-denied", retryable: false },
      });
    }
    expect({
      rows: rows(),
      counters: counters(),
      receipts: receipts(),
    }).toEqual(before);
  });

  it("accepts the original reporter and records a maintainer override under its own principal", async () => {
    await append({ principal: "reporter" }, "root");
    const own = await append({ principal: "reporter" }, "own", {
      ...report,
      corrects_seq: 1,
    });
    expect(own.status).toBe(200);
    const override = await append(
      { principal: "maintainer", role: "maintainer", policyRole: "maintainer" },
      "override",
      { ...report, corrects_seq: 2 },
    );
    expect(override.status).toBe(200);
    expect(await override.json()).toMatchObject({
      event: { seq: 3, principal_id: "maintainer" },
    });
    const replay = await append(
      { principal: "maintainer", role: "maintainer", policyRole: "maintainer" },
      "override",
      { ...report, corrects_seq: 2 },
    );
    expect(replay.headers.get("Idempotency-Replayed")).toBe("true");
    expect(rows()).toHaveLength(3);
  });

  it("lets a credential ceiling lower the resolved role but never raise it", async () => {
    await append({ principal: "reporter" }, "root");
    const lowered = await append(
      {
        principal: "maintainer",
        role: "maintainer",
        policyRole: "participant",
      },
      "lowered",
      { ...report, corrects_seq: 1 },
    );
    expect(lowered.status).toBe(403);
    const raised = await append(
      { principal: "other", role: "participant", policyRole: "owner" },
      "raised",
      { ...report, corrects_seq: 1 },
    );
    expect(raised.status).toBe(403);
    expect(rows()).toHaveLength(1);
  });

  it("rejects role or identity fields smuggled into the report", async () => {
    await append({ principal: "reporter" }, "root");
    for (const forged of [
      { role: "owner" },
      { authorized_role: "owner" },
      { principal_id: "reporter" },
    ]) {
      const response = await append({ principal: "other" }, "forged", {
        ...report,
        corrects_seq: 1,
        ...forged,
      });
      expect(response.status).toBe(400);
    }
    expect(rows()).toHaveLength(1);
  });

  it("fails closed on unavailable and corrupt lineage without writing", async () => {
    await append({ principal: "reporter" }, "root");
    await append({ principal: "reporter" }, "fix", {
      ...report,
      corrects_seq: 1,
    });
    // Archive the root without an archive reader: its owner cannot be established.
    fixture.sqlite.prepare("DELETE FROM journal WHERE seq = 1").run();
    fixture.sqlite
      .prepare(
        "INSERT INTO _journal_archive_watermark (id, last_archived_seq, archived_at) VALUES (1, 1, 0)",
      )
      .run();
    const before = {
      rows: rows(),
      counters: counters(),
      receipts: receipts(),
    };
    for (const principal of ["reporter", "other"]) {
      const response = await append({ principal }, `${principal}-archived`, {
        ...report,
        corrects_seq: 2,
      });
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({
        error: { code: "journal-history-unavailable", retryable: true },
      });
    }
    // A readable link that is not a report is damage, not a transient outage.
    const insert = fixture.sqlite.prepare(
      "INSERT INTO journal (t, kind, resource, principal_id, participant_id, environment, actor, data) VALUES (0, ?, 'project:project', 'reporter', 'raw', '{}', '', ?)",
    );
    insert.run("task.created", "{}"); // sequence 3
    insert.run(
      "custom.reported",
      JSON.stringify({ ...report, corrects_seq: 3 }), // sequence 4
    );
    const damaged = await append({ principal: "reporter" }, "damaged", {
      ...report,
      corrects_seq: 4,
    });
    expect(damaged.status).toBe(503);
    expect(await damaged.json()).toMatchObject({
      error: { code: "journal-history-unavailable", retryable: false },
    });
    expect(counters()).toEqual(before.counters);
    expect(receipts()).toEqual(before.receipts);
    expect(rows()).toHaveLength(before.rows.length + 1);
  });
});
