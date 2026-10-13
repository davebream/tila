import {
  Facts,
  LandedNotice,
  ManageNote,
  OwnerStepUp,
  SettingsHeading,
  WriteFailure,
} from "@/components/settings/settings-ui";
import { Button } from "@/components/ui/button";
import { CopyButton } from "@/components/ui/copy-button";
import { FormNotice, TextField } from "@/components/ui/form-fields";
import { QuerySection } from "@/components/ui/query-section";
import {
  useInvalidateAccess,
  useProjectSettings,
  useStepUp,
} from "@/hooks/use-access-settings";
import {
  isStepUpRequired,
  useAdminCapabilities,
  useWhoami,
} from "@/hooks/use-admin";
import { updateProjectSettings } from "@/lib/api";
import { failureKind, revisionConflict } from "@/lib/mutation-errors";
import { operationKey } from "@/lib/operation-draft";
import { deriveSectionState } from "@/lib/query-state";
import { useSettingsDraft } from "@/lib/settings-draft";
import { formatDateTime } from "@/lib/time";
import { useMutation } from "@tanstack/react-query";
import {
  type ProjectSettings,
  type UpdateProjectSettings,
  UpdateProjectSettingsSchema,
} from "@tila/schemas";
import { type FormEvent, useState } from "react";
import { z } from "zod";

/** Registry timestamps are seconds on some paths and milliseconds on others. */
const toMs = (value: number) => (value < 1e12 ? value * 1000 : value);

export function SettingsGeneralPage() {
  const { canConfigureProject } = useAdminCapabilities();
  const whoami = useWhoami();
  const settings = useProjectSettings();
  const state = deriveSectionState(settings, { isEmpty: () => false });
  const stepUp = useStepUp();
  const [saved, setSaved] = useState<string | null>(null);

  return (
    <div className="space-y-6 p-3 md:p-6">
      <SettingsHeading title="General">
        The project's identity. The display name is cosmetic: the project ID,
        URLs, credentials and memberships never change when it does.
      </SettingsHeading>
      {stepUp.required && <OwnerStepUp onDismiss={stepUp.dismiss} />}
      {saved && <FormNotice tone="info">{saved}</FormNotice>}
      <QuerySection
        state={state}
        label="project settings"
        empty=""
        forbidden="Your access does not include project settings."
        onRetry={() => void settings.refetch()}
      >
        {(data) => (
          <div className="max-w-2xl space-y-6">
            <Facts
              label="Project"
              rows={[
                [
                  "Project ID",
                  <span key="id" className="inline-flex items-center gap-1">
                    {data.project_id}
                    <CopyButton value={data.project_id} />
                  </span>,
                ],
                ["Display name", data.display_name ?? "Not set"],
                ["Created", formatDateTime(toMs(data.created_at))],
                ["Created by", data.created_by],
                ["Revision", String(data.revision)],
              ]}
            />
            {canConfigureProject ? (
              <DisplayNameForm
                settings={data}
                principal={whoami.data?.principal_id ?? null}
                onStepUp={stepUp.caught}
                onSaved={(next) =>
                  setSaved(
                    next.display_name
                      ? `Renamed to ${next.display_name} (revision ${next.revision}).`
                      : `Display name cleared (revision ${next.revision}).`,
                  )
                }
              />
            ) : (
              <ManageNote>
                Only a project owner (or a credential with project:configure)
                can rename the project.
              </ManageNote>
            )}
          </div>
        )}
      </QuerySection>
    </div>
  );
}

const NameForm = z.object({ display_name: z.string() });
type NameForm = z.infer<typeof NameForm>;

const canonical = (form: NameForm) => ({
  display_name: form.display_name.trim() || null,
});

function DisplayNameForm({
  settings,
  principal,
  onStepUp,
  onSaved,
}: {
  settings: ProjectSettings;
  principal: string | null;
  onStepUp: (error: unknown) => boolean;
  onSaved: (settings: ProjectSettings) => void;
}) {
  const invalidate = useInvalidateAccess();
  const draft = useSettingsDraft({
    key: operationKey("project-settings", principal, settings.project_id),
    current: {
      revision: settings.revision,
      form: { display_name: settings.display_name ?? "" },
    },
    canonical,
    schemas: { form: NameForm, command: UpdateProjectSettingsSchema },
  });
  const save = useMutation({
    networkMode: "always",
    mutationFn: (op: { id: string; command: UpdateProjectSettings }) =>
      updateProjectSettings(settings.project_id, op.command),
    onSuccess: (next) => {
      draft.discard();
      void invalidate.project();
      onSaved(next);
    },
    onError: (error) => {
      const kind = failureKind(error);
      if (kind !== "unconfirmed") draft.release();
      if (onStepUp(error)) return;
      if (kind === "forbidden") void invalidate.access();
      if (kind === "conflict") void invalidate.project();
    },
  });
  const name = canonical(draft.form).display_name;
  const problem =
    name !== null && name.length > 100 ? "Use at most 100 characters." : null;
  const conflict = revisionConflict(save.error);
  const locked = save.isPending || Boolean(draft.pending);

  function submit(event: FormEvent) {
    event.preventDefault();
    if (draft.pending) return save.mutate(draft.pending);
    if (problem || !draft.dirty) return;
    const staged = draft.stage((copy) => ({
      expected_revision: copy.revision,
      display_name: canonical(copy.form).display_name,
    }));
    if (staged) save.mutate(staged);
  }

  return (
    <form
      aria-label="Rename project"
      className="space-y-3"
      onSubmit={submit}
      noValidate
    >
      {draft.stale ? (
        <LandedNotice
          revision={settings.revision}
          changed={draft.landed.length ? ["the display name"] : []}
          onKeepMine={() => {
            save.reset();
            draft.keepMine();
          }}
          onLoadLatest={() => {
            save.reset();
            draft.discard();
          }}
        />
      ) : (
        conflict && <LandedNotice revision={null} changed={[]} />
      )}
      <TextField
        label="Display name"
        value={draft.form.display_name}
        disabled={locked}
        error={problem ?? undefined}
        hint="Up to 100 characters. Leave empty to show the project ID instead."
        onChange={(e) => {
          const display_name = e.target.value;
          draft.edit(() => ({ display_name }));
        }}
      />
      {save.error !== null && failureKind(save.error) === "unconfirmed" ? (
        <FormNotice tone="warning">
          The server did not confirm the rename. Retry sends the same request
          against the same revision, so it cannot overwrite another change.
        </FormNotice>
      ) : (
        save.error !== null &&
        !isStepUpRequired(save.error) && (
          <WriteFailure error={save.error} action="rename" />
        )
      )}
      <div className="flex gap-2">
        <Button
          type="submit"
          disabled={
            save.isPending ||
            Boolean(problem) ||
            (!draft.pending && !draft.dirty)
          }
        >
          {save.isPending
            ? "Saving…"
            : draft.pending
              ? "Retry rename"
              : "Save name"}
        </Button>
        {draft.dirty && !locked && (
          <Button type="button" variant="ghost" onClick={draft.discard}>
            Discard
          </Button>
        )}
      </div>
    </form>
  );
}
