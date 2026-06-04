// packages/core/src/interfaces/gate-backend.ts

export interface GateFilter {
  resource?: string;
  status?: string;
  limit?: number;
}

export interface GateRecord {
  id: string;
  resource: string;
  await_type: string;
  status: string;
  fence: number;
  timeout_at: number | null;
  resolved_at: number | null;
  resolution: string | null;
  created_at: number;
  created_by: string;
}

export interface GateBackend {
  createGate(
    resource: string,
    awaitType: string,
    fence: number,
    timeoutAt?: number,
  ): Promise<GateRecord>;
  listGates(filter?: GateFilter): Promise<GateRecord[]>;
  resolveGate(gateId: string, resolution?: string): Promise<void>;
  cancelGate(gateId: string): Promise<void>;
}
