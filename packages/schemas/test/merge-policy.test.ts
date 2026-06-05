import { describe, expect, it } from "vitest";
import { SCHEMA_SECTION_MERGE_POLICY } from "../src/index.js";

describe("SCHEMA_SECTION_MERGE_POLICY", () => {
  it("exports a const object with the correct keys", () => {
    expect(SCHEMA_SECTION_MERGE_POLICY).toBeDefined();
    expect(typeof SCHEMA_SECTION_MERGE_POLICY).toBe("object");
  });

  it("marks declaration-map sections as disjoint-keys", () => {
    expect(SCHEMA_SECTION_MERGE_POLICY.work_units).toBe("disjoint-keys");
    expect(SCHEMA_SECTION_MERGE_POLICY.records).toBe("disjoint-keys");
    expect(SCHEMA_SECTION_MERGE_POLICY.templates).toBe("disjoint-keys");
    expect(SCHEMA_SECTION_MERGE_POLICY.artifacts).toBe("disjoint-keys");
  });

  it("marks singleton sections as singleton", () => {
    expect(SCHEMA_SECTION_MERGE_POLICY.hierarchy).toBe("singleton");
    expect(SCHEMA_SECTION_MERGE_POLICY.artifact_relationships).toBe(
      "singleton",
    );
    expect(SCHEMA_SECTION_MERGE_POLICY.entity_artifact_references).toBe(
      "singleton",
    );
  });

  it("marks schema_version as singleton-scalar", () => {
    expect(SCHEMA_SECTION_MERGE_POLICY.schema_version).toBe("singleton-scalar");
  });

  it("covers exactly the expected set of sections", () => {
    const keys = Object.keys(SCHEMA_SECTION_MERGE_POLICY).sort();
    expect(keys).toEqual([
      "artifact_relationships",
      "artifacts",
      "entity_artifact_references",
      "hierarchy",
      "records",
      "schema_version",
      "templates",
      "work_units",
    ]);
  });
});
