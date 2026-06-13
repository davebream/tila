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
  /**
   * Acknowledge (consume) a signal on behalf of `acker`. Only the signal's
   * addressee, its original sender, or any caller for a broadcast may ack it;
   * an unauthorized ack is a no-op and returns `authorized: false`.
   */
  ackSignal(
    signalId: string,
    acker: string,
  ): Promise<{ found: boolean; authorized: boolean }>;
}
