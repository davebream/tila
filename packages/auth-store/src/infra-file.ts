import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { type PerSlugInfraMeta, PerSlugInfraMetaSchema } from "@tila/schemas";
import { parse, stringify } from "smol-toml";
import { RegistryParseError } from "./errors.js";
import type { TilaPaths } from "./paths.js";

/**
 * Read ~/.tila/infra/<slug>.toml.
 *
 * Returns null if the file does not exist.
 * Throws RegistryParseError on corrupt TOML or invalid schema.
 * The slug is validated by TilaPaths.infraFile() (charset + containment).
 */
export async function readInfraMeta(
  paths: TilaPaths,
  slug: string,
): Promise<PerSlugInfraMeta | null> {
  const filePath = paths.infraFile(slug);

  if (!existsSync(filePath)) {
    return null;
  }

  let raw: string;
  try {
    raw = await readFile(filePath, "utf-8");
  } catch (err) {
    throw new RegistryParseError(
      `Failed to read infra file at ${filePath}`,
      err,
    );
  }

  let parsed: unknown;
  try {
    parsed = parse(raw);
  } catch (err) {
    throw new RegistryParseError(
      `Failed to parse TOML in infra file at ${filePath}`,
      err,
    );
  }

  const result = PerSlugInfraMetaSchema.safeParse(parsed);
  if (!result.success) {
    throw new RegistryParseError(
      `Invalid infra schema at ${filePath}: ${result.error.message}`,
      result.error,
    );
  }

  return result.data;
}

/**
 * Write ~/.tila/infra/<slug>.toml atomically (temp file + rename).
 *
 * Creates the infra directory with mode 0o700 if it does not exist.
 * The infra file is written with mode 0o600.
 * The slug is validated by TilaPaths.infraFile() (charset + containment).
 */
export async function writeInfraMeta(
  paths: TilaPaths,
  slug: string,
  meta: PerSlugInfraMeta,
): Promise<void> {
  const filePath = paths.infraFile(slug);
  const infraDir = paths.infraDir();

  // Ensure the infra directory exists with restrictive permissions
  mkdirSync(infraDir, { recursive: true, mode: 0o700 });

  const serialized = stringify(meta as Record<string, unknown>);

  // Atomic write: write to a temp file, then rename into place
  const tempPath = `${filePath}.tmp.${process.pid}`;
  try {
    writeFileSync(tempPath, serialized, { mode: 0o600 });
    renameSync(tempPath, filePath);
  } catch (err) {
    // Clean up temp file if it exists
    try {
      if (existsSync(tempPath)) {
        const { unlinkSync } = await import("node:fs");
        unlinkSync(tempPath);
      }
    } catch {
      // best-effort cleanup
    }
    throw err;
  }
}
