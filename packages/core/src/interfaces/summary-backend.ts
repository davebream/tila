import type { EnvironmentMetadata } from "@tila/schemas";

export interface ProjectSummary {
  entity_count: number;
  entity_counts: Record<string, number>;
  status_counts: Record<string, number>;
  active_claims: number;
  ready_count: number;
  online_participants: string[];
  token_estimate: number;
  recent_events: Array<{
    seq: number;
    t: number;
    kind: string;
    resource: string;
    principal_id: string;
    participant_id: string;
    environment: EnvironmentMetadata;
  }>;
}

export interface SummaryBackend {
  getSummary(): Promise<ProjectSummary>;
}
