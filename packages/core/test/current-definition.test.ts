import { describe, expect, it } from "vitest";
import {
  currentDefinition,
  parseDefinitionDocument,
} from "../src/schema-document";

describe("currentDefinition", () => {
  it("represents an unapplied project at revision zero", () => {
    expect(currentDefinition({ version: null, definition: null })).toEqual({
      revision: 0,
      source: null,
      doc: null,
      appliedAt: null,
    });
  });

  it("preserves applied TOML, unknown keys and provenance", () => {
    const source = '# note\nschema_version = 1\ncustom = "kept"\n';
    expect(
      currentDefinition({
        version: 4,
        revision: 5,
        definition: source,
        applied_at: 123,
      }),
    ).toEqual({
      revision: 5,
      source,
      doc: { schema_version: 1, custom: "kept" },
      appliedAt: 123,
    });
  });

  it("normalizes a legacy JSON definition into TOML", () => {
    const doc = { schema_version: 1, custom: { flag: true } };
    const current = currentDefinition({
      version: 3,
      definition: JSON.stringify(doc),
    });
    expect(current.revision).toBe(3);
    expect(current.doc).toEqual(doc);
    expect(parseDefinitionDocument(current.source ?? "")).toEqual({
      ok: true,
      doc,
    });
  });

  it.each(["broken = [", "[1, 2]", '"a scalar"', "null"])(
    "rejects corrupt stored text without quoting it: %s",
    (definition) => {
      expect(() => currentDefinition({ version: 2, definition })).toThrow(
        expect.objectContaining({ code: "schema-corrupt" }),
      );
    },
  );
});
