import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { D1RevokedSubjectsStore } from "../src/revoked-subjects-store";

const CREATE_REVOKED_SUBJECTS = `
  CREATE TABLE IF NOT EXISTS _revoked_subjects (
    project_id    TEXT    NOT NULL,
    identity_host TEXT    NOT NULL DEFAULT 'github.com',
    subject_id    TEXT    NOT NULL,
    revoked_before INTEGER NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_revoked_subjects_principal
    ON _revoked_subjects (project_id, identity_host, subject_id);
`;

function createD1Shim(sqlite: Database.Database) {
  return {
    prepare(query: string) {
      return {
        bind(...params: unknown[]) {
          return {
            async all() {
              const stmt = sqlite.prepare(query);
              const rows = stmt.all(...(params as unknown[]));
              return { results: rows, success: true };
            },
            async first() {
              const stmt = sqlite.prepare(query);
              const row = stmt.get(...(params as unknown[]));
              return row ?? null;
            },
            async run() {
              const stmt = sqlite.prepare(query);
              const info = stmt.run(...(params as unknown[]));
              return { success: true, meta: { changes: info.changes } };
            },
            async raw() {
              const stmt = sqlite.prepare(query);
              stmt.raw(true);
              const rows = stmt.all(...(params as unknown[]));
              return rows;
            },
          };
        },
      };
    },
    async batch(stmts: unknown[]) {
      return stmts.map((s: unknown) => (s as { all: () => unknown }).all());
    },
    async exec(query: string) {
      sqlite.exec(query);
      return { count: 1, duration: 0 };
    },
  };
}

function createTestStore() {
  const sqlite = new Database(":memory:");
  sqlite.exec(CREATE_REVOKED_SUBJECTS);
  const d1Shim = createD1Shim(sqlite);
  const store = new D1RevokedSubjectsStore(d1Shim as unknown as D1Database);
  return { store, sqlite };
}

describe("D1RevokedSubjectsStore", () => {
  describe("getRevokedBefore — miss", () => {
    it("returns null when no tombstone exists for the principal", async () => {
      const { store } = createTestStore();
      const result = await store.getRevokedBefore("proj-1", "github.com", "42");
      expect(result).toBeNull();
    });
  });

  describe("revokeSubject + getRevokedBefore round-trip", () => {
    it("stores and retrieves revoked_before value", async () => {
      const { store } = createTestStore();
      const revokedBefore = 1_700_000_000_000; // EpochMillis

      await store.revokeSubject("proj-1", "github.com", "42", revokedBefore);
      const result = await store.getRevokedBefore("proj-1", "github.com", "42");

      expect(result).toBe(revokedBefore);
    });

    it("canonicalizes host on revokeSubject and getRevokedBefore matches", async () => {
      const { store } = createTestStore();
      const revokedBefore = 1_700_000_000_000;

      // Write with mixed-case host
      await store.revokeSubject("proj-1", "GitHub.COM", "42", revokedBefore);

      // Read with lowercase host — must find it (same canonical form)
      const result = await store.getRevokedBefore("proj-1", "github.com", "42");
      expect(result).toBe(revokedBefore);
    });

    it("canonicalizes host on getRevokedBefore (mixed-case read finds canonical row)", async () => {
      const { store } = createTestStore();
      const revokedBefore = 1_700_000_000_000;

      // Write with lowercase (canonical)
      await store.revokeSubject("proj-1", "github.com", "42", revokedBefore);

      // Read with mixed-case — must still find it
      const result = await store.getRevokedBefore("proj-1", "GITHUB.com", "42");
      expect(result).toBe(revokedBefore);
    });
  });

  describe("monotonic MAX — revokeSubject", () => {
    it("later-smaller cutoff is a no-op (does not lower revoked_before)", async () => {
      const { store } = createTestStore();
      const higher = 1_700_000_000_000;
      const lower = 1_600_000_000_000;

      await store.revokeSubject("proj-1", "github.com", "42", higher);
      await store.revokeSubject("proj-1", "github.com", "42", lower); // must be no-op

      const result = await store.getRevokedBefore("proj-1", "github.com", "42");
      expect(result).toBe(higher); // still the larger value
    });

    it("later-larger cutoff raises revoked_before", async () => {
      const { store } = createTestStore();
      const initial = 1_600_000_000_000;
      const larger = 1_700_000_000_000;

      await store.revokeSubject("proj-1", "github.com", "42", initial);
      await store.revokeSubject("proj-1", "github.com", "42", larger);

      const result = await store.getRevokedBefore("proj-1", "github.com", "42");
      expect(result).toBe(larger);
    });
  });

  describe("deleteExpired", () => {
    function seedRow(
      sqlite: Database.Database,
      subjectId: string,
      revokedBefore: number,
    ) {
      sqlite
        .prepare(
          "INSERT INTO _revoked_subjects (project_id, identity_host, subject_id, revoked_before) VALUES (?, ?, ?, ?)",
        )
        .run("proj-1", "github.com", subjectId, revokedBefore);
    }

    it("deletes a row strictly older than the cutoff", async () => {
      const { store, sqlite } = createTestStore();
      const cutoff = 1_700_000_000_000;
      seedRow(sqlite, "old", cutoff - 1);

      const deleted = await store.deleteExpired(cutoff);

      expect(deleted).toBe(1);
      expect(
        await store.getRevokedBefore("proj-1", "github.com", "old"),
      ).toBeNull();
    });

    it("keeps a row exactly at the cutoff (strict <)", async () => {
      const { store, sqlite } = createTestStore();
      const cutoff = 1_700_000_000_000;
      seedRow(sqlite, "boundary", cutoff);

      const deleted = await store.deleteExpired(cutoff);

      expect(deleted).toBe(0);
      expect(
        await store.getRevokedBefore("proj-1", "github.com", "boundary"),
      ).toBe(cutoff);
    });

    it("keeps a row newer than the cutoff", async () => {
      const { store, sqlite } = createTestStore();
      const cutoff = 1_700_000_000_000;
      seedRow(sqlite, "fresh", cutoff + 1);

      const deleted = await store.deleteExpired(cutoff);

      expect(deleted).toBe(0);
      expect(
        await store.getRevokedBefore("proj-1", "github.com", "fresh"),
      ).toBe(cutoff + 1);
    });

    it("returns the count of deleted rows", async () => {
      const { store, sqlite } = createTestStore();
      const cutoff = 1_700_000_000_000;
      seedRow(sqlite, "old-1", cutoff - 100);
      seedRow(sqlite, "old-2", cutoff - 50);
      seedRow(sqlite, "boundary", cutoff);
      seedRow(sqlite, "fresh", cutoff + 100);

      const deleted = await store.deleteExpired(cutoff);

      expect(deleted).toBe(2);
      expect(
        await store.getRevokedBefore("proj-1", "github.com", "boundary"),
      ).toBe(cutoff);
      expect(
        await store.getRevokedBefore("proj-1", "github.com", "fresh"),
      ).toBe(cutoff + 100);
    });

    it("returns 0 when no rows match", async () => {
      const { store, sqlite } = createTestStore();
      const cutoff = 1_700_000_000_000;
      seedRow(sqlite, "fresh", cutoff + 1);

      const deleted = await store.deleteExpired(cutoff);

      expect(deleted).toBe(0);
    });
  });

  describe("project scoping", () => {
    it("revoke in project A returns null for project B (same principal)", async () => {
      const { store } = createTestStore();
      const revokedBefore = 1_700_000_000_000;

      await store.revokeSubject("proj-A", "github.com", "42", revokedBefore);

      const resultB = await store.getRevokedBefore(
        "proj-B",
        "github.com",
        "42",
      );
      expect(resultB).toBeNull();
    });

    it("each project stores its own revoked_before independently", async () => {
      const { store } = createTestStore();
      const timeA = 1_600_000_000_000;
      const timeB = 1_700_000_000_000;

      await store.revokeSubject("proj-A", "github.com", "42", timeA);
      await store.revokeSubject("proj-B", "github.com", "42", timeB);

      expect(await store.getRevokedBefore("proj-A", "github.com", "42")).toBe(
        timeA,
      );
      expect(await store.getRevokedBefore("proj-B", "github.com", "42")).toBe(
        timeB,
      );
    });
  });
});
