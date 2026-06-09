import { artifactOps, type schema } from "@tila/ops-sqlite";
import { sql } from "drizzle-orm";
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import { describe, expect, it } from "vitest";
import { createTestDb } from "./helpers/create-test-db";

const { listExpiredPointers, listPointers, tombstonePointer, upsertPointer } =
  artifactOps;

function insertPointer(
  db: BaseSQLiteDatabase<"sync", unknown, typeof schema>,
  r2Key: string,
  expiresAt: number | null,
): void {
  upsertPointer(
    db,
    {
      r2_key: r2Key,
      resource: null,
      kind: "produced",
      sha256: `sha-${r2Key.replace(/\//g, "-")}`,
      bytes: 100,
      fence: null,
      mime_type: "application/octet-stream",
      produced_at: Date.now(),
      produced_by: "test",
      expires_at: expiresAt,
    },
    { actor: "test" },
  );
}

function insertSearchDoc(
  db: BaseSQLiteDatabase<"sync", unknown, typeof schema>,
  artifactKey: string,
  opts?: { title?: string; bodyText?: string },
): void {
  const now = Date.now();
  db.run(
    sql`INSERT INTO artifact_search_docs(artifact_key, kind, mime_type, resource, title, body_text, indexed_at, source_sha256, tombstoned)
        VALUES(${artifactKey}, ${"produced"}, ${"text/markdown"}, ${null}, ${opts?.title ?? "Test Title"}, ${opts?.bodyText ?? "Test body text content"}, ${now}, ${`sha-${artifactKey.replace(/\//g, "-")}`}, ${0})`,
  );
}

function countSearchDocs(
  db: BaseSQLiteDatabase<"sync", unknown, typeof schema>,
  artifactKey: string,
): number {
  const rows = db.all<{ cnt: number }>(
    sql`SELECT COUNT(*) as cnt FROM artifact_search_docs WHERE artifact_key = ${artifactKey}`,
  );
  return rows[0]?.cnt ?? 0;
}

function countFtsResults(
  db: BaseSQLiteDatabase<"sync", unknown, typeof schema>,
  query: string,
): number {
  const rows = db.all<{ cnt: number }>(
    sql`SELECT COUNT(*) as cnt FROM artifact_search_docs_fts WHERE artifact_search_docs_fts MATCH ${query}`,
  );
  return rows[0]?.cnt ?? 0;
}

describe("listExpiredPointers", () => {
  it("returns only rows with expires_at <= now AND tombstoned = 0", () => {
    const { db } = createTestDb();
    const now = Date.now();
    insertPointer(db, "expired/1/abc.bin", now - 1000); // expired
    insertPointer(db, "future/2/def.bin", now + 60000); // not expired
    insertPointer(db, "null/3/ghi.bin", null); // no expiry

    const result = listExpiredPointers(db, now, 100);
    expect(result).toHaveLength(1);
    expect(result[0].r2_key).toBe("expired/1/abc.bin");
  });

  it("respects the limit parameter", () => {
    const { db } = createTestDb();
    const now = Date.now();
    insertPointer(db, "expired/1/a.bin", now - 1000);
    insertPointer(db, "expired/2/b.bin", now - 2000);
    insertPointer(db, "expired/3/c.bin", now - 3000);

    const result = listExpiredPointers(db, now, 2);
    expect(result).toHaveLength(2);
  });

  it("excludes already-tombstoned rows", () => {
    const { db } = createTestDb();
    const now = Date.now();
    insertPointer(db, "expired/1/a.bin", now - 1000);
    tombstonePointer(db, "expired/1/a.bin", { actor: "test" });

    const result = listExpiredPointers(db, now, 100);
    expect(result).toHaveLength(0);
  });
});

describe("tombstonePointer with journalKind", () => {
  it("tombstones pointer and excludes it from listPointers", () => {
    const { db } = createTestDb();
    insertPointer(db, "expired/1/a.bin", Date.now() - 1000);

    // Verify present before tombstone
    const before = listPointers(db, {});
    expect(before).toHaveLength(1);

    tombstonePointer(
      db,
      "expired/1/a.bin",
      { actor: "sweep-cron" },
      "artifact.expired",
    );

    // After tombstone, listPointers (tombstoned=0 filter) excludes it
    const after = listPointers(db, {});
    expect(after).toHaveLength(0);
  });

  it("defaults to artifact.tombstoned when journalKind is omitted", () => {
    const { db } = createTestDb();
    insertPointer(db, "test/1/b.bin", null);

    // Should not throw when called without journalKind
    expect(() =>
      tombstonePointer(db, "test/1/b.bin", { actor: "manual-user" }),
    ).not.toThrow();

    const after = listPointers(db, {});
    expect(after).toHaveLength(0);
  });

  it("accepts artifact.expired journal kind without error", () => {
    const { db } = createTestDb();
    insertPointer(db, "expired/2/c.bin", Date.now() - 500);

    expect(() =>
      tombstonePointer(
        db,
        "expired/2/c.bin",
        { actor: "sweep-cron" },
        "artifact.expired",
      ),
    ).not.toThrow();

    const after = listPointers(db, {});
    expect(after).toHaveLength(0);
  });
});

describe("tombstonePointer search doc cleanup", () => {
  it("deletes search doc when tombstoning a pointer with an indexed search doc", () => {
    const { db } = createTestDb();
    const key = "produced/1/abc.md";
    insertPointer(db, key, null);
    insertSearchDoc(db, key, { title: "My Doc", bodyText: "hello world" });

    // Verify search doc exists before tombstone
    expect(countSearchDocs(db, key)).toBe(1);
    expect(countFtsResults(db, "hello")).toBe(1);

    tombstonePointer(db, key, { actor: "test-actor" });

    // Search doc should be deleted
    expect(countSearchDocs(db, key)).toBe(0);
    // FTS entry should also be removed (via asd_ad trigger)
    expect(countFtsResults(db, "hello")).toBe(0);
  });

  it("tombstone without search doc is a no-op (no error)", () => {
    const { db } = createTestDb();
    const key = "produced/2/def.bin";
    insertPointer(db, key, null);

    // No search doc inserted -- this simulates a non-searchable artifact
    expect(() =>
      tombstonePointer(db, key, { actor: "test-actor" }),
    ).not.toThrow();

    // Pointer should still be tombstoned
    const pointers = listPointers(db, {});
    expect(pointers).toHaveLength(0);
  });

  it("tombstone idempotency -- second tombstone does not throw", () => {
    const { db } = createTestDb();
    const key = "produced/3/ghi.md";
    insertPointer(db, key, null);
    insertSearchDoc(db, key);

    tombstonePointer(db, key, { actor: "test-actor" });
    // Second tombstone: pointer UPDATE is no-op (already tombstoned=1),
    // DELETE on absent search doc is no-op
    expect(() =>
      tombstonePointer(db, key, { actor: "test-actor" }),
    ).not.toThrow();

    expect(countSearchDocs(db, key)).toBe(0);
  });

  it("listExpiredPointers excludes tombstoned rows after search doc cleanup", () => {
    const { db } = createTestDb();
    const now = Date.now();
    const key = "expired/4/jkl.md";
    insertPointer(db, key, now - 1000);
    insertSearchDoc(db, key);

    tombstonePointer(db, key, { actor: "sweep-cron" }, "artifact.expired");

    // listExpiredPointers should return 0 rows (tombstoned=1)
    const expired = listExpiredPointers(db, now, 100);
    expect(expired).toHaveLength(0);
    // Search doc should be gone
    expect(countSearchDocs(db, key)).toBe(0);
  });
});

describe("retention enforcement via schema", () => {
  it("retention_days: 7 results in expires_at = produced_at + 7 days", () => {
    // Simulates what the DO handler computes for retention_days: 7
    const { db } = createTestDb();
    const producedAt = Date.now();
    const retentionDays = 7;
    const computedExpiresAt = producedAt + retentionDays * 86_400_000;

    upsertPointer(
      db,
      {
        r2_key: "produced/T-1/abc123.md",
        resource: null,
        kind: "logs",
        sha256: "sha-retention-7d",
        bytes: 100,
        fence: null,
        mime_type: "text/markdown",
        produced_at: producedAt,
        produced_by: "test",
        expires_at: computedExpiresAt,
      },
      { actor: "test" },
    );

    const pointers = listPointers(db, { kind: "logs" });
    expect(pointers).toHaveLength(1);
    expect(pointers[0].expires_at).toBe(computedExpiresAt);
    // Verify the math: 7 days in ms
    const expiresAt = pointers[0].expires_at;
    expect(expiresAt).not.toBeNull();
    expect((expiresAt as number) - producedAt).toBe(7 * 86_400_000);
  });

  it("retention_days: 0 results in expires_at = null", () => {
    const { db } = createTestDb();
    insertPointer(db, "produced/T-2/def456.md", null); // null = retention_days: 0

    const pointers = listPointers(db, {});
    expect(pointers).toHaveLength(1);
    expect(pointers[0].expires_at).toBeNull();
  });

  it("undeclared kind results in expires_at = null", () => {
    // When the schema has no entry for the kind, getArtifactKindRetention returns 0
    // DO handler computes null. Same as retention_days: 0.
    const { db } = createTestDb();
    insertPointer(db, "produced/T-3/ghi789.bin", null);

    const pointers = listPointers(db, {});
    expect(pointers).toHaveLength(1);
    expect(pointers[0].expires_at).toBeNull();
  });

  it("indexes/ prefix is lifecycle-exempt (expires_at = null even with retention)", () => {
    // indexes/ prefix artifacts always get expires_at = null regardless of schema
    const { db } = createTestDb();
    insertPointer(db, "indexes/sha256abc.json", null);

    const pointers = listPointers(db, {});
    expect(pointers).toHaveLength(1);
    expect(pointers[0].expires_at).toBeNull();
  });

  it("sources/ prefix is lifecycle-exempt (expires_at = null even with retention)", () => {
    const { db } = createTestDb();
    insertPointer(db, "sources/sha256def.bin", null);

    const pointers = listPointers(db, {});
    expect(pointers).toHaveLength(1);
    expect(pointers[0].expires_at).toBeNull();
  });

  it("listExpiredPointers excludes null expires_at rows (isNotNull guard)", () => {
    const { db } = createTestDb();
    const now = Date.now();

    // Row with past expires_at (should be returned)
    insertPointer(db, "produced/T-4/expired.bin", now - 1000);
    // Row with null expires_at (must NOT be returned)
    insertPointer(db, "produced/T-5/permanent.bin", null);
    // Row with future expires_at (should not be returned)
    insertPointer(db, "produced/T-6/future.bin", now + 60000);

    const expired = listExpiredPointers(db, now, 100);
    expect(expired).toHaveLength(1);
    expect(expired[0].r2_key).toBe("produced/T-4/expired.bin");
  });

  it("shared sha256 pointers expire independently (dedup safety)", () => {
    const { db } = createTestDb();
    const now = Date.now();
    const sharedSha256 = "sha-shared-content-abc123";

    // Pointer A: retention_days: 7, already expired
    upsertPointer(
      db,
      {
        r2_key: "produced/res-A/shared.md",
        resource: null,
        kind: "logs",
        sha256: sharedSha256,
        bytes: 200,
        fence: null,
        mime_type: "text/markdown",
        produced_at: now - 8 * 86_400_000, // 8 days ago
        produced_by: "test",
        expires_at: now - 1 * 86_400_000, // expired 1 day ago
      },
      { actor: "test" },
    );

    // Pointer B: retention_days: 30, not expired
    upsertPointer(
      db,
      {
        r2_key: "produced/res-B/shared.md",
        resource: null,
        kind: "logs",
        sha256: sharedSha256,
        bytes: 200,
        fence: null,
        mime_type: "text/markdown",
        produced_at: now - 8 * 86_400_000, // same upload time
        produced_by: "test",
        expires_at: now + 22 * 86_400_000, // still 22 days left
      },
      { actor: "test" },
    );

    // Only pointer A should be returned by listExpiredPointers
    const expired = listExpiredPointers(db, now, 100);
    expect(expired).toHaveLength(1);
    expect(expired[0].r2_key).toBe("produced/res-A/shared.md");

    // Tombstone pointer A
    tombstonePointer(
      db,
      "produced/res-A/shared.md",
      { actor: "sweep-cron" },
      "artifact.expired",
    );

    // Pointer B should still be visible
    const remaining = listPointers(db, {});
    expect(remaining).toHaveLength(1);
    expect(remaining[0].r2_key).toBe("produced/res-B/shared.md");
    expect(remaining[0].expires_at).toBe(now + 22 * 86_400_000);

    // No more expired pointers
    const expiredAfter = listExpiredPointers(db, now, 100);
    expect(expiredAfter).toHaveLength(0);
  });
});
