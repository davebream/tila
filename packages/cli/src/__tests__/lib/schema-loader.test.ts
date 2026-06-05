import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadComposedSchema } from "../../lib/schema-loader";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const VALID_SCHEMA_TOML = `schema_version = 1

[work_units.task]
label = "Task"
`;

const VALID_SCHEMA_TOML_2 = `schema_version = 1

[work_units.bug]
label = "Bug"
`;

const MALFORMED_TOML = `schema_version = 1
this is not valid toml ===
`;

// ---------------------------------------------------------------------------
// Temp dir helpers
// ---------------------------------------------------------------------------

let tmpDir: string;

function tmpPath(filename: string): string {
  return join(tmpDir, filename);
}

function writeFile(filename: string, content: string): void {
  writeFileSync(tmpPath(filename), content, "utf8");
}

beforeEach(() => {
  // Create a fresh temp dir for each test
  const base = join(tmpdir(), "tila-schema-loader-test");
  mkdirSync(base, { recursive: true });
  // Use a unique subdirectory per test to avoid cross-test pollution
  tmpDir = join(
    base,
    `test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(tmpDir, { recursive: true });
});

afterEach(() => {
  // No teardown needed — OS cleans up /tmp
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("loadComposedSchema()", () => {
  it("(a) only tila.schema.toml → ok:true, definition byte-equal, fragmentCount 1", () => {
    writeFile("tila.schema.toml", VALID_SCHEMA_TOML);

    const result = loadComposedSchema(tmpDir);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok:true");
    expect(result.definition).toBe(VALID_SCHEMA_TOML);
    expect(result.fragmentCount).toBe(1);
    expect(result.schemaVersion).toBe(1);
    expect(result.warnings).toEqual([]);
  });

  it("(b) two *.schema.toml files → merged, fragmentCount 2, tila.schema.toml ordered first", () => {
    writeFile("tila.schema.toml", VALID_SCHEMA_TOML);
    writeFile("extra.schema.toml", VALID_SCHEMA_TOML_2);

    const result = loadComposedSchema(tmpDir);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok:true");
    expect(result.fragmentCount).toBe(2);
    expect(result.schemaVersion).toBe(1);
    // Both work_units keys must be in the merged definition
    expect(result.definition).toContain("[work_units.task]");
    expect(result.definition).toContain("[work_units.bug]");
  });

  it("(c) glob ignores non-*.schema.toml files", () => {
    writeFile("tila.schema.toml", VALID_SCHEMA_TOML);
    writeFile("tila.schema.yaml", "should_be_ignored: true");
    writeFile("schema.toml", "# should be ignored — no .schema.toml suffix");
    writeFile("README.md", "# ignored");

    const result = loadComposedSchema(tmpDir);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok:true");
    // Only the one schema.toml file should be loaded
    expect(result.fragmentCount).toBe(1);
  });

  it("(d) zero fragments → ok:false, code FILE_NOT_FOUND", () => {
    // tmpDir is empty — no schema.toml files

    const result = loadComposedSchema(tmpDir);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected ok:false");
    expect(result.code).toBe("FILE_NOT_FOUND");
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it("(e) malformed fragment → ok:false, code SCHEMA_PARSE_ERROR", () => {
    writeFile("tila.schema.toml", MALFORMED_TOML);

    const result = loadComposedSchema(tmpDir);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected ok:false");
    expect(result.code).toBe("SCHEMA_PARSE_ERROR");
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it("uses process.cwd() as default when no cwd argument provided", () => {
    // This test just asserts that loadComposedSchema() is callable without args.
    // When process.cwd() has no *.schema.toml files, we get FILE_NOT_FOUND.
    // We can't fully control process.cwd() in tests, so just verify no throw.
    const result = loadComposedSchema();
    // It should return either ok:true (if there happen to be schema files in cwd)
    // or ok:false with FILE_NOT_FOUND or SCHEMA_PARSE_ERROR — but never throw.
    expect(typeof result.ok).toBe("boolean");
  });
});
