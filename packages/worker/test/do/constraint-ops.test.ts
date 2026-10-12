import { constraintOps } from "@tila/ops-sqlite";
import { describe, expect, it } from "vitest";

const { getArtifactKindRetention } = constraintOps;

describe("getArtifactKindRetention", () => {
  it("returns retention_days when kind is declared with non-zero value", () => {
    const schema = {
      work_units: {},
      artifacts: {
        logs: {
          mime_types: [],
          retention_days: 7,
          searchable: false,
          search_mode: "none" as const,
        },
      },
    };
    expect(getArtifactKindRetention(schema, "logs")).toBe(7);
  });

  it("returns 0 when kind is declared with retention_days: 0 (default)", () => {
    const schema = {
      work_units: {},
      artifacts: {
        reports: {
          mime_types: [],
          retention_days: 0,
          searchable: false,
          search_mode: "none" as const,
        },
      },
    };
    expect(getArtifactKindRetention(schema, "reports")).toBe(0);
  });

  it("returns 0 when kind is not declared in artifacts map", () => {
    const schema = {
      work_units: {},
      artifacts: {
        logs: {
          mime_types: [],
          retention_days: 7,
          searchable: false,
          search_mode: "none" as const,
        },
      },
    };
    expect(getArtifactKindRetention(schema, "unknown")).toBe(0);
  });

  it("returns 0 when artifacts section is absent", () => {
    const schema = {
      work_units: {},
    };
    expect(getArtifactKindRetention(schema, "logs")).toBe(0);
  });

  it("returns 0 when artifacts section is empty object", () => {
    const schema = {
      work_units: {},
      artifacts: {},
    };
    expect(getArtifactKindRetention(schema, "logs")).toBe(0);
  });

  it("returns large retention_days correctly", () => {
    const schema = {
      work_units: {},
      artifacts: {
        archives: {
          mime_types: [],
          retention_days: 365,
          searchable: false,
          search_mode: "none" as const,
        },
      },
    };
    expect(getArtifactKindRetention(schema, "archives")).toBe(365);
  });
});
