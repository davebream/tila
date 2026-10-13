import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DEFINITION_MAX_BYTES, canonicalJson } from "@tila/schemas";
import { describe, expect, it } from "vitest";
import {
  type DefinitionImportPlan,
  definitionFormatFromName,
  findForbiddenDefinitionContent,
  planDefinitionImport,
  readTomlDefinition,
  renderTomlDefinitionExport,
} from "../src/definition-transfer";
import {
  type DefinitionDocument,
  compareDefinitionUnits,
  getIn,
  parseDefinitionDocument,
  putField,
  sameDefinitionValue,
  setIn,
} from "../src/schema-document";
import { parseSchemaToml } from "../src/schema-parser";

function doc(toml: string): DefinitionDocument {
  const result = parseDefinitionDocument(toml);
  if (!result.ok) throw new Error(result.errors[0].message);
  return result.doc;
}

function read(toml: string) {
  const result = readTomlDefinition(toml);
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  return result;
}

function planned(plan: DefinitionImportPlan) {
  if (!plan.ok) throw new Error(JSON.stringify(plan.errors));
  return plan;
}

function semantic(source: string) {
  const parsed = parseSchemaToml(source);
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));
  return canonicalJson(parsed.schema);
}

const REPO_SCHEMA = readFileSync(
  resolve(__dirname, "../../../tila.schema.toml"),
  "utf8",
);

const CURRENT = `
schema_version = 1
team_note = "kept"

[work_units.task]
parents = []
fields = [
  { name = "title", type = "string", required = true },
  { name = "priority", type = "enum", values = ["low", "high"] },
]

[work_units.bug]
parents = []
fields = [{ name = "title", type = "string", required = true }]

[artifacts.plan]
mime_types = ["text/markdown"]
retention_days = 30

[templates.bugfix]
description = "Bug"
[templates.bugfix.entities.b]
id_suffix = "b"
type = "bug"

[records.config]
fields = [{ name = "url", type = "string" }]
`;

describe("readTomlDefinition", () => {
  it("strips export metadata and returns it", () => {
    const result = read(`
schema_version = 1

[tila_export]
format = "tila-definitions"
format_version = 1
project_id = "p1"
revision = 4

[work_units.task]
fields = [{ name = "title", type = "string" }]
`);
    expect(result.doc.tila_export).toBeUndefined();
    expect(result.metadata).toMatchObject({ project_id: "p1", revision: 4 });
  });

  it("rejects a newer export format version", () => {
    const result = readTomlDefinition(`
schema_version = 1
[tila_export]
format = "tila-definitions"
format_version = 2
`);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0].code).toBe("export-metadata");
      expect(result.errors[0].message).toMatch(/newer tila/);
    }
  });

  it("rejects foreign export metadata", () => {
    const result = readTomlDefinition(`
schema_version = 1
[tila_export]
format = "something-else"
format_version = 1
`);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0].code).toBe("export-metadata");
  });

  it("rejects the client connection file", () => {
    const result = readTomlDefinition(`
project_id = "abc"
backend = "cloud"
worker_url = "https://tila.example.com"
schema_version = 1
`);
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.errors[0].code).toBe("client-connection-file");
  });

  it("reports syntax errors with a line", () => {
    const result = readTomlDefinition("schema_version = \n[work_units");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0].code).toBe("syntax");
      expect(result.errors[0].line).toBeGreaterThan(0);
    }
  });

  it("rejects oversize input before parsing", () => {
    const big = `schema_version = 1\nnote = "${"x".repeat(DEFINITION_MAX_BYTES)}"\n`;
    const result = readTomlDefinition(big);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0].code).toBe("too-large");
      expect(result.errors[0].message).toMatch(/256 KiB/);
    }
  });

  it("rejects an empty file and non-table sections", () => {
    const empty = readTomlDefinition("");
    expect(empty.ok).toBe(false);
    if (!empty.ok) expect(empty.errors[0].code).toBe("no-definitions");

    const bad = readTomlDefinition('schema_version = 1\nwork_units = "x"\n');
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      expect(bad.errors[0].code).toBe("invalid-definition");
      expect(bad.errors[0].path).toBe("work_units");
    }
  });
});

describe("findForbiddenDefinitionContent", () => {
  it("flags secret-shaped values anywhere, by path, without echoing them", () => {
    const token = `ghp_${"a".repeat(36)}`;
    const errors = findForbiddenDefinitionContent(
      doc(`
schema_version = 1
[templates.t.entities.a]
id_suffix = "a"
type = "task"
data = { note = "${token}" }
`),
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({
      code: "forbidden-secret",
      path: "templates.t.entities.a.data.note",
    });
    expect(errors[0].message).not.toContain(token);
  });

  it("flags tila tokens, private keys and credential-named keys", () => {
    const errors = findForbiddenDefinitionContent(
      doc(`
schema_version = 1
custom_token = "tila_d1_${"ab".repeat(36)}"
[extra]
key = "-----BEGIN RSA PRIVATE KEY-----"
db_password = "hunter2"
api_key = "plain"
`),
    );
    expect(errors.map((e) => e.path).sort()).toEqual([
      "custom_token",
      "extra.api_key",
      "extra.db_password",
      "extra.key",
    ]);
  });

  it("does not flag modeled keys, field names, empty values or non-strings", () => {
    const errors = findForbiddenDefinitionContent(
      doc(`
schema_version = 1
[work_units.task]
fields = [
  { name = "api_token", type = "string" },
  { name = "password_policy", type = "enum", values = ["token", "secret"] },
]
[work_units.secret_thing.fields.token]
type = "string"
default = "none"
[records.creds]
key_description = "Name of the credential reference"
fields = [{ name = "secret_ref", type = "string" }]
[extra]
token = ""
secret = true
max_tokens = "100"
`),
    );
    expect(errors).toEqual([]);
  });

  it("rejects export metadata in a definition", () => {
    const errors = findForbiddenDefinitionContent(
      doc(
        'schema_version = 1\n[tila_export]\nformat = "tila-definitions"\nformat_version = 1\n',
      ),
    );
    expect(errors[0].code).toBe("export-metadata");
  });

  it("accepts the repository schema", () => {
    expect(findForbiddenDefinitionContent(doc(REPO_SCHEMA))).toEqual([]);
  });
});

describe("planDefinitionImport", () => {
  it("merge replaces named declarations and preserves omitted sections", () => {
    const imported = read(`
[work_units.task]
parents = []
fields = [{ name = "title", type = "string", required = true }]
`).doc;
    const plan = planned(planDefinitionImport(doc(CURRENT), imported, "merge"));
    expect(plan.units.changed).toEqual(["work_units.task"]);
    expect(plan.units.removed).toEqual([]);
    expect(plan.units.preserved).toEqual(
      expect.arrayContaining([
        "schema_version",
        "team_note",
        "work_units.bug",
        "artifacts.plan",
        "templates.bugfix",
        "records.config",
      ]),
    );
    // The declaration is replaced whole: the dropped field is gone.
    const fields = getIn(plan.document, ["work_units", "task", "fields"]);
    expect(fields).toEqual([{ name: "title", type: "string", required: true }]);
    expect(plan.document.team_note).toBe("kept");
  });

  it("importing one section never removes other sections", () => {
    const imported = read(
      '[artifacts.plan]\nmime_types = ["text/markdown"]\nretention_days = 7\n',
    ).doc;
    const plan = planned(planDefinitionImport(doc(CURRENT), imported, "merge"));
    const comparison = compareDefinitionUnits(doc(CURRENT), plan.document);
    expect(comparison.removed).toEqual([]);
    expect(comparison.changed).toEqual(["artifacts.plan"]);
    expect(getIn(plan.document, ["templates", "bugfix"])).toBeDefined();
  });

  it("an empty section changes nothing", () => {
    const plan = planned(
      planDefinitionImport(doc(CURRENT), { templates: {} }, "merge"),
    );
    expect(plan.noChange).toBe(true);
  });

  it("replace enumerates every removed unit, templates and unknown keys included", () => {
    const imported = read(`
schema_version = 1
[work_units.task]
parents = []
fields = [{ name = "title", type = "string", required = true }]
`).doc;
    const plan = planned(
      planDefinitionImport(doc(CURRENT), imported, "replace"),
    );
    expect(plan.units.removed.sort()).toEqual([
      "artifacts.plan",
      "records.config",
      "team_note",
      "templates.bugfix",
      "work_units.bug",
    ]);
    expect(plan.units.preserved).toEqual([]);
  });

  it("replace needs schema_version; merge takes it from the project", () => {
    const partial = read(
      '[work_units.task]\nfields = [{ name = "title", type = "string" }]\n',
    ).doc;
    const replace = planDefinitionImport(doc(CURRENT), partial, "replace");
    expect(replace.ok).toBe(false);
    if (!replace.ok) expect(replace.errors[0].path).toBe("schema_version");

    const bootstrap = planDefinitionImport(null, partial, "merge");
    expect(bootstrap.ok).toBe(false);

    expect(planDefinitionImport(doc(CURRENT), partial, "merge").ok).toBe(true);
  });

  it("validates the merged result as a whole definition", () => {
    const imported = read(`
[templates.orphan]
[templates.orphan.entities.x]
id_suffix = "x"
type = "missing_type"
`).doc;
    const plan = planDefinitionImport(doc(CURRENT), imported, "merge");
    expect(plan.ok).toBe(false);
    if (!plan.ok) {
      expect(plan.errors[0].code).toBe("invalid-definition");
      expect(plan.errors[0].path).toContain("templates.orphan");
    }
  });

  it("bootstraps an empty project with every unit added", () => {
    const plan = planned(planDefinitionImport(null, doc(CURRENT), "merge"));
    expect(plan.units.added).toHaveLength(7);
    expect(plan.units.removed).toEqual([]);
    expect(semantic(plan.source)).toBe(semantic(CURRENT));
  });

  it("detects no change and keeps unknown keys", () => {
    const plan = planned(
      planDefinitionImport(doc(CURRENT), doc(CURRENT), "replace"),
    );
    expect(plan.noChange).toBe(true);
    expect(doc(plan.source).team_note).toBe("kept");
  });

  it("warns when a same-project export is older than the applied revision", () => {
    const exported = read(`
schema_version = 1
[tila_export]
format = "tila-definitions"
format_version = 1
project_id = "p1"
revision = 2
[artifacts.plan]
mime_types = ["text/markdown"]
retention_days = 90
`);
    const plan = planned(
      planDefinitionImport(doc(CURRENT), exported.doc, "merge", {
        metadata: exported.metadata,
        projectId: "p1",
        revision: 5,
        currentSource: `# applied by hand\n${CURRENT}`,
      }),
    );
    expect(plan.warnings[0]).toMatch(/revision 2.*revision 5/);
    expect(plan.warnings[1]).toMatch(/comments/);
  });
});

describe("export", () => {
  const input = {
    source: CURRENT,
    projectId: "p1",
    revision: 7,
    appliedAt: Date.UTC(2026, 9, 1),
    exportedAt: new Date(Date.UTC(2026, 9, 13, 12)),
    exportedWith: "test",
  };

  it("writes metadata and an explanatory header", () => {
    const rendered = renderTomlDefinitionExport(input);
    if (!rendered.ok) throw new Error(JSON.stringify(rendered.errors));
    expect(rendered.text.startsWith("# tila definitions export\n")).toBe(true);
    expect(rendered.text).toContain("not a project");
    expect(rendered.text).toContain("tila project export");
    const back = read(rendered.text);
    expect(back.metadata).toEqual({
      format: "tila-definitions",
      format_version: 1,
      project_id: "p1",
      revision: 7,
      exported_at: "2026-10-13T12:00:00.000Z",
      applied_at: "2026-10-01T00:00:00.000Z",
      exported_with: "test",
    });
    expect(sameDefinitionValue(back.doc, doc(CURRENT))).toBe(true);
  });

  it("lists values copied verbatim", () => {
    const withData = setIn(
      setIn(doc(CURRENT), ["records", "config", "schema_ref"], "schemas/x"),
      ["templates", "bugfix", "entities", "b", "data"],
      { title: "x" },
    );
    const rendered = renderTomlDefinitionExport({
      ...input,
      source: planned(planDefinitionImport(null, withData, "replace")).source,
    });
    if (!rendered.ok) throw new Error("export failed");
    expect(rendered.verbatimPaths).toEqual([
      "records.config.schema_ref",
      "templates.bugfix.entities.b.data",
    ]);
    expect(rendered.text).toContain("#   templates.bugfix.entities.b.data");
  });

  it("refuses to export a stored definition with credentials", () => {
    const rendered = renderTomlDefinitionExport({
      ...input,
      source: 'schema_version = 1\npassword = "hunter2"\n',
    });
    expect(rendered.ok).toBe(false);
    if (!rendered.ok) expect(rendered.errors[0].path).toBe("password");
  });

  it("drops stale export metadata stored in a legacy definition", () => {
    const rendered = renderTomlDefinitionExport({
      ...input,
      source:
        'schema_version = 1\n[tila_export]\nformat = "tila-definitions"\nformat_version = 1\nrevision = 1\n',
    });
    if (!rendered.ok) throw new Error("export failed");
    expect(read(rendered.text).metadata?.revision).toBe(7);
  });
});

describe("semantic round trip", () => {
  it("bootstrap → edit field and retention → export → import to a fresh project", () => {
    // Bootstrap the repository schema, then edit it as the settings forms do.
    const bootstrap = planned(
      planDefinitionImport(null, read(REPO_SCHEMA).doc, "merge"),
    );
    let edited = setIn(
      bootstrap.document,
      ["work_units", "task", "fields"],
      putField(
        getIn(bootstrap.document, ["work_units", "task", "fields"]),
        null,
        {
          name: "estimate",
          declaration: { type: "string", required: false },
        },
      ),
    );
    const artifactKind = Object.keys(getIn(edited, ["artifacts"]) as object)[0];
    edited = setIn(edited, ["artifacts", artifactKind, "retention_days"], 14);
    const applied = planned(
      planDefinitionImport(bootstrap.document, edited, "replace"),
    ).source;

    const exported = renderTomlDefinitionExport({
      source: applied,
      projectId: "source-project",
      revision: 2,
    });
    if (!exported.ok) throw new Error("export failed");

    const imported = read(exported.text);
    const fresh = planned(planDefinitionImport(null, imported.doc, "merge"));
    expect(semantic(fresh.source)).toBe(semantic(applied));
    expect(sameDefinitionValue(fresh.document, doc(applied))).toBe(true);
  });

  it("reimporting the original file after edits shows what it reverts", () => {
    const original = read(CURRENT).doc;
    const edited = setIn(
      doc(CURRENT),
      ["artifacts", "plan", "retention_days"],
      90,
    );
    const plan = planned(planDefinitionImport(edited, original, "merge"));
    expect(plan.units.changed).toEqual(["artifacts.plan"]);
    expect(plan.noChange).toBe(false);
  });
});

describe("definitionFormatFromName", () => {
  it("maps extensions and rejects others", () => {
    expect(definitionFormatFromName("a.toml")).toBe("toml");
    expect(definitionFormatFromName("dir/a.YML")).toBe("yaml");
    expect(definitionFormatFromName("a.yaml")).toBe("yaml");
    const json = definitionFormatFromName("a.json");
    expect(typeof json).toBe("object");
    if (typeof json === "object") {
      expect(json.code).toBe("unsupported-format");
      expect(json.message).toContain(".json");
    }
  });
});
