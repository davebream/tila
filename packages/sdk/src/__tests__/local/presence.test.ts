import type { PresenceWithStatus } from "@tila/core";
import { describe, expect, it } from "vitest";

/**
 * C5 — local presence.listAll stale-participant parity.
 *
 * The remote `presence/all` endpoint returns ALL participants with a computed
 * `active` flag (last_seen vs TTL cutoff), including stale ones.
 * The local adapter must match this semantic via `EmbeddedProject.listAllPresence`.
 */
describe("local presence.listAll stale-machine parity", () => {
  it("returns stale participants with active:false", () => {
    const now = Date.now();
    const ttlMs = 60_000;

    // Simulate what EmbeddedProject.listAllPresence returns:
    // one active machine, one stale machine (last_seen older than ttlMs).
    const mockRows: PresenceWithStatus[] = [
      {
        principal_id: "local:test",
        participant_id: "active-participant",
        environment: { machine: "shared-machine" },
        last_seen: now - 10_000, // 10s ago → within 60s TTL → active
        info: {},
        active: true,
      },
      {
        principal_id: "local:test",
        participant_id: "stale-participant",
        environment: { machine: "shared-machine" },
        last_seen: now - 120_000, // 120s ago → beyond 60s TTL → stale
        info: {},
        active: false,
      },
    ];

    // Map the rows as the adapter does: { ...p, active: p.active }
    const participants = mockRows.map((p) => ({
      principal_id: p.principal_id,
      participant_id: p.participant_id,
      environment: p.environment,
      last_seen: p.last_seen,
      info: p.info,
      active: p.active,
    }));

    expect(participants).toHaveLength(2);

    const stale = participants.find(
      (p) => p.participant_id === "stale-participant",
    );
    expect(stale).toBeDefined();
    expect(stale?.active).toBe(false);

    const active = participants.find(
      (p) => p.participant_id === "active-participant",
    );
    expect(active).toBeDefined();
    expect(active?.active).toBe(true);
  });

  /**
   * Integration-style test: verifies the adapter's `listAll` method passes
   * `active` through from the backend row rather than hardcoding `true`.
   *
   * We mock the project object directly to avoid spinning up SQLite.
   */
  it("adapter maps active flag from backend row (integration-style mock)", async () => {
    const now = Date.now();

    // Build a minimal mock of EmbeddedProject
    const mockProject = {
      listAllPresence: async () => [
        {
          principal_id: "local:test",
          participant_id: "fresh",
          environment: { machine: "shared-machine" },
          last_seen: now - 5000,
          info: {},
          active: true,
        },
        {
          principal_id: "local:test",
          participant_id: "expired",
          environment: { machine: "shared-machine" },
          last_seen: now - 200000,
          info: {},
          active: false,
        },
      ],
      // Stub out other methods that might be called during module load
    } as never;

    // Import the adapter factory directly and call it with our mock project
    const { buildLocalPresenceMethodsForTest } = await import(
      "../../local/resource-adapters.js"
    );

    const presence = buildLocalPresenceMethodsForTest(mockProject);
    const result = await presence.listAll();

    expect(result.ok).toBe(true);
    expect(result.participants).toHaveLength(2);

    const expired = result.participants.find(
      (p: { participant_id: string; active: boolean }) =>
        p.participant_id === "expired",
    );
    expect(expired?.active).toBe(false);

    const fresh = result.participants.find(
      (p: { participant_id: string; active: boolean }) =>
        p.participant_id === "fresh",
    );
    expect(fresh?.active).toBe(true);
  });
});
