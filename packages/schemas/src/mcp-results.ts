import { z } from "zod";
import {
  SettingsDocumentSchema,
  SettingsReceiptSchema,
} from "./settings-transfer";

export const McpSettingsExportResultSchema = z.object({
  status: z.literal("exported"),
  format: z.enum(["toml", "yaml"]),
  text: z.string(),
  coverage: SettingsDocumentSchema.shape.coverage,
});
export const McpSettingsImportResultSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("mapping-required"),
    references: z.array(z.string()),
    profile_references: z.array(z.string()),
    resource_ids: z.object({
      agents: z.array(z.string()),
      rooms: z.array(z.string()),
      signal_groups: z.array(z.string()),
    }),
    coverage: SettingsDocumentSchema.shape.coverage,
  }),
  z.object({
    status: z.literal("blocked"),
    errors: z.array(
      z.object({
        code: z.string(),
        message: z.string(),
        path: z.string().optional(),
      }),
    ),
  }),
  z.object({
    status: z.literal("preview"),
    receipt: SettingsReceiptSchema,
    definition_previews: z.array(api.SchemaPreviewResponseSchema),
  }),
]);
export const McpSettingsResumeResultSchema = z.object({
  status: z.enum(["preview", "complete", "partial", "blocked"]),
  receipt: SettingsReceiptSchema,
  error_code: z.string().optional(),
});
import {
  AgentArchivePreviewResponseSchema,
  AgentArchiveResponseSchema,
  AgentBindingResponseSchema,
  AgentGetResponseSchema,
  AgentListResponseSchema,
  AgentResponseSchema,
} from "./agent-binding";
import * as api from "./api";
import {
  ArtifactReviewResponseSchema,
  ArtifactReviewsResponseSchema,
  ArtifactTrustFieldsSchema,
} from "./artifact-review";
import {
  ArtifactHistoryResponseSchema,
  ArtifactRevisionSchema,
} from "./artifact-version";
import { ServiceAccountSchema } from "./capability";
import { TaskListScopeSchema } from "./catalog";
import {
  HandoffListResponseSchema,
  HandoffSchema,
  JournalCursorSchema,
  JournalReplayResponseSchema,
  ReentryResponseSchema,
} from "./continuity";
import * as conversations from "./conversation";
import { GateResponseSchema } from "./gate";
import { McpRecoverySchema } from "./mcp-workflow";
import { ProjectMembershipSchema } from "./membership";
import * as signals from "./signal";

// Existing journal responses may include older relationship events without
// attribution. Preserve their text and absence of identity; never invent an actor.
const historicalIdentity = {
  principal_id:
    api.JournalResponseSchema.shape.events.element.shape.principal_id.nullable(),
  participant_id:
    api.JournalResponseSchema.shape.events.element.shape.participant_id.nullable(),
  environment:
    api.JournalResponseSchema.shape.events.element.shape.environment.nullable(),
};
const journal = api.JournalResponseSchema.extend({
  events: z.array(
    api.JournalResponseSchema.shape.events.element.extend(historicalIdentity),
  ),
});
const summary = api.SummaryResponseSchema.extend({
  project: api.SummaryResponseSchema.shape.project.extend({
    recent_events: z.array(
      api.SummaryResponseSchema.shape.project.shape.recent_events.element.extend(
        historicalIdentity,
      ),
    ),
  }),
});
const replay = JournalReplayResponseSchema.extend({
  events: journal.shape.events,
});
const reentry = ReentryResponseSchema.extend({
  summary: summary.shape.project,
  changes: replay,
});

const capped = {
  truncated: z.boolean().optional(),
  total: z.number().int().optional(),
};
const ready = api.ListReadyEntitiesResponseSchema.extend(capped);
const relationships = api.ListEntityRelationshipsResponseSchema.extend(capped);
const grep = api.ArtifactGrepResponseSchema.extend({
  matches_truncated: z.boolean().optional(),
  matches_total: z.number().int().optional(),
});
const pagination = {
  total: z.number().int().optional(),
  limit: z.number().int().nullable().optional(),
  offset: z.number().int().optional(),
  has_more: z.boolean().optional(),
};
const taskPagination = {
  ...pagination,
  next_cursor: z.string().nullable().optional(),
  scope: TaskListScopeSchema.optional(),
};
const ok = z.object({ ok: z.literal(true) });
export const McpCursorResultSchema = ok.extend({ cursor: JournalCursorSchema });
export const McpHandoffResultSchema = ok.extend({ handoff: HandoffSchema });
export const McpTaskDetailSchema = api.EntityDetailResponseSchema.extend({
  truncated: z.boolean().optional(),
  total: z.number().int().optional(),
});
export const McpArtifactTextSchema = z.object({
  content: z.string(),
  mime_type: z.string().optional(),
  artifact_metadata: z.union([
    ArtifactRevisionSchema,
    ArtifactTrustFieldsSchema,
  ]),
  notice: z.string(),
  truncated: z.boolean(),
});
export const McpCloseResultSchema = z.object({
  handoff: HandoffSchema,
  complete: z.boolean(),
  cleanup: z.array(
    z.object({
      resource: z.string(),
      fence: z.number().int(),
      status: z.enum(["released", "already_released", "not_current", "failed"]),
      error: McpRecoverySchema.optional(),
    }),
  ),
});

/** A small review snapshot clients retain unchanged for apply and receipt replay. */
export const McpDefinitionReviewSchema = z.object({
  revision: z.number().int().nonnegative(),
  definition: z.string(),
  removed: z.array(z.string()),
});
export const McpDefinitionImportResultSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("preview"),
    format: z.enum(["toml", "yaml"]),
    mode: z.enum(["merge", "replace"]),
    units: z.object({
      added: z.array(z.string()),
      changed: z.array(z.string()),
      unchanged: z.array(z.string()),
      preserved: z.array(z.string()),
      removed: z.array(z.string()),
    }),
    warnings: z.array(z.string()),
    noChange: z.boolean(),
    reviewed_plan: McpDefinitionReviewSchema,
    preview: api.SchemaPreviewResponseSchema,
  }),
  z.object({
    status: z.literal("applied"),
    reviewed_plan: McpDefinitionReviewSchema,
    application: api.SchemaApplyResponseSchema,
  }),
]);
export const McpDefinitionExportResultSchema = z.object({
  status: z.enum(["exported", "empty"]),
  revision: z.number().int().nonnegative(),
  format: z.enum(["toml", "yaml"]),
  text: z.string().nullable(),
  verbatim_paths: z.array(z.string()),
});
const templates = api.TemplateListResponseSchema;
export const McpPrimitiveResults = {
  tila_room_list: conversations.RoomListResponseSchema,
  tila_room_history: conversations.RoomHistoryResponseSchema,
  tila_room_publish: conversations.MessagePublishResponseSchema,
  tila_inbox_fetch: conversations.ConversationInboxResponseSchema,
  tila_inbox_ack: conversations.InboxAckResponseSchema,
  tila_inbox_watch: conversations.InboxWatchResponseSchema,
  tila_inbox_explain: conversations.DeliveryExplainResponseSchema,
  tila_agent_bind: AgentBindingResponseSchema,
  tila_access_members: ok.extend({
    memberships: z.array(ProjectMembershipSchema),
  }),
  tila_access_repos: api.RepoListResponseSchema,
  tila_access_service_accounts: ok.extend({
    service_accounts: z.array(ServiceAccountSchema),
  }),
  tila_access_credentials: api.TokenListResponseSchema,
  tila_agent_list: AgentListResponseSchema,
  tila_agent_get: AgentGetResponseSchema,
  tila_agent_register: AgentResponseSchema,
  tila_agent_update: AgentResponseSchema,
  tila_agent_archive_preview: AgentArchivePreviewResponseSchema,
  tila_agent_archive: AgentArchiveResponseSchema,
  tila_agent_unarchive: AgentResponseSchema,
  tila_room_get: conversations.RoomResponseSchema,
  tila_room_create: conversations.RoomResponseSchema,
  tila_room_update: conversations.RoomResponseSchema,
  tila_room_member_set: ok.extend({
    room: conversations.RoomSchema.optional(),
  }),
  tila_room_member_remove: ok.extend({
    room: conversations.RoomSchema.optional(),
  }),
  tila_room_archive_preview: conversations.RoomArchivePreviewResponseSchema,
  tila_room_archive: conversations.RoomResponseSchema,
  tila_room_unarchive: conversations.RoomResponseSchema,
  tila_task_create: api.EntityResponseSchema,
  tila_task_list: z.union([
    api.CompactEntityListResponseSchema.extend(taskPagination),
    api.EntityListResponseSchema.extend(taskPagination),
  ]),
  tila_task_show: McpTaskDetailSchema,
  tila_task_update: api.EntityResponseSchema,
  tila_task_archive: api.ArchiveSuccessResponseSchema,
  tila_task_ready: ready,
  tila_task_relationships_add: api.CreateEntityRelationshipResponseSchema,
  tila_task_relationships_list: relationships,
  tila_claim_acquire: api.AcquireSuccessResponseSchema,
  tila_claim_release: api.ReleaseSuccessResponseSchema,
  tila_claim_list: api.StateListResponseSchema,
  tila_task_claim: api.AcquireSuccessResponseSchema,
  tila_task_release: api.ReleaseSuccessResponseSchema,
  tila_artifact_put: api.ArtifactPutResponseSchema,
  tila_artifact_write_text: api.ArtifactPutResponseSchema,
  tila_artifact_read_text: McpArtifactTextSchema,
  tila_artifact_search: api.ArtifactSearchResponseSchema,
  tila_artifact_grep: grep,
  tila_artifact_get_latest: ok.extend({
    pointer: ArtifactRevisionSchema.nullable(),
  }),
  tila_artifact_relationships_add: api.ArtifactRelationshipOkResponseSchema,
  tila_artifact_relationships_list: api.ArtifactRelationshipListResponseSchema,
  tila_artifact_history: ArtifactHistoryResponseSchema,
  tila_artifact_reviews: ArtifactReviewsResponseSchema,
  tila_artifact_review: ArtifactReviewResponseSchema,
  tila_search: api.UnifiedSearchResponseSchema,
  tila_record_get: api.RecordGetResponseSchema,
  tila_record_set: api.RecordMutateResponseSchema,
  tila_record_put: api.RecordMutateResponseSchema,
  tila_record_patch: api.RecordMutateResponseSchema,
  tila_record_list: api.RecordListResponseSchema,
  tila_record_archive: api.RecordMutateResponseSchema,
  tila_record_unarchive: api.RecordMutateResponseSchema,
  tila_record_history: api.RecordHistoryResponseSchema,
  tila_summary: summary,
  tila_signal_send: signals.SendSignalResponseSchema,
  tila_signal_list: signals.InboxResponseSchema,
  tila_signal_ack: signals.AckSignalResponseSchema,
  tila_signal_history: signals.SignalHistoryResponseSchema,
  tila_signal_group_list: signals.SignalGroupsResponseSchema,
  tila_signal_group_get: signals.SignalGroupResponseSchema,
  tila_signal_group_set: signals.SignalGroupResponseSchema,
  tila_signal_group_delete: ok,
  tila_journal_list: journal,
  tila_journal_append: JournalAppendResponseSchema,
  tila_presence_heartbeat: api.PresenceHeartbeatSuccessResponseSchema,
  tila_gate_create: GateResponseSchema,
  tila_gate_resolve: GateResponseSchema,
  tila_gate_cancel: ok,
  tila_schema_update: api.SchemaApplyResponseSchema,
  tila_schema_preview: api.SchemaPreviewResponseSchema,
  tila_schema_import: McpDefinitionImportResultSchema,
  tila_schema_export: McpDefinitionExportResultSchema,
  tila_settings_export: McpSettingsExportResultSchema,
  tila_settings_import: McpSettingsImportResultSchema,
  tila_settings_resume: McpSettingsResumeResultSchema,
  tila_template_list: templates,
  tila_template_instantiate: api.InstantiateTemplateResponseSchema,
  tila_reentry: reentry,
  tila_journal_replay: replay,
  tila_journal_cursor_get: McpCursorResultSchema,
  tila_journal_acknowledge: McpCursorResultSchema,
  tila_handoff_create: McpHandoffResultSchema,
  tila_handoff_get: McpHandoffResultSchema,
  tila_handoff_list: HandoffListResponseSchema,
} satisfies Record<string, z.ZodTypeAny>;

export const McpWorkflowResults = {
  tila_session: z.union([
    reentry,
    McpCursorResultSchema,
    api.PresenceHeartbeatSuccessResponseSchema,
  ]),
  tila_inspect: z.union([
    ready,
    McpTaskDetailSchema,
    api.RecordGetResponseSchema,
    McpArtifactTextSchema,
    McpHandoffResultSchema,
    api.PresenceAllListResponseSchema,
    api.UnifiedSearchResponseSchema,
    replay,
  ]),
  tila_claim: z.union([
    api.AcquireSuccessResponseSchema,
    api.RenewSuccessResponseSchema.extend({ fence: z.number().int() }),
    api.ReleaseSuccessResponseSchema,
  ]),
  tila_publish: z.union([
    api.EntityResponseSchema,
    api.RecordMutateResponseSchema,
    api.ArtifactPutResponseSchema,
  ]),
  tila_signal: z.union([
    signals.SendSignalResponseSchema,
    signals.InboxResponseSchema,
    signals.AckSignalResponseSchema,
  ]),
  tila_close: McpCloseResultSchema,
};
import { JournalAppendResponseSchema } from "./custom-journal";
