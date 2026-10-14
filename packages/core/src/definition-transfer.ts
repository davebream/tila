import {
  DEFINITION_EXPORT_FORMAT,
  DEFINITION_EXPORT_FORMAT_VERSION,
  DEFINITION_EXPORT_KEY,
  DEFINITION_MAX_BYTES,
  type DefinitionExportMetadata,
  DefinitionExportMetadataSchema,
  definitionByteLength,
} from "@tila/schemas";
import {
  DECLARATION_SECTIONS,
  type DefinitionDocument,
  cloneValue,
  compareDefinitionUnits,
  definitionHasComments,
  definitionUnits,
  getIn,
  isTable,
  parseDefinitionDocument,
  serializeDefinitionDocument,
  setIn,
} from "./schema-document";
import { type SchemaParseError, parseSchemaToml } from "./schema-parser";

/**
 * Explicit import and export of definitions (#299). The server stays the
 * authority: an import is planned here against the revision the caller just
 * read, then goes through the normal preview and revision-checked apply.
 * Nothing in this module talks to a server or applies anything.
 */

export type DefinitionFormat = "toml" | "yaml";

export type DefinitionImportMode = "merge" | "replace";

export type DefinitionTransferErrorCode =
  | "unsupported-format"
  | "syntax"
  | "too-large"
  | "not-a-table"
  | "client-connection-file"
  | "export-metadata"
  | "no-definitions"
  | "forbidden-secret"
  | "unrepresentable-value"
  | "invalid-definition";

export type DefinitionTransferError = SchemaParseError & {
  code: DefinitionTransferErrorCode;
};

export type ReadDefinitionResult =
  | {
      ok: true;
      /** The definition tree, with `[tila_export]` removed. */
      doc: DefinitionDocument;
      format: DefinitionFormat;
      /** Export metadata when the file came from an export, else null. */
      metadata: DefinitionExportMetadata | null;
    }
  | { ok: false; errors: DefinitionTransferError[] };

function fail(
  code: DefinitionTransferErrorCode,
  message: string,
  extra: Partial<SchemaParseError> = {},
): DefinitionTransferError {
  return { code, message, ...extra };
}

function kib(bytes: number): string {
  return `${Math.ceil(bytes / 1024)} KiB`;
}

/** Null when `text` fits the definition size limit. */
export function definitionSizeError(
  text: string,
  what = "The definition",
  maxBytes = DEFINITION_MAX_BYTES,
): DefinitionTransferError | null {
  const bytes = definitionByteLength(text);
  if (bytes <= maxBytes) return null;
  return fail(
    "too-large",
    `${what} is ${kib(bytes)}; definitions are limited to ${kib(maxBytes)}.`,
  );
}

// --- Forbidden content -----------------------------------------------------

const CLIENT_CONFIG_MARKERS = ["worker_url", "tila_version", "backend"];

/**
 * True for the client connection file (`.tila/config.toml`). It has an
 * integer `schema_version`, so without this check it would parse as a valid,
 * empty definition and a replace import would remove everything.
 */
export function looksLikeClientConfig(doc: DefinitionDocument): boolean {
  return (
    typeof doc.project_id === "string" &&
    CLIENT_CONFIG_MARKERS.some((key) => key in doc)
  );
}

const SECRET_VALUE_PATTERNS: { label: string; pattern: RegExp }[] = [
  { label: "a tila API token", pattern: /tila_d1_[0-9a-f]{72}/ },
  { label: "a tila session token", pattern: /tila_u_[A-Za-z0-9._~-]{16,}/ },
  {
    label: "a GitHub token",
    pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})/,
  },
  {
    label: "a private key",
    pattern: /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/,
  },
  { label: "an AWS access key", pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { label: "a Slack token", pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}/ },
  { label: "an API key", pattern: /\bsk-(?:ant-)?[A-Za-z0-9_-]{20,}/ },
  {
    label: "a JSON Web Token",
    pattern:
      /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/,
  },
];

/**
 * Key names that hold credentials. Modeled definition keys never match; a
 * field declared as `name = "api_token"` is a value, and a keyed field table
 * (`fields.api_token`) holds a table, so neither is flagged.
 */
const SECRET_KEY =
  /^(?:[a-z0-9]+[_-])*(?:password|passwd|secret|client_secret|api_?key|access_?key|private_?key|token|access_token|refresh_token|auth_token|bearer|credentials?)$/i;

function secretErrors(
  value: unknown,
  path: string[],
  out: DefinitionTransferError[],
): void {
  if (typeof value === "string") {
    const key = path[path.length - 1] ?? "";
    const at = path.join(".");
    const shaped = SECRET_VALUE_PATTERNS.find((p) => p.pattern.test(value));
    if (shaped) {
      out.push(
        fail(
          "forbidden-secret",
          `${at} looks like ${shaped.label}. Definitions are shared, exported and kept in history, so they must not contain credentials; store a reference (an environment variable or secret name) instead.`,
          { path: at },
        ),
      );
    } else if (value.trim() !== "" && SECRET_KEY.test(key)) {
      out.push(
        fail(
          "forbidden-secret",
          `${at} is named like a credential. Definitions must not contain credentials; remove the value or store a reference (an environment variable or secret name) under a different key.`,
          { path: at },
        ),
      );
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, i) => secretErrors(item, [...path, String(i)], out));
    return;
  }
  if (isTable(value)) {
    for (const [key, item] of Object.entries(value))
      secretErrors(item, [...path, key], out);
  }
}

/**
 * Content a definition must never carry: credentials, export metadata (which
 * import strips) and a client connection file. Shared by the server write
 * guard and by import and export, so every path rejects the same things.
 * Messages name the path, never the value.
 */
export function findForbiddenDefinitionContent(
  doc: unknown,
): DefinitionTransferError[] {
  if (!isTable(doc)) return [];
  if (looksLikeClientConfig(doc)) {
    return [
      fail(
        "client-connection-file",
        "This is a client connection file (.tila/config.toml), not definitions. Definitions usually live in tila.schema.toml or come from an export.",
      ),
    ];
  }
  const errors: DefinitionTransferError[] = [];
  if (DEFINITION_EXPORT_KEY in doc) {
    errors.push(
      fail(
        "export-metadata",
        `[${DEFINITION_EXPORT_KEY}] is export metadata, not a definition. Import the file (tila schema import, or Settings › Definitions › Import), which removes it.`,
        { path: DEFINITION_EXPORT_KEY },
      ),
    );
  }
  secretErrors(doc, [], errors);
  return errors;
}

// --- Reading ---------------------------------------------------------------

/**
 * Validate a parsed tree as an importable definition: strip and check export
 * metadata, then reject client config files, credentials and malformed
 * declaration sections. Used by the TOML and YAML readers.
 */
export function readDefinitionTree(
  tree: unknown,
  format: DefinitionFormat,
): ReadDefinitionResult {
  if (!isTable(tree)) {
    return {
      ok: false,
      errors: [
        fail(
          "not-a-table",
          "A definition file must be a table of sections (schema_version, work_units, records, ...).",
        ),
      ],
    };
  }
  let doc: DefinitionDocument = tree;
  let metadata: DefinitionExportMetadata | null = null;
  if (DEFINITION_EXPORT_KEY in doc) {
    const parsed = DefinitionExportMetadataSchema.safeParse(
      doc[DEFINITION_EXPORT_KEY],
    );
    if (!parsed.success) {
      return {
        ok: false,
        errors: [
          fail(
            "export-metadata",
            `[${DEFINITION_EXPORT_KEY}] is not tila definitions export metadata (expected format = "${DEFINITION_EXPORT_FORMAT}" and a format_version).`,
            { path: DEFINITION_EXPORT_KEY },
          ),
        ],
      };
    }
    if (parsed.data.format_version > DEFINITION_EXPORT_FORMAT_VERSION) {
      return {
        ok: false,
        errors: [
          fail(
            "export-metadata",
            `This file was exported by a newer tila (format_version ${parsed.data.format_version}; this version reads ${DEFINITION_EXPORT_FORMAT_VERSION}). Upgrade tila to import it.`,
            { path: `${DEFINITION_EXPORT_KEY}.format_version` },
          ),
        ],
      };
    }
    metadata = parsed.data;
    doc = setIn(doc, [DEFINITION_EXPORT_KEY], undefined);
  }
  if (Object.keys(doc).length === 0) {
    return {
      ok: false,
      errors: [fail("no-definitions", "The file contains no definitions.")],
    };
  }
  const forbidden = findForbiddenDefinitionContent(doc);
  if (forbidden.length > 0) return { ok: false, errors: forbidden };
  const malformed = DECLARATION_SECTIONS.filter(
    (section) => section in doc && !isTable(doc[section]),
  ).map((section) =>
    fail(
      "invalid-definition",
      `${section} must be a table of named declarations.`,
      { path: section },
    ),
  );
  if (malformed.length > 0) return { ok: false, errors: malformed };
  return { ok: true, doc, format, metadata };
}

/** Read TOML definition text: size, syntax, export metadata and forbidden content. */
export function readTomlDefinition(text: string): ReadDefinitionResult {
  const tooLarge = definitionSizeError(text, "The file");
  if (tooLarge) return { ok: false, errors: [tooLarge] };
  const parsed = parseDefinitionDocument(text);
  if (!parsed.ok) {
    return {
      ok: false,
      errors: parsed.errors.map((e) => ({ ...e, code: "syntax" as const })),
    };
  }
  return readDefinitionTree(parsed.doc, "toml");
}

/** Format implied by a file name, or an error for an unsupported extension. */
export function definitionFormatFromName(
  filename: string,
): DefinitionFormat | DefinitionTransferError {
  const match = /\.([^./\\]+)$/.exec(filename);
  const ext = match?.[1]?.toLowerCase();
  if (ext === "toml") return "toml";
  if (ext === "yaml" || ext === "yml") return "yaml";
  return fail(
    "unsupported-format",
    `Definitions can be imported from .toml, .yaml or .yml files${ext ? `, not .${ext}` : ""}.`,
  );
}

// --- Planning --------------------------------------------------------------

export type DefinitionImportUnits = {
  /** Units the result adds. */
  added: string[];
  /** Units the file replaces with a different value. */
  changed: string[];
  /** Units the file contains with the value already applied. */
  unchanged: string[];
  /** Current units the file omits and a merge keeps. */
  preserved: string[];
  /** Current units a replace removes. Each needs explicit confirmation. */
  removed: string[];
};

export type DefinitionImportPlan =
  | {
      ok: true;
      mode: DefinitionImportMode;
      document: DefinitionDocument;
      /** TOML to preview and apply. Comments and layout are not kept. */
      source: string;
      /** True when the result equals the current definition, unknown keys included. */
      noChange: boolean;
      units: DefinitionImportUnits;
      warnings: string[];
    }
  | { ok: false; errors: DefinitionTransferError[] };

export type DefinitionImportContext = {
  /** Applied TOML, to warn that its comments will be rewritten. */
  currentSource?: string;
  /** Export metadata of the imported file. */
  metadata?: DefinitionExportMetadata | null;
  projectId?: string;
  /** Revision `current` was read at. */
  revision?: number;
};

/**
 * Plan an import onto the definition applied now (`null` before the first
 * apply). A unit is one named declaration in work_units, records, artifacts
 * or templates, or any other whole top-level key.
 *
 * - merge: each unit in the file replaces the same unit; omitted units are
 *   kept. A declaration is replaced whole, so fields it drops are removals the
 *   preview reports. An empty section changes nothing.
 * - replace: the file becomes the whole definition; `units.removed` lists
 *   what disappears, which callers must have the user confirm.
 *
 * The result is validated as a complete definition. Errors mean nothing may be
 * applied.
 */
export function planDefinitionImport(
  current: DefinitionDocument | null,
  imported: DefinitionDocument,
  mode: DefinitionImportMode,
  context: DefinitionImportContext = {},
): DefinitionImportPlan {
  const base = current ?? {};
  let document: DefinitionDocument;
  if (mode === "replace") {
    document = cloneValue(imported);
  } else {
    document = cloneValue(base);
    for (const unit of definitionUnits(imported)) {
      document = setIn(
        document,
        unit.keys,
        cloneValue(getIn(imported, unit.keys)),
      );
    }
  }

  if (document.schema_version === undefined) {
    return {
      ok: false,
      errors: [
        fail(
          "invalid-definition",
          mode === "replace"
            ? "schema_version is required: a replace import must be a complete definition."
            : "schema_version is required: the file doesn't set it and the project has none applied.",
          { path: "schema_version" },
        ),
      ],
    };
  }

  let source: string;
  try {
    source = serializeDefinitionDocument(document);
  } catch (e) {
    return {
      ok: false,
      errors: [
        fail(
          "unrepresentable-value",
          `The result can't be written as TOML: ${e instanceof Error ? e.message : String(e)}`,
        ),
      ],
    };
  }

  const tooLarge = definitionSizeError(source, "The resulting definition");
  if (tooLarge) return { ok: false, errors: [tooLarge] };

  const forbidden = findForbiddenDefinitionContent(document);
  if (forbidden.length > 0) return { ok: false, errors: forbidden };

  const validated = parseSchemaToml(source);
  if (!validated.ok) {
    return {
      ok: false,
      errors: validated.errors.map((e) => ({
        ...e,
        code: "invalid-definition" as const,
      })),
    };
  }

  const comparison = compareDefinitionUnits(base, document);
  const inFile = new Set(definitionUnits(imported).map((u) => u.path));
  const units: DefinitionImportUnits = {
    added: comparison.added,
    changed: comparison.changed,
    unchanged: comparison.unchanged.filter((path) => inFile.has(path)),
    preserved:
      mode === "merge"
        ? comparison.unchanged.filter((path) => !inFile.has(path))
        : [],
    removed: comparison.removed,
  };
  const noChange =
    units.added.length === 0 &&
    units.changed.length === 0 &&
    units.removed.length === 0;

  const warnings: string[] = [];
  const { metadata } = context;
  if (
    metadata?.project_id !== undefined &&
    metadata.project_id === context.projectId &&
    metadata.revision !== undefined &&
    context.revision !== undefined &&
    metadata.revision < context.revision &&
    !noChange
  ) {
    warnings.push(
      `This file was exported from revision ${metadata.revision}; the project is at revision ${context.revision}. Importing it reverts the declarations it contains that changed since then.`,
    );
  }
  if (
    !noChange &&
    context.currentSource &&
    definitionHasComments(context.currentSource)
  ) {
    warnings.push(
      "The applied definition has comments. The imported result is rewritten without them.",
    );
  }

  return { ok: true, mode, document, source, noChange, units, warnings };
}

// --- Export ----------------------------------------------------------------

export type DefinitionExportInput = {
  /** Applied definition text (`GET /schema` → `schema.definition`). */
  source: string;
  projectId: string;
  revision: number;
  /** Applied-at time of `revision`, in epoch milliseconds. */
  appliedAt?: number | null;
  exportedAt?: Date;
  /** What produced the file, e.g. "tila-cli 0.8.0" or "dashboard". */
  exportedWith?: string;
};

export type PreparedDefinitionExport =
  | {
      ok: true;
      /** The definition with `[tila_export]` placed after top-level scalars. */
      document: DefinitionDocument;
      /** Comment lines (without `#`) explaining what the file is. */
      header: string[];
      /** Values copied as-is that may refer to something outside the project. */
      verbatimPaths: string[];
    }
  | { ok: false; errors: DefinitionTransferError[] };

/** Paths whose values are copied verbatim and are worth checking elsewhere. */
export function definitionVerbatimPaths(doc: DefinitionDocument): string[] {
  const paths: string[] = [];
  const records = doc.records;
  if (isTable(records)) {
    for (const [type, declaration] of Object.entries(records)) {
      if (isTable(declaration) && typeof declaration.schema_ref === "string")
        paths.push(`records.${type}.schema_ref`);
    }
  }
  const templates = doc.templates;
  if (isTable(templates)) {
    for (const [name, template] of Object.entries(templates)) {
      const entities = isTable(template) ? template.entities : undefined;
      if (!isTable(entities)) continue;
      for (const [id, entity] of Object.entries(entities)) {
        if (
          isTable(entity) &&
          isTable(entity.data) &&
          Object.keys(entity.data).length > 0
        )
          paths.push(`templates.${name}.entities.${id}.data`);
      }
    }
  }
  return paths;
}

/**
 * Build the export document and its explanatory header. Stored definitions
 * that contain credentials are refused rather than redacted, so an export is
 * never silently different from what is applied.
 */
export function prepareDefinitionExport(
  input: DefinitionExportInput,
): PreparedDefinitionExport {
  const parsed = parseDefinitionDocument(input.source);
  if (!parsed.ok) {
    return {
      ok: false,
      errors: parsed.errors.map((e) => ({ ...e, code: "syntax" as const })),
    };
  }
  const definition = setIn(parsed.doc, [DEFINITION_EXPORT_KEY], undefined);
  const forbidden = findForbiddenDefinitionContent(definition);
  if (forbidden.length > 0) return { ok: false, errors: forbidden };

  const exportedAt = (input.exportedAt ?? new Date()).toISOString();
  const metadata: DefinitionExportMetadata = {
    format: DEFINITION_EXPORT_FORMAT,
    format_version: DEFINITION_EXPORT_FORMAT_VERSION,
    project_id: input.projectId,
    revision: input.revision,
    exported_at: exportedAt,
    ...(input.appliedAt
      ? { applied_at: new Date(input.appliedAt).toISOString() }
      : {}),
    ...(input.exportedWith ? { exported_with: input.exportedWith } : {}),
  };

  // Top-level scalars first, then the metadata table, then the sections.
  const document: DefinitionDocument = {};
  for (const [key, value] of Object.entries(definition))
    if (!isTable(value) && !Array.isArray(value)) document[key] = value;
  document[DEFINITION_EXPORT_KEY] = metadata;
  for (const [key, value] of Object.entries(definition))
    if (!(key in document)) document[key] = value;

  const verbatimPaths = definitionVerbatimPaths(definition);
  const header = [
    " tila definitions export",
    ` Project ${input.projectId}, revision ${input.revision}, exported ${exportedAt}.`,
    "",
    " Definitions only: work and record types, fields, templates, hierarchy and",
    " artifact policies. Agents, rooms, signal groups, members, credentials,",
    " tasks, records and artifacts are not included. This is not a project",
    " backup; use `tila project export` for that.",
    "",
    " Definitions name no project-specific identities, so nothing needs",
    " remapping for another project.",
    ...(verbatimPaths.length > 0
      ? [
          " These values are copied verbatim; check them if they point at",
          " something outside this project:",
          ...verbatimPaths.map((path) => `   ${path}`),
        ]
      : []),
    "",
    " Comments and layout of the applied definition are not kept. Import with",
    " Settings › Definitions › Import or `tila schema import <file>`; the",
    ` [${DEFINITION_EXPORT_KEY}] table is removed on import.`,
  ];
  return { ok: true, document, header, verbatimPaths };
}

export type RenderedDefinitionExport =
  | { ok: true; text: string; verbatimPaths: string[] }
  | { ok: false; errors: DefinitionTransferError[] };

/** The export as TOML. YAML lives in `@tila/core/definition-yaml`. */
export function renderTomlDefinitionExport(
  input: DefinitionExportInput,
): RenderedDefinitionExport {
  const prepared = prepareDefinitionExport(input);
  if (!prepared.ok) return prepared;
  const comment = prepared.header
    .map((line) => (line === "" ? "#" : `#${line}`))
    .join("\n");
  return {
    ok: true,
    text: `${comment}\n\n${serializeDefinitionDocument(prepared.document)}`,
    verbatimPaths: prepared.verbatimPaths,
  };
}
