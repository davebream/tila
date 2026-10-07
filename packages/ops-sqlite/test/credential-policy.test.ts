import type { CredentialPolicy } from "@tila/schemas";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CredentialPolicyDenied,
  assertCredentialRequest,
  filterRelationships,
} from "../src/credential-policy";
import * as entities from "../src/entity-ops";
import * as records from "../src/record-ops";
import * as schema from "../src/schema";
import { type TestDb, createTestDb, testOrigin } from "./helpers";

describe("namespace isolation in shared SQLite operations", () => {
  let f: TestDb;
  const policy: CredentialPolicy = {
    role: "participant",
    capabilities: [
      "tasks:read",
      "tasks:write",
      "records:read",
      "records:write",
      "claims:acquire",
    ],
    restrictions: {
      task_types: ["task"],
      records: [{ type: "config", key_prefixes: ["team/a"] }],
    },
  };
  beforeEach(async () => {
    f = createTestDb();
    f.db
      .insert(schema.entities)
      .values([
        {
          id: "hidden-parent-child",
          type: "task",
          schema_version: 1,
          data: JSON.stringify({ parent_id: "hidden" }),
          archived: 0,
          created_at: 1,
          updated_at: 1,
          created_by: "test",
        },
        {
          id: "visible",
          type: "task",
          schema_version: 1,
          data: "{}",
          archived: 0,
          created_at: 1,
          updated_at: 1,
          created_by: "test",
        },
        {
          id: "hidden",
          type: "secret",
          schema_version: 1,
          data: "{}",
          archived: 0,
          created_at: 1,
          updated_at: 1,
          created_by: "test",
        },
      ])
      .run();
    for (const key of ["team/a", "team/a/child", "team/ab", "other"]) {
      await records.createRecord(
        f.db,
        {
          type: "config",
          key,
          value: { key },
          schema_version: 1,
          actor: "test",
        },
        testOrigin("test"),
      );
    }
    await records.createRecord(
      f.db,
      {
        type: "secret",
        key: "team/a",
        value: {},
        schema_version: 1,
        actor: "test",
      },
      testOrigin("test"),
    );
  });
  afterEach(() => f.rawDb.close());
  it("filters rows and totals before task pagination", () => {
    const page = entities.list(f.db, {
      restrictions: policy.restrictions,
      limit: 1,
    });
    expect(page.total).toBe(1);
    expect(page.entities.map((e) => e.id)).toEqual(["visible"]);
    expect(
      entities.list(f.db, { restrictions: { task_types: [] } }).total,
    ).toBe(0);
    expect(
      entities.list(f.db, { restrictions: policy.restrictions, type: "secret" })
        .total,
    ).toBe(0);
  });
  it("filters record counts, type enumeration, and literal segment prefixes", () => {
    const page = records.listRecords(f.db, {
      type: "config",
      restrictions: policy.restrictions,
      limit: 1,
    });
    expect(page.total).toBe(2);
    expect(page.items).toHaveLength(1);
    expect(records.listRecordTypesInUse(f.db, policy.restrictions)).toEqual([
      "config",
    ]);
    expect(
      records.listRecords(f.db, {
        type: "secret",
        restrictions: policy.restrictions,
      }).total,
    ).toBe(0);
    expect(
      records.listRecords(f.db, {
        type: "config",
        restrictions: { records: [] },
      }).total,
    ).toBe(0);
  });
  it("guards direct/history/mutation paths and claim resources", () => {
    const allow = (path: string, method = "GET", body = {}) =>
      assertCredentialRequest(
        f.db,
        policy,
        method,
        path,
        new URLSearchParams(),
        body,
      );
    expect(() => allow("/record/config/team/a/history")).not.toThrow();
    expect(() => allow("/record/config/team/ab/history")).toThrow(
      CredentialPolicyDenied,
    );
    expect(() => allow("/record/config/team%2Fa/patch", "POST")).not.toThrow();
    expect(() => allow("/record/secret/team/a/archive", "POST")).toThrow(
      CredentialPolicyDenied,
    );
    expect(() =>
      allow("/coord/acquire", "POST", { resource: "record:config/team/ab" }),
    ).toThrow(CredentialPolicyDenied);
    expect(() =>
      allow("/coord/acquire", "POST", { resource: "secret:hidden" }),
    ).toThrow(CredentialPolicyDenied);
    expect(() =>
      allow("/coord/acquire", "POST", { resource: "task:visible" }),
    ).not.toThrow();
  });
  it("checks both relationship endpoints and filters related reads", () => {
    expect(() =>
      assertCredentialRequest(
        f.db,
        policy,
        "POST",
        "/entity/relationship/create",
        new URLSearchParams(),
        { from_id: "visible", to_id: "hidden" },
      ),
    ).toThrow(CredentialPolicyDenied);
    expect(
      filterRelationships(f.db, policy, [
        { from_id: "visible", to_id: "hidden" },
        { from_id: "visible", to_id: "visible" },
      ]),
    ).toEqual([{ from_id: "visible", to_id: "visible" }]);
    expect(() =>
      assertCredentialRequest(
        f.db,
        policy,
        "POST",
        "/entity/create",
        new URLSearchParams(),
        { type: "task", data: { parent_id: "hidden" } },
      ),
    ).toThrow(CredentialPolicyDenied);
  });
  it("rejects broad aggregates and templates without all mutation capabilities", () => {
    for (const path of [
      "/summary",
      "/search",
      "/journal/list",
      "/admin/transfer/snapshot/entities",
    ])
      expect(() =>
        assertCredentialRequest(
          f.db,
          policy,
          "GET",
          path,
          new URLSearchParams(),
          {},
        ),
      ).toThrow(CredentialPolicyDenied);
    expect(() =>
      assertCredentialRequest(
        f.db,
        { ...policy, capabilities: ["templates:instantiate"] },
        "POST",
        "/template/instantiate",
        new URLSearchParams(),
        {},
      ),
    ).toThrow(CredentialPolicyDenied);
  });
});
