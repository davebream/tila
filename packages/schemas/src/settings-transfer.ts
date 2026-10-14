import { z } from "zod";
import {
  AgentIdSchema,
  AgentProfileSelectionSchema,
  AgentRegistrationSchema,
  UpdateAgentSchema,
} from "./agent";
import { CreateRoomSchema, UpdateRoomSchema } from "./conversation";
import { containsCredentialValue } from "./credential-patterns";
import { SetSignalGroupRequestSchema, SignalGroupIdSchema } from "./signal";

export const SETTINGS_TRANSFER_FORMAT = "tila-project-settings";
export const SETTINGS_TRANSFER_VERSION = 1;
export const SETTINGS_TRANSFER_MAX_BYTES = 1_048_576;
export const SettingsSectionSchema = z.enum([
  "definitions",
  "agents",
  "rooms",
  "signal_groups",
]);
export const SettingsCoverageSchema = z
  .object({
    status: z.enum(["read", "omitted", "unavailable", "failed"]),
    // Visibility is scoped to the caller; listing rooms never proves a full roster.
    scope: z.enum(["project", "visible"]),
    unavailable_fields: z.array(z.string()).default([]),
  })
  .strict();
const provenance = {
  source_revision: z.number().int().nonnegative(),
  archived: z.boolean(),
};
const ProfileReferenceSchema = AgentProfileSelectionSchema.omit({
  host_ref: true,
  account_ref: true,
})
  .extend({
    host_ref: z.string().min(1).max(256).optional(),
    account_ref: z.string().min(1).max(256).optional(),
  })
  .strict();
export const SettingsAgentSchema = z
  .object({
    ...provenance,
    name: AgentRegistrationSchema.shape.name,
    bind_policy: AgentRegistrationSchema.shape.bind_policy
      .removeDefault()
      .optional(),
    // An absent selection means hidden. `none` means visibly unconfigured.
    profile: z
      .union([
        z.object({ state: z.literal("none") }).strict(),
        z
          .object({
            state: z.literal("selected"),
            selection: ProfileReferenceSchema,
          })
          .strict(),
      ])
      .optional(),
  })
  .strict();
export const SettingsRoomSchema = CreateRoomSchema.omit({ id: true })
  .extend({
    ...provenance,
    members: z
      .array(
        z
          .object({
            member: z
              .string()
              .regex(/^(agent|principal):.+$/)
              .max(256),
            wake: z.boolean(),
          })
          .strict(),
      )
      .optional(),
  })
  .strict();
export const SettingsGroupSchema = SetSignalGroupRequestSchema.omit({
  expected_revision: true,
})
  .extend({
    source_revision: z.number().int().nonnegative(),
  })
  .strict();
export const SettingsDocumentSchema = z
  .object({
    tila_export: z
      .object({
        format: z.literal(SETTINGS_TRANSFER_FORMAT),
        format_version: z.literal(SETTINGS_TRANSFER_VERSION),
        project_id: z.string().min(1),
        exported_at: z.string().datetime(),
        definition_revision: z.number().int().nonnegative().optional(),
      })
      .strict(),
    coverage: z
      .object({
        definitions: SettingsCoverageSchema,
        agents: SettingsCoverageSchema,
        rooms: SettingsCoverageSchema,
        signal_groups: SettingsCoverageSchema,
      })
      .strict(),
    definitions: z.record(z.string(), z.unknown()).optional(),
    settings: z
      .object({
        agents: z.record(AgentIdSchema, SettingsAgentSchema).optional(),
        rooms: z.record(AgentIdSchema, SettingsRoomSchema).optional(),
        signal_groups: z
          .record(SignalGroupIdSchema, SettingsGroupSchema)
          .optional(),
      })
      .strict(),
  })
  .strict();
const DropSchema = z.object({ drop: z.literal(true) }).strict();
export const SettingsMappingsSchema = z
  .object({
    identities: z
      .record(
        z.string(),
        z.union([DropSchema, z.object({ target: z.string().min(1) }).strict()]),
      )
      .default({}),
    profiles: z
      .record(
        z.string(),
        z.union([
          DropSchema,
          z
            .object({
              selection: AgentProfileSelectionSchema,
            })
            .strict(),
        ]),
      )
      .default({}),
    resources: z
      .object({
        agents: z
          .record(
            AgentIdSchema,
            z.union([
              DropSchema,
              z
                .object({
                  id: AgentIdSchema,
                  mode: z.enum(["create", "update"]),
                })
                .strict(),
            ]),
          )
          .default({}),
        rooms: z
          .record(
            AgentIdSchema,
            z.union([
              DropSchema,
              z
                .object({
                  id: AgentIdSchema,
                  mode: z.enum(["create", "update"]),
                })
                .strict(),
            ]),
          )
          .default({}),
        signal_groups: z
          .record(
            SignalGroupIdSchema,
            z.union([
              DropSchema,
              z
                .object({
                  id: SignalGroupIdSchema,
                  mode: z.enum(["create", "update"]),
                })
                .strict(),
            ]),
          )
          .default({}),
      })
      .strict(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (containsCredentialValue(value))
      ctx.addIssue({
        code: "custom",
        message: "Mappings must not contain credential-shaped content.",
      });
  });
const actionBase = {
  id: z.string().min(1).max(256),
  resource_id: z.string().min(1),
  expected_revision: z.number().int().nonnegative().optional(),
  // Follow exactly this committed action, never a freshly fetched revision.
  revision_from: z.string().optional(),
};
export const SettingsActionSchema = z.discriminatedUnion("kind", [
  z
    .object({
      ...actionBase,
      kind: z.literal("definitions"),
      payload: z
        .object({
          definition: z.string(),
          strategy: z.enum(["relax", "force"]).optional(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...actionBase,
      kind: z.literal("agent.create"),
      payload: AgentRegistrationSchema,
    })
    .strict(),
  z
    .object({
      ...actionBase,
      kind: z.literal("agent.update"),
      payload: z
        .object({
          name: UpdateAgentSchema.shape.name,
          bind_policy: UpdateAgentSchema.shape.bind_policy,
          profile_selection: UpdateAgentSchema.shape.profile_selection,
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...actionBase,
      kind: z.literal("room.create"),
      payload: CreateRoomSchema,
    })
    .strict(),
  z
    .object({
      ...actionBase,
      kind: z.literal("room.update"),
      payload: z
        .object({
          name: UpdateRoomSchema.shape.name,
          history_policy: UpdateRoomSchema.shape.history_policy,
          delivery_ttl_seconds: UpdateRoomSchema.shape.delivery_ttl_seconds,
          budgets: UpdateRoomSchema.shape.budgets,
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...actionBase,
      kind: z.literal("room.member"),
      payload: z
        .object({
          member: z
            .string()
            .regex(/^(agent|principal):.+$/)
            .max(256),
          wake: z.boolean().nullable(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...actionBase,
      kind: z.literal("group.set"),
      payload: SetSignalGroupRequestSchema.omit({
        expected_revision: true,
      }).strict(),
    })
    .strict(),
]);
export const SettingsPlanSchema = z
  .object({
    format: z.literal("tila-settings-plan"),
    version: z.literal(1),
    operation_id: z.string().uuid(),
    project_id: z.string().min(1),
    creator_member: z.string().regex(/^(agent|principal):.+$/),
    mappings: SettingsMappingsSchema,
    actions: z.array(SettingsActionSchema),
    references: z.array(z.string()),
    removals: z.array(z.string()),
    warnings: z.array(z.string()),
    coverage: SettingsDocumentSchema.shape.coverage,
  })
  .strict();
export const SettingsActionReceiptSchema = z
  .object({
    action_id: z.string(),
    status: z.enum(["committed", "failed", "not-attempted", "uncertain"]),
    revision: z.number().int().nonnegative().optional(),
    sent_revision: z.number().int().nonnegative().optional(),
    error_code: z.string().optional(),
  })
  .strict();
export const SettingsReceiptSchema = z
  .object({
    format: z.literal("tila-settings-receipt"),
    version: z.literal(1),
    plan: SettingsPlanSchema,
    plan_sha256: z.string().regex(/^[a-f0-9]{64}$/),
    actions: z.array(SettingsActionReceiptSchema),
  })
  .strict();
export type SettingsDocument = z.infer<typeof SettingsDocumentSchema>;
export type SettingsMappings = z.infer<typeof SettingsMappingsSchema>;
export type SettingsPlan = z.infer<typeof SettingsPlanSchema>;
export type SettingsAction = z.infer<typeof SettingsActionSchema>;
export type SettingsReceipt = z.infer<typeof SettingsReceiptSchema>;
export type SettingsActionReceipt = z.infer<typeof SettingsActionReceiptSchema>;
export type SettingsSection = z.infer<typeof SettingsSectionSchema>;
