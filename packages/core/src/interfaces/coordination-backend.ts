import type { Claim, Presence } from "@tila/schemas";

export interface AcquireResult {
  acquired: boolean;
  fence: number;
  expires_at: number;
  claim?: Claim;
}

export interface CoordinationBackend {
  acquire(
    resource: string,
    machine: string,
    user: string,
    mode: "exclusive" | "owner" | "presence",
    ttlMs: number,
  ): Promise<AcquireResult>;
  renew(
    resource: string,
    machine: string,
    user: string,
    fence: number,
    ttlMs: number,
  ): Promise<boolean>;
  release(resource: string, fence: number): Promise<void>;
  state(resource: string): Promise<Claim | null>;
  heartbeat(machine: string, info?: Record<string, unknown>): Promise<void>;
  listPresence(): Promise<Presence[]>;
  listClaims(): Promise<Claim[]>;
}
