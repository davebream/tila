import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { type InstanceRegistry, InstanceRegistrySchema } from "@tila/schemas";
import { parse, stringify } from "smol-toml";
import { RegistryParseError } from "./errors.js";
import type { TilaPaths } from "./paths.js";

/**
 * Normalize a raw TOML-parsed registry object by restoring nullable fields
 * that smol-toml silently drops when their value is null.
 *
 * TOML does not support null — we use omission to represent null and restore
 * the contract fields here before Zod validation.
 */
function normalizeRegistryFromToml(raw: Record<string, unknown>): unknown {
  const instances = Array.isArray(raw.instances) ? raw.instances : [];
  return {
    current_context: null,
    ...raw,
    instances: instances.map((inst) => {
      if (typeof inst !== "object" || inst === null) return inst;
      const rec = inst as Record<string, unknown>;
      const trust = rec.trust as Record<string, unknown> | undefined;
      return {
        ...rec,
        trust:
          trust !== undefined
            ? { trusted_at: null, ...trust }
            : { trusted: false, trusted_at: null },
      };
    }),
  };
}

/**
 * Read ~/.tila/instances.toml.
 *
 * Returns null if the file does not exist.
 * Throws RegistryParseError on corrupt TOML or invalid schema.
 */
export async function readRegistry(
  paths: TilaPaths,
): Promise<InstanceRegistry | null> {
  const filePath = paths.registryFile();

  if (!existsSync(filePath)) {
    return null;
  }

  let raw: string;
  try {
    raw = await readFile(filePath, "utf-8");
  } catch (err) {
    throw new RegistryParseError(
      `Failed to read registry file at ${filePath}`,
      err,
    );
  }

  let parsed: unknown;
  try {
    parsed = parse(raw);
  } catch (err) {
    throw new RegistryParseError(
      `Failed to parse TOML in registry file at ${filePath}`,
      err,
    );
  }

  // TOML does not support null values; normalize missing nullable fields.
  // current_context and trust.trusted_at are nullable in the schema but are
  // silently dropped by smol-toml stringify when null. Restore them here.
  const normalized = normalizeRegistryFromToml(
    parsed as Record<string, unknown>,
  );

  const result = InstanceRegistrySchema.safeParse(normalized);
  if (!result.success) {
    throw new RegistryParseError(
      `Invalid registry schema at ${filePath}: ${result.error.message}`,
      result.error,
    );
  }

  return result.data;
}

/**
 * Write ~/.tila/instances.toml atomically (temp file + rename).
 *
 * Creates the home directory with mode 0o700 if it does not exist.
 * The registry file is written with mode 0o600.
 */
export async function writeRegistry(
  paths: TilaPaths,
  registry: InstanceRegistry,
): Promise<void> {
  const homeDir = paths.home;
  const filePath = paths.registryFile();

  // Ensure the home directory exists with restrictive permissions
  mkdirSync(homeDir, { recursive: true, mode: 0o700 });

  const serialized = stringify(registry as Record<string, unknown>);

  // Atomic write: write to a temp file, then rename into place
  const tempPath = `${filePath}.tmp.${process.pid}`;
  try {
    writeFileSync(tempPath, serialized, { mode: 0o600 });
    renameSync(tempPath, filePath);
    // Ensure the final file has the correct mode (rename preserves temp mode on most systems)
    // but we also set it explicitly on the temp file which should survive the rename
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

/**
 * Resolve a path relative to the registry's parent directory,
 * used internally to build paths for sibling files.
 */
export function registryDir(paths: TilaPaths): string {
  return path.dirname(paths.registryFile());
}
