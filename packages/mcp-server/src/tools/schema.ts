import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  type DefinitionTransferError,
  currentDefinition,
  isTable,
  planDefinitionImport,
  readTomlDefinition,
} from "@tila/core";
import {
  readDefinitionFile,
  renderDefinitionExport,
} from "@tila/core/definition-yaml";
import {
  McpDefinitionReviewSchema,
  type SchemaGetResponse,
} from "@tila/schemas";
import type { TilaFacade } from "tila-sdk";
import { z } from "zod";
import { toMcpError } from "../errors";
import { registerPrimitiveTool } from "../tool-registration";

function failure(code: string, message: string): never {
  throw Object.assign(new Error(message), { code });
}

function invalid(errors: DefinitionTransferError[]): never {
  // Syntax errors can quote source; definition text must not leak in diagnostics.
  const code = errors[0]?.code ?? "invalid-definition";
  return failure(code, `Definition transfer rejected (${code}).`);
}

function definitionResult(value: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value) }] };
}

/** Unwrap the SDK envelope; core handles stored TOML and legacy JSON text. */
function appliedDefinition(response: SchemaGetResponse) {
  const revision = response.revision ?? response.version ?? 0;
  const stored = response.schema;
  if (stored === null || stored === undefined)
    return currentDefinition({
      version: response.version,
      revision,
      definition: null,
    });
  if (typeof stored === "string")
    return currentDefinition({
      version: response.version,
      revision,
      definition: stored,
    });
  if (!isTable(stored) || typeof stored.definition !== "string")
    return failure(
      "schema-corrupt",
      "The applied definition could not be read.",
    );
  return currentDefinition({
    version: response.version,
    revision,
    definition: stored.definition,
    applied_at:
      typeof stored.applied_at === "number" ? stored.applied_at : null,
  });
}

export function registerSchemaTools(
  server: McpServer,
  facade: TilaFacade,
  projectId: string,
): void {
  const schema = facade.schema;

  registerPrimitiveTool(
    server,
    "tila_schema_update",
    "Apply a full TOML schema definition. Preview first and supply expected_revision to reject stale writes. Revisionless applies are deprecated and return warnings; managed projects require a revision. Returns the version, changes and compatibility warnings.",
    {
      expected_revision: z.number().int().nonnegative().optional(),
      reviewed_definition: z.string().optional(),
      idempotency_key: z.string().min(1).max(256).optional(),
      definition: z.string().describe("Full TOML schema definition string"),
      strategy: z
        .enum(["relax", "force"])
        .optional()
        .describe("Migration strategy when destructive changes are detected"),
    },
    async ({
      definition,
      strategy,
      expected_revision,
      reviewed_definition,
      idempotency_key,
    }) => {
      try {
        const options = {
          expected_revision,
          reviewed_definition,
          idempotency_key,
        };
        const result = Object.values(options).some(
          (value) => value !== undefined,
        )
          ? await schema.apply(definition, strategy, options)
          : await schema.apply(definition, strategy);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result) }],
        };
      } catch (err) {
        throw toMcpError(err);
      }
    },
  );
  registerPrimitiveTool(
    server,
    "tila_schema_preview",
    "Preview configuration changes and obtain a revision and reviewed definition for a conditional apply.",
    { definition: z.string() },
    async ({ definition }) => {
      try {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(await schema.preview(definition)),
            },
          ],
        };
      } catch (err) {
        throw toMcpError(err);
      }
    },
  );

  registerPrimitiveTool(
    server,
    "tila_schema_import",
    "Plan a TOML/YAML definition import (merge by default) without writing. To apply, retain reviewed_plan unchanged and pass apply:true plus its expected_revision. Replace removals require confirm_removals:true; destructive changes require strategy. Retry with the original reviewed_plan, revision and idempotency_key; stale requests never rebase.",
    {
      text: z.string().describe("Definition file contents"),
      format: z.enum(["toml", "yaml", "detect"]).default("detect"),
      mode: z.enum(["merge", "replace"]).default("merge"),
      apply: z.boolean().default(false),
      expected_revision: z.number().int().nonnegative().optional(),
      reviewed_plan: McpDefinitionReviewSchema.optional(),
      confirm_removals: z.boolean().default(false),
      strategy: z.enum(["relax", "force"]).optional(),
      idempotency_key: z.string().min(1).max(256).optional(),
    },
    async ({
      text,
      format,
      mode,
      apply,
      expected_revision,
      reviewed_plan,
      confirm_removals,
      strategy,
      idempotency_key,
    }) => {
      const file = readDefinitionFile(text, {
        format: format === "detect" ? "auto" : format,
      });
      if (!file.ok) invalid(file.errors);

      if (apply) {
        if (expected_revision === undefined)
          failure(
            "schema-revision-required",
            "Apply requires expected_revision from the reviewed plan.",
          );
        if (!reviewed_plan)
          failure(
            "schema-review-required",
            "Apply requires the unchanged reviewed_plan returned by this tool.",
          );
        if (reviewed_plan.revision !== expected_revision)
          failure(
            "schema-review-mismatch",
            "expected_revision must match the reviewed plan.",
          );
        const reviewed = readTomlDefinition(reviewed_plan.definition);
        if (!reviewed.ok) invalid(reviewed.errors);
        if (reviewed.metadata)
          failure(
            "schema-review-mismatch",
            "The reviewed definition must be the planned TOML without export metadata.",
          );
        // Check the file against the retained result, without using newer project
        // state. This also guards malformed/oversize/secret-bearing review text.
        const retained = planDefinitionImport(reviewed.doc, file.doc, mode);
        if (!retained.ok) invalid(retained.errors);
        if (retained.source !== reviewed_plan.definition)
          failure(
            "schema-review-mismatch",
            "The file does not match the reviewed definition. Plan and review again.",
          );
        if (reviewed_plan.removed.length > 0 && !confirm_removals)
          failure(
            "removals-not-confirmed",
            "Review the removed units and pass confirm_removals:true.",
          );
      }

      const response = await schema.get();
      const revision = response.revision ?? response.version ?? 0;
      if (apply && reviewed_plan && expected_revision !== revision) {
        if (!idempotency_key)
          failure(
            "schema-revision-conflict",
            `The project is at revision ${revision}; plan and review again.`,
          );
        // The server checks receipts before the revision precondition. Send the
        // original request unchanged: a lost response can replay, while a fresh
        // stale request still conflicts in the server transaction. Never replan.
        const application = await schema.apply(
          reviewed_plan.definition,
          strategy,
          {
            expected_revision,
            reviewed_definition: reviewed_plan.definition,
            idempotency_key,
          },
        );
        return definitionResult({
          status: "applied",
          reviewed_plan,
          application,
        });
      }

      const current = appliedDefinition(response);
      const plan = planDefinitionImport(current.doc, file.doc, mode, {
        currentSource: current.source ?? undefined,
        metadata: file.metadata,
        projectId,
        revision: current.revision,
      });
      if (!plan.ok) invalid(plan.errors);
      const preview = await schema.preview(plan.source);
      if (preview.revision !== current.revision)
        failure(
          "schema-revision-conflict",
          "The definitions changed during preview. Plan and review again.",
        );
      if (preview.reviewed_definition !== plan.source)
        failure(
          "schema-review-mismatch",
          "The server preview differs from the planned definition. Plan and review again.",
        );
      const review = {
        revision: preview.revision,
        definition: preview.reviewed_definition,
        removed: plan.units.removed,
      };
      if (!apply)
        return definitionResult({
          status: "preview",
          format: file.format,
          mode,
          units: plan.units,
          warnings: plan.warnings,
          noChange: plan.noChange,
          reviewed_plan: review,
          preview,
        });

      if (!reviewed_plan)
        failure("schema-review-required", "Apply requires reviewed_plan.");
      if (
        reviewed_plan.definition !== review.definition ||
        JSON.stringify(reviewed_plan.removed) !== JSON.stringify(review.removed)
      )
        failure(
          "schema-review-mismatch",
          "The reviewed plan differs from this import. Plan and review again.",
        );
      if (review.removed.length > 0 && !confirm_removals)
        failure(
          "removals-not-confirmed",
          "Review the removed units and pass confirm_removals:true.",
        );
      if (!preview.autoApplicable && !strategy)
        failure(
          "schema-destructive",
          "The preview lists destructive changes. Review them and pass strategy:relax or strategy:force.",
        );
      const application = await schema.apply(
        reviewed_plan.definition,
        strategy,
        {
          expected_revision,
          reviewed_definition: reviewed_plan.definition,
          ...(idempotency_key ? { idempotency_key } : {}),
        },
      );
      return definitionResult({
        status: "applied",
        reviewed_plan,
        application,
      });
    },
  );

  registerPrimitiveTool(
    server,
    "tila_schema_export",
    "Export the applied definition as TOML or YAML with tila_export provenance. Definitions only; settings, identities and stored data are excluded. Returns status:empty when no definition is applied.",
    { format: z.enum(["toml", "yaml"]).default("toml") },
    async ({ format }) => {
      const current = appliedDefinition(await schema.get());
      if (current.source === null)
        return definitionResult({
          status: "empty",
          revision: current.revision,
          format,
          text: null,
          verbatim_paths: [],
        });
      const rendered = renderDefinitionExport(
        {
          source: current.source,
          projectId,
          revision: current.revision,
          appliedAt: current.appliedAt,
        },
        format,
      );
      if (!rendered.ok) invalid(rendered.errors);
      return definitionResult({
        status: "exported",
        revision: current.revision,
        format,
        text: rendered.text,
        verbatim_paths: rendered.verbatimPaths,
      });
    },
  );
}
