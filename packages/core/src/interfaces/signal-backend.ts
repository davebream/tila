// packages/core/src/interfaces/signal-backend.ts

export interface SendSignalInput {
  target: string;
  kind: string;
  resource?: string;
  payload?: unknown;
  ttl_ms?: number;
}

export interface SignalRecord {
  id: string;
  target: string;
  kind: string;
  resource: string | null;
  payload: unknown;
  created_by: string;
  created_at: number;
  expires_at: number;
  acked_at: number | null;
}

export interface SignalBackend {
  sendSignal(
    input: SendSignalInput,
    createdBy: string,
  ): Promise<{ id: string }>;
  listSignals(tokenName: string): Promise<SignalRecord[]>;
  ackSignal(signalId: string): Promise<{ found: boolean }>;
}
