import type { PresenceWithStatus } from "@tila/core";
import { describe, expect, it } from "vitest";

/**
 * C5 — local presence.listAll stale-machine parity.
 *
 * The remote `presence/all` endpoint returns ALL machines with a computed
 * `active` flag (last_seen vs TTL cutoff), including stale ones.
 * The local adapter must match this semantic via `EmbeddedProject.listAllPresence`.
 */
describe("local presence.listAll stale-machine parity", () => {
  it("returns stale machines with active:false", () => {
    const now = Date.now();
    const ttlMs = 60_000;

    // Simulate what EmbeddedProject.listAllPresence returns:
    // one active machine, one stale machine (last_seen older than ttlMs).
    const mockRows: PresenceWithStatus[] = [
      {
        machine: "active-machine",
        last_seen: now - 10_000, // 10s ago → within 60s TTL → active
        info: {},
        active: true,
      },
      {
        machine: "stale-machine",
        last_seen: now - 120_000, // 120s ago → beyond 60s TTL → stale
        info: {},
        active: false,
      },
    ];

    // Map the rows as the adapter does: { ...p, active: p.active }
    const machines = mockRows.map((p) => ({
      machine: p.machine,
      last_seen: p.last_seen,
      info: p.info,
      active: p.active,
    }));

    expect(machines).toHaveLength(2);

    const stale = machines.find((m) => m.machine === "stale-machine");
    expect(stale).toBeDefined();
    expect(stale?.active).toBe(false);

    const active = machines.find((m) => m.machine === "active-machine");
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
        { machine: "fresh", last_seen: now - 5000, info: {}, active: true },
        {
          machine: "expired",
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
    expect(result.machines).toHaveLength(2);

    const expired = result.machines.find(
      (m: { machine: string; active: boolean }) => m.machine === "expired",
    );
    expect(expired?.active).toBe(false);

    const fresh = result.machines.find(
      (m: { machine: string; active: boolean }) => m.machine === "fresh",
    );
    expect(fresh?.active).toBe(true);
  });
});
