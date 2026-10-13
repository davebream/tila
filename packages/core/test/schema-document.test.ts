import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  cloneDeclaration,
  copyName,
  definitionHasComments,
  duplicateField,
  getIn,
  parseDefinitionDocument,
  putField,
  readFields,
  rebaseDefinition,
  removeDeclaration,
  removeField,
  serializeDefinitionDocument,
  setIn,
} from "../src/schema-document";
import { parseSchemaToml } from "../src/schema-parser";

function doc(toml: string) {
  const result = parseDefinitionDocument(toml);
  if (!result.ok) throw new Error(result.errors[0].message);
  return result.doc;
}

const CUSTOM = `
schema_version = 1
team_note = "top-level custom key"

[work_units.task]
owner_hint = "custom on a type"
parents = []
fields = [
  { name = "title", type = "string", required = true, ui_width = 40 },
  { name = "status", type = "enum", values = ["open", "done"] },
]

[work_units.epic.fields.title]
type = "string"
required = true
widget = "custom on a keyed field"

[artifacts.plan]
mime_types = ["text/markdown"]
retention_days = 30
legacy_bucket = "custom on an artifact kind"
`;

describe("definition documents", () => {
  it("round-trips the repository schema without semantic change", () => {
    const source = readFileSync(
      resolve(__dirname, "../../../tila.schema.toml"),
      "utf8",
    );
    const before = parseSchemaToml(source);
    const after = parseSchemaToml(serializeDefinitionDocument(doc(source)));
    expect(before.ok && after.ok).toBe(true);
    if (before.ok && after.ok) expect(after.schema).toEqual(before.schema);
  });

  it("keeps unknown keys at every level through an unrelated edit", () => {
    const edited = setIn(
      doc(CUSTOM),
      ["artifacts", "plan", "retention_days"],
      7,
    );
    const reread = doc(serializeDefinitionDocument(edited));
    expect(reread.team_note).toBe("top-level custom key");
    expect(getIn(reread, ["work_units", "task", "owner_hint"])).toBe(
      "custom on a type",
    );
    expect(getIn(reread, ["artifacts", "plan", "legacy_bucket"])).toBe(
      "custom on an artifact kind",
    );
    expect(getIn(reread, ["artifacts", "plan", "retention_days"])).toBe(7);
    const fields = readFields(getIn(reread, ["work_units", "task", "fields"]));
    expect(fields.entries[0].declaration.ui_width).toBe(40);
    expect(
      getIn(reread, ["work_units", "epic", "fields", "title", "widget"]),
    ).toBe("custom on a keyed field");
  });

  it("pins TOML value fidelity: dates stay dates, 1.0 becomes 1", () => {
    const reread = doc(
      serializeDefinitionDocument(
        doc(
          "schema_version = 1\nratio = 1.0\nratio_b = 2.5\nat = 1979-05-27T07:32:00Z\n",
        ),
      ),
    );
    expect(reread.ratio).toBe(1);
    expect(reread.ratio_b).toBe(2.5);
    expect(reread.at).toBeInstanceOf(Date);
    expect((reread.at as Date).toISOString()).toBe("1979-05-27T07:32:00.000Z");
  });

  it("reports TOML syntax errors with a position", () => {
    const result = parseDefinitionDocument("schema_version = \n[x");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0].line).toBeGreaterThan(0);
  });

  it("setIn removes keys with undefined and does not mutate the input", () => {
    const original = doc(CUSTOM);
    const next = setIn(
      original,
      ["work_units", "task", "owner_hint"],
      undefined,
    );
    expect(getIn(next, ["work_units", "task", "owner_hint"])).toBeUndefined();
    expect(getIn(original, ["work_units", "task", "owner_hint"])).toBe(
      "custom on a type",
    );
  });
});

describe("field collections", () => {
  it("keeps the array shape and renames in place", () => {
    const fields = getIn(doc(CUSTOM), ["work_units", "task", "fields"]);
    const renamed = putField(fields, "title", {
      name: "headline",
      declaration: { type: "string", required: true, ui_width: 40 },
    });
    expect(Array.isArray(renamed)).toBe(true);
    expect(readFields(renamed).entries.map((f) => f.name)).toEqual([
      "headline",
      "status",
    ]);
  });

  it("keeps the keyed-table shape", () => {
    const fields = getIn(doc(CUSTOM), ["work_units", "epic", "fields"]);
    const added = putField(fields, null, {
      name: "status",
      declaration: { type: "enum", values: ["open"] },
    });
    expect(Array.isArray(added)).toBe(false);
    expect(Object.keys(added as object)).toEqual(["title", "status"]);
    expect(Object.keys(removeField(added, "title") as object)).toEqual([
      "status",
    ]);
  });

  it("duplicates a field with its unknown keys", () => {
    const fields = getIn(doc(CUSTOM), ["work_units", "task", "fields"]);
    const copied = readFields(duplicateField(fields, "title", "title_copy"));
    expect(copied.entries[2]).toEqual({
      name: "title_copy",
      declaration: { type: "string", required: true, ui_width: 40 },
    });
  });

  it("creates the array shape when a type has no fields yet", () => {
    expect(
      putField(undefined, null, {
        name: "title",
        declaration: { type: "string" },
      }),
    ).toEqual([{ name: "title", type: "string" }]);
  });
});

describe("declarations", () => {
  it("clones, refuses to overwrite, and removes", () => {
    const original = doc(CUSTOM);
    const cloned = cloneDeclaration(original, "work_units", "task", "bug");
    expect(getIn(cloned, ["work_units", "bug", "owner_hint"])).toBe(
      "custom on a type",
    );
    expect(() => cloneDeclaration(cloned, "work_units", "task", "bug")).toThrow(
      /already exists/,
    );
    expect(
      getIn(removeDeclaration(cloned, "work_units", "task"), [
        "work_units",
        "task",
      ]),
    ).toBeUndefined();
  });

  it("picks an unused copy name", () => {
    expect(copyName(["task"], "task")).toBe("task_copy");
    expect(copyName(["task", "task_copy"], "task")).toBe("task_copy_2");
  });
});

describe("rebaseDefinition", () => {
  const base = doc(CUSTOM);

  it("takes one-sided changes from both sides", () => {
    const mine = setIn(base, ["artifacts", "plan", "retention_days"], 7);
    const latest = setIn(base, ["records", "deploy"], { format: "json" });
    const result = rebaseDefinition(base, mine, latest);
    expect(result.conflicts).toEqual([]);
    expect(getIn(result.merged, ["artifacts", "plan", "retention_days"])).toBe(
      7,
    );
    expect(getIn(result.merged, ["records", "deploy", "format"])).toBe("json");
  });

  it("keeps a removal made on one side", () => {
    const mine = removeDeclaration(base, "work_units", "epic");
    const result = rebaseDefinition(base, mine, base);
    expect(getIn(result.merged, ["work_units", "epic"])).toBeUndefined();
  });

  it("reports a declaration both sides changed and honours resolutions", () => {
    const mine = setIn(base, ["artifacts", "plan", "retention_days"], 7);
    const latest = setIn(base, ["artifacts", "plan", "retention_days"], 90);
    const theirs = rebaseDefinition(base, mine, latest);
    expect(theirs.conflicts).toEqual(["artifacts.plan"]);
    expect(getIn(theirs.merged, ["artifacts", "plan", "retention_days"])).toBe(
      90,
    );
    const kept = rebaseDefinition(base, mine, latest, {
      "artifacts.plan": "mine",
    });
    expect(getIn(kept.merged, ["artifacts", "plan", "retention_days"])).toBe(7);
  });

  it("does not report identical changes as a conflict", () => {
    const both = setIn(base, ["team_note"], "same");
    expect(rebaseDefinition(base, both, both).conflicts).toEqual([]);
  });
});

describe("definitionHasComments", () => {
  it.each([
    ["schema_version = 1 # trailing", true],
    ["# heading\nschema_version = 1", true],
    ['name = "#not-a-comment"', false],
    ["name = '#literal'", false],
    ['text = """\n# inside\n"""', false],
    ['text = "a \\" # still string"', false],
  ])("%j -> %s", (toml, expected) => {
    expect(definitionHasComments(toml)).toBe(expected);
  });
});
