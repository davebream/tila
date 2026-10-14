import { existsSync, readFileSync, writeFileSync } from "node:fs";
import {
  type DefinitionFormat,
  createSettingsReceipt,
  exportSettings,
  inspectSettingsDestination,
  planSettingsImport,
  settingsReferences,
  settingsSections,
} from "@tila/core";
import {
  readSettingsFile,
  renderSettingsFile,
} from "@tila/core/definition-yaml";
import {
  type SettingsMappings,
  SettingsMappingsSchema,
  type SettingsReceipt,
  type SettingsSection,
  SettingsSectionSchema,
} from "@tila/schemas";
import { defineCommand } from "citty";
import { createSettingsTransferMethods } from "tila-sdk";
import { requireClient, resolveContext } from "../context";
import { exit, jsonArg, outputText, printJson, rawOutput } from "../lib/output";
import { cliError } from "../lib/schema-transfer";
import {
  loadSettingsReceipt,
  saveSettingsReceipt,
  settingsReadPort,
} from "../lib/settings-transfer";

const fileArg = {
  type: "positional" as const,
  required: true as const,
  description: "Settings file (.toml, .yaml, .yml)",
};
function format(raw: string | undefined): DefinitionFormat {
  if (raw === undefined || raw === "toml") return "toml";
  if (raw === "yaml") return "yaml";
  throw cliError("invalid-argument", "--format must be toml or yaml");
}
function sections(raw?: string): SettingsSection[] {
  return raw
    ? raw.split(",").map((s) => SettingsSectionSchema.parse(s.trim()))
    : ["agents", "rooms", "signal_groups"];
}
function show(value: unknown, json: boolean) {
  if (json) printJson(value);
  else outputText(JSON.stringify(value, null, 2));
}
async function context() {
  const ctx = await resolveContext();
  const client = requireClient(ctx);
  const methods = createSettingsTransferMethods(client, ctx.config.project_id);
  const read = settingsReadPort(methods);
  return { methods, read, client, projectId: ctx.config.project_id };
}
function outcomes(receipt: SettingsReceipt) {
  return receipt.plan.actions.map((action, i) => ({
    kind: action.kind,
    resource: action.resource_id,
    ...receipt.actions[i],
  }));
}
export default defineCommand({
  meta: {
    name: "settings",
    description:
      "Explicitly transfer configured agents, rooms and signal groups with identity remapping",
  },
  subCommands: {
    export: defineCommand({
      meta: {
        name: "export",
        description:
          "Export allowlisted settings as TOML/YAML with visible caller-scoped coverage",
      },
      args: {
        ...jsonArg,
        output: {
          type: "string",
          description: "Output file; defaults to stdout",
        },
        format: {
          type: "string",
          description: "toml or yaml",
          default: "toml",
        },
        sections: {
          type: "string",
          description:
            "Comma-separated sections: agents,rooms,signal_groups,definitions",
        },
        "archived-ids": {
          type: "string",
          description: "Explicit archived agent:id or room:id selections",
        },
      },
      async run({ args }) {
        const ctx = await context();
        const doc = await exportSettings(ctx.read, ctx.projectId, {
          sections: sections(args.sections),
          archivedIds: args["archived-ids"]?.split(",").map((s) => s.trim()),
        });
        const text = renderSettingsFile(doc, format(args.format));
        if (args.output)
          writeFileSync(args.output, text, { mode: 0o600, flag: "wx" });
        if (args.json)
          printJson({
            status: "exported",
            coverage: doc.coverage,
            ...(args.output ? { file: args.output } : { text }),
          });
        else if (args.output) {
          outputText(`Exported ${args.output}`);
          outputText(JSON.stringify(doc.coverage, null, 2));
        } else rawOutput(text);
      },
    }),
    import: defineCommand({
      meta: {
        name: "import",
        description:
          "Preview and freeze a settings import; apply the saved receipt with settings resume --apply",
      },
      args: {
        ...jsonArg,
        file: fileArg,
        mappings: {
          type: "string",
          description: "Explicit mappings JSON file",
        },
        "resume-file": {
          type: "string",
          description: "Private receipt to create after a valid preview",
        },
        strategy: {
          type: "string",
          description: "Optional reviewed definitions strategy: relax or force",
        },
      },
      async run({ args }) {
        const file = readSettingsFile(readFileSync(args.file, "utf8"), {
          filename: args.file,
        });
        if (!file.ok) {
          show({ status: "blocked", errors: file.errors }, args.json);
          exit(1);
          return;
        }
        if (!args.mappings) {
          show(
            {
              status: "mapping-required",
              references: settingsReferences(file.value),
              profiles: Object.entries(file.value.settings.agents ?? {})
                .filter(([, a]) => a.profile?.state === "selected")
                .map(([id, a]) => ({ agent: id, profile: a.profile })),
              resources: {
                agents: Object.keys(file.value.settings.agents ?? {}),
                rooms: Object.keys(file.value.settings.rooms ?? {}),
                signal_groups: Object.keys(
                  file.value.settings.signal_groups ?? {},
                ),
              },
              coverage: file.value.coverage,
              hint: "Provide --mappings with explicit identity destination/drop and resource create/update/drop decisions.",
            },
            args.json,
          );
          return;
        }
        let mappings: SettingsMappings;
        try {
          mappings = SettingsMappingsSchema.parse(
            JSON.parse(readFileSync(args.mappings, "utf8")),
          );
        } catch {
          throw cliError(
            "invalid-mapping",
            "The mappings file is invalid; no writes were attempted.",
          );
        }
        if (
          args.strategy &&
          args.strategy !== "relax" &&
          args.strategy !== "force"
        )
          throw cliError(
            "invalid-argument",
            "--strategy must be relax or force",
          );
        const ctx = await context();
        const destination = await inspectSettingsDestination(
          ctx.read,
          ctx.projectId,
          settingsSections(file.value),
          mappings,
        );
        const plan = planSettingsImport(
          file.value,
          mappings,
          destination,
          crypto.randomUUID(),
          args.strategy as "relax" | "force" | undefined,
        );
        if (!plan.ok) {
          show({ status: "blocked", errors: plan.errors }, args.json);
          exit(1);
          return;
        }
        const previews = [];
        for (const action of plan.value.actions)
          if (action.kind === "definitions") {
            const preview = await ctx.client.post<{
              revision: number;
              reviewed_definition: string;
              autoApplicable: boolean;
            }>(
              `/projects/${encodeURIComponent(ctx.projectId)}/schema/preview`,
              { definition: action.payload.definition },
            );
            if (
              preview.revision !== action.expected_revision ||
              preview.reviewed_definition !== action.payload.definition
            )
              throw cliError(
                "revision-conflict",
                "Definitions changed during preview; plan again.",
              );
            if (!preview.autoApplicable && !action.payload.strategy)
              throw cliError(
                "schema-destructive",
                "Review the definition changes and supply --strategy relax or force.",
              );
            previews.push(preview);
          }
        const receipt = await createSettingsReceipt(plan.value);
        if (args["resume-file"]) {
          if (existsSync(args["resume-file"]))
            throw cliError(
              "resume-file-exists",
              "Choose a new resume file; an existing operation is never replaced by a new plan.",
            );
          saveSettingsReceipt(args["resume-file"], receipt);
        }
        show(
          {
            status: "preview",
            plan: plan.value,
            definition_previews: previews,
            ...(args["resume-file"]
              ? { resume_file: args["resume-file"] }
              : { receipt }),
            hint: "Review exact payloads and removals, then run tila settings resume <receipt> --apply [--confirm-removals].",
          },
          args.json,
        );
      },
    }),
    resume: defineCommand({
      meta: {
        name: "resume",
        description:
          "Inspect or apply a frozen receipt; retries skip committed actions",
      },
      args: {
        ...jsonArg,
        file: { ...fileArg, description: "Private settings resume receipt" },
        apply: {
          type: "boolean",
          default: false,
          description: "Apply the exact reviewed plan",
        },
        "confirm-removals": {
          type: "boolean",
          default: false,
          description: "Confirm every listed grant/member/recipient removal",
        },
      },
      async run({ args }) {
        const ctx = await context();
        const receipt = await loadSettingsReceipt(args.file, ctx.projectId);
        if (!args.apply) {
          show(
            {
              status: "preview",
              plan: receipt.plan,
              outcomes: outcomes(receipt),
            },
            args.json,
          );
          return;
        }
        const result = await ctx.methods.execute(
          receipt,
          (value) => saveSettingsReceipt(args.file, value),
          { confirmRemovals: args["confirm-removals"] },
        );
        const complete = result.actions.every((a) => a.status === "committed");
        show(
          {
            status: complete ? "complete" : "partial",
            resume_file: args.file,
            outcomes: outcomes(result),
          },
          args.json,
        );
        if (!complete) exit(1);
      },
    }),
  },
});
