import { constraintOps } from "@tila/ops-sqlite";
import type { TilaSchemaToml } from "@tila/schemas";
import { describe, expect, it } from "vitest";

const { checkArtifactKindSearchable } = constraintOps;

function makeSchema(
  artifacts?: Record<
    string,
    { searchable?: boolean; search_mode?: "none" | "full_text" }
  >,
): TilaSchemaToml {
  const base: TilaSchemaToml = {
    schema_version: 1,
    work_units: {},
  };
  if (artifacts) {
    base.artifacts = Object.fromEntries(
      Object.entries(artifacts).map(([k, v]) => [
        k,
        {
          mime_types: [],
          retention_days: 0,
          searchable: v.searchable ?? false,
          search_mode: v.search_mode ?? "none",
        },
      ]),
    );
  }
  return base;
}

describe("checkArtifactKindSearchable", () => {
  it("returns searchable=true for a kind declared searchable", () => {
    const schema = makeSchema({
      lesson: { searchable: true, search_mode: "full_text" },
    });
    const result = checkArtifactKindSearchable(schema, "lesson");
    expect(result).toEqual({ searchable: true, search_mode: "full_text" });
  });

  it("returns searchable=false for a kind declared non-searchable", () => {
    const schema = makeSchema({
      binary: { searchable: false, search_mode: "none" },
    });
    const result = checkArtifactKindSearchable(schema, "binary");
    expect(result).toEqual({ searchable: false, search_mode: "none" });
  });

  it("returns searchable=false when kind is not in artifacts", () => {
    const schema = makeSchema({ lesson: { searchable: true } });
    const result = checkArtifactKindSearchable(schema, "unknown");
    expect(result).toEqual({ searchable: false, search_mode: "none" });
  });

  it("returns searchable=false when artifacts section is absent", () => {
    const schema = makeSchema();
    const result = checkArtifactKindSearchable(schema, "lesson");
    expect(result).toEqual({ searchable: false, search_mode: "none" });
  });
});
