import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { create } from "../src/entity-ops";
import {
  DefinitionTooLargeError,
  SchemaParseException,
  applySchema,
  getCurrentSchema,
  listSchemaHistory,
  previewSchema,
} from "../src/schema-ops";
import { type TestDb, createTestDb, testOrigin } from "./helpers";

const initial = `schema_version = 1
[work_units.task.fields.title]
type = "string"
required = true
[work_units.task.fields.status]
type = "string"
values = ["open", "done"]
`;
const changed = initial.replace('["open", "done"]', '["pending", "done"]');
let fixture: TestDb;
beforeEach(() => {
  fixture = createTestDb();
});
afterEach(() => fixture.rawDb.close());

describe("revision-aware configuration", () => {
  it("rejects a stale writer and preserves the winning history and journal", () => {
    const a = previewSchema(fixture.db, initial);
    const b = previewSchema(fixture.db, changed);
    expect(a.revision).toBe(0);
    applySchema(fixture.db, initial, "alice", undefined, testOrigin(), {
      expected_revision: a.revision,
    });
    expect(() =>
      applySchema(fixture.db, changed, "bob", undefined, testOrigin(), {
        expected_revision: b.revision,
      }),
    ).toThrow("schema-revision-conflict");
    expect(listSchemaHistory(fixture.db)).toHaveLength(1);
    expect(getCurrentSchema(fixture.db)?.definition).toBe(initial);
    expect(
      fixture.rawDb
        .prepare(
          "SELECT count(*) AS n FROM journal WHERE kind = 'schema.applied'",
        )
        .get(),
    ).toEqual({ n: 1 });
  });

  it("binds a destructive apply to both the preview definition and revision", () => {
    applySchema(fixture.db, initial, "alice");
    const review = previewSchema(fixture.db, changed);
    expect(review.autoApplicable).toBe(false);
    expect(() =>
      applySchema(fixture.db, changed, "alice", "force", testOrigin(), {
        expected_revision: review.revision,
      }),
    ).toThrow("schema-review-required");
    expect(() =>
      applySchema(fixture.db, changed, "alice", "force", testOrigin(), {
        expected_revision: review.revision,
        reviewed_definition: initial,
      }),
    ).toThrow("schema-review-mismatch");
    expect(
      applySchema(fixture.db, changed, "alice", "force", testOrigin(), {
        expected_revision: review.revision,
        reviewed_definition: review.reviewed_definition,
      }),
    ).toMatchObject({ ok: true, revision: 2 });
    expect(listSchemaHistory(fixture.db, 1, 2)[0].definition).toBe(initial);
  });

  it("replays a lost committed response before checking the now-stale revision", () => {
    const options = { expected_revision: 0, idempotency_key: "first-write" };
    const first = applySchema(
      fixture.db,
      initial,
      "alice",
      undefined,
      testOrigin(),
      options,
    );
    expect(
      applySchema(
        fixture.db,
        initial,
        "alice",
        undefined,
        testOrigin(),
        options,
      ),
    ).toEqual(first);
    expect(listSchemaHistory(fixture.db)).toHaveLength(1);
    expect(() =>
      applySchema(
        fixture.db,
        changed,
        "alice",
        undefined,
        testOrigin(),
        options,
      ),
    ).toThrow("different request body");
    expect(() =>
      applySchema(
        fixture.db,
        initial,
        "bob",
        undefined,
        testOrigin("other"),
        options,
      ),
    ).toThrow("schema-revision-conflict");
  });

  it("detects defaults, artifact settings, hierarchy, and templates instead of discarding them", () => {
    applySchema(fixture.db, initial, "alice");
    for (const definition of [
      initial.replace(
        "required = true",
        'required = true\ndefault = "untitled"',
      ),
      `${initial}\n[artifacts.log]\nretention_days = 3`,
      `${initial}\n[hierarchy]\nlevels = ["task"]`,
      `${initial}\n[templates.one.entities.task]\ntype = "task"`,
    ]) {
      expect(
        previewSchema(fixture.db, definition).changes.length,
      ).toBeGreaterThan(0);
    }
    expect(
      applySchema(fixture.db, `# comment\n${initial}`, "alice"),
    ).toMatchObject({ reason: "no-change", revision: 1 });
  });

  it("uses the current schema in the entity write transaction", () => {
    applySchema(fixture.db, initial, "alice");
    const input = {
      id: "task-1",
      type: "task",
      data: { title: "Test" },
      created_by: "alice",
    };
    const stricter = `${initial}\n[work_units.task.fields.owner]\ntype = "string"\nrequired = true`;
    applySchema(fixture.db, stricter, "alice", "relax");
    expect(() => create(fixture.db, input, 1, testOrigin())).toThrow(
      'Required field "owner" is missing',
    );
    expect(
      fixture.rawDb.prepare("SELECT count(*) AS n FROM entities").get(),
    ).toEqual({ n: 0 });
  });

  describe("new-write guard", () => {
    const secret = `${initial}\n[extra]\napi_key = "plain-value"\n`;
    const exported = `${initial}\n[tila_export]\nformat = "tila-definitions"\nformat_version = 1\n`;
    const clientConfig = `project_id = "p"\nworker_url = "https://x"\n${initial}`;
    const oversize = `${initial}\nnote = "${"x".repeat(256 * 1024)}"\n`;

    it.each([
      ["a credential", secret, "extra.api_key"],
      ["export metadata", exported, "tila_export"],
      ["a client connection file", clientConfig, undefined],
    ])("rejects %s on preview and apply without writing", (_n, text, path) => {
      for (const write of [
        () => previewSchema(fixture.db, text),
        () =>
          applySchema(fixture.db, text, "alice", undefined, testOrigin(), {
            expected_revision: 0,
          }),
      ]) {
        try {
          write();
          expect.unreachable();
        } catch (error) {
          expect(error).toBeInstanceOf(SchemaParseException);
          expect((error as SchemaParseException).errors[0].path).toBe(path);
          expect((error as Error).message).not.toContain("plain-value");
        }
      }
      expect(listSchemaHistory(fixture.db)).toHaveLength(0);
    });

    it("rejects oversize definitions and reviewed copies", () => {
      expect(() => previewSchema(fixture.db, oversize)).toThrow(
        DefinitionTooLargeError,
      );
      expect(() =>
        applySchema(fixture.db, initial, "alice", undefined, testOrigin(), {
          expected_revision: 0,
          reviewed_definition: oversize,
        }),
      ).toThrow(DefinitionTooLargeError);
      expect(listSchemaHistory(fixture.db)).toHaveLength(0);
    });

    it("still reads a stored definition the guard would now reject", () => {
      fixture.rawDb
        .prepare(
          "INSERT INTO _schema_history (version, definition, applied_at, applied_by) VALUES (1, ?, 0, 'legacy')",
        )
        .run(secret);
      expect(getCurrentSchema(fixture.db)?.definition).toBe(secret);
      expect(previewSchema(fixture.db, initial).revision).toBe(1);
    });
  });
});
