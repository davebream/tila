/**
 * Verifies that EmbeddedProject.listAllPresence returns ALL participants (fresh +
 * stale) with the `active` flag computed per row. This exercises the C5 wiring
 * from CoordinationBackend → EmbeddedProject → coordination-ops.listAllPresence.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { EmbeddedProject } from "../src/index";
import { type Harness, makeHarness } from "./harness.bun";

describe("EmbeddedProject.listAllPresence", () => {
  let h: Harness;
  let project: EmbeddedProject;

  beforeEach(() => {
    h = makeHarness();
    project = h.project;
  });

  afterEach(() => {
    h.close();
  });

  it("returns stale participants with active:false alongside fresh participants with active:true", async () => {
    const ttlMs = 60_000;
    const now = Date.now();
    const staleTs = now - ttlMs - 5_000;

    // Insert a fresh heartbeat directly via the underlying raw DB to control timestamps.
    h.rawDb
      .query(
        "INSERT OR REPLACE INTO presence(principal_id, participant_id, environment, last_seen, info) VALUES(?, ?, ?, ?, ?)",
      )
      .run(
        "local:test-org",
        "participant-fresh",
        JSON.stringify({ machine: "machine-fresh" }),
        now,
        JSON.stringify({ role: "worker" }),
      );

    // Insert a stale heartbeat.
    h.rawDb
      .query(
        "INSERT OR REPLACE INTO presence(principal_id, participant_id, environment, last_seen, info) VALUES(?, ?, ?, ?, ?)",
      )
      .run(
        "local:test-org",
        "participant-stale",
        JSON.stringify({ machine: "machine-stale" }),
        staleTs,
        JSON.stringify({ role: "old" }),
      );

    const rows = await project.listAllPresence(ttlMs, now);

    expect(rows).toHaveLength(2);

    const fresh = rows.find((r) => r.participant_id === "participant-fresh");
    const stale = rows.find((r) => r.participant_id === "participant-stale");

    expect(fresh).toBeDefined();
    expect(fresh?.active).toBe(true);

    expect(stale).toBeDefined();
    expect(stale?.active).toBe(false);
  });
});
