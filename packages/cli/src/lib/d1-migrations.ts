import { readFileSync, readdirSync } from "node:fs";

export type QueryFn = (
  sql: string,
  params?: (string | number | null)[],
) => Promise<unknown[]>;

export interface MigrationResult {
  applied: number;
  skipped: number;
}

export async function applyD1Migrations(opts: {
  queryFn: QueryFn;
  migrationsDir: string;
}): Promise<MigrationResult> {
  const { queryFn, migrationsDir } = opts;

  await queryFn(`
    CREATE TABLE IF NOT EXISTS _d1_migrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  await seedFromWrangler(queryFn);

  const appliedRes = (await queryFn(
    "SELECT name FROM _d1_migrations ORDER BY id",
  )) as Array<{ name: string }>;
  const applied = new Set(appliedRes.map((r) => r.name));

  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  let appliedCount = 0;
  let skipped = 0;
  for (const file of files) {
    if (applied.has(file)) {
      skipped++;
      continue;
    }

    const sql = readFileSync(`${migrationsDir}/${file}`, "utf-8").trim();
    if (!sql) continue;

    for (const stmt of splitStatements(sql)) {
      try {
        await queryFn(stmt);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (
          msg.includes("already exists") ||
          msg.includes("duplicate column")
        ) {
          continue;
        }
        throw err;
      }
    }

    await queryFn("INSERT OR IGNORE INTO _d1_migrations (name) VALUES (?)", [
      file,
    ]);
    appliedCount++;
  }

  return { applied: appliedCount, skipped };
}

async function seedFromWrangler(queryFn: QueryFn): Promise<void> {
  try {
    const rows = (await queryFn(
      "SELECT name FROM d1_migrations ORDER BY id",
    )) as Array<{ name: string }>;
    for (const row of rows) {
      const base = row.name.replace(/\.sql$/, "");
      const name = `${base}.sql`;
      await queryFn("INSERT OR IGNORE INTO _d1_migrations (name) VALUES (?)", [
        name,
      ]);
    }
  } catch {
    // Table doesn't exist — fresh database, nothing to seed
  }
}

export function splitStatements(sql: string): string[] {
  return sql
    .replace(/--.*$/gm, "")
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}
