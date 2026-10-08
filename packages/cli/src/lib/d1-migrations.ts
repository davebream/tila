import { readFileSync, readdirSync } from "node:fs";

export type QueryFn = (
  sql: string,
  params?: (string | number | null)[],
) => Promise<unknown[]>;

export interface MigrationResult {
  applied: number;
  skipped: number;
  appliedNames: string[];
  watermark: string | null;
}

export async function applyD1Migrations(opts: {
  queryFn: QueryFn;
  migrationsDir: string;
  migrate?: boolean;
}): Promise<MigrationResult> {
  const { queryFn, migrationsDir } = opts;
  // Resolve bundled files before any database writes (including the tracker).
  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  if (opts.migrate === false) {
    const rows = [
      ...(await readHistory(queryFn, "_d1_migrations")),
      ...(await readHistory(queryFn, "d1_migrations")),
    ];
    const applied = new Set(
      rows.map((row) => `${row.name.replace(/\.sql$/, "")}.sql`),
    );
    const pending = files.filter((file) => !applied.has(file));
    if (pending.length > 0) {
      throw new Error(
        `Pending D1 migrations: ${pending.join(", ")}. Apply them separately or run tila deploy without --no-migrate.`,
      );
    }
    return {
      applied: 0,
      skipped: files.length,
      appliedNames: [],
      watermark: [...applied].sort().at(-1) ?? null,
    };
  }

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

  let appliedCount = 0;
  let skipped = 0;
  const appliedNames: string[] = [];
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
    appliedNames.push(file);
    applied.add(file);
  }

  return {
    applied: appliedCount,
    skipped,
    appliedNames,
    watermark: [...applied].sort().at(-1) ?? null,
  };
}

async function readHistory(
  queryFn: QueryFn,
  table: "_d1_migrations" | "d1_migrations",
): Promise<Array<{ name: string }>> {
  try {
    return (await queryFn(`SELECT name FROM ${table} ORDER BY id`)) as Array<{
      name: string;
    }>;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("no such table")) return [];
    throw err;
  }
}

async function seedFromWrangler(queryFn: QueryFn): Promise<void> {
  const rows = await readHistory(queryFn, "d1_migrations");
  for (const row of rows) {
    const name = `${row.name.replace(/\.sql$/, "")}.sql`;
    await queryFn("INSERT OR IGNORE INTO _d1_migrations (name) VALUES (?)", [
      name,
    ]);
  }
}

export function splitStatements(sql: string): string[] {
  const statements: string[] = [];
  let statement = "";
  let trigger = false;
  let depth = 0;
  // Consume comments and quoted values/identifiers as whole tokens so their
  // semicolons and BEGIN/END keywords cannot affect statement boundaries.
  const tokens = sql.matchAll(
    /--[^\r\n]*|\/\*[\s\S]*?\*\/|'(?:''|[^'])*'|"(?:""|[^"])*"|`(?:``|[^`])*`|\[[^\]]*\]|[a-zA-Z_][\w$]*|[\s\S]/g,
  );
  for (const [token] of tokens) {
    if (token.startsWith("--") || token.startsWith("/*")) {
      statement += " ";
      continue;
    }
    if (token === ";" && depth === 0) {
      if (statement.trim()) statements.push(statement.trim());
      statement = "";
      trigger = false;
      continue;
    }
    statement += token;
    if (!trigger) {
      trigger = /^\s*CREATE\s+(?:TEMP(?:ORARY)?\s+)?TRIGGER\b/i.test(statement);
    }
    if (trigger) {
      const keyword = token.toUpperCase();
      if (keyword === "BEGIN" || keyword === "CASE") depth++;
      else if (keyword === "END") depth--;
    }
  }
  if (statement.trim()) statements.push(statement.trim());
  return statements;
}
