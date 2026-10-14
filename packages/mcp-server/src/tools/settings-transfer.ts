import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  type SettingsReadPort,
  appliedSettingsDefinition,
  createSettingsReceipt,
  exportSettings,
  inspectSettingsDestination,
  planSettingsImport,
  settingsReferences,
  settingsSections,
  validateSettingsReceipt,
} from "@tila/core";
import {
  readSettingsFile,
  renderSettingsFile,
} from "@tila/core/definition-yaml";
import {
  SettingsMappingsSchema,
  type SettingsReceipt,
  SettingsReceiptSchema,
  SettingsSectionSchema,
} from "@tila/schemas";
import type { TilaFacade } from "tila-sdk";
import { z } from "zod";
import { registerPrimitiveTool } from "../tool-registration";
const result = (value: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(value) }],
});
const fail = (code: string, message: string): never => {
  throw Object.assign(new Error(message), { code });
};
export function registerSettingsTransferTools(
  server: McpServer,
  facade: TilaFacade,
  projectId: string,
) {
  const methods = () =>
    facade.settingsTransfer ??
    fail(
      "unsupported-backend",
      "Settings transfer requires the Cloudflare backend.",
    );
  const readPort = (): SettingsReadPort => ({
    ...methods().read,
    definitions: async () =>
      appliedSettingsDefinition(await methods().read.definitions()),
  });
  registerPrimitiveTool(
    server,
    "tila_settings_export",
    "Export allowlisted configured settings as TOML/YAML with explicit caller-scoped coverage. Failed reads abort. Credentials, runtime/content/access configuration are excluded. Definitions remain optional and separate.",
    {
      format: z.enum(["toml", "yaml"]).default("toml"),
      sections: z
        .array(SettingsSectionSchema)
        .default(["agents", "rooms", "signal_groups"]),
      archived_ids: z.array(z.string()).default([]),
    },
    async ({ format, sections, archived_ids }) => {
      const doc = await exportSettings(readPort(), projectId, {
        sections,
        archivedIds: archived_ids,
      });
      return result({
        status: "exported",
        format,
        text: renderSettingsFile(doc, format),
        coverage: doc.coverage,
      });
    },
  );
  registerPrimitiveTool(
    server,
    "tila_settings_import",
    "Preview and freeze a settings import without writing. Every identity/resource/profile needs explicit destination or drop. Return and retain the non-secret receipt unchanged before calling tila_settings_resume with apply:true. Hidden fields/omitted resources stay; removals need explicit confirmation.",
    {
      text: z.string(),
      format: z.enum(["toml", "yaml", "detect"]).default("detect"),
      mappings: SettingsMappingsSchema.optional(),
      strategy: z.enum(["relax", "force"]).optional(),
    },
    async ({ text, format, mappings, strategy }) => {
      const file = readSettingsFile(text, {
        format: format === "detect" ? "auto" : format,
      });
      if (!file.ok)
        return fail(
          file.errors[0]?.code ?? "settings-format",
          "Settings file rejected. Correct the format/coverage and remove credential-bearing content.",
        );
      if (!mappings)
        return result({
          status: "mapping-required",
          references: settingsReferences(file.value),
          profile_references: Object.entries(file.value.settings.agents ?? {})
            .filter(([, a]) => a.profile?.state === "selected")
            .map(([id]) => id),
          resource_ids: {
            agents: Object.keys(file.value.settings.agents ?? {}),
            rooms: Object.keys(file.value.settings.rooms ?? {}),
            signal_groups: Object.keys(file.value.settings.signal_groups ?? {}),
          },
          coverage: file.value.coverage,
        });
      const snapshot = await inspectSettingsDestination(
        readPort(),
        projectId,
        settingsSections(file.value),
        mappings,
      );
      const plan = planSettingsImport(
        file.value,
        mappings,
        snapshot,
        crypto.randomUUID(),
        strategy,
      );
      if (!plan.ok) return result({ status: "blocked", errors: plan.errors });
      const definition_previews = [];
      for (const action of plan.value.actions)
        if (action.kind === "definitions") {
          const preview = await facade.schema.preview(
            action.payload.definition,
          );
          if (
            preview.revision !== action.expected_revision ||
            preview.reviewed_definition !== action.payload.definition
          )
            fail(
              "revision-conflict",
              "Definitions changed during preview. Review a new plan.",
            );
          if (!preview.autoApplicable && !strategy)
            fail(
              "schema-destructive",
              "Review definition changes and select a strategy before retaining a plan.",
            );
          definition_previews.push(preview);
        }
      return result({
        status: "preview",
        receipt: await createSettingsReceipt(plan.value),
        definition_previews,
      });
    },
  );
  registerPrimitiveTool(
    server,
    "tila_settings_resume",
    "Inspect or apply an explicit retained settings receipt. apply:true sends only unresolved actions, persisting their exact IDs/revisions before calls. Confirm listed removals. Authorization is checked again; conflicts never rebase, prior commits remain. Retain the returned receipt for the next retry.",
    {
      receipt: SettingsReceiptSchema,
      apply: z.boolean().default(false),
      confirm_removals: z.boolean().default(false),
    },
    async ({ receipt, apply, confirm_removals }) => {
      let retained: SettingsReceipt = await validateSettingsReceipt(
        receipt,
        projectId,
      );
      if (!apply) return result({ status: "preview", receipt: retained });
      try {
        retained = await methods().execute(
          retained,
          (value) => {
            retained = value;
          },
          { confirmRemovals: confirm_removals },
        );
        return result({
          status: retained.actions.every((a) => a.status === "committed")
            ? "complete"
            : "partial",
          receipt: retained,
        });
      } catch (error) {
        const code = (error as { code?: unknown }).code;
        return result({
          status: "blocked",
          receipt: retained,
          error_code:
            typeof code === "string" && /^[a-zA-Z0-9._-]{1,80}$/.test(code)
              ? code
              : "preflight-rejected",
        });
      }
    },
  );
}
