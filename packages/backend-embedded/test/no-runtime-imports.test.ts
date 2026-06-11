import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Runtime-agnostic invariant (C10): `@tila/backend-embedded` must never import a
 * runtime-specific or platform-specific module. This is the executable
 * enforcement of the architecture constraint — alongside `tsconfig.json`'s
 * `types: []`, which prevents the corresponding ambient globals from resolving.
 *
 * THIS TEST IS THE AUTHORITATIVE GUARD for all six banned specifiers. The
 * biome.json `noRestrictedImports` override is intentionally PARTIAL: biome can
 * only ban the 3 npm-package specifiers, not the `node:`/`bun:`/`@cloudflare/`
 * protocol prefixes. Do not weaken this test on the assumption biome covers
 * everything — it does not.
 */
const BANNED_SPECIFIERS = [
  "bun:",
  "node:",
  "better-sqlite3",
  "drizzle-orm/bun-sqlite",
  "drizzle-orm/better-sqlite3",
  "@cloudflare/",
];

const SRC_DIR = join(fileURLToPath(new URL(".", import.meta.url)), "../src");

function collectSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collectSourceFiles(full));
    else if (entry.name.endsWith(".ts")) out.push(full);
  }
  return out;
}

// Match every form that introduces a module specifier:
//   import x from "spec" / export ... from "spec"  (binding imports/re-exports)
//   import "spec"                                   (bare side-effect import)
//   import("spec") / require("spec")                (dynamic, quoted)
//   import(`spec`) / require(`spec`)                (dynamic, template literal)
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

describe("backend-embedded runtime-import invariant (C10)", () => {
  const files = collectSourceFiles(SRC_DIR);

  it("scans at least the known source files", () => {
    expect(files.length).toBeGreaterThanOrEqual(3);
  });

  it("no source file imports a banned runtime/platform specifier", () => {
    const violations: string[] = [];
    for (const file of files) {
      const source = readFileSync(file, "utf-8");
      for (const spec of importedSpecifiers(source)) {
        for (const banned of BANNED_SPECIFIERS) {
          if (spec === banned || spec.startsWith(banned)) {
            violations.push(`${file}: imports "${spec}" (banned: ${banned})`);
          }
        }
      }
    }
    expect(violations).toEqual([]);
  });
});
