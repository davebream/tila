import type { Claim, Presence } from "@tila/schemas";

/** Presence row augmented with a computed `active` flag. */
export interface PresenceWithStatus extends Presence {
  active: boolean;
}

export interface AcquireResult {
  acquired: boolean;
  fence: number;
  expires_at: number;
  claim?: Claim;
}

/**
 * Result of a renew attempt. Mirrors `coordinationOps.RenewResult` and the DO
 * `/coord/renew` route: `renewed` is false (with `expires_at: 0`) when the claim
 * is missing, expired, or held by a different machine/user. Returning the full
 * result — not a bare boolean — lets callers (a) distinguish loss-of-claim from
 * success and (b) surface the REAL stored `expires_at` instead of recomputing it.
 */
export interface RenewResult {
  renewed: boolean;
  expires_at: number;
}

export interface CoordinationBackend {
  acquire(
    resource: string,
    machine: string,
    user: string,
    mode: "exclusive" | "owner" | "presence",
    ttlMs: number,
  ): Promise<AcquireResult>;
  /**
   * Renew a held claim. Resolves to `{ renewed, expires_at }`. `renewed: false`
   * means the caller has LOST the claim (missing / expired / holder mismatch);
   * callers MUST check it rather than assuming success. Mirrors the DO
   * `/coord/renew` 409 `renew-failed` contract on the remote side.
   */
  renew(
    resource: string,
    machine: string,
    user: string,
    fence: number,
    ttlMs: number,
  ): Promise<RenewResult>;
  release(resource: string, fence: number): Promise<void>;
  state(resource: string): Promise<Claim | null>;
  heartbeat(machine: string, info?: Record<string, unknown>): Promise<void>;
  listPresence(): Promise<Presence[]>;
  /**
   * Returns ALL presence rows, including stale ones. Each row carries an
   * `active` flag: `true` when `last_seen > now - ttlMs`, `false` otherwise.
   * Use this instead of `listPresence` when you need a full machine inventory
   * (e.g. SDK local `presence.listAll`).
   */
  listAllPresence(ttlMs?: number, now?: number): Promise<PresenceWithStatus[]>;
  listClaims(): Promise<Claim[]>;
}
