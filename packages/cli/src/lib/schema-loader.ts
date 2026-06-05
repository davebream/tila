import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  type ComposeWarning,
  type SchemaParseError,
  composeSchemaFragments,
} from "@tila/core";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type LoadComposedSchemaResult =
  | {
      ok: true;
      definition: string;
      schemaVersion: number;
      warnings: ComposeWarning[];
      fragmentCount: number;
    }
  | {
      ok: false;
      code: "FILE_NOT_FOUND" | "SCHEMA_PARSE_ERROR";
      errors: SchemaParseError[];
      warnings: ComposeWarning[];
    };

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Discover all *.schema.toml files in `cwd` (non-recursive), compose them
 * into a single effective definition, and return the result.
 *
 * - Zero fragments found → ok:false, code:"FILE_NOT_FOUND" (the loader owns
 *   this case directly so the existing FILE_NOT_FOUND CLI behavior stays intact).
 * - Compose engine error → ok:false, code:"SCHEMA_PARSE_ERROR".
 * - Single fragment → verbatim passthrough (byte-for-byte, comments preserved).
 * - Multiple fragments → merged via composeSchemaFragments, tila.schema.toml first.
 */
export function loadComposedSchema(
  cwd: string = process.cwd(),
): LoadComposedSchemaResult {
  // Discover *.schema.toml files (non-recursive, suffix match)
  let entries: string[];
  try {
    entries = readdirSync(cwd);
  } catch {
    return {
      ok: false,
      code: "FILE_NOT_FOUND",
      errors: [],
      warnings: [],
    };
  }

  const schemaFiles = entries.filter((name) => name.endsWith(".schema.toml"));

  // Zero fragments — owned directly by the loader
  if (schemaFiles.length === 0) {
    return {
      ok: false,
      code: "FILE_NOT_FOUND",
      errors: [],
      warnings: [],
    };
  }

  // Read each file into a fragment
  const fragments = schemaFiles.map((name) => ({
    path: join(cwd, name),
    content: readFileSync(join(cwd, name), "utf8"),
  }));

  // Delegate to the compose engine
  const result = composeSchemaFragments(fragments);

  if (!result.ok) {
    return {
      ok: false,
      code: "SCHEMA_PARSE_ERROR",
      errors: result.errors,
      warnings: result.warnings,
    };
  }

  return {
    ok: true,
    definition: result.definition,
    schemaVersion: result.schemaVersion,
    warnings: result.warnings,
    fragmentCount: result.fragmentCount,
  };
}
