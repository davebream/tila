import { DefinitionDraftValue } from "@/lib/definition-draft";

describe("DefinitionDraftValue", () => {
  test("drafts saved before import existed still load", () => {
    const saved = {
      baseRevision: 3,
      baseSource: "schema_version = 1\n",
      source: "schema_version = 1\n# edited\n",
      restoredFrom: null,
    };
    expect(DefinitionDraftValue.parse(saved)).toEqual(saved);
  });

  test("an imported draft records its file, format and mode", () => {
    const parsed = DefinitionDraftValue.parse({
      baseRevision: 0,
      baseSource: "",
      source: "schema_version = 1\n",
      restoredFrom: null,
      importedFrom: { name: "defs.yaml", format: "yaml", mode: "merge" },
    });
    expect(parsed.importedFrom).toEqual({
      name: "defs.yaml",
      format: "yaml",
      mode: "merge",
      warnings: [],
    });
  });
});
