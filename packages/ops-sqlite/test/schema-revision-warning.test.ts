import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listJournal } from "../src/journal-ops";
import { configure } from "../src/queue-ops";
import * as schema from "../src/schema";
import { applySchema, listSchemaHistory } from "../src/schema-ops";
import { type TestDb, createTestDb, testOrigin } from "./helpers";

const initial = `schema_version = 1
[work_units.task.fields.title]
type = "string"
`;
const next = `${initial}\n[work_units.task.fields.note]\ntype = "string"\n`;
const origin = {
  ...testOrigin("alice"),
  participantId: "alice-cli",
  environment: { client_name: "cli", client_version: "test", machine: "host" },
  tokenId: "token-id",
};
let fixture: TestDb;
beforeEach(() => {
  fixture = createTestDb();
});
afterEach(() => fixture.rawDb.close());
const events = () =>
  listJournal(fixture.db, { kind: "schema.revisionless_applied" });
const apply = (definition = initial, options = {}) =>
  applySchema(fixture.db, definition, "Alice", undefined, origin, options);

describe("revisionless schema compatibility", () => {
  it("warns and co-commits a minimal event with identity, provenance and revisions", () => {
    const result = apply(initial, { idempotency_key: "initial" });
    expect(result).toMatchObject({
      ok: true,
      revision: 1,
      warnings: [
        {
          code: "schema-revision-deprecated",
          observed_revision: 0,
          result_revision: 1,
          message: expect.stringMatching(/Preview.*expected_revision/),
        },
      ],
    });
    expect(events()).toEqual([
      expect.objectContaining({
        resource: "schema",
        principal_id: origin.principalId,
        participant_id: "alice-cli",
        environment: origin.environment,
        token_id: "token-id",
        fence: null,
        data: {
          actor: "Alice",
          idempotency_key: "initial",
          expected_revision: null,
          observed_revision: 0,
          result_revision: 1,
        },
      }),
    ]);
    expect(JSON.stringify(events())).not.toContain("work_units");
    expect(listSchemaHistory(fixture.db)).toHaveLength(1);
    expect(listJournal(fixture.db, { kind: "schema.applied" })).toHaveLength(1);
  });

  it("replays the original warning after another writer advances the revision", () => {
    const options = { idempotency_key: "lost-response" };
    const first = apply(initial, options);
    apply(next, { expected_revision: 1 });
    expect(apply(initial, options)).toEqual(first);
    expect(events()).toHaveLength(1);
    expect(listSchemaHistory(fixture.db)).toHaveLength(2);
    expect(() => apply(next, options)).toThrow("different request body");
    expect(events()).toHaveLength(1);
  });

  it("warns on no-change and retries without claiming another state change", () => {
    apply(initial, { expected_revision: 0 });
    const options = { idempotency_key: "no-op" };
    const noChange = apply(`# comment\n${initial}`, options);
    expect(noChange).toMatchObject({
      ok: false,
      reason: "no-change",
      warnings: [
        {
          observed_revision: 1,
          result_revision: 1,
        },
      ],
    });
    apply(next, { expected_revision: 1 });
    expect(apply(`# comment\n${initial}`, options)).toEqual(noChange);
    expect(events()).toHaveLength(0);
    expect(listSchemaHistory(fixture.db)).toHaveLength(2);
  });

  it("adds a warning to a pre-warning receipt without inventing a new event or observation", () => {
    apply(initial, { idempotency_key: "legacy" });
    const receipt = fixture.db.select().from(schema.doIdempotency).get();
    if (!receipt) throw new Error("Missing fixture receipt");
    const { warnings: _warnings, ...legacy } = JSON.parse(
      receipt.response_json,
    );
    fixture.db
      .update(schema.doIdempotency)
      .set({ response_json: JSON.stringify(legacy) })
      .where(eq(schema.doIdempotency.key, receipt.key))
      .run();
    const before = events();
    const result = apply(initial, { idempotency_key: "legacy" });
    expect(result).toMatchObject({
      ok: true,
      revision: 1,
      warnings: [
        {
          code: "schema-revision-deprecated",
          result_revision: 1,
        },
      ],
    });
    if (!result.ok) throw new Error("Expected replay success");
    expect(result.warnings?.[0]).not.toHaveProperty("observed_revision");
    expect(events()).toEqual(before);
    expect(listSchemaHistory(fixture.db)).toHaveLength(1);
  });

  it("keeps conditional writes and conflicts free of compatibility warnings", () => {
    expect(apply(initial, { expected_revision: 0 })).toMatchObject({
      warnings: [],
    });
    expect(apply(initial, { expected_revision: 1 })).toMatchObject({
      warnings: [],
    });
    expect(() => apply(next, { expected_revision: 0 })).toThrow(
      "schema-revision-conflict",
    );
    expect(events()).toHaveLength(0);
  });

  it("does not record an accepted apply for invalid or destructive-rejected requests", () => {
    expect(() => apply("schema_version = [")).toThrow();
    expect(listSchemaHistory(fixture.db)).toHaveLength(0);
    apply(initial, { expected_revision: 0 });
    const result = apply("schema_version = 1\nwork_units = {}");
    expect(result).toMatchObject({ ok: false, reason: "destructive" });
    expect(result).not.toHaveProperty("warnings");
    expect(events()).toHaveLength(0);
    expect(listSchemaHistory(fixture.db)).toHaveLength(1);
  });

  it("rolls back history, both journal events and the receipt when journaling fails", () => {
    fixture.rawDb.exec(`CREATE TRIGGER reject_revisionless BEFORE INSERT ON journal
      WHEN NEW.kind = 'schema.revisionless_applied'
      BEGIN SELECT RAISE(ABORT, 'journal unavailable'); END;`);
    expect(() => apply(initial, { idempotency_key: "atomic" })).toThrow(
      "journal unavailable",
    );
    expect(listSchemaHistory(fixture.db)).toHaveLength(0);
    expect(listJournal(fixture.db, {})).toHaveLength(0);
    expect(fixture.db.select().from(schema.doIdempotency).all()).toHaveLength(
      0,
    );
  });

  it("enforces the sticky managed precondition before legacy write and no-change receipts", () => {
    apply(initial, { idempotency_key: "write" });
    apply(initial, { idempotency_key: "no-change" });
    // Model receipts stored by a server predating the response warning.
    for (const receipt of fixture.db
      .select()
      .from(schema.doIdempotency)
      .all()) {
      const { warnings: _warnings, ...legacy } = JSON.parse(
        receipt.response_json,
      );
      fixture.db
        .update(schema.doIdempotency)
        .set({ response_json: JSON.stringify(legacy) })
        .where(eq(schema.doIdempotency.key, receipt.key))
        .run();
    }
    configure(
      fixture.db,
      {
        idempotency_key: "enable",
        expected_revision: 0,
        enabled: true,
        execution_limit: 1,
      },
      origin,
      true,
    );
    configure(
      fixture.db,
      { idempotency_key: "disable", expected_revision: 1, enabled: false },
      origin,
      true,
    );
    for (const idempotency_key of ["write", "no-change", "new"])
      expect(() => apply(initial, { idempotency_key })).toThrow(
        "schema-revision-required",
      );
    expect(events()).toHaveLength(1);
    expect(listSchemaHistory(fixture.db)).toHaveLength(1);
    expect(apply(next, { expected_revision: 1 })).toMatchObject({
      ok: true,
      warnings: [],
    });
  });
});
