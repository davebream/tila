import { StepUpBanner } from "@/components/admin/step-up-banner";
import { SettingsHeading } from "@/components/settings/settings-ui";
import { Button } from "@/components/ui/button";
import {
  FormNotice,
  SelectField,
  TextAreaField,
  TextField,
} from "@/components/ui/form-fields";
import { useAuth } from "@/hooks/use-auth";
import { useProjectRights } from "@/hooks/use-identities";
import { previewSchema } from "@/lib/api";
import { downloadText } from "@/lib/definition-transfer";
import { browserSettingsTransfer } from "@/lib/settings-transfer";
import {
  type SettingsError,
  createSettingsReceipt,
  exportSettings,
  inspectSettingsDestination,
  planSettingsImport,
  settingsReferences,
  settingsSections,
  validateSettingsReceipt,
} from "@tila/core";
import {
  SETTINGS_TRANSFER_MAX_BYTES,
  type SchemaPreviewResponse,
  type SettingsDocument,
  type SettingsMappings,
  SettingsMappingsSchema,
  type SettingsReceipt,
  type SettingsSection,
} from "@tila/schemas";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router";

const emptyMappings = (): SettingsMappings =>
  SettingsMappingsSchema.parse({ resources: {} });
type Choices = {
  principals: string[];
  agents: { id: string; name: string }[];
  rooms: { id: string; name: string }[];
  signal_groups: { id: string; name: string }[];
};
const noChoices: Choices = {
  principals: [],
  agents: [],
  rooms: [],
  signal_groups: [],
};
const SECTIONS: SettingsSection[] = [
  "agents",
  "rooms",
  "signal_groups",
  "definitions",
];

type TransferMarker = {
  project: string;
  principal: string | null;
  authenticated: boolean;
};
export function SettingsTransferPage() {
  const { project, known, whoami } = useProjectRights();
  const { isAuthenticated } = useAuth();
  const principal =
    whoami.data?.project_id === project
      ? (whoami.data.principal_id ?? null)
      : null;
  const marker = useMemo(
    () => ({ project, principal, authenticated: isAuthenticated }),
    [project, principal, isAuthenticated],
  );
  const liveMarker = useRef<TransferMarker | null>(marker);
  liveMarker.current = marker;
  useEffect(() => {
    liveMarker.current = marker;
    return () => {
      if (liveMarker.current === marker) liveMarker.current = null;
    };
  }, [marker]);
  const isCurrent = useCallback(
    (candidate: TransferMarker) => liveMarker.current === candidate,
    [],
  );
  return (
    <SettingsTransferView
      key={JSON.stringify([project, principal, isAuthenticated])}
      marker={marker}
      isCurrent={isCurrent}
      known={known}
      retryIdentity={() => {
        void whoami.refetch();
      }}
    />
  );
}
function SettingsTransferView({
  marker,
  isCurrent,
  known,
  retryIdentity,
}: {
  marker: TransferMarker;
  isCurrent: (candidate: TransferMarker) => boolean;
  known: boolean;
  retryIdentity: () => void;
}) {
  const project = marker.project;
  const principalHint = marker.principal;
  const transfer = useMemo(() => browserSettingsTransfer(project), [project]);
  const storageKey = principalHint
    ? `tila:settings-transfer:${encodeURIComponent(project)}:${encodeURIComponent(principalHint)}`
    : null;
  const [text, setText] = useState("");
  const [filename, setFilename] = useState<string>();
  const [doc, setDoc] = useState<SettingsDocument | null>(null);
  const [mappings, setMappings] = useState<SettingsMappings>(emptyMappings);
  const [choices, setChoices] = useState<Choices>(noChoices);
  const [retained, setRetained] = useState<{
    marker: typeof marker;
    receipt: SettingsReceipt | null;
  } | null>(null);
  const receipt = retained?.marker === marker ? retained.receipt : null;
  const [errors, setErrors] = useState<SettingsError[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [stepUp, setStepUp] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [strategy, setStrategy] = useState<"" | "relax" | "force">("");
  const [sections, setSections] = useState<SettingsSection[]>([
    "agents",
    "rooms",
    "signal_groups",
  ]);
  const [format, setFormat] = useState<"toml" | "yaml">("toml");
  const [definitionPreviews, setDefinitionPreviews] = useState<unknown[]>([]);
  const [identityFailure, setIdentityFailure] = useState(false);
  const [corruptSaved, setCorruptSaved] = useState(false);
  const [identityRetry, setIdentityRetry] = useState(0);
  const liveIdentityRetry = useRef(identityRetry);
  liveIdentityRetry.current = identityRetry;
  const [activeStorageKey, setActiveStorageKey] = useState<string | null>(
    storageKey,
  );
  const [restoredMarker, setRestoredMarker] = useState<typeof marker | null>(
    null,
  );
  const resumeReady = restoredMarker === marker;
  const generation = useMemo(
    () => ({
      text,
      filename,
      doc,
      mappings,
      strategy,
      marker,
      sections,
      format,
    }),
    [text, filename, doc, mappings, strategy, marker, sections, format],
  );
  const liveGeneration = useRef(generation);
  liveGeneration.current = generation;

  useEffect(() => {
    let active = true;
    const current = () =>
      active &&
      isCurrent(marker) &&
      liveIdentityRetry.current === identityRetry;
    setRestoredMarker(null);
    setRetained(null);
    setIdentityFailure(false);
    setCorruptSaved(false);
    if (!project || !principalHint || !marker.authenticated || !storageKey) {
      if (known && marker.authenticated) setIdentityFailure(true);
      return;
    }
    void (async () => {
      try {
        const identity = await transfer.read.identity();
        if (!current()) return;
        if (
          identity.project_id !== project ||
          identity.principal_id !== principalHint
        )
          throw new Error("Current identity changed");
      } catch {
        if (current()) setIdentityFailure(true);
        return;
      }
      try {
        const pointer = window.sessionStorage.getItem(`${storageKey}:active`);
        if (
          pointer &&
          (!pointer.startsWith(`${storageKey}:recovery:`) ||
            !/^[a-f0-9-]{36}$/.test(
              pointer.slice(`${storageKey}:recovery:`.length),
            ))
        )
          throw new Error("Invalid receipt slot");
        const slot = pointer ?? storageKey;
        const saved = window.sessionStorage.getItem(slot);
        const loaded = saved
          ? await validateSettingsReceipt(JSON.parse(saved), project)
          : null;
        if (
          loaded &&
          loaded.plan.creator_member !== `principal:${principalHint}`
        )
          throw new Error("Receipt belongs to another identity");
        if (current()) {
          setActiveStorageKey(slot);
          setRetained({ marker, receipt: loaded });
          setConfirmed(false);
          setRestoredMarker(marker);
        }
      } catch {
        if (current()) {
          setCorruptSaved(true);
          setRestoredMarker(marker);
          setNotice(
            "The saved receipt is invalid or unreadable. Its original contents are preserved. Explicitly open a recovery slot before importing a valid matching-account receipt or reviewing current destination state.",
          );
        }
      }
    })();
    return () => {
      active = false;
    };
  }, [
    marker,
    storageKey,
    project,
    principalHint,
    marker.authenticated,
    known,
    transfer.read.identity,
    isCurrent,
    identityRetry,
  ]);

  function recoverLocalReceipt() {
    if (!storageKey || !resumeReady || !isCurrent(marker)) return;
    const slot = `${storageKey}:recovery:${crypto.randomUUID()}`;
    window.sessionStorage.setItem(`${storageKey}:active`, slot);
    setActiveStorageKey(slot);
    setCorruptSaved(false);
    setNotice(
      "Original receipt preserved in browser storage. Import a valid receipt for this account to resume exactly, or review destination state in a new plan.",
    );
  }

  function persist(value: SettingsReceipt) {
    if (
      !resumeReady ||
      !isCurrent(marker) ||
      !activeStorageKey ||
      corruptSaved ||
      value.plan.project_id !== project ||
      value.plan.creator_member !== `principal:${principalHint}`
    )
      throw new Error("Receipt identity changed");
    window.sessionStorage.setItem(activeStorageKey, JSON.stringify(value));
    setRetained({ marker, receipt: value });
  }
  function problem(err: unknown) {
    setErrors([
      {
        code: (err as { code?: string }).code ?? "settings-unavailable",
        message:
          "The operation could not be completed. Check current destination access and connection, then retry with the retained receipt.",
      },
    ]);
  }
  const activity = useRef(0);
  async function task(
    run: (publish: (change: () => void) => boolean) => Promise<void>,
  ) {
    const taskGeneration = generation;
    const token = ++activity.current;
    const publish = (change: () => void) => {
      if (
        !isCurrent(marker) ||
        liveGeneration.current !== taskGeneration ||
        activity.current !== token
      )
        return false;
      change();
      return true;
    };
    setBusy(true);
    setErrors([]);
    setNotice(null);
    try {
      await run(publish);
    } catch (err) {
      publish(() => problem(err));
    } finally {
      if (isCurrent(marker) && activity.current === token) setBusy(false);
    }
  }
  const fieldError = (path: string) =>
    errors.find((e) => e.path === path)?.message;

  async function loadSource() {
    await task(async (publish) => {
      const { readSettingsFile } = await import("@tila/core/definition-yaml");
      const result = readSettingsFile(text, { filename });
      if (!result.ok) {
        publish(() => setErrors(result.errors));
        return;
      }
      const identity = await transfer.read.identity();
      if (
        identity.project_id !== project ||
        identity.principal_id !== principalHint
      )
        throw new Error("Current identity changed");
      const responses = await Promise.allSettled([
        transfer.read.principals(),
        transfer.read.agents(true),
        transfer.read.rooms(true),
        transfer.read.groups(),
      ]);
      const [principals, agents, rooms, groups] = responses;
      publish(() => {
        setDoc(result.value);
        setMappings(emptyMappings());
        setDefinitionPreviews([]);
        setChoices({
          principals: [
            ...new Set([
              identity.principal_id ?? "",
              ...(principals.status === "fulfilled" ? principals.value : []),
            ]),
          ].filter(Boolean),
          agents:
            agents.status === "fulfilled"
              ? agents.value.filter((a) => !a.archived)
              : [],
          rooms:
            rooms.status === "fulfilled"
              ? rooms.value.filter((r) => !r.archived)
              : [],
          signal_groups: groups.status === "fulfilled" ? groups.value : [],
        });
        if (responses.some((r) => r.status === "rejected"))
          setNotice(
            "Some destination lists are unavailable. Only readable identities/resources can be selected; choose drop or obtain access before previewing.",
          );
      });
    });
  }
  function selectIdentity(ref: string, value: string) {
    setMappings((current) => ({
      ...current,
      identities: value
        ? {
            ...current.identities,
            [ref]: value === "drop" ? { drop: true } : { target: value },
          }
        : Object.fromEntries(
            Object.entries(current.identities).filter(([key]) => key !== ref),
          ),
    }));
  }
  function selectResource(
    section: "agents" | "rooms" | "signal_groups",
    source: string,
    value: string,
  ) {
    setMappings((current) => ({
      ...current,
      resources: {
        ...current.resources,
        [section]: value
          ? {
              ...current.resources[section],
              [source]:
                value === "drop"
                  ? { drop: true }
                  : value === "create"
                    ? { mode: "create", id: "" }
                    : { mode: "update", id: value.slice(7) },
            }
          : Object.fromEntries(
              Object.entries(current.resources[section]).filter(
                ([key]) => key !== source,
              ),
            ),
      },
    }));
  }
  async function preview() {
    if (!doc || busy || !resumeReady) return;
    const reviewedGeneration = generation;
    await task(async (publish) => {
      const checked = SettingsMappingsSchema.safeParse(mappings);
      if (!checked.success) {
        publish(() =>
          setErrors(
            checked.error.issues.map((i) => ({
              code: "invalid-mapping",
              path: i.path.join("."),
              message:
                "Choose a valid destination ID/profile or explicitly drop this reference. Credentials are never permitted.",
            })),
          ),
        );
        return;
      }
      const destination = await inspectSettingsDestination(
        transfer.read,
        project,
        settingsSections(doc),
        checked.data,
      );
      const plan = planSettingsImport(
        doc,
        checked.data,
        destination,
        crypto.randomUUID(),
        strategy || undefined,
      );
      if (!plan.ok) {
        publish(() => setErrors(plan.errors));
        return;
      }
      const previews: SchemaPreviewResponse[] = [];
      for (const action of plan.value.actions)
        if (action.kind === "definitions") {
          const result = await previewSchema(
            project,
            action.payload.definition,
          );
          if (
            result.revision !== action.expected_revision ||
            result.reviewed_definition !== action.payload.definition
          ) {
            publish(() =>
              setErrors([
                {
                  code: "revision-conflict",
                  message:
                    "Definitions changed during preview. Review a new plan; nothing was written.",
                },
              ]),
            );
            return;
          }
          if (!result.autoApplicable && !strategy) {
            publish(() =>
              setErrors([
                {
                  code: "schema-destructive",
                  message:
                    "The definition preview includes destructive changes. Review the strategy selection before creating this plan.",
                },
              ]),
            );
            publish(() => setDefinitionPreviews([result]));
            return;
          }
          previews.push(result);
        }
      const frozen = await createSettingsReceipt(plan.value);
      if (liveGeneration.current !== reviewedGeneration || !isCurrent(marker))
        return;
      publish(() => {
        setDefinitionPreviews(previews);
        setConfirmed(false);
        persist(frozen);
      });
    });
  }
  async function apply() {
    if (!receipt) return;
    await task(async (publish) => {
      const result = await transfer.execute(receipt, persist, {
        confirmRemovals: confirmed,
      });
      const failure = result.actions.find((a) => a.status !== "committed");
      publish(() => {
        setStepUp(failure?.error_code === "step-up-required");
        if (failure)
          setNotice(
            `Transfer stopped at ${failure.status}${failure.error_code ? ` (${failure.error_code})` : ""}. Earlier committed actions are retained. Retry uses the original plan and keys; revision conflicts require a new review.`,
          );
        else
          setNotice(
            "Settings transfer complete. Profile selections do not start or bind a runtime.",
          );
      });
    });
  }
  async function importReceipt(file: File) {
    if (!resumeReady || busy || receipt || corruptSaved) return;
    const importMarker = marker;
    await task(async (publish) => {
      if (file.size > SETTINGS_TRANSFER_MAX_BYTES * 4)
        throw new Error("Receipt is too large");
      const identity = await transfer.read.identity();
      const loaded = await validateSettingsReceipt(
        JSON.parse(await file.text()),
        project,
      );
      if (!isCurrent(importMarker)) return;
      if (
        identity.project_id !== project ||
        identity.principal_id !== principalHint ||
        loaded.plan.creator_member !== `principal:${identity.principal_id}`
      )
        throw new Error("Receipt belongs to another identity");
      publish(() => {
        persist(loaded);
        setConfirmed(false);
        setDefinitionPreviews([]);
      });
    });
  }
  function newReview() {
    if (!activeStorageKey || !resumeReady || !isCurrent(marker) || corruptSaved)
      return;
    if (receipt)
      window.sessionStorage.setItem(
        `${activeStorageKey}:saved:${receipt.plan.operation_id}`,
        JSON.stringify(receipt),
      );
    window.sessionStorage.removeItem(activeStorageKey);
    setRetained({ marker, receipt: null });
    setConfirmed(false);
    setStepUp(false);
    setNotice(
      "Previous receipt retained in this browser session. New review reads current destination state; select existing copies explicitly for updates.",
    );
  }
  const unresolved = receipt?.actions.some((a) => a.status !== "committed");
  const locked = busy || !!receipt || !resumeReady || corruptSaved;

  return (
    <div className="space-y-6 p-3 md:p-6">
      <SettingsHeading title="Settings transfer">
        Copy configured agents, rooms and signal groups with explicit
        destination identities.{" "}
        <Link className="underline" to={`/p/${project}/settings/definitions`}>
          Definitions
        </Link>{" "}
        also have their own import/export.
      </SettingsHeading>
      {identityFailure && (
        <FormNotice>
          Current canonical identity could not be verified. Receipts stay hidden
          and operations are disabled.{" "}
          <Button
            onClick={() => {
              retryIdentity();
              setIdentityRetry((n) => n + 1);
            }}
          >
            Retry identity verification
          </Button>
        </FormNotice>
      )}
      {corruptSaved && (
        <FormNotice tone="warning">
          Saved receipt recovery is required. The original remains untouched.{" "}
          <Button onClick={recoverLocalReceipt}>
            Preserve original and open recovery slot
          </Button>
        </FormNotice>
      )}
      {notice && <FormNotice tone="info">{notice}</FormNotice>}
      {errors.length > 0 && (
        <FormNotice>
          <ul className="list-disc pl-5">
            {errors.map((e, i) => (
              <li key={`${e.code}:${e.path}:${i}`}>
                {e.path ? `${e.path}: ` : ""}
                {e.message}
              </li>
            ))}
          </ul>
        </FormNotice>
      )}
      {stepUp && (
        <StepUpBanner
          onDismiss={() => setStepUp(false)}
          description="The transfer stopped for re-authentication. Its exact plan and committed outcomes are retained; resume after signing in."
          onBeforeSignIn={() => {
            if (!receipt) return false;
            try {
              persist(receipt);
              return true;
            } catch {
              setNotice(
                "Could not save the receipt. Download it before signing in.",
              );
              return false;
            }
          }}
        />
      )}
      <section
        aria-label="Export settings"
        className="space-y-3 rounded-lg border p-4"
      >
        <h2 className="text-lg">Export settings</h2>
        <fieldset
          disabled={busy || !resumeReady}
          className="flex flex-wrap gap-4"
        >
          <legend className="text-sm">Sections to export</legend>
          {SECTIONS.map((section) => (
            <label key={section}>
              <input
                type="checkbox"
                checked={sections.includes(section)}
                onChange={(e) =>
                  setSections((current) =>
                    e.target.checked
                      ? [...current, section]
                      : current.filter((s) => s !== section),
                  )
                }
              />{" "}
              {section.replaceAll("_", " ")}
            </label>
          ))}
        </fieldset>
        <SelectField
          disabled={busy || !resumeReady}
          label="Export format"
          value={format}
          options={[
            { value: "toml", label: "TOML" },
            { value: "yaml", label: "YAML" },
          ]}
          onChange={(e) => setFormat(e.target.value as "toml" | "yaml")}
        />
        <Button
          disabled={busy || !known || !project || !resumeReady || corruptSaved}
          onClick={() =>
            task(async (publish) => {
              const identity = await transfer.read.identity();
              if (
                identity.project_id !== project ||
                identity.principal_id !== principalHint
              )
                throw new Error("Current identity changed");
              const exported = await exportSettings(transfer.read, project, {
                sections,
              });
              const { renderSettingsFile } = await import(
                "@tila/core/definition-yaml"
              );
              publish(() => {
                downloadText(
                  renderSettingsFile(exported, format),
                  `${project}-settings.${format}`,
                );
                setNotice(
                  `Export coverage: ${Object.entries(exported.coverage)
                    .map(
                      ([s, c]) =>
                        `${s}: ${c.status} (${c.scope}${c.unavailable_fields.length ? ", hidden fields omitted" : ""})`,
                    )
                    .join("; ")}.`,
                );
              });
            })
          }
        >
          Export selected settings
        </Button>
      </section>
      {!receipt && (
        <section
          aria-label="Import settings"
          className="space-y-3 rounded-lg border p-4"
        >
          <h2 className="text-lg">Import settings</h2>
          <TextField
            disabled={locked}
            label="Settings file"
            type="file"
            accept=".toml,.yaml,.yml"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (!file) return;
              void task(async (publish) => {
                if (file.size > SETTINGS_TRANSFER_MAX_BYTES)
                  throw new Error("Settings file is too large");
                const sourceText = await file.text();
                publish(() => {
                  setText(sourceText);
                  setFilename(file.name);
                  setDoc(null);
                });
              });
            }}
          />
          <TextAreaField
            disabled={locked}
            label="Or paste settings"
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              setFilename(undefined);
              setDoc(null);
            }}
          />
          <Button disabled={locked || !text.trim()} onClick={loadSource}>
            Read file and choose mappings
          </Button>
          {doc && (
            <>
              <p className="text-sm">
                Source {doc.tila_export.project_id}; destination {project}.
                Source IDs and revisions are labels only. Omitted resources and
                hidden fields are retained.
              </p>
              <details>
                <summary>Source coverage</summary>
                <pre className="overflow-auto text-xs">
                  {JSON.stringify(doc.coverage, null, 2)}
                </pre>
              </details>
              {(["agents", "rooms", "signal_groups"] as const).map((section) =>
                Object.keys(doc.settings[section] ?? {}).map((source) => {
                  const choice = mappings.resources[section][source];
                  return (
                    <fieldset
                      key={`${section}:${source}`}
                      className="space-y-2 rounded border p-3"
                    >
                      <legend>
                        {section.replaceAll("_", " ")}: {source}
                      </legend>
                      <SelectField
                        disabled={locked}
                        label={`Destination for ${section} ${source}`}
                        placeholder="Choose create, existing destination or drop"
                        value={
                          choice
                            ? "drop" in choice
                              ? "drop"
                              : choice.mode === "create"
                                ? "create"
                                : `update:${choice.id}`
                            : ""
                        }
                        options={[
                          {
                            value: "create",
                            label: "Create a new destination resource",
                          },
                          ...choices[section].map((r) => ({
                            value: `update:${r.id}`,
                            label: `Update ${r.name} (${r.id})`,
                          })),
                          {
                            value: "drop",
                            label: "Drop this resource from the import",
                          },
                        ]}
                        onChange={(e) =>
                          selectResource(section, source, e.target.value)
                        }
                        error={fieldError(`${section}.${source}`)}
                      />
                      {choice && "id" in choice && choice.mode === "create" && (
                        <TextField
                          disabled={locked}
                          label={`New destination ID for ${source}`}
                          value={choice.id}
                          error={fieldError(
                            `resources.${section}.${source}.id`,
                          )}
                          onChange={(e) =>
                            setMappings((current) => ({
                              ...current,
                              resources: {
                                ...current.resources,
                                [section]: {
                                  ...current.resources[section],
                                  [source]: {
                                    mode: "create",
                                    id: e.target.value,
                                  },
                                },
                              },
                            }))
                          }
                        />
                      )}
                    </fieldset>
                  );
                }),
              )}
              <fieldset className="space-y-3">
                <legend className="text-lg">Identity references</legend>
                {settingsReferences(doc).map((ref) => {
                  const choice = mappings.identities[ref];
                  const targets = ref.startsWith("principal:")
                    ? choices.principals.map((id) => ({ value: id, label: id }))
                    : [
                        ...new Set([
                          ...choices.agents.map((a) => a.id),
                          ...Object.values(mappings.resources.agents).flatMap(
                            (a) => ("id" in a && a.id ? [a.id] : []),
                          ),
                        ]),
                      ].map((id) => ({ value: id, label: id }));
                  return (
                    <SelectField
                      disabled={locked}
                      key={ref}
                      label={`Destination for ${ref}`}
                      placeholder="Choose a destination identity or drop"
                      value={
                        choice
                          ? "drop" in choice
                            ? "drop"
                            : choice.target
                          : ""
                      }
                      options={[
                        ...targets,
                        {
                          value: "drop",
                          label: "Drop this grant/member/recipient reference",
                        },
                      ]}
                      error={fieldError(ref)}
                      onChange={(e) => selectIdentity(ref, e.target.value)}
                    />
                  );
                })}
              </fieldset>
              {Object.entries(doc.settings.agents ?? {})
                .filter(([, a]) => a.profile?.state === "selected")
                .map(([source]) => {
                  const choice = mappings.profiles[source];
                  return (
                    <fieldset
                      key={source}
                      className="space-y-2 rounded border p-3"
                    >
                      <legend>Profile selection for {source}</legend>
                      <SelectField
                        disabled={locked}
                        label={`Destination profile decision for ${source}`}
                        placeholder="Select explicitly or drop"
                        value={
                          choice ? ("drop" in choice ? "drop" : "select") : ""
                        }
                        options={[
                          {
                            value: "select",
                            label:
                              "Select a destination profile (verification pending)",
                          },
                          {
                            value: "drop",
                            label: "Drop the profile selection",
                          },
                        ]}
                        error={fieldError(`agents.${source}.profile`)}
                        onChange={(e) =>
                          setMappings((current) => ({
                            ...current,
                            profiles: e.target.value
                              ? {
                                  ...current.profiles,
                                  [source]:
                                    e.target.value === "drop"
                                      ? { drop: true }
                                      : {
                                          selection: {
                                            profile_id: "",
                                            host_ref: null,
                                            account_ref: null,
                                          },
                                        },
                                }
                              : Object.fromEntries(
                                  Object.entries(current.profiles).filter(
                                    ([key]) => key !== source,
                                  ),
                                ),
                          }))
                        }
                      />
                      {choice &&
                        "selection" in choice &&
                        (
                          ["profile_id", "host_ref", "account_ref"] as const
                        ).map((field) => (
                          <TextField
                            disabled={locked}
                            key={field}
                            label={`${source} destination ${field.replaceAll("_", " ")}`}
                            value={choice.selection[field] ?? ""}
                            error={fieldError(
                              `profiles.${source}.selection.${field}`,
                            )}
                            onChange={(e) =>
                              setMappings((current) => ({
                                ...current,
                                profiles: {
                                  ...current.profiles,
                                  [source]: {
                                    selection: {
                                      ...choice.selection,
                                      [field]:
                                        e.target.value ||
                                        (field === "profile_id" ? "" : null),
                                    },
                                  },
                                },
                              }))
                            }
                          />
                        ))}
                      <p className="text-xs text-muted-foreground">
                        Host/account/profile references are selected for this
                        destination. Live verification is pending when
                        unavailable; saving does not start or bind a runtime.
                      </p>
                    </fieldset>
                  );
                })}
              {doc.definitions && (
                <SelectField
                  disabled={locked}
                  label="Definitions strategy"
                  value={strategy}
                  placeholder="Stop if destructive changes need review"
                  options={[
                    {
                      value: "relax",
                      label: "Relax after reviewing definition changes",
                    },
                    {
                      value: "force",
                      label: "Force after reviewing definition changes",
                    },
                  ]}
                  onChange={(e) =>
                    setStrategy(e.target.value as typeof strategy)
                  }
                />
              )}
              {definitionPreviews.length > 0 && (
                <pre className="overflow-auto text-xs">
                  {JSON.stringify(definitionPreviews, null, 2)}
                </pre>
              )}
              <Button disabled={busy} onClick={preview}>
                Preview complete import
              </Button>
            </>
          )}
        </section>
      )}
      <section
        aria-label="Resume settings transfer"
        className="space-y-3 rounded-lg border p-4"
      >
        <TextField
          label="Load a resume receipt"
          type="file"
          accept=".json"
          disabled={busy || !!receipt || !resumeReady || corruptSaved}
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void importReceipt(file);
          }}
        />
        {receipt && (
          <>
            <h2 className="text-lg">
              Reviewed import for {receipt.plan.project_id}
            </h2>
            {receipt.plan.warnings.map((w) => (
              <p key={w} className="text-sm">
                {w}
              </p>
            ))}
            <ol className="space-y-3">
              {receipt.plan.actions.map((a, i) => (
                <li key={a.id} className="rounded border p-3">
                  <p>
                    {a.kind}: {a.resource_id} · {receipt.actions[i].status}
                    {receipt.actions[i].revision !== undefined
                      ? ` (committed revision ${receipt.actions[i].revision})`
                      : ""}
                    {receipt.actions[i].error_code
                      ? ` · ${receipt.actions[i].error_code}`
                      : ""}
                  </p>
                  <pre className="overflow-auto whitespace-pre-wrap text-xs">
                    {JSON.stringify(a.payload, null, 2)}
                  </pre>
                  <p className="text-xs">
                    {a.revision_from
                      ? "Uses the preceding committed resource revision"
                      : a.expected_revision !== undefined
                        ? `Reviewed destination revision ${a.expected_revision}`
                        : "Stable ID create with exact initial state reconciliation"}
                  </p>
                </li>
              ))}
            </ol>
            {definitionPreviews.length > 0 && (
              <details>
                <summary>Definitions preview</summary>
                <pre className="overflow-auto text-xs">
                  {JSON.stringify(definitionPreviews, null, 2)}
                </pre>
              </details>
            )}
            {receipt.plan.removals.length > 0 && (
              <fieldset>
                <legend>Reviewed removals</legend>
                <ul className="list-disc pl-5">
                  {receipt.plan.removals.map((r) => (
                    <li key={r}>{r}</li>
                  ))}
                </ul>
                <label>
                  <input
                    type="checkbox"
                    checked={confirmed}
                    onChange={(e) => setConfirmed(e.target.checked)}
                  />{" "}
                  Confirm every listed grant/member/recipient removal
                </label>
              </fieldset>
            )}
            <div className="flex flex-wrap gap-2">
              <Button
                disabled={busy}
                onClick={() =>
                  downloadText(
                    JSON.stringify(receipt, null, 2),
                    `${project}-settings-resume.json`,
                  )
                }
              >
                Download resume receipt
              </Button>
              <Button
                disabled={
                  busy ||
                  !unresolved ||
                  (receipt.plan.removals.length > 0 && !confirmed)
                }
                onClick={apply}
              >
                {receipt.actions.every((a) => a.status === "not-attempted")
                  ? "Apply reviewed import"
                  : "Resume unresolved actions"}
              </Button>
              <Button variant="outline" disabled={busy} onClick={newReview}>
                Start a new review
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              The frozen receipt contains no credentials. It survives reload and
              sign-in in this browser session. Download a copy to resume
              elsewhere; committed actions are skipped and stale revisions are
              retained.
            </p>
          </>
        )}
      </section>
    </div>
  );
}
