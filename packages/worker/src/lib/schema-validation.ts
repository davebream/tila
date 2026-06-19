/**
 * Unified TOML schema validation helper (C6 / AC-5).
 *
 * Centralizes the two-step pattern used in four worker route handlers:
 *   1. Fetch the current schema from the per-isolate cache (no per-write DO round-trip).
 *   2. TOML.parse → TilaSchemaTomlSchema.safeParse.
 *
 * Returns a typed discriminated-union result. Each call site maps the result to
 * its own fallback / error response — this helper does NOT own fallback decisions.
 *
 * Call sites:
 *   - artifacts.ts  /relationship    → relationship-type validation (allow-through on failure)
 *   - entities.ts   /artifact-refs   → slot validation (allow-through on failure)
 *   - records.ts    resolveRecordHistoryMode → history mode (returns "revision" on failure)
 *   - records.ts    GET /_types      → declared record types (empty list on failure)
 */
import { type TilaSchemaToml, TilaSchemaTomlSchema } from "@tila/schemas";
import TOML from "smol-toml";
import { getCurrentSchema } from "./schema-cache";

export type SchemaValidationResult =
  | { ok: true; schema: TilaSchemaToml }
  | { ok: false; reason: "no-schema" | "parse-error" | "validate-error" };

/**
 * Fetch and validate the current schema for a project.
 *
 * Uses the per-isolate cache (30s TTL) — avoids a DO round-trip on every write.
 * The projectId MUST match the key used by bustSchemaCache (i.e., `c.get("projectId")`).
 *
 * Returns:
 *   - `{ ok: true, schema }` — schema parsed and validated successfully
 *   - `{ ok: false, reason: "no-schema" }` — no schema configured for this project
 *   - `{ ok: false, reason: "parse-error" }` — TOML.parse threw
 *   - `{ ok: false, reason: "validate-error" }` — TilaSchemaTomlSchema.safeParse failed
 *
 * Does NOT throw. Each call site applies its own fallback + error-code mapping.
 */
export async function getValidatedSchema(
  stub: DurableObjectStub,
  projectId: string,
): Promise<SchemaValidationResult> {
  let schemaBody: Awaited<ReturnType<typeof getCurrentSchema>>;
  try {
    schemaBody = await getCurrentSchema(stub, projectId);
  } catch {
    // DO fetch error — propagate as no-schema (caller falls back permissively)
    return { ok: false, reason: "no-schema" };
  }

  if (!schemaBody?.definition) {
    return { ok: false, reason: "no-schema" };
  }

  let parsed: unknown;
  try {
    parsed = TOML.parse(schemaBody.definition);
  } catch {
    return { ok: false, reason: "parse-error" };
  }

  const schemaDef = TilaSchemaTomlSchema.safeParse(parsed);
  if (!schemaDef.success) {
    return { ok: false, reason: "validate-error" };
  }

  return { ok: true, schema: schemaDef.data };
}
