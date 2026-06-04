import { readFileSync, readdirSync } from "node:fs";
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
});
