// packages/core/src/interfaces/journal-backend.ts

export interface JournalQuery {
  resource?: string;
  kind?: string;
  after_seq?: number;
  limit?: number;
}

export interface JournalEvent {
  seq: number;
  t: number;
  kind: string;
  resource: string;
  actor: string;
  fence: number | null;
}

export interface JournalBackend {
  listJournal(query: JournalQuery): Promise<JournalEvent[]>;
}
