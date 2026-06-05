import { describe, expect, it } from "vitest";
import {
  applyPrefix,
  stripPrefix,
  validateNamespace,
} from "../namespace-prefix";

describe("applyPrefix", () => {
  it("prefixes a name with ns_", () => {
    expect(applyPrefix("cp", "task")).toBe("cp_task");
  });

  it("prefixes with longer namespace", () => {
    expect(applyPrefix("myapp", "deploy")).toBe("myapp_deploy");
  });

  it("throws on double-prefix with message containing name and prefix", () => {
    expect(() => applyPrefix("cp", "cp_task")).toThrow(
      /cp_task.*cp_|cp_.*cp_task/,
    );
  });

  it("throws on double-prefix: error message mentions the name", () => {
    expect(() => applyPrefix("cp", "cp_task")).toThrow("cp_task");
  });

  it("throws on double-prefix: error message mentions the prefix", () => {
    expect(() => applyPrefix("cp", "cp_task")).toThrow("cp_");
  });

  it("does NOT throw when name starts with a different ns prefix", () => {
    // "other_cp_task" does not start with "cp_", so no collision
    expect(applyPrefix("cp", "other_task")).toBe("cp_other_task");
  });
});

describe("stripPrefix", () => {
  it("strips the ns_ prefix when present", () => {
    expect(stripPrefix("cp", "cp_task")).toBe("task");
  });

  it("returns name unchanged when prefix is absent (passthrough)", () => {
    expect(stripPrefix("cp", "other_x")).toBe("other_x");
  });

  it("returns name unchanged when it only partially matches prefix", () => {
    expect(stripPrefix("cp", "cptask")).toBe("cptask");
  });

  it("returns name unchanged for empty string", () => {
    expect(stripPrefix("cp", "")).toBe("");
  });

  it("strips only the leading prefix, not inner occurrences", () => {
    expect(stripPrefix("cp", "cp_cp_task")).toBe("cp_task");
  });
});

describe("validateNamespace", () => {
  it("accepts a simple lowercase identifier", () => {
    expect(() => validateNamespace("cp")).not.toThrow();
  });

  it("accepts identifiers with digits and underscores", () => {
    expect(() => validateNamespace("my_ns1")).not.toThrow();
  });

  it("accepts identifiers with hyphens", () => {
    expect(() => validateNamespace("my-ns")).not.toThrow();
  });

  it("throws TypeError for empty string", () => {
    expect(() => validateNamespace("")).toThrow(TypeError);
  });

  it("throws TypeError for uppercase start", () => {
    expect(() => validateNamespace("Cp!")).toThrow(TypeError);
  });

  it("throws TypeError for starting with digit", () => {
    expect(() => validateNamespace("1cp")).toThrow(TypeError);
  });

  it("throws TypeError for special characters", () => {
    expect(() => validateNamespace("cp!")).toThrow(TypeError);
  });

  it("throws TypeError for spaces", () => {
    expect(() => validateNamespace("my ns")).toThrow(TypeError);
  });
});
