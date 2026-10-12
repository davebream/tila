import { searchDriftOps } from "@tila/ops-sqlite";
import type { TilaSchemaToml } from "@tila/schemas";
import { describe, expect, it } from "vitest";
import { createTestDb } from "./helpers/create-test-db";

const { computeDrift } = searchDriftOps;

function insertPointer(
  sqlite: ReturnType<typeof createTestDb>["sqlite"],
  overrides: {
    r2_key: string;
    kind?: string;
    sha256?: string;
    tombstoned?: number;
  },
) {
  const row = {
    kind: "lesson",
    sha256: "abc123",
    bytes: 100,
    mime_type: "text/markdown",
    produced_at: Date.now(),
    produced_by: "test",
    tombstoned: 0,
    ...overrides,
  };
  sqlite
    .prepare(
      "INSERT INTO artifact_pointers (r2_key, kind, sha256, bytes, mime_type, produced_at, produced_by, tombstoned) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .run(
      row.r2_key,
      row.kind,
      row.sha256,
      row.bytes,
      row.mime_type,
      row.produced_at,
      row.produced_by,
      row.tombstoned,
    );
}

function insertSearchDoc(
  sqlite: ReturnType<typeof createTestDb>["sqlite"],
  overrides: {
    artifact_key: string;
    kind?: string;
    source_sha256?: string;
    tombstoned?: number;
  },
) {
  const row = {
    kind: "lesson",
    mime_type: "text/markdown",
    resource: null,
    title: "Test",
    body_text: "Test body",
    indexed_at: Date.now(),
    source_sha256: "abc123",
    tombstoned: 0,
    ...overrides,
  };
  sqlite
    .prepare(
      "INSERT INTO artifact_search_docs (artifact_key, kind, mime_type, resource, title, body_text, indexed_at, source_sha256, tombstoned) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .run(
      row.artifact_key,
      row.kind,
      row.mime_type,
      row.resource,
      row.title,
      row.body_text,
      row.indexed_at,
      row.source_sha256,
      row.tombstoned,
    );
}

// Test schema: "lesson" is searchable, "snapshot" is not
const TEST_SCHEMA: TilaSchemaToml = {
  schema_version: 1,
  work_units: {},
  artifacts: {
    lesson: {
      searchable: true,
      search_mode: "full_text",
      mime_types: [],
      retention_days: 0,
    },
    snapshot: {
      searchable: false,
      search_mode: "none",
      mime_types: [],
      retention_days: 0,
    },
  },
};

describe("computeDrift", () => {
  it("returns all-pass when tables are in sync", () => {
    const { db, sqlite } = createTestDb();
    insertPointer(sqlite, { r2_key: "produced/res/abc.md" });
    insertSearchDoc(sqlite, { artifact_key: "produced/res/abc.md" });
    const report = computeDrift(db, TEST_SCHEMA);
    for (const f of report.findings) {
      expect(f.status).toBe("pass");
      expect(f.count).toBe(0);
    }
    expect(report.findings).toHaveLength(5);
    expect(report.checkedAt).toBeGreaterThan(0);
  });

  it("detects search-missing-doc (searchable pointer, no search doc)", () => {
    const { db, sqlite } = createTestDb();
    insertPointer(sqlite, { r2_key: "produced/res/abc.md", kind: "lesson" });
    const report = computeDrift(db, TEST_SCHEMA);
    const f = report.findings.find((f) => f.check === "search-missing-doc");
    expect(f).toBeDefined();
    expect(f?.status).toBe("fail");
    expect(f?.count).toBe(1);
    expect(f?.examples).toContain("produced/res/abc.md");
  });

  it("detects search-orphan-doc (search doc, no pointer)", () => {
    const { db, sqlite } = createTestDb();
    insertSearchDoc(sqlite, { artifact_key: "produced/res/orphan.md" });
    const report = computeDrift(db, TEST_SCHEMA);
    const f = report.findings.find((f) => f.check === "search-orphan-doc");
    expect(f).toBeDefined();
    expect(f?.status).toBe("fail");
    expect(f?.count).toBe(1);
    expect(f?.examples).toContain("produced/res/orphan.md");
  });

  it("detects search-tombstone-leak (tombstoned pointer, visible search doc)", () => {
    const { db, sqlite } = createTestDb();
    insertPointer(sqlite, {
      r2_key: "produced/res/tomb.md",
      tombstoned: 1,
    });
    insertSearchDoc(sqlite, {
      artifact_key: "produced/res/tomb.md",
      tombstoned: 0,
    });
    const report = computeDrift(db, TEST_SCHEMA);
    const f = report.findings.find((f) => f.check === "search-tombstone-leak");
    expect(f).toBeDefined();
    expect(f?.status).toBe("fail");
    expect(f?.count).toBe(1);
    expect(f?.examples).toContain("produced/res/tomb.md");
  });

  it("detects search-unsupported-kind (search doc for non-searchable kind)", () => {
    const { db, sqlite } = createTestDb();
    insertPointer(sqlite, { r2_key: "produced/res/snap.md", kind: "snapshot" });
    insertSearchDoc(sqlite, {
      artifact_key: "produced/res/snap.md",
      kind: "snapshot",
    });
    const report = computeDrift(db, TEST_SCHEMA);
    const f = report.findings.find(
      (f) => f.check === "search-unsupported-kind",
    );
    expect(f).toBeDefined();
    expect(f?.status).toBe("warn");
    expect(f?.count).toBe(1);
    expect(f?.examples).toContain("produced/res/snap.md");
  });

  it("detects search-stale-index (sha256 mismatch)", () => {
    const { db, sqlite } = createTestDb();
    insertPointer(sqlite, {
      r2_key: "produced/res/stale.md",
      sha256: "new-hash",
    });
    insertSearchDoc(sqlite, {
      artifact_key: "produced/res/stale.md",
      source_sha256: "old-hash",
    });
    const report = computeDrift(db, TEST_SCHEMA);
    const f = report.findings.find((f) => f.check === "search-stale-index");
    expect(f).toBeDefined();
    expect(f?.status).toBe("warn");
    expect(f?.count).toBe(1);
    expect(f?.examples).toContain("produced/res/stale.md");
  });

  it("returns schema-unavailable sentinel when parsedSchema is null", () => {
    const { db } = createTestDb();
    const report = computeDrift(db, null);
    const missing = report.findings.find(
      (f) => f.check === "search-missing-doc",
    );
    const unsupported = report.findings.find(
      (f) => f.check === "search-unsupported-kind",
    );
    expect(missing).toBeDefined();
    expect(missing?.status).toBe("warn");
    expect(missing?.detail).toContain("Schema unavailable");
    expect(unsupported).toBeDefined();
    expect(unsupported?.status).toBe("warn");
    expect(unsupported?.detail).toContain("Schema unavailable");
    // Non-schema-dependent checks should still run normally
    const orphan = report.findings.find((f) => f.check === "search-orphan-doc");
    expect(orphan).toBeDefined();
    expect(orphan?.status).toBe("pass");
    const tombstone = report.findings.find(
      (f) => f.check === "search-tombstone-leak",
    );
    expect(tombstone).toBeDefined();
    expect(tombstone?.status).toBe("pass");
    const stale = report.findings.find((f) => f.check === "search-stale-index");
    expect(stale).toBeDefined();
    expect(stale?.status).toBe("pass");
  });
});
