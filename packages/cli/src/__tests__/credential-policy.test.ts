import { describe, expect, it } from "vitest";
import { credentialPolicyArgs, policyFromArgs } from "../lib/credential-policy";
import { describeCliError } from "../lib/output";

const fromRestrictions = (restrictions: unknown) =>
  policyFromArgs({
    preset: "worker",
    restrictions:
      typeof restrictions === "string"
        ? restrictions
        : JSON.stringify(restrictions),
  });

const failure = (restrictions: unknown) => {
  try {
    fromRestrictions(restrictions);
  } catch (error) {
    return describeCliError(error);
  }
  throw new Error("expected the restrictions to be refused");
};

describe("--restrictions help", () => {
  const help = credentialPolicyArgs.restrictions.description;

  it("explains the legacy list, the split lists and their exclusion", () => {
    expect(help).toContain('"records"');
    expect(help).toContain("reads and writes");
    expect(help).toContain('"records_read" and "records_write"');
    expect(help).toContain("never both");
  });

  it("says a side that is left out or empty denies every record", () => {
    expect(help).toMatch(/left out or empty denies every record/);
  });

  it("carries an example that parses as a policy", () => {
    const example = help.match(/Example: (\{.*\})$/)?.[1];
    expect(example).toBeDefined();
    expect(fromRestrictions(example).restrictions).toEqual({
      records_read: [{ type: "answer", key_prefixes: ["a1"] }],
      records_write: [{ type: "question" }],
    });
  });
});

describe("policyFromArgs restrictions", () => {
  it("keeps one list as the legacy rule for both sides", () => {
    expect(
      fromRestrictions({ records: [{ type: "config" }] }).restrictions,
    ).toEqual({ records: [{ type: "config" }] });
  });

  it("keeps a missing split side missing, so it denies", () => {
    const restrictions = fromRestrictions({
      records_write: [{ type: "question", key_prefixes: ["q1"] }],
    }).restrictions;
    expect(restrictions).toEqual({
      records_write: [{ type: "question", key_prefixes: ["q1"] }],
    });
    expect(restrictions).not.toHaveProperty("records_read");
  });

  it("keeps explicit empty lists", () => {
    expect(
      fromRestrictions({ records_read: [], records_write: [] }).restrictions,
    ).toEqual({ records_read: [], records_write: [] });
    expect(fromRestrictions({ records: [] }).restrictions).toEqual({
      records: [],
    });
  });
});

describe("policyFromArgs validation messages", () => {
  it("names the flag for text that is not JSON", () => {
    const refused = failure("{records_read:");
    expect(refused.code).toBe("invalid-argument");
    expect(refused.message).toMatch(/^--restrictions is not valid JSON: /);
    expect(refused.hint).toMatch(/records_read/);
  });

  it("requires a JSON object", () => {
    for (const text of ["[]", "null", '"records"', "3"]) {
      const refused = failure(text);
      expect(refused.code).toBe("invalid-argument");
      expect(refused.message).toMatch(/^--restrictions must be a JSON object/);
    }
  });

  it("refuses the legacy list next to a split list and says so", () => {
    const refused = failure({
      records: [{ type: "config" }],
      records_read: [{ type: "answer" }],
    });
    expect(refused.code).toBe("invalid-argument");
    expect(refused.message).toBe(
      "Invalid --restrictions: restrictions.records cannot be combined with records_read or records_write",
    );
  });

  it("locates a malformed rule by its list and index", () => {
    const refused = failure({
      records_write: [{ type: "question" }, { type: "Question" }],
    });
    expect(refused.message).toMatch(
      /^Invalid --restrictions: records_write\.1\.type: Record type must start with lowercase/,
    );
  });

  it("names an unknown field", () => {
    const refused = failure({ records_reed: [] });
    expect(refused.message).toMatch(/^Invalid --restrictions: .*records_reed/);
  });

  it("keeps the exit-code mapping of invalid arguments", () => {
    expect(failure({ records: 1 }).code).toBe("invalid-argument");
  });
});
