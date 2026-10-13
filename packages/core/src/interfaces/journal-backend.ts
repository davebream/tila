import type {
  EnvironmentMetadata,
  JournalAppendRequest,
  JournalAppendResponse,
} from "@tila/schemas";

export interface JournalQuery {
  resource?: string;
  kind?: string;
  client_name?: string;
  event_name?: string;
  correlation_id?: string;
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
  appendJournal(
    input: JournalAppendRequest,
    options: { idempotencyKey: string },
  ): Promise<JournalAppendResponse>;
  listJournal(query: JournalQuery): Promise<JournalEvent[]>;
}
