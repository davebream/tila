import type {
  Handoff,
  HandoffCreateRequest,
  HandoffListRequest,
  HandoffListResponse,
  JournalCursor,
  JournalReplayRequest,
  JournalReplayResponse,
  ReentryRequest,
  ReentryResponse,
} from "@tila/schemas";

export interface ContinuityBackend {
  replayJournal(input: JournalReplayRequest): Promise<JournalReplayResponse>;
  getJournalCursor(): Promise<JournalCursor>;
  acknowledgeJournal(input: { seq: number }): Promise<JournalCursor>;
  createHandoff(input: HandoffCreateRequest): Promise<Handoff>;
  getHandoff(id: string): Promise<Handoff | null>;
  listHandoffs(input?: HandoffListRequest): Promise<HandoffListResponse>;
  reentry(input?: ReentryRequest): Promise<ReentryResponse>;
}
