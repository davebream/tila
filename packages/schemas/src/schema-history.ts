import { z } from "zod";

// Matches DO SQLite: _schema_history table
// Column names follow the SQL migration (definition, not schema_toml)

export const SchemaHistorySchema = z.object({
  version: z.number().int(),
  definition: z.string(), // TOML content as string; SQL column is `definition TEXT NOT NULL`
  applied_at: z.number().int(),
  applied_by: z.string(),
});

export type SchemaHistory = z.infer<typeof SchemaHistorySchema>;

// Apply strategy for schema evolution (v0.1: relax and force only)
// v0.2 strategies (migrate, default-parent, backfill) are not in scope for v0.1

export const ApplyStrategySchema = z.enum(["relax", "force"]);

export type ApplyStrategy = z.infer<typeof ApplyStrategySchema>;
