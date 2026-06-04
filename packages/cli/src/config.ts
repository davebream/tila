import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { type TilaProjectConfig, TilaProjectConfigSchema } from "@tila/schemas";
import { parse, stringify } from "smol-toml";

const CONFIG_FILENAME = "config.toml";
const CONFIG_DIR = ".tila";

/**
 * Walk up from startDir looking for .tila/config.toml.
 * Returns the parsed and validated config, or null if not found.
 */
export function findConfig(startDir?: string): TilaProjectConfig | null {
  let dir = resolve(startDir ?? process.cwd());
  const root = resolve("/");

  while (true) {
    const candidate = join(dir, CONFIG_DIR, CONFIG_FILENAME);
    if (existsSync(candidate)) {
      return loadConfigFile(candidate);
    }
    if (dir === root) {
      return null;
    }
    dir = dirname(dir);
  }
}

/**
 * Load and validate a specific config file path.
 * Throws on parse or validation errors with actionable messages.
 */
export function loadConfigFile(filePath: string): TilaProjectConfig {
  const raw = readFileSync(filePath, "utf-8");
  const parsed = parse(raw);
  const result = TilaProjectConfigSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .map(
        (i: { path: (string | number)[]; message: string }) =>
          `  - ${i.path.join(".")}: ${i.message}`,
      )
      .join("\n");
    throw new Error(
      `Invalid config at ${filePath}:\n${issues}\n\nSee docs/01-DECISIONS.md section 8 for the expected config shape.`,
    );
  }
  return result.data;
}

/**
 * Write a validated config to <dir>/config.toml.
 * Validates against TilaProjectConfigSchema before writing.
 * Creates the directory if it doesn't exist.
 */
export function writeConfigFile(
  config: TilaProjectConfig,
  dir = ".tila",
): void {
  // Validate before writing -- never write a config that won't load
  const result = TilaProjectConfigSchema.safeParse(config);
  if (!result.success) {
    const issues = result.error.issues
      .map(
        (i: { path: (string | number)[]; message: string }) =>
          `  - ${i.path.join(".")}: ${i.message}`,
      )
      .join("\n");
    throw new Error(`Invalid config:\n${issues}`);
  }
  mkdirSync(dir, { recursive: true });
  const toml = stringify(result.data as Record<string, unknown>);
  writeFileSync(join(dir, CONFIG_FILENAME), toml, "utf-8");
}

/**
 * Resolve the .tila directory path (parent of config.toml).
 * Returns null if no config found.
 */
export function findTilaDir(startDir?: string): string | null {
  let dir = resolve(startDir ?? process.cwd());
  const root = resolve("/");

  while (true) {
    const candidate = join(dir, CONFIG_DIR);
    if (existsSync(join(candidate, CONFIG_FILENAME))) {
      return candidate;
    }
    if (dir === root) {
      return null;
    }
    dir = dirname(dir);
  }
}
