import {
  ChangeList,
  destructiveChanges,
} from "@/components/definitions/change-list";
import { ConflictPanel } from "@/components/definitions/conflict-panel";
import { ProblemSummary } from "@/components/definitions/problem-summary";
import { Button } from "@/components/ui/button";
import { ConfirmAction } from "@/components/ui/confirm-action";
import { FormNotice } from "@/components/ui/form-fields";
import { type SchemaApplyCommand, applySchema, previewSchema } from "@/lib/api";
import {
  type DefinitionDraftValue,
  appliedSchemaQueryKey,
  definitionChanges,
  useDefinitionDraft,
} from "@/lib/definition-draft";
import { failureMessage, schemaFailure } from "@/lib/mutation-errors";
import { releaseOperation, stageOperation } from "@/lib/operation-draft";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  type DefinitionUnitComparison,
  compareDefinitionUnits,
  parseDefinitionDocument,
} from "@tila/core";
import { useEffect, useId, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router";

/** Declarations a draft adds, changes and removes relative to its base. */
function unitComparison(
  baseSource: string,
  source: string,
): DefinitionUnitComparison | null {
  const base = baseSource.trim()
    ? parseDefinitionDocument(baseSource)
    : { ok: true as const, doc: {} };
  const next = parseDefinitionDocument(source);
  if (!base.ok || !next.ok) return null;
  return compareDefinitionUnits(base.doc, next.doc);
}

function UnitList({ label, units }: { label: string; units: string[] }) {
  if (units.length === 0) return null;
  return (
    <div>
      <dt className="text-xs text-muted-foreground">
        {label} ({units.length})
      </dt>
      <dd className="font-mono text-xs">{units.join(", ")}</dd>
    </div>
  );
}

/** What an imported file does to the declarations of its base revision. */
function ImportSummary({
  importedFrom,
  units,
  baseRevision,
}: {
  importedFrom: NonNullable<DefinitionDraftValue["importedFrom"]>;
  units: DefinitionUnitComparison | null;
  baseRevision: number;
}) {
  return (
    <section
      aria-label="Imported file"
      className="space-y-2 rounded-lg border border-border p-3 text-sm"
    >
      <p>
        This draft imports{" "}
        <span className="font-medium">{importedFrom.name}</span> (
        {importedFrom.format.toUpperCase()},{" "}
        {importedFrom.mode === "merge"
          ? "merged: declarations the file doesn't mention are kept"
          : "replacing the whole definition"}
        ) onto revision {baseRevision}.
      </p>
      {importedFrom.warnings.map((warning) => (
        <FormNotice key={warning} tone="warning">
          {warning}
        </FormNotice>
      ))}
      {units && (
        <dl className="space-y-1">
          <UnitList label="Added" units={units.added} />
          <UnitList label="Changed" units={units.changed} />
          <UnitList label="Removed" units={units.removed} />
          {importedFrom.mode === "merge" && units.unchanged.length > 0 && (
            <div>
              <dt className="text-xs text-muted-foreground">
                Unchanged ({units.unchanged.length})
              </dt>
              <dd className="text-xs text-muted-foreground">
                Kept as applied, including everything the file doesn't mention.
              </dd>
            </div>
          )}
        </dl>
      )}
    </section>
  );
}

export type AppliedNotice =
  | { kind: "applied"; revision: number }
  | { kind: "no-change" };

/** Queries whose answers depend on the applied definition. */
export async function invalidateDefinitions(
  client: ReturnType<typeof useQueryClient>,
  project: string,
) {
  await Promise.all([
    client.invalidateQueries({ queryKey: appliedSchemaQueryKey(project) }),
    client.invalidateQueries({ queryKey: ["schema-history", project] }),
    client.invalidateQueries({ queryKey: ["schema-preview", project] }),
    client.invalidateQueries({ queryKey: ["work-catalog", project] }),
    client.invalidateQueries({ queryKey: ["recordTypes", project] }),
  ]);
}

/**
 * Review the draft against current data, then apply it as a new revision. The
 * apply is bound to the previewed revision and text: if either moved, the
 * server refuses and the draft is kept for another review.
 */
export function SettingsDefinitionsReviewPage() {
  const navigate = useNavigate();
  const client = useQueryClient();
  const {
    project,
    applied,
    current,
    ready,
    draft,
    value,
    dirty,
    replace,
    update,
    discard,
    canPreview,
    canApply,
  } = useDefinitionDraft();
  const [confirming, setConfirming] = useState(false);
  const [removalsConfirmed, setRemovalsConfirmed] = useState(false);
  const removalsId = useId();
  const back = `/p/${encodeURIComponent(project)}/settings/definitions`;
  const units = useMemo(
    () =>
      value.importedFrom
        ? unitComparison(value.baseSource, value.source)
        : null,
    [value.importedFrom, value.baseSource, value.source],
  );
  // An import never removes a declaration without an explicit confirmation,
  // even when the server would treat the removal as non-destructive.
  const removals = units?.removed ?? [];
  const removalSignature = removals.join("\n");
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset when the removal list changes
  useEffect(() => setRemovalsConfirmed(false), [removalSignature]);

  const preview = useQuery({
    queryKey: ["schema-preview", project, value.source],
    queryFn: () => previewSchema(project, value.source),
    enabled: ready && dirty && canPreview && value.source.trim() !== "",
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
  });
  const reviewed = preview.data;

  // The preview and the applied revision disagree: refresh the older one, so a
  // revision applied elsewhere surfaces as a conflict before apply.
  const previewAhead =
    reviewed !== undefined &&
    current !== null &&
    reviewed.revision !== current.revision;
  const previewed = reviewed?.revision;
  const appliedRevision = current?.revision;
  const { refetch: refetchApplied } = applied;
  const { refetch: refetchPreview } = preview;
  useEffect(() => {
    if (previewed === undefined || appliedRevision === undefined) return;
    if (previewed > appliedRevision) void refetchApplied();
    else if (previewed < appliedRevision) void refetchPreview();
  }, [previewed, appliedRevision, refetchApplied, refetchPreview]);

  const apply = useMutation({
    mutationFn: (staged: NonNullable<typeof draft.pending>) =>
      applySchema(project, staged.command as SchemaApplyCommand, staged.id),
    onSuccess: async (result) => {
      discard();
      await invalidateDefinitions(client, project);
      const notice: AppliedNotice = result.noChange
        ? { kind: "no-change" }
        : { kind: "applied", revision: result.revision ?? result.version ?? 0 };
      navigate(back, { state: { definitions: notice } });
    },
    onError: async (error) => {
      const failure = schemaFailure(error);
      if (failure.kind !== "unconfirmed") update(releaseOperation);
      if (failure.kind === "forbidden")
        await client.invalidateQueries({ queryKey: ["whoami", project] });
      if (failure.kind === "conflict" || failure.kind === "review") {
        await client.invalidateQueries({
          queryKey: ["schema-preview", project],
        });
        await applied.refetch();
      }
    },
  });

  function submit(strategy?: "relax") {
    if (draft.pending) return apply.mutate(draft.pending);
    if (!reviewed) return;
    const next = stageOperation(draft, (v) => ({
      definition: v.source,
      expected_revision: reviewed.revision,
      reviewed_definition: reviewed.reviewed_definition,
      ...(strategy ? { strategy } : {}),
    }));
    update(() => next);
    if (next.pending) apply.mutate(next.pending);
  }

  const heading = (
    <header className="space-y-1">
      <Link to={back} className="text-xs text-muted-foreground hover:underline">
        ← Definitions
      </Link>
      <h1 className="font-logo text-xl tracking-tight text-foreground">
        Review definition changes
      </h1>
      <p className="text-sm text-muted-foreground">
        What applying your draft changes, checked against this project's current
        data.
      </p>
    </header>
  );

  if (!ready) return <div className="space-y-6 p-3 md:p-6">{heading}</div>;

  if (!canPreview)
    return (
      <div className="space-y-6 p-3 md:p-6">
        {heading}
        <FormNotice tone="info">
          Your access can read definitions but not preview or change them.
        </FormNotice>
      </div>
    );

  if (!dirty)
    return (
      <div className="space-y-6 p-3 md:p-6">
        {heading}
        <p className="text-sm text-muted-foreground">
          You have no draft to review.{" "}
          <Link to={back} className="underline">
            Back to definitions
          </Link>
        </p>
      </div>
    );

  const conflict =
    current !== null &&
    current.revision !== value.baseRevision &&
    !draft.pending;
  const failure = apply.isError ? schemaFailure(apply.error) : null;
  const previewFailure = preview.isError ? schemaFailure(preview.error) : null;
  const firstApply = reviewed?.revision === 0;
  const changes =
    reviewed && firstApply
      ? (definitionChanges("", value.source) ?? [])
      : (reviewed?.changes ?? []);
  const destructive = reviewed ? !reviewed.autoApplicable : false;
  const busy = apply.isPending;

  return (
    <div className="space-y-6 p-3 md:p-6">
      {heading}

      {value.importedFrom && (
        <ImportSummary
          importedFrom={value.importedFrom}
          units={units}
          baseRevision={value.baseRevision}
        />
      )}

      {value.restoredFrom !== null && (
        <FormNotice tone="info">
          This draft restores revision {value.restoredFrom}. Applying it records
          a new revision; history is not rewritten.
        </FormNotice>
      )}

      {conflict && current ? (
        <ConflictPanel
          value={value}
          latest={current}
          onRebase={(next) => {
            apply.reset();
            replace(next);
          }}
          onStartOver={() => {
            apply.reset();
            discard();
          }}
        />
      ) : (
        <section aria-labelledby="review-changes" className="space-y-3">
          <h2 id="review-changes" className="font-logo text-lg tracking-tight">
            {firstApply
              ? "Will be created"
              : `Changes to revision ${value.baseRevision}`}
          </h2>
          {preview.isPending && (
            <output className="block text-sm text-muted-foreground">
              Checking your draft against current data…
            </output>
          )}
          {previewFailure?.kind === "parse" && (
            <ProblemSummary
              title="Fix these problems before applying"
              problems={previewFailure.problems}
            />
          )}
          {previewFailure && previewFailure.kind !== "parse" && (
            <FormNotice>
              The preview failed: {failureMessage(preview.error)}{" "}
              <Button
                type="button"
                size="xs"
                variant="outline"
                onClick={() => void preview.refetch()}
              >
                Try again
              </Button>
            </FormNotice>
          )}
          {reviewed && (
            <>
              <ChangeList changes={changes} />
              {firstApply && (
                <p className="text-xs text-muted-foreground">
                  This is the project's first definition, so no existing data is
                  affected.
                </p>
              )}
            </>
          )}
        </section>
      )}

      {failure && failure.kind === "parse" && (
        <ProblemSummary
          title="The server rejected this definition"
          problems={failure.problems}
        />
      )}
      {failure?.kind === "unconfirmed" && (
        <FormNotice tone="warning">
          The server did not confirm the apply ({failureMessage(apply.error)}).
          Retry sends the same request, so at most one revision is recorded.
        </FormNotice>
      )}
      {failure?.kind === "review" && (
        <FormNotice tone="warning">
          The reviewed preview no longer matches. It has been refreshed; review
          the changes again before applying.
        </FormNotice>
      )}
      {failure?.kind === "forbidden" && (
        <FormNotice>
          Your access changed and the apply was refused. Your draft is kept.
        </FormNotice>
      )}
      {(failure?.kind === "invalid" || failure?.kind === "exists") && (
        <FormNotice>
          {failureMessage(apply.error)} Your draft is kept.
        </FormNotice>
      )}

      {!conflict && removals.length > 0 && !draft.pending && canApply && (
        <div className="flex items-start gap-2 rounded-lg border border-status-amber/40 p-3 text-sm">
          <input
            id={removalsId}
            type="checkbox"
            checked={removalsConfirmed}
            onChange={(event) => setRemovalsConfirmed(event.target.checked)}
            className="mt-1"
          />
          <label htmlFor={removalsId}>
            Remove {removals.length}{" "}
            {removals.length === 1 ? "declaration" : "declarations"} the
            imported file doesn't contain:{" "}
            <span className="font-mono text-xs">{removals.join(", ")}</span>.
            Existing tasks and records stay readable as legacy data.
          </label>
        </div>
      )}

      {!conflict && (
        <div className="flex flex-wrap items-center gap-2">
          {canApply ? (
            <Button
              type="button"
              disabled={
                busy ||
                (!draft.pending &&
                  (!reviewed ||
                    previewAhead ||
                    (removals.length > 0 && !removalsConfirmed)))
              }
              onClick={() =>
                draft.pending || !destructive ? submit() : setConfirming(true)
              }
            >
              {busy
                ? "Applying…"
                : draft.pending
                  ? "Retry apply"
                  : `Apply as revision ${(reviewed?.revision ?? value.baseRevision) + 1}`}
            </Button>
          ) : (
            <p className="text-sm text-muted-foreground">
              A maintainer applies definition changes. Your access can draft and
              preview them.
            </p>
          )}
          <Button asChild variant="ghost">
            <Link to={back}>Keep editing</Link>
          </Button>
        </div>
      )}

      <ConfirmAction
        open={confirming}
        onOpenChange={setConfirming}
        title="Apply destructive definition changes?"
        confirmText={project}
        confirmLabel="Apply changes"
        pending={busy}
        description={
          <div className="space-y-2">
            <p>
              Some changes retire declarations or change existing behaviour.
              Existing tasks, records and artifacts are not deleted or
              rewritten, but they may no longer match the definition.
            </p>
            {reviewed && (
              <ChangeList
                changes={destructiveChanges(reviewed.changes)}
                label="Changes that need confirmation"
              />
            )}
            <p>Cancel leaves the applied definition unchanged.</p>
          </div>
        }
        onConfirm={() => {
          setConfirming(false);
          submit("relax");
        }}
      />
    </div>
  );
}
