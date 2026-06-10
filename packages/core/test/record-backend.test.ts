import type {
  RecordHistoryItem,
  RecordListItem,
  RecordRow,
} from "@tila/schemas";
import { describe, expect, it } from "vitest";
import type { RecordBackend } from "../src/interfaces/record-backend";

// Type-level conformance test for the `RecordBackend` interface seam.
//
// The package `typecheck` script chains `tsc --noEmit -p tsconfig.test.json`
// specifically so this file is typechecked in CI — the default `typecheck`
// only covers `src`, and vitest strips types at transform time, so without the
// chained config a broken interface would never fail. tsconfig.test.json is
// scoped to this file (not the whole `test/` dir) because the other tests and
// fixtures are intentionally loose and would surface unrelated pre-existing
// errors under a strict `tsc` run.

// A fully-typed `RecordRow` literal. Returning this (rather than casting the
// input) means the stub's return types are genuinely checked against the
// interface — if a method's declared return type drifts from `RecordRow`, this
// fixture stops compiling (see tsconfig.test.json, chained into `typecheck`).
const row: RecordRow = {
  type: "config",
  key: "k",
  schema_version: 1,
  value: {},
  value_sha256: "sha",
  revision: 1,
  archived: 0,
  created_at: 0,
  updated_at: 0,
  updated_by: "actor",
  tags: [],
  fence: 1,
};

// Structural type-check fixture: this stub only compiles if `RecordBackend`
// exposes exactly the expected surface, typed against the canonical record
// types from `@tila/schemas`. It is a type-level (compile-time) assertion;
// the runtime body is irrelevant.
const _impl: RecordBackend = {
  async createRecord(_input) {
    return row;
  },
  async setRecord(_input) {
    return row;
  },
  async getRecord(_type, _key) {
    return null;
  },
  async patchRecord(_input) {
    return row;
  },
  async archiveRecord(_input) {
    return row;
  },
  async unarchiveRecord(_input) {
    return row;
  },
  async listRecords(_filter) {
    const items: RecordListItem[] = [];
    return { items, total: 0, next_cursor: null };
  },
  async listRecordHistory(_type, _key, _opts) {
    const items: RecordHistoryItem[] = [];
    return { items, total: 0, next_cursor: null };
  },
  async listRecordTypesInUse() {
    return [];
  },
};

describe("RecordBackend interface", () => {
  it("is structurally satisfiable by a conforming implementation", () => {
    expect(typeof _impl.createRecord).toBe("function");
    expect(typeof _impl.listRecordHistory).toBe("function");
    expect(typeof _impl.listRecordTypesInUse).toBe("function");
  });
});
