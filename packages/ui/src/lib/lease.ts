import type { AgentList } from "@/lib/api";

type AgentBinding = AgentList["agents"][number]["binding"];

// Presence `active` is server-computed with this TTL (ops-sqlite listAllPresence).
// Mirrored here so freshness keeps flipping between polls.
export const PRESENCE_TTL_MS = 60_000;

// Runtime lease fields travel as Unix seconds; presence and entity timestamps
// travel as milliseconds. This is the only place seconds become milliseconds.
export function leaseExpiryMs(leaseSeconds: number): number {
  return leaseSeconds * 1000;
}

export type BindingView =
  | { kind: "none" }
  | {
      kind: "attached" | "expired" | "replaced" | "released";
      expiresAtMs: number;
      redacted: boolean;
    };

export function deriveBindingView(
  binding: AgentBinding,
  nowMs: number,
): BindingView {
  if (!binding) return { kind: "none" };
  const expiresAtMs = leaseExpiryMs(binding.lease_expires_at);
  // The permission-redacted summary omits the holder and harness fields.
  const redacted = !("holder" in binding);
  if (binding.state === "active") {
    // Deadline is exclusive, matching the backend (`lease * 1000 <= now`).
    return {
      kind: expiresAtMs > nowMs ? "attached" : "expired",
      expiresAtMs,
      redacted,
    };
  }
  return { kind: binding.state, expiresAtMs, redacted };
}

export function heartbeatFresh(
  participant: { active: boolean; last_seen: number },
  nowMs: number,
): boolean {
  return participant.active && nowMs - participant.last_seen < PRESENCE_TTL_MS;
}

export function leaseCountdown(expiresAtMs: number, nowMs: number): string {
  const secs = Math.floor(Math.abs(expiresAtMs - nowMs) / 1000);
  const span =
    secs < 60
      ? `${secs}s`
      : secs < 3600
        ? `${Math.floor(secs / 60)}m`
        : secs < 86400
          ? `${Math.floor(secs / 3600)}h`
          : `${Math.floor(secs / 86400)}d`;
  return expiresAtMs > nowMs ? `in ${span}` : `${span} ago`;
}
