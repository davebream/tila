import { SCHEMA_SECTION_MERGE_POLICY } from "@tila/schemas";
import { parse as parseTOML, stringify as stringifyTOML } from "smol-toml";
import { type SchemaParseError, parseSchemaToml } from "./schema-parser";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type SchemaFragment = { path: string; content: string };

export type ComposeWarning = { message: string; fragments: string[] };

export type ComposeSchemaResult =
  | {
      ok: true;
      definition: string;
      schemaVersion: number;
      warnings: ComposeWarning[];
      fragmentCount: number;
    }
  | { ok: false; errors: SchemaParseError[]; warnings: ComposeWarning[] };

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Policy section names, typed from the constant. */
type PolicyKey = keyof typeof SCHEMA_SECTION_MERGE_POLICY;
const POLICY_KEYS = new Set<string>(Object.keys(SCHEMA_SECTION_MERGE_POLICY));

/** Sort key: tila.schema.toml is always first (the "base"), then lexicographic. */
function sortFragments(fragments: SchemaFragment[]): SchemaFragment[] {
  return [...fragments].sort((a, b) => {
    const aBase =
      a.path === "tila.schema.toml" || a.path.endsWith("/tila.schema.toml");
    const bBase =
      b.path === "tila.schema.toml" || b.path.endsWith("/tila.schema.toml");
    if (aBase && !bBase) return -1;
    if (!aBase && bBase) return 1;
    return a.path.localeCompare(b.path);
  });
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Check whether two values are deeply equal (structural equality for primitives,
 * arrays, and plain objects — sufficient for TOML value comparison).
 */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((item, i) => deepEqual(item, b[i]));
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const keysA = Object.keys(a);
    const keysB = Object.keys(b);
    if (keysA.length !== keysB.length) return false;
    return keysA.every((k) => deepEqual(a[k], b[k]));
  }
  return false;
}

/**
 * Thin wrapper around smol-toml stringify — extracted so tests can exercise the
 * error branch without needing public-surface changes.
 *
 * @internal exported for testing only; do not use in production code.
 */
export function _serializeMergedForTest(
  merged: Record<string, unknown>,
): string {
  return stringifyTOML(merged);
}

// ---------------------------------------------------------------------------
// Main public function
// ---------------------------------------------------------------------------

export function composeSchemaFragments(
  fragments: SchemaFragment[],
): ComposeSchemaResult {
  // Step 1: Zero fragments
  if (fragments.length === 0) {
    return {
      ok: false,
      errors: [
        {
          message:
            "no schema fragment provided — at least one *.schema.toml is required",
        },
      ],
      warnings: [],
    };
  }

  // Step 2: Single fragment — verbatim passthrough (no parse/serialize)
  if (fragments.length === 1) {
    const frag = fragments[0];
    // Read schemaVersion via a lightweight parse
    let schemaVersion: number;
    try {
      const raw = parseTOML(frag.content) as Record<string, unknown>;
      const sv = raw.schema_version;
      if (typeof sv !== "number") {
        return {
          ok: false,
          errors: [
            {
              message: "schema_version must be a number",
              path: frag.path,
            },
          ],
          warnings: [],
        };
      }
      schemaVersion = sv;
    } catch (e: unknown) {
      const line =
        typeof (e as { line?: unknown }).line === "number"
          ? (e as { line: number }).line
          : undefined;
      const column =
        typeof (e as { column?: unknown }).column === "number"
          ? (e as { column: number }).column
          : undefined;
      return {
        ok: false,
        errors: [
          {
            message: e instanceof Error ? e.message : String(e),
            path: frag.path,
            line,
            column,
          },
        ],
        warnings: [],
      };
    }

    return {
      ok: true,
      definition: frag.content,
      schemaVersion,
      warnings: [],
      fragmentCount: 1,
    };
  }

  // Step 3: N >= 2 fragments
  return composeMultiple(fragments);
}

function composeMultiple(fragments: SchemaFragment[]): ComposeSchemaResult {
  const warnings: ComposeWarning[] = [];
  const errors: SchemaParseError[] = [];

  // 3a: Sort deterministically (base first, then lexicographic)
  const sorted = sortFragments(fragments);

  // 3b: Parse each fragment
  const parsed: Array<{ path: string; raw: Record<string, unknown> }> = [];
  for (const frag of sorted) {
    try {
      const raw = parseTOML(frag.content) as Record<string, unknown>;
      parsed.push({ path: frag.path, raw });
    } catch (e: unknown) {
      const line =
        typeof (e as { line?: unknown }).line === "number"
          ? (e as { line: number }).line
          : undefined;
      const column =
        typeof (e as { column?: unknown }).column === "number"
          ? (e as { column: number }).column
          : undefined;
      errors.push({
        message: e instanceof Error ? e.message : String(e),
        path: frag.path,
        line,
        column,
      });
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors, warnings };
  }

  // 3c: schema_version reconciliation
  // Base is parsed[0] (tila.schema.toml first or lexicographic)
  const base = parsed[0];
  const baseSv = base.raw.schema_version;
  if (typeof baseSv !== "number") {
    errors.push({
      message: "schema_version is missing or not a number in base fragment",
      path: base.path,
    });
    return { ok: false, errors, warnings };
  }
  const schemaVersion = baseSv;

  for (let i = 1; i < parsed.length; i++) {
    const frag = parsed[i];
    const sv = frag.raw.schema_version;
    if (sv !== undefined) {
      // Fragment explicitly declares schema_version
      if (typeof sv !== "number") {
        errors.push({
          message: `schema_version must be a number in fragment ${frag.path}`,
          path: frag.path,
        });
      } else if (sv !== baseSv) {
        errors.push({
          message: `schema_version mismatch: ${baseSv} (${base.path}) vs ${sv} (${frag.path})`,
          path: frag.path,
        });
      }
      // If sv === baseSv, it's consistent — no error
    }
    // If sv is undefined: inherits base version — no error
  }

  if (errors.length > 0) {
    return { ok: false, errors, warnings };
  }

  // Build the merged object
  // Start with schema_version from base
  const merged: Record<string, unknown> = { schema_version: schemaVersion };

  // Track which fragments declared each declaration-map key per section
  // Map: section -> key -> fragment path
  const declaredKeys = new Map<string, Map<string, string>>();

  // Process declaration-map sections (disjoint-keys)
  const disjointSections = (
    Object.entries(SCHEMA_SECTION_MERGE_POLICY) as Array<[PolicyKey, string]>
  )
    .filter(([, policy]) => policy === "disjoint-keys")
    .map(([section]) => section);

  // Process singleton sections
  const singletonSections = (
    Object.entries(SCHEMA_SECTION_MERGE_POLICY) as Array<[PolicyKey, string]>
  )
    .filter(([, policy]) => policy === "singleton")
    .map(([section]) => section);

  // Process declaration-map sections
  for (const section of disjointSections) {
    const keyTracker = new Map<string, string>();
    declaredKeys.set(section, keyTracker);

    for (const { path: fragPath, raw } of parsed) {
      const sectionData = raw[section];
      if (sectionData === undefined) continue;
      if (!isPlainObject(sectionData)) continue;

      if (!(section in merged)) {
        merged[section] = {};
      }
      const mergedSection = merged[section] as Record<string, unknown>;

      for (const [key, val] of Object.entries(sectionData)) {
        if (keyTracker.has(key)) {
          errors.push({
            message: `duplicate ${section} key "${key}" declared in ${keyTracker.get(key)} and ${fragPath}`,
            path: `${section}.${key}`,
          });
        } else {
          keyTracker.set(key, fragPath);
          mergedSection[key] = val;
        }
      }
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors, warnings };
  }

  // Process singleton sections (base-wins + advisory warning on conflict)
  for (const section of singletonSections) {
    const baseVal = base.raw[section];
    if (baseVal !== undefined) {
      merged[section] = baseVal;
    }

    // Track the effective value (declared by base OR first non-base that declares it)
    // and the path of the fragment that established it, for conflict detection.
    let effectiveVal: unknown = baseVal;
    let effectivePath: string = base.path;

    for (let i = 1; i < parsed.length; i++) {
      const { path: fragPath, raw } = parsed[i];
      const fragVal = raw[section];
      if (fragVal === undefined) continue;

      if (effectiveVal === undefined) {
        // No value yet — first non-base fragment to declare this section wins.
        merged[section] = fragVal;
        effectiveVal = fragVal;
        effectivePath = fragPath;
      } else {
        // An effective value is already established — check for conflict.
        if (!deepEqual(fragVal, effectiveVal)) {
          warnings.push({
            message: `singleton section "${section}" in ${fragPath} differs from ${effectivePath === base.path ? `base (${base.path})` : `first declarer (${effectivePath})`}; ${effectivePath === base.path ? "base" : "first-declarer"} value retained`,
            fragments: [effectivePath, fragPath],
          });
        }
        // Effective value is retained; this fragment's value is discarded.
      }
    }
  }

  // 3f: Unmodeled top-level keys (not in SCHEMA_SECTION_MERGE_POLICY)
  // Preserve via deep-merge (base-wins for conflicts), advisory warning on conflict
  for (const { path: fragPath, raw } of parsed) {
    for (const [key, val] of Object.entries(raw)) {
      if (POLICY_KEYS.has(key)) continue; // already handled
      if (key === "schema_version") continue; // already handled

      if (!(key in merged)) {
        merged[key] = val;
      } else {
        // Key exists — check for conflict
        if (!deepEqual(merged[key], val)) {
          warnings.push({
            message: `unmodeled top-level key "${key}" in ${fragPath} differs from base; base value retained`,
            fragments: [base.path, fragPath],
          });
        }
        // base-wins: keep existing value
      }
    }
  }

  // 3g: Cross-reference resolution
  // Build merged work_units keys
  const workUnitKeys = new Set<string>(
    Object.keys(
      (merged.work_units as Record<string, unknown> | undefined) ?? {},
    ),
  );
  // Build merged artifacts keys
  const artifactKeys = new Set<string>(
    Object.keys(
      (merged.artifacts as Record<string, unknown> | undefined) ?? {},
    ),
  );

  // Validate cross-references for each fragment
  for (const { path: fragPath, raw } of parsed) {
    // work_units.*.parents → resolve against work_units keys
    const workUnitsData = raw.work_units;
    if (isPlainObject(workUnitsData)) {
      for (const [unitKey, unitVal] of Object.entries(workUnitsData)) {
        if (!isPlainObject(unitVal)) continue;
        const parents = unitVal.parents;
        if (Array.isArray(parents)) {
          for (const parent of parents) {
            if (typeof parent === "string" && !workUnitKeys.has(parent)) {
              errors.push({
                message: `${fragPath}: work_units.${unitKey}.parents references unknown type "${parent}" (not declared in any fragment)`,
                path: `${fragPath}:work_units.${unitKey}.parents`,
              });
            }
          }
        }

        // work_units.*.references[].kinds → resolve against artifacts keys (ENGINE-SOLE)
        const references = unitVal.references;
        if (Array.isArray(references)) {
          for (let ri = 0; ri < references.length; ri++) {
            const ref = references[ri];
            if (!isPlainObject(ref)) continue;
            const kinds = ref.kinds;
            if (Array.isArray(kinds)) {
              for (const kind of kinds) {
                if (typeof kind === "string" && !artifactKeys.has(kind)) {
                  errors.push({
                    message: `${fragPath}: work_units.${unitKey}.references[${ri}].kinds references unknown artifact kind "${kind}" (not declared in any fragment)`,
                    path: `${fragPath}:work_units.${unitKey}.references[${ri}].kinds`,
                  });
                }
              }
            }
          }
        }
      }
    }

    // hierarchy.levels → resolve against work_units keys
    const hierarchyData = raw.hierarchy;
    if (isPlainObject(hierarchyData)) {
      const levels = hierarchyData.levels;
      if (Array.isArray(levels)) {
        for (let li = 0; li < levels.length; li++) {
          const level = levels[li];
          if (typeof level === "string" && !workUnitKeys.has(level)) {
            errors.push({
              message: `${fragPath}: hierarchy.levels[${li}] references unknown work-unit type "${level}" (not declared in any fragment)`,
              path: `${fragPath}:hierarchy.levels`,
            });
          }
        }
      }
    }

    // templates.*.entities.*.type → resolve against work_units keys
    const templatesData = raw.templates;
    if (isPlainObject(templatesData)) {
      for (const [templateKey, templateVal] of Object.entries(templatesData)) {
        if (!isPlainObject(templateVal)) continue;
        const entities = templateVal.entities;
        if (isPlainObject(entities)) {
          for (const [entityKey, entityVal] of Object.entries(entities)) {
            if (!isPlainObject(entityVal)) continue;
            const type = entityVal.type;
            if (typeof type === "string" && !workUnitKeys.has(type)) {
              errors.push({
                message: `${fragPath}: templates.${templateKey}.entities.${entityKey}.type references unknown work-unit type "${type}" (not declared in any fragment)`,
                path: `${fragPath}:templates.${templateKey}.entities.${entityKey}.type`,
              });
            }
          }
        }
      }
    }

    // artifacts.*.requires_reference_to → resolve against artifacts keys (ENGINE-SOLE)
    const artifactsData = raw.artifacts;
    if (isPlainObject(artifactsData)) {
      for (const [artifactKey, artifactVal] of Object.entries(artifactsData)) {
        if (!isPlainObject(artifactVal)) continue;
        const requiresRefTo = artifactVal.requires_reference_to;
        if (Array.isArray(requiresRefTo)) {
          for (const ref of requiresRefTo) {
            if (typeof ref === "string" && !artifactKeys.has(ref)) {
              errors.push({
                message: `${fragPath}: artifacts.${artifactKey}.requires_reference_to references unknown artifact kind "${ref}" (not declared in any fragment)`,
                path: `${fragPath}:artifacts.${artifactKey}.requires_reference_to`,
              });
            }
          }
        }
      }
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors, warnings };
  }

  // 3h: Serialize merged object
  let definition: string;
  try {
    definition = stringifyTOML(merged);
  } catch (e: unknown) {
    return {
      ok: false,
      errors: [
        {
          message: `failed to serialize merged schema: ${e instanceof Error ? e.message : String(e)}`,
        },
      ],
      warnings,
    };
  }

  // 3i: Self-validation
  const selfValidation = parseSchemaToml(definition);
  if (!selfValidation.ok) {
    return {
      ok: false,
      errors: selfValidation.errors,
      warnings,
    };
  }

  return {
    ok: true,
    definition,
    schemaVersion,
    warnings,
    fragmentCount: fragments.length,
  };
}
