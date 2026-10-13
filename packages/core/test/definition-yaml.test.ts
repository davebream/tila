import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  planDefinitionImport,
  readTomlDefinition,
} from "../src/definition-transfer";
import {
  readDefinitionFile,
  readYamlDefinition,
  renderDefinitionExport,
} from "../src/definition-yaml";
import { sameDefinitionValue } from "../src/schema-document";

const fixture = (name: string) =>
  readFileSync(resolve(__dirname, "fixtures/definitions", name), "utf8");

function ok<T extends { ok: boolean }>(result: T): Extract<T, { ok: true }> {
  if (!result.ok) throw new Error(JSON.stringify(result));
  return result as Extract<T, { ok: true }>;
}

describe("YAML definitions", () => {
  it("normalize to the same document as the equivalent TOML", () => {
    const toml = ok(readTomlDefinition(fixture("parity.toml")));
    const yaml = ok(readYamlDefinition(fixture("parity.yaml")));
    expect(yaml.format).toBe("yaml");
    expect(sameDefinitionValue(yaml.doc, toml.doc)).toBe(true);

    const fromToml = ok(planDefinitionImport(null, toml.doc, "merge"));
    const fromYaml = ok(planDefinitionImport(null, yaml.doc, "merge"));
    expect(fromYaml.source).toBe(fromToml.source);
  });

  it("round-trip through YAML and TOML exports to the same definition", () => {
    const source = ok(
      planDefinitionImport(
        null,
        ok(readTomlDefinition(fixture("parity.toml"))).doc,
        "merge",
      ),
    ).source;
    const input = {
      source,
      projectId: "p1",
      revision: 3,
      exportedAt: new Date(0),
    };
    const asYaml = ok(renderDefinitionExport(input, "yaml"));
    const asToml = ok(renderDefinitionExport(input, "toml"));
    expect(asYaml.text.startsWith("# tila definitions export\n")).toBe(true);

    const yamlBack = ok(
      readDefinitionFile(asYaml.text, { filename: "x.yaml" }),
    );
    const tomlBack = ok(
      readDefinitionFile(asToml.text, { filename: "x.toml" }),
    );
    expect(yamlBack.metadata).toEqual(tomlBack.metadata);
    expect(sameDefinitionValue(yamlBack.doc, tomlBack.doc)).toBe(true);
  });

  it("uses YAML 1.2 core scalars", () => {
    const result = ok(
      readYamlDefinition(
        "schema_version: 1\nnote:\n  answer: yes\n  when: 2026-01-01\n  text: |\n    two\n    lines\n",
      ),
    );
    expect(result.doc.note).toEqual({
      answer: "yes",
      when: "2026-01-01",
      text: "two\nlines\n",
    });
  });

  it.each([
    ["multiple documents", "a: 1\n---\nb: 2\n", /2 YAML documents/],
    [
      "duplicate keys",
      "schema_version: 1\nschema_version: 2\n",
      /unique|Map keys/i,
    ],
    ["aliases", "schema_version: 1\nbase: &b {k: 1}\nother: *b\n", /alias/],
    [
      "merge keys",
      "schema_version: 1\nbase: {k: 1}\nother:\n  <<: {k: 2}\n",
      /merge key/,
    ],
    ["custom tags", "schema_version: 1\nnote: !!python/object x\n", /tag/],
    ["nulls", "schema_version: 1\nnote: ~\nlist: [1, null]\n", /null/],
    ["a scalar document", "just text\n", /table of sections/],
  ])("rejects %s", (_name, text, message) => {
    const result = readYamlDefinition(text);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0].message).toMatch(message);
  });

  it("applies the same forbidden-content checks as TOML", () => {
    const secret = readYamlDefinition(
      "schema_version: 1\nextra:\n  password: hunter2\n",
    );
    expect(secret.ok).toBe(false);
    if (!secret.ok) expect(secret.errors[0].code).toBe("forbidden-secret");

    const client = readYamlDefinition(
      "project_id: p\nworker_url: https://x\nschema_version: 1\n",
    );
    expect(client.ok).toBe(false);
    if (!client.ok)
      expect(client.errors[0].code).toBe("client-connection-file");
  });

  it("refuses YAML export of TOML dates", () => {
    const result = renderDefinitionExport(
      {
        source: "schema_version = 1\nstarted = 2026-01-01T00:00:00Z\n",
        projectId: "p",
        revision: 1,
      },
      "yaml",
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0].path).toBe("started");
  });
});

describe("readDefinitionFile", () => {
  it("chooses the format from the file name", () => {
    const result = readDefinitionFile("schema_version: 1\n", {
      filename: "defs.toml",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0].code).toBe("syntax");
    const unsupported = readDefinitionFile("{}", { filename: "defs.json" });
    expect(unsupported.ok).toBe(false);
    if (!unsupported.ok)
      expect(unsupported.errors[0].code).toBe("unsupported-format");
  });

  it("detects pasted TOML and YAML", () => {
    expect(ok(readDefinitionFile("schema_version = 1\n")).format).toBe("toml");
    expect(ok(readDefinitionFile("schema_version: 1\n")).format).toBe("yaml");
  });

  it("reports the TOML error for text that is neither", () => {
    const result = readDefinitionFile("schema_version = \n");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0].code).toBe("syntax");
      expect(result.errors[0].line).toBeDefined();
    }
  });
});
