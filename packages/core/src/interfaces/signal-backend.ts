import type {
  SendSignalRequest,
  Signal,
  SignalGroup,
  SignalHistoryResponse,
} from "@tila/schemas";

export type SendSignalInput = SendSignalRequest;
export type SignalRecord = Signal;

export interface SignalBackend {
  sendSignal(
    input: SendSignalInput,
  ): Promise<{ id: string; recipient_count: number }>;
  listSignals(): Promise<SignalRecord[]>;
  historySignals(options?: {
    limit?: number;
    cursor?: string;
  }): Promise<Omit<SignalHistoryResponse, "ok">>;
  ackSignal(
    signalId: string,
  ): Promise<{ found: boolean; authorized: boolean; expired: boolean }>;
  listSignalGroups(): Promise<SignalGroup[]>;
  getSignalGroup(groupId: string): Promise<SignalGroup | null>;
  setSignalGroup(
    groupId: string,
    input: { name: string; principal_ids: string[] },
  ): Promise<SignalGroup>;
  deleteSignalGroup(groupId: string): Promise<boolean>;
}
