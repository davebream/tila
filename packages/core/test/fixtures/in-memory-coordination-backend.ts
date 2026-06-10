import type { Claim, Presence } from "@tila/schemas";
import type {
  AcquireResult,
  CoordinationBackend,
  RenewResult,
} from "../../src/interfaces/coordination-backend";

const PRESENCE_TTL_MS = 60_000;

export class InMemoryCoordinationBackend implements CoordinationBackend {
  private claims = new Map<string, Claim>();
  private fences = new Map<string, number>();
  private presenceMap = new Map<string, Presence>();

  async acquire(
    resource: string,
    machine: string,
    user: string,
    mode: "exclusive" | "owner" | "presence",
    ttlMs: number,
  ): Promise<AcquireResult> {
    const now = Date.now();

    const existing = this.claims.get(resource);
    if (existing && existing.expires_at > now) {
      if (
        mode === "exclusive" &&
        (existing.machine !== machine || existing.user !== user)
      ) {
        return {
          acquired: false,
          fence: this.fences.get(resource) ?? 0,
          expires_at: 0,
        };
      }
      if (mode === "owner" && existing.user !== user) {
        return {
          acquired: false,
          fence: this.fences.get(resource) ?? 0,
          expires_at: 0,
        };
      }
    }

    const currentFence = this.fences.get(resource) ?? 0;
    const newFence = currentFence + 1;
    this.fences.set(resource, newFence);

    const expiresAt = now + ttlMs;
    const claim: Claim = {
      resource,
      machine,
      user,
      mode,
      fence: newFence,
      acquired_at: now,
      expires_at: expiresAt,
    };
    this.claims.set(resource, claim);

    return {
      acquired: true,
      fence: newFence,
      expires_at: expiresAt,
      claim,
    };
  }

  async renew(
    resource: string,
    machine: string,
    user: string,
    fence: number,
    ttlMs: number,
  ): Promise<RenewResult> {
    const claim = this.claims.get(resource);
    if (!claim) return { renewed: false, expires_at: 0 };
    if (claim.machine !== machine || claim.user !== user)
      return { renewed: false, expires_at: 0 };
    if (claim.fence !== fence) return { renewed: false, expires_at: 0 };

    const expires_at = Date.now() + ttlMs;
    const renewed: Claim = {
      ...claim,
      expires_at,
    };
    this.claims.set(resource, renewed);
    return { renewed: true, expires_at };
  }

  async release(resource: string, fence: number): Promise<void> {
    const claim = this.claims.get(resource);
    if (!claim) return;
    if (claim.fence !== fence) return;
    this.claims.delete(resource);
  }

  async state(resource: string): Promise<Claim | null> {
    const claim = this.claims.get(resource);
    if (!claim) return null;

    // Lazy expiry: expired claims are treated as released
    if (claim.expires_at <= Date.now()) {
      this.claims.delete(resource);
      return null;
    }

    return claim;
  }

  async heartbeat(
    machine: string,
    info?: Record<string, unknown>,
  ): Promise<void> {
    this.presenceMap.set(machine, {
      machine,
      last_seen: Date.now(),
      info: info ?? {},
    });
  }

  async listPresence(): Promise<Presence[]> {
    const now = Date.now();
    const cutoff = now - PRESENCE_TTL_MS;
    const active: Presence[] = [];

    for (const [key, entry] of this.presenceMap) {
      if (entry.last_seen > cutoff) {
        active.push(entry);
      } else {
        this.presenceMap.delete(key);
      }
    }

    return active;
  }

  /** Test-only accessor. NOT part of the CoordinationBackend interface. */
  getClaims(): Map<string, Claim> {
    return new Map(this.claims);
  }
}
