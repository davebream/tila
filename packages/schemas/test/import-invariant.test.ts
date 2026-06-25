import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Worker-purity invariant: new and edited @tila/schemas files must not import
 * any runtime-specific or platform-specific module. Schemas are pure Zod/types
 * and must remain importable in Cloudflare Workers, Node, and Bun without any
 * runtime adaptation.
 *
 * Mirrors packages/backend-embedded/test/no-runtime-imports.test.ts.
 */
const BANNED_SPECIFIERS = [
  "node:",
  "bun:",
  "require(",
  "@cloudflare/",
  "better-sqlite3",
  "drizzle-orm/bun-sqlite",
  "drizzle-orm/better-sqlite3",
];

const SRC_DIR = join(fileURLToPath(new URL(".", import.meta.url)), "../src");

/**
 * The schema files introduced or edited by WI-J1.
 * These must all be Worker-pure (Zod + types only, no runtime imports).
 */
const GUARDED_FILES = [
  "instance-registry.ts",
  "credential.ts",
  "refresh.ts",
  "infra-config.ts",
  "config.ts",
];

function importedSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  const patterns = [
    /(?:import|export)\b[\s\S]*?\bfrom\s*["'`]([^"'`]+)["'`]/g,
    /\bimport\s*["'`]([^"'`]+)["'`]/g,
    /\b(?:import|require)\s*\(\s*["'`]([^"'`]+)["'`]\s*\)/g,
  ];
  for (const re of patterns) {
    let m: RegExpExecArray | null = re.exec(source);
    while (m !== null) {
      specifiers.push(m[1]);
      m = re.exec(source);
    }
  }
  return specifiers;
}

describe("@tila/schemas WI-J1 Worker-purity invariant", () => {
  it("guards the expected set of files (non-zero)", () => {
    expect(GUARDED_FILES.length).toBeGreaterThan(0);
  });

  it("no guarded schema file imports a banned runtime/platform specifier", () => {
    const violations: string[] = [];
    for (const filename of GUARDED_FILES) {
      const filePath = join(SRC_DIR, filename);
      let source: string;
      try {
        source = readFileSync(filePath, "utf-8");
      } catch {
        // File doesn't exist yet — skip (tests written before source files)
        continue;
      }
      for (const spec of importedSpecifiers(source)) {
        for (const banned of BANNED_SPECIFIERS) {
          if (spec === banned || spec.startsWith(banned)) {
            violations.push(
              `${filename}: imports "${spec}" (banned: ${banned})`,
            );
          }
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("all guarded files exist (ensures the test is not vacuously passing)", () => {
    const missing: string[] = [];
    for (const filename of GUARDED_FILES) {
      const filePath = join(SRC_DIR, filename);
      try {
        readFileSync(filePath, "utf-8");
      } catch {
        missing.push(filename);
      }
    }
    expect(missing).toEqual([]);
  });
});
