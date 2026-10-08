import { readFileSync, readdirSync } from "node:fs";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs", () => ({
  readdirSync: vi.fn(),
  readFileSync: vi.fn(),
}));

const mockReaddirSync = vi.mocked(readdirSync);
const mockReadFileSync = vi.mocked(readFileSync);

describe("splitStatements", () => {
  it("splits simple semicolon-delimited SQL", async () => {
    const { splitStatements } = await import("../../lib/d1-migrations");
    const result = splitStatements(
      "CREATE TABLE a (id INT); CREATE TABLE b (id INT)",
    );
    expect(result).toEqual([
      "CREATE TABLE a (id INT)",
      "CREATE TABLE b (id INT)",
    ]);
  });

  it("ignores trailing semicolons and whitespace", async () => {
    const { splitStatements } = await import("../../lib/d1-migrations");
    const result = splitStatements("CREATE TABLE a (id INT);\n\n");
    expect(result).toEqual(["CREATE TABLE a (id INT)"]);
  });

  it("returns empty array for empty input", async () => {
    const { splitStatements } = await import("../../lib/d1-migrations");
    expect(splitStatements("")).toEqual([]);
    expect(splitStatements("   ")).toEqual([]);
  });

  it("handles multi-line statements", async () => {
    const { splitStatements } = await import("../../lib/d1-migrations");
    const sql = `CREATE TABLE a (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL
);

CREATE INDEX idx_a_name ON a(name)`;
    const result = splitStatements(sql);
    expect(result).toHaveLength(2);
    expect(result[0]).toContain("CREATE TABLE");
    expect(result[1]).toContain("CREATE INDEX");
  });

  it("strips SQL comments", async () => {
    const { splitStatements } = await import("../../lib/d1-migrations");
    const sql = `-- This is a comment
CREATE TABLE a (id INT);
-- Another comment
CREATE TABLE b (id INT)`;
    const result = splitStatements(sql);
    expect(result).toEqual([
      "CREATE TABLE a (id INT)",
      "CREATE TABLE b (id INT)",
    ]);
  });
  it("keeps the real 0027 triggers intact", async () => {
    const fs = await vi.importActual<typeof import("node:fs")>("node:fs");
    const sql = fs.readFileSync(
      new URL(
        "../../../../worker/migrations/global/0027_scoped_credentials.sql",
        import.meta.url,
      ),
      "utf8",
    );
    const { splitStatements } = await import("../../lib/d1-migrations");
    const statements = splitStatements(sql);
    expect(statements).toHaveLength(20);
    const triggers = statements.filter((statement) =>
      statement.startsWith("CREATE TRIGGER"),
    );
    expect(triggers).toHaveLength(2);
    for (const trigger of triggers)
      expect(trigger).toMatch(/BEGIN SELECT RAISE\([\s\S]*; END$/);
  });

  it("preserves quoted SQL and comments inside strings while splitting trigger bodies", async () => {
    const { splitStatements } = await import("../../lib/d1-migrations");
    const sql = `/* ; BEGIN */ CREATE TABLE "semi;colon" ([end] TEXT, \`begin\` TEXT);
CREATE TEMP TRIGGER t AFTER INSERT ON "semi;colon"
BEGIN
  INSERT INTO "semi;colon" VALUES ('it''s; --literal', '/* literal */');
  SELECT CASE WHEN 1 THEN CASE WHEN 1 THEN 'END;' END ELSE 'BEGIN' END;
END;
-- tail ;
SELECT "semi;colon", [end], \`begin\` FROM "semi;colon";`;
    const statements = splitStatements(sql);
    expect(statements).toHaveLength(3);
    expect(statements[1]).toContain("'it''s; --literal'");
    expect(statements[1]).toContain("'/* literal */'");
    expect(statements[1]).toMatch(/END;\s*END$/);
    expect(statements[2]).toContain('SELECT "semi;colon"');
  });
});

describe("applyD1Migrations", () => {
  let queries: Array<{ sql: string; params?: unknown[] }>;

  function makeQueryFn() {
    queries = [];
    return async (sql: string, params?: (string | number | null)[]) => {
      queries.push({ sql, params });
      if (sql.includes("SELECT name FROM _d1_migrations")) {
        return [];
      }
      if (sql.includes("SELECT name FROM d1_migrations")) {
        throw new Error("no such table: d1_migrations");
      }
      return [];
    };
  }

  beforeEach(() => {
    vi.resetAllMocks();
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("creates tracker table and applies all migrations on fresh DB", async () => {
    const queryFn = makeQueryFn();
    mockReaddirSync.mockReturnValue([
      "0001_initial.sql",
      "0002_extras.sql",
    ] as unknown as ReturnType<typeof readdirSync>);
    mockReadFileSync.mockImplementation((path) => {
      if (String(path).includes("0001")) return "CREATE TABLE a (id INT)";
      return "CREATE TABLE b (id INT)";
    });

    const { applyD1Migrations } = await import("../../lib/d1-migrations");
    const result = await applyD1Migrations({
      queryFn,
      migrationsDir: "/fake/migrations",
    });

    expect(result.applied).toBe(2);
    expect(result.skipped).toBe(0);
    expect(result.appliedNames).toEqual([
      "0001_initial.sql",
      "0002_extras.sql",
    ]);

    const createTracker = queries.find((q) => q.sql.includes("_d1_migrations"));
    expect(createTracker).toBeDefined();

    const inserts = queries.filter((q) => q.sql.includes("INSERT OR IGNORE"));
    expect(inserts).toHaveLength(2);
  });

  it("skips already-applied migrations", async () => {
    const queryFn = async (
      sql: string,
      _params?: (string | number | null)[],
    ) => {
      if (sql.includes("SELECT name FROM _d1_migrations")) {
        return [{ name: "0001_initial.sql" }];
      }
      if (sql.includes("SELECT name FROM d1_migrations")) {
        throw new Error("no such table");
      }
      return [];
    };
    mockReaddirSync.mockReturnValue([
      "0001_initial.sql",
      "0002_extras.sql",
    ] as unknown as ReturnType<typeof readdirSync>);
    mockReadFileSync.mockReturnValue("CREATE TABLE b (id INT)");

    const { applyD1Migrations } = await import("../../lib/d1-migrations");
    const result = await applyD1Migrations({
      queryFn,
      migrationsDir: "/fake/migrations",
    });

    expect(result.applied).toBe(1);
    expect(result.skipped).toBe(1);
    expect(result.appliedNames).toEqual(["0002_extras.sql"]);
  });

  it("seeds from wrangler d1_migrations table", async () => {
    const seeded: string[] = [];
    const queryFn = async (
      sql: string,
      params?: (string | number | null)[],
    ) => {
      if (sql.includes("SELECT name FROM d1_migrations")) {
        return [{ name: "0001_initial" }, { name: "0002_extras.sql" }];
      }
      if (sql.includes("SELECT name FROM _d1_migrations")) {
        return seeded.map((name) => ({ name }));
      }
      if (sql.includes("INSERT OR IGNORE INTO _d1_migrations") && params?.[0]) {
        seeded.push(String(params[0]));
      }
      return [];
    };
    mockReaddirSync.mockReturnValue([
      "0001_initial.sql",
      "0002_extras.sql",
    ] as unknown as ReturnType<typeof readdirSync>);
    mockReadFileSync.mockReturnValue("");

    const { applyD1Migrations } = await import("../../lib/d1-migrations");
    const result = await applyD1Migrations({
      queryFn,
      migrationsDir: "/fake/migrations",
    });

    // Both should be seeded (with .sql normalization)
    expect(seeded).toContain("0001_initial.sql");
    expect(seeded).toContain("0002_extras.sql");
    expect(result.applied).toBe(0);
    expect(result.appliedNames).toEqual([]);
  });

  it("catches 'already exists' errors on individual statements", async () => {
    let callCount = 0;
    const queryFn = async (sql: string) => {
      if (sql.includes("SELECT name FROM _d1_migrations")) return [];
      if (sql.includes("SELECT name FROM d1_migrations"))
        throw new Error("no such table");
      if (sql.includes("ADD COLUMN")) {
        throw new Error("duplicate column name: foo");
      }
      callCount++;
      return [];
    };
    mockReaddirSync.mockReturnValue([
      "0001_initial.sql",
    ] as unknown as ReturnType<typeof readdirSync>);
    mockReadFileSync.mockReturnValue(
      "CREATE TABLE a (id INT); ALTER TABLE a ADD COLUMN foo TEXT",
    );

    const { applyD1Migrations } = await import("../../lib/d1-migrations");
    const result = await applyD1Migrations({
      queryFn,
      migrationsDir: "/fake/migrations",
    });

    expect(result.applied).toBe(1);
  });

  it("propagates non-idempotent errors", async () => {
    const queryFn = async (sql: string) => {
      if (sql.includes("SELECT name FROM _d1_migrations")) return [];
      if (sql.includes("SELECT name FROM d1_migrations"))
        throw new Error("no such table");
      if (sql.includes("CREATE TABLE"))
        throw new Error("SQLITE_ERROR: syntax error");
      return [];
    };
    mockReaddirSync.mockReturnValue(["0001_bad.sql"] as unknown as ReturnType<
      typeof readdirSync
    >);
    mockReadFileSync.mockReturnValue("CREATE TABLE");

    const { applyD1Migrations } = await import("../../lib/d1-migrations");
    await expect(
      applyD1Migrations({ queryFn, migrationsDir: "/fake" }),
    ).rejects.toThrow("SQLITE_ERROR");
  });
  it.each([false, true])(
    "applies real migrations in SQLite and recovers partial 0027: %s",
    async (interrupt) => {
      const fs = await vi.importActual<typeof import("node:fs")>("node:fs");
      mockReaddirSync.mockImplementation(fs.readdirSync);
      mockReadFileSync.mockImplementation(fs.readFileSync);
      const { fileURLToPath } = await import("node:url");
      const migrationsDir = fileURLToPath(
        new URL("../../../../worker/migrations/global/", import.meta.url),
      );
      const { applyD1Migrations } = await import("../../lib/d1-migrations");
      const db = new Database(":memory:");
      let failTrigger = interrupt;
      let seeded = false;
      const queryFn = async (
        sql: string,
        params: (string | number | null)[] = [],
      ) => {
        if (
          !seeded &&
          sql.startsWith("CREATE TABLE _project_memberships_new")
        ) {
          db.prepare(`INSERT INTO _project_memberships
            (membership_id, project_id, principal_id, provider, identity_host, subject_id, subject_kind, role, granted_by, granted_at)
            VALUES ('member-1', 'project-1', 'principal-1', 'github', 'github.com', '42', 'human', 'owner', 'principal-1', 123)`).run();
          seeded = true;
        }
        if (failTrigger && sql.startsWith("CREATE TRIGGER")) {
          failTrigger = false;
          throw new Error("simulated interrupted migration");
        }
        const statement = db.prepare(sql);
        if (statement.reader) return statement.all(...params);
        statement.run(...params);
        return [];
      };
      try {
        if (interrupt) {
          await expect(
            applyD1Migrations({ queryFn, migrationsDir }),
          ).rejects.toThrow("simulated interrupted migration");
          expect(
            db
              .prepare("SELECT name FROM _d1_migrations WHERE name = ?")
              .get("0027_scoped_credentials.sql"),
          ).toBeUndefined();
        }
        await applyD1Migrations({ queryFn, migrationsDir });
        expect(
          db
            .prepare(
              "SELECT name FROM sqlite_master WHERE type = 'trigger' ORDER BY name",
            )
            .all(),
        ).toEqual([
          { name: "credentials_legacy_name" },
          { name: "tokens_credential_name" },
        ]);
        expect(
          db
            .prepare(
              "SELECT name FROM sqlite_master WHERE name = '_workload_exchange_once'",
            )
            .get(),
        ).toBeDefined();
        const files = fs
          .readdirSync(migrationsDir)
          .filter((file) => file.endsWith(".sql"))
          .sort();
        expect(
          db.prepare("SELECT name FROM _d1_migrations ORDER BY name").all(),
        ).toEqual(files.map((name) => ({ name })));
        expect(
          db
            .prepare(
              "SELECT membership_id, principal_id, role FROM _project_memberships",
            )
            .all(),
        ).toEqual([
          {
            membership_id: "member-1",
            principal_id: "principal-1",
            role: "owner",
          },
        ]);
        const rerun = await applyD1Migrations({ queryFn, migrationsDir });
        expect(rerun.applied).toBe(0);
      } finally {
        db.close();
      }
    },
  );

  it("refuses pending files in --no-migrate mode without writing to D1", async () => {
    mockReaddirSync.mockReturnValue([
      "0002_new.sql",
      "0001_initial.sql",
    ] as unknown as ReturnType<typeof readdirSync>);
    const queryFn = vi.fn(async (sql: string) => {
      if (sql.includes("FROM _d1_migrations"))
        return [{ name: "0001_initial.sql" }];
      if (sql.includes("FROM d1_migrations"))
        throw new Error("no such table: d1_migrations");
      return [];
    });
    const { applyD1Migrations } = await import("../../lib/d1-migrations");
    await expect(
      applyD1Migrations({ queryFn, migrationsDir: "/fake", migrate: false }),
    ).rejects.toThrow("0002_new.sql");
    expect(
      queryFn.mock.calls.every(([sql]) => sql.trim().startsWith("SELECT")),
    ).toBe(true);
  });

  it.each(["_d1_migrations", "d1_migrations"])(
    "accepts current %s history in read-only mode",
    async (table) => {
      mockReaddirSync.mockReturnValue([
        "0001_initial.sql",
      ] as unknown as ReturnType<typeof readdirSync>);
      const queryFn = vi.fn(async (sql: string) => {
        if (sql.includes(`FROM ${table} `))
          return [
            {
              name:
                table === "d1_migrations" ? "0001_initial" : "0001_initial.sql",
            },
          ];
        throw new Error("no such table");
      });
      const { applyD1Migrations } = await import("../../lib/d1-migrations");
      await expect(
        applyD1Migrations({ queryFn, migrationsDir: "/fake", migrate: false }),
      ).resolves.toEqual({
        applied: 0,
        skipped: 1,
        appliedNames: [],
        watermark: "0001_initial.sql",
      });
      expect(
        queryFn.mock.calls.every(([sql]) => sql.trim().startsWith("SELECT")),
      ).toBe(true);
      expect(mockReadFileSync).not.toHaveBeenCalled();
    },
  );

  it("fails closed on history query errors in read-only mode", async () => {
    mockReaddirSync.mockReturnValue([
      "0001_initial.sql",
    ] as unknown as ReturnType<typeof readdirSync>);
    const queryFn = vi.fn(async () => {
      throw new Error("D1 permission denied");
    });
    const { applyD1Migrations } = await import("../../lib/d1-migrations");
    await expect(
      applyD1Migrations({ queryFn, migrationsDir: "/fake", migrate: false }),
    ).rejects.toThrow("D1 permission denied");
  });
});
