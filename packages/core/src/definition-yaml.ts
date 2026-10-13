import {
  Document,
  isAlias,
  isMap,
  isScalar,
  parseAllDocuments,
  visit,
} from "yaml";
import {
  type DefinitionExportInput,
  type DefinitionFormat,
  type DefinitionTransferError,
  type ReadDefinitionResult,
  type RenderedDefinitionExport,
  definitionFormatFromName,
  definitionSizeError,
  prepareDefinitionExport,
  readDefinitionTree,
  readTomlDefinition,
  renderTomlDefinitionExport,
} from "./definition-transfer";
import { isTable } from "./schema-document";

/**
 * YAML adapter for definition import and export. It is a separate entry
 * (`@tila/core/definition-yaml`) so the `yaml` library stays out of the
 * Worker, Durable Object and SDK bundles that import `@tila/core`.
 *
 * YAML is read with the 1.2 core schema (no `yes`/`no` booleans, no
 * timestamps) and normalizes to the same document as TOML. Features TOML
 * can't represent, or that hide content, are rejected: several documents,
 * custom tags, aliases and merge keys, and null values.
 */

const CORE_TAGS = new Set(
  ["str", "int", "float", "bool", "null", "map", "seq"].map(
    (t) => `tag:yaml.org,2002:${t}`,
  ),
);

function fail(
  code: DefinitionTransferError["code"],
  message: string,
  path?: string,
): DefinitionTransferError {
  return { code, message, ...(path ? { path } : {}) };
}

function nodePath(path: readonly unknown[]): string {
  const keys: string[] = [];
  for (const step of path) {
    if (step && typeof step === "object" && "key" in step) {
      const key = (step as { key: unknown }).key;
      keys.push(isScalar(key) ? String(key.value) : String(key));
    }
  }
  return keys.join(".");
}

function nullErrors(
  value: unknown,
  path: string[],
  out: DefinitionTransferError[],
): void {
  if (value === null || value === undefined) {
    out.push(
      fail(
        "unrepresentable-value",
        `${path.join(".") || "The document"} is null. TOML has no null; remove the key or give it a value.`,
        path.join(".") || undefined,
      ),
    );
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, i) => nullErrors(item, [...path, String(i)], out));
    return;
  }
  if (isTable(value)) {
    for (const [key, item] of Object.entries(value))
      nullErrors(item, [...path, key], out);
  }
}

/** Read YAML definition text into the same document a TOML file produces. */
export function readYamlDefinition(text: string): ReadDefinitionResult {
  const tooLarge = definitionSizeError(text, "The file");
  if (tooLarge) return { ok: false, errors: [tooLarge] };

  const docs = parseAllDocuments(text, {
    schema: "core",
    uniqueKeys: true,
    merge: false,
  });
  if (!Array.isArray(docs) || docs.length === 0) {
    return {
      ok: false,
      errors: [fail("no-definitions", "The file contains no definitions.")],
    };
  }
  if (docs.length > 1) {
    return {
      ok: false,
      errors: [
        fail(
          "syntax",
          `The file contains ${docs.length} YAML documents; a definition must be a single document.`,
        ),
      ],
    };
  }
  const doc = docs[0];
  if (doc.errors.length > 0) {
    return {
      ok: false,
      errors: doc.errors.map((e) => ({
        code: "syntax" as const,
        message: e.message.split("\n")[0],
        line: e.linePos?.[0]?.line,
        column: e.linePos?.[0]?.col,
      })),
    };
  }

  const errors: DefinitionTransferError[] = [];
  visit(doc, {
    Alias(_key, _node, path) {
      errors.push(
        fail(
          "unrepresentable-value",
          `${nodePath(path) || "The document"} uses a YAML alias. Write the value out instead.`,
          nodePath(path) || undefined,
        ),
      );
    },
    Pair(_key, pair, path) {
      if (isScalar(pair.key) && pair.key.value === "<<") {
        const at = nodePath(path);
        errors.push(
          fail(
            "unrepresentable-value",
            `${at || "The document"} uses a YAML merge key (<<). Write the values out instead.`,
            at || undefined,
          ),
        );
      }
    },
    Node(_key, node, path) {
      if (isAlias(node)) return;
      if (node.tag && !CORE_TAGS.has(node.tag)) {
        const at = nodePath(path);
        errors.push(
          fail(
            "unrepresentable-value",
            `${at || "The document"} has the YAML tag ${node.tag}; only plain values are supported.`,
            at || undefined,
          ),
        );
      }
    },
  });
  if (errors.length > 0) return { ok: false, errors };
  if (!isMap(doc.contents)) return readDefinitionTree(doc.toJS(), "yaml");

  const tree = doc.toJS({ maxAliasCount: 0 }) as unknown;
  nullErrors(tree, [], errors);
  if (errors.length > 0) return { ok: false, errors };
  return readDefinitionTree(tree, "yaml");
}

export type ReadDefinitionFileOptions = {
  /** Explicit format; `auto` (default) uses the file name, else detects. */
  format?: DefinitionFormat | "auto";
  filename?: string;
};

/**
 * Read an import file or pasted text. With no explicit format, the file name
 * decides; pasted text is tried as TOML, then as YAML when that yields a
 * table. Unsupported extensions are rejected rather than guessed.
 */
export function readDefinitionFile(
  text: string,
  options: ReadDefinitionFileOptions = {},
): ReadDefinitionResult {
  let format = options.format ?? "auto";
  if (format === "auto" && options.filename) {
    const named = definitionFormatFromName(options.filename);
    if (typeof named !== "string") return { ok: false, errors: [named] };
    format = named;
  }
  if (format === "toml") return readTomlDefinition(text);
  if (format === "yaml") return readYamlDefinition(text);

  const toml = readTomlDefinition(text);
  if (toml.ok || toml.errors.some((e) => e.code !== "syntax")) return toml;
  const yaml = readYamlDefinition(text);
  if (yaml.ok || yaml.errors.some((e) => e.code !== "syntax")) {
    // Plain text that is neither format parses as a YAML string, which is
    // reported as "not a table"; the TOML syntax error is more useful then.
    if (!yaml.ok && yaml.errors.every((e) => e.code === "not-a-table"))
      return toml;
    return yaml;
  }
  return toml;
}

function dateErrors(
  value: unknown,
  path: string[],
  out: DefinitionTransferError[],
): void {
  if (value instanceof Date) {
    out.push(
      fail(
        "unrepresentable-value",
        `${path.join(".")} is a TOML date, which YAML would turn into text. Export as TOML instead.`,
        path.join("."),
      ),
    );
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, i) => dateErrors(item, [...path, String(i)], out));
    return;
  }
  if (isTable(value)) {
    for (const [key, item] of Object.entries(value))
      dateErrors(item, [...path, key], out);
  }
}

/** Render an export as TOML or YAML. */
export function renderDefinitionExport(
  input: DefinitionExportInput,
  format: DefinitionFormat,
): RenderedDefinitionExport {
  if (format === "toml") return renderTomlDefinitionExport(input);
  const prepared = prepareDefinitionExport(input);
  if (!prepared.ok) return prepared;
  const errors: DefinitionTransferError[] = [];
  dateErrors(prepared.document, [], errors);
  if (errors.length > 0) return { ok: false, errors };
  const doc = new Document(prepared.document, {
    aliasDuplicateObjects: false,
  });
  doc.commentBefore = prepared.header.join("\n");
  return {
    ok: true,
    text: doc.toString({ lineWidth: 0 }),
    verbatimPaths: prepared.verbatimPaths,
  };
}
