import { z } from "zod";
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
import {
  HandoffListResponseSchema,
  HandoffSchema,
  JournalCursorSchema,
  JournalReplayResponseSchema,
  ReentryResponseSchema,
} from "./continuity";
import { GateResponseSchema } from "./gate";
import { McpRecoverySchema } from "./mcp-workflow";
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
const templates = ok.extend({
  templates: z.array(
    z.object({
      name: z.string(),
      type: z.string(),
      description: z.string().nullable(),
      variables: z.array(z.string()),
    }),
  ),
});
export const McpPrimitiveResults = {
  tila_task_create: api.EntityResponseSchema,
  tila_task_list: z.union([
    api.CompactEntityListResponseSchema.extend(pagination),
    api.EntityListResponseSchema.extend(pagination),
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
  tila_presence_heartbeat: api.PresenceHeartbeatSuccessResponseSchema,
  tila_gate_create: GateResponseSchema,
  tila_gate_resolve: GateResponseSchema,
  tila_gate_cancel: ok,
  tila_schema_update: api.SchemaApplyResponseSchema,
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
