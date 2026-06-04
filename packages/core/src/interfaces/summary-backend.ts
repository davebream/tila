// packages/core/src/interfaces/summary-backend.ts

export interface ProjectSummary {
  entity_count: number;
  entity_counts: Record<string, number>;
  status_counts: Record<string, number>;
  active_claims: number;
  ready_count: number;
  online_machines: string[];
  token_estimate: number;
  recent_events: Array<{
    seq: number;
    t: number;
    kind: string;
    resource: string;
    actor: string;
  }>;
}

export interface SummaryBackend {
  getSummary(): Promise<ProjectSummary>;
}
