import type { EnvironmentMetadata } from "@tila/schemas";

export interface JournalQuery {
  resource?: string;
  kind?: string;
  client_name?: string;
  after_seq?: number;
  limit?: number;
}

export interface JournalEvent {
  seq: number;
  t: number;
  kind: string;
  resource: string;
  principal_id: string;
  participant_id: string;
  environment: EnvironmentMetadata;
  token_id: string | null;
  fence: number | null;
  data: Record<string, unknown>;
}

export interface JournalBackend {
  listJournal(query: JournalQuery): Promise<JournalEvent[]>;
}
