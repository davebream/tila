import { useWhoami } from "@/hooks/use-admin";
import { useAuth } from "@/hooks/use-auth";
import {
  type AppliedSchemaResponse,
  getSchema,
  getWorkCatalog,
  listRecordTypes,
} from "@/lib/api";
import {
  ATTENTION_RULES,
  type AttentionSource,
  type OverviewView,
  evaluateOverview,
  isUnconfigured,
  ruleRow,
} from "@/lib/attention";
import {
  type AccessTarget,
  isRestricted,
  navVisibility,
} from "@/lib/navigation";
import { type SectionState, deriveSectionState } from "@/lib/query-state";
import { useQueries, useQuery } from "@tanstack/react-query";
import type { RecordTypesResponse, WorkCatalogResponse } from "@tila/schemas";

const REFRESH_MS = 30_000;

const DEFINITIONS: AccessTarget = {
  requires: ["schema:read"],
  surface: "schema",
};
const WORK: AccessTarget = { requires: ["tasks:read"], surface: "tasks" };
const RECORDS: AccessTarget = {
  requires: ["records:read"],
  surface: "records",
};

const SOURCES: readonly AttentionSource[] = [
  ...new Map(
    ATTENTION_RULES.map((rule) => [rule.source.id, rule.source]),
  ).values(),
];

export interface OverviewData {
  view: OverviewView;
  schema: SectionState<AppliedSchemaResponse> | "hidden";
  work: SectionState<WorkCatalogResponse> | "hidden";
  records: SectionState<RecordTypesResponse> | "hidden";
  /** The credential only sees some task and record types. */
  restricted: boolean;
  /** Newest successful read across the page's queries. */
  updatedAt: number;
  refetch: () => void;
}

/**
 * Everything the Overview shows, read in parallel. Sources the caller cannot
 * use are not requested; each source fails, goes stale or loads on its own so
 * one outage never reads as "nothing needs attention".
 */
export function useOverview(): OverviewData {
  const { projectId } = useAuth();
  const project = projectId ?? "";
  const identity = useWhoami();
  // Wait for the identity so forbidden sources are skipped, not attempted.
  const identityKnown = identity.isSuccess || identity.isError;
  const canUse = navVisibility(identity.data, projectId);
  const enabled = (target: AccessTarget) =>
    Boolean(projectId) && identityKnown && canUse(target);

  const sources = useQueries({
    queries: SOURCES.map((source) => ({
      queryKey: ["overview", project, source.id],
      queryFn: () => source.fetch(project),
      enabled: enabled(source),
      refetchInterval: REFRESH_MS,
    })),
  });
  const schema = useQuery({
    queryKey: ["overview", project, "schema"],
    queryFn: () => getSchema(project),
    enabled: enabled(DEFINITIONS),
    refetchInterval: REFRESH_MS,
  });
  const work = useQuery({
    queryKey: ["work-catalog", projectId],
    queryFn: () => getWorkCatalog(project),
    enabled: enabled(WORK),
    staleTime: 30_000,
    refetchInterval: REFRESH_MS,
  });
  const records = useQuery({
    queryKey: ["recordTypes", projectId],
    queryFn: () => listRecordTypes(project),
    enabled: enabled(RECORDS),
    refetchInterval: REFRESH_MS,
  });

  const known = identityKnown || !projectId;
  const state = <T>(
    target: AccessTarget,
    query: Parameters<typeof deriveSectionState<T>>[0],
  ): SectionState<T> | "hidden" =>
    known && !canUse(target) ? "hidden" : deriveSectionState<T>(query);

  const sourceStates = new Map(
    SOURCES.map((source, i) => [source.id, state<unknown>(source, sources[i])]),
  );
  const rows = ATTENTION_RULES.map((rule) => ({
    rule,
    state: ruleRow(rule, sourceStates.get(rule.source.id) ?? "hidden"),
  }));
  const schemaState = state<AppliedSchemaResponse>(DEFINITIONS, schema);
  const workState = state<WorkCatalogResponse>(WORK, work);
  const recordState = state<RecordTypesResponse>(RECORDS, records);
  const unconfigured =
    schemaState !== "hidden" &&
    workState !== "hidden" &&
    isUnconfigured({
      schema: schemaState,
      work: workState,
      records:
        recordState === "hidden"
          ? { phase: "failed", kind: "forbidden", error: null }
          : recordState,
    });

  return {
    view: evaluateOverview({ rows, unconfigured }),
    schema: schemaState,
    work: workState,
    records: recordState,
    restricted:
      identity.data?.project_id === projectId && isRestricted(identity.data),
    updatedAt: Math.max(
      0,
      ...[...sources, schema, work, records].map((q) => q.dataUpdatedAt),
    ),
    refetch: () => {
      for (const query of [...sources, schema, work, records])
        void query.refetch();
    },
  };
}
