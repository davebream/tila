import { useWhoami } from "@/hooks/use-admin";
import { useAuth } from "@/hooks/use-auth";
import { getSchema } from "@/lib/api";
import {
  editOperation,
  operationKey,
  useOperationDraft,
} from "@/lib/operation-draft";
import { rights } from "@/lib/rights";
import { useQuery } from "@tanstack/react-query";
import {
  type DefinitionDocument,
  type SchemaChange,
  type SchemaParseError,
  diffSchemas,
  parseDefinitionDocument,
  parseSchemaToml,
  serializeDefinitionDocument,
} from "@tila/core";
import type { TilaSchemaToml } from "@tila/schemas";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router";
import { z } from "zod";

/**
 * The browser's definition draft. Text, not a parsed tree, is what persists:
 * it is exactly what preview and apply receive, and a JSON copy of the tree
 * would turn TOML dates into strings.
 */
export const DefinitionDraftValue = z.object({
  /** Applied revision the draft started from; 0 before the first apply. */
  baseRevision: z.number().int().nonnegative(),
  /** Applied TOML at `baseRevision`, for rebasing and the comment warning. */
  baseSource: z.string(),
  source: z.string(),
  /** Set when the draft restores a historical revision. */
  restoredFrom: z.number().int().positive().nullable(),
});
export type DefinitionDraftValue = z.infer<typeof DefinitionDraftValue>;

export const DefinitionApplyCommand = z.object({
  definition: z.string(),
  expected_revision: z.number().int().nonnegative(),
  reviewed_definition: z.string(),
  strategy: z.enum(["relax", "force"]).optional(),
});

/** Starting text for a project with no applied definitions. */
export const STARTER_DEFINITION = "schema_version = 1\n";

export function appliedSchemaQueryKey(project: string) {
  return ["overview", project, "schema"] as const;
}

/** The applied definition, shared with the overview page. */
export function useAppliedSchema() {
  const { projectId } = useAuth();
  const project = projectId ?? "";
  return useQuery({
    queryKey: appliedSchemaQueryKey(project),
    queryFn: () => getSchema(project),
    enabled: Boolean(projectId),
    refetchInterval: 30_000,
  });
}

/**
 * The current principal's session draft for this project's definitions. With
 * nothing drafted, it follows the applied revision; once edited it stays on
 * its base revision until the user applies, rebases or discards it.
 */
export function useDefinitionDraft() {
  const { projectId } = useAuth();
  const project = projectId ?? "";
  const whoami = useWhoami();
  const applied = useAppliedSchema();
  const allowed = rights(whoami.data, project);
  const current = applied.data
    ? {
        revision: applied.data.revision ?? applied.data.version ?? 0,
        source: applied.data.schema?.definition ?? "",
      }
    : null;
  const key =
    current && !whoami.isLoading
      ? operationKey("definitions", whoami.data?.principal_id ?? null, project)
      : null;
  const { draft, update, discard } = useOperationDraft(
    key,
    () => ({
      baseRevision: current?.revision ?? 0,
      baseSource: current?.source ?? "",
      source: current?.source ?? "",
      restoredFrom: null,
    }),
    { value: DefinitionDraftValue, command: DefinitionApplyCommand },
  );
  const value = draft.value;
  const dirty =
    value.source !== value.baseSource || value.restoredFrom !== null;

  // An untouched draft tracks whatever is applied now.
  const behind =
    key !== null &&
    current !== null &&
    !dirty &&
    !draft.pending &&
    (value.baseRevision !== current.revision ||
      value.baseSource !== current.source);
  useEffect(() => {
    if (behind) discard();
  }, [behind, discard]);

  // Navigating in the same event as an edit would unmount this page before
  // the draft is persisted; go once the edit has rendered (and been saved by
  // the draft hook's earlier effect).
  const navigate = useNavigate();
  const [then, setThen] = useState<string | null>(null);
  useEffect(() => {
    if (then === null) return;
    setThen(null);
    navigate(then);
  }, [then, navigate]);

  const edit = useCallback(
    (source: string, next?: string) => {
      update((d) => editOperation(d, { ...d.value, source }));
      if (next) setThen(next);
    },
    [update],
  );
  const replace = useCallback(
    (value: DefinitionDraftValue, next?: string) => {
      update((d) => editOperation(d, value));
      if (next) setThen(next);
    },
    [update],
  );

  return {
    project,
    applied,
    current,
    ready: key !== null,
    draft,
    value,
    dirty,
    edit,
    replace,
    update,
    discard,
    canPreview: allowed.previewDefinitions,
    canApply: allowed.applyDefinitions,
  };
}

export type DraftAnalysis =
  | { ok: false; problems: SchemaParseError[]; syntax: boolean }
  | {
      ok: true;
      doc: DefinitionDocument;
      schema: TilaSchemaToml;
      /** Client-side semantic diff against the base; no data counts. */
      changes: SchemaChange[];
    };

const EMPTY = parseSchemaToml(STARTER_DEFINITION);

/** Parse once with the shared core parser; the server preview stays authoritative. */
export function parsedSchema(source: string): TilaSchemaToml | null {
  if (!source.trim()) return EMPTY.ok ? EMPTY.schema : null;
  const result = parseSchemaToml(source);
  return result.ok ? result.schema : null;
}

/** Client-side semantic changes between two TOML texts, or null if one is invalid. */
export function definitionChanges(
  before: string,
  after: string,
): SchemaChange[] | null {
  const a = parsedSchema(before);
  const b = parsedSchema(after);
  return a && b ? diffSchemas(a, b).changes : null;
}

export function analyzeDraft(value: DefinitionDraftValue): DraftAnalysis {
  const document = parseDefinitionDocument(value.source);
  if (!document.ok)
    return { ok: false, problems: document.errors, syntax: true };
  const parsed = parseSchemaToml(value.source);
  if (!parsed.ok) return { ok: false, problems: parsed.errors, syntax: false };
  return {
    ok: true,
    doc: document.doc,
    schema: parsed.schema,
    changes: definitionChanges(value.baseSource, value.source) ?? [],
  };
}

export function useDraftAnalysis(value: DefinitionDraftValue): DraftAnalysis {
  return useMemo(() => analyzeDraft(value), [value]);
}

/**
 * The editable tree behind a draft. Forms change it and write the serialized
 * text back, so keys they do not model are preserved.
 */
export function editDocument(
  source: string,
  change: (doc: DefinitionDocument) => DefinitionDocument,
): string | null {
  const parsed = parseDefinitionDocument(
    source.trim() ? source : STARTER_DEFINITION,
  );
  if (!parsed.ok) return null;
  return serializeDefinitionDocument(change(parsed.doc));
}
