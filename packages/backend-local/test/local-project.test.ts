import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LocalProject } from "../src/local-project";

describe("LocalProject", () => {
  let tempDir: string;
  let project: LocalProject;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "tila-lp-test-"));
    const dbPath = join(tempDir, "test.db");
    project = LocalProject.open(dbPath, "test-org", "test-project", {
      skipFilesystemCheck: true,
    });
  });

  afterEach(() => {
    project.close();
    if (tempDir && existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  // --- EntityBackend ---

  describe("EntityBackend", () => {
    it("create returns an Entity with all fields", async () => {
      const entity = await project.create({
        id: "task-1",
        type: "task",
        data: { status: "open", title: "Test task" },
        created_by: "cli",
      });
      expect(entity.id).toBe("task-1");
      expect(entity.type).toBe("task");
      expect(entity.data).toEqual({ status: "open", title: "Test task" });
      expect(entity.created_by).toBe("cli");
      expect(entity.created_at).toBeTypeOf("number");
      expect(entity.updated_at).toBeTypeOf("number");
    });

    it("get returns entity by id", async () => {
      await project.create({
        id: "task-2",
        type: "task",
        data: { status: "open" },
        created_by: "cli",
      });
      const entity = await project.get("task-2");
      expect(entity).not.toBeNull();
      expect(entity?.id).toBe("task-2");
    });

    it("get returns null for non-existent entity", async () => {
      const entity = await project.get("nonexistent");
      expect(entity).toBeNull();
    });

    it("list filters by type", async () => {
      await project.create({
        id: "task-3",
        type: "task",
        data: {},
        created_by: "cli",
      });
      await project.create({
        id: "milestone-1",
        type: "milestone",
        data: {},
        created_by: "cli",
      });

      const tasks = await project.list({ type: "task" });
      expect(tasks).toHaveLength(1);
      expect(tasks[0].type).toBe("task");
    });

    it("update merges data fields", async () => {
      await project.create({
        id: "task-4",
        type: "task",
        data: { status: "open", title: "Original" },
        created_by: "cli",
      });
      const updated = await project.update("task-4", { status: "closed" });
      expect(updated.data).toEqual({ status: "closed", title: "Original" });
    });

    it("archive sets archived flag", async () => {
      await project.create({
        id: "task-5",
        type: "task",
        data: {},
        created_by: "cli",
      });
      await project.archive("task-5");
      const entity = await project.get("task-5");
      expect(entity?.archived).toBe(1);
    });
  });

  describe("EntityBackend relationships", () => {
    // entity_relationships has FK constraints to entities; create the referenced
    // tasks before relating them (local bun:sqlite enforces foreign keys).
    beforeEach(async () => {
      for (const id of ["A", "B", "C"]) {
        await project.create({
          id,
          type: "task",
          data: { status: "open" },
          created_by: "cli",
        });
      }
    });

    it("addRelationship persists a row and listRelationships returns it", async () => {
      const added = await project.addRelationship({
        from_id: "A",
        to_id: "B",
        type: "blocks",
      });
      expect(added).toEqual({ created: true });

      const rels = await project.listRelationships({ from_id: "A" });
      expect(rels).toHaveLength(1);
      expect(rels[0]).toMatchObject({
        from_id: "A",
        to_id: "B",
        type: "blocks",
      });
    });

    it("addRelationship is idempotent (second add returns created:false)", async () => {
      await project.addRelationship({
        from_id: "A",
        to_id: "B",
        type: "blocks",
      });
      const again = await project.addRelationship({
        from_id: "A",
        to_id: "B",
        type: "blocks",
      });
      expect(again).toEqual({ created: false });
      const rels = await project.listRelationships({ from_id: "A" });
      expect(rels).toHaveLength(1);
    });

    it("listRelationships filters by type (AND semantics with from_id)", async () => {
      await project.addRelationship({
        from_id: "A",
        to_id: "B",
        type: "blocks",
      });
      await project.addRelationship({
        from_id: "A",
        to_id: "C",
        type: "parent-child",
      });
      const blocks = await project.listRelationships({
        from_id: "A",
        type: "blocks",
      });
      expect(blocks).toHaveLength(1);
      expect(blocks[0].to_id).toBe("B");
    });

    it("removeRelationship returns removed:true for a present edge, false for an absent one (remote parity)", async () => {
      await project.addRelationship({
        from_id: "A",
        to_id: "B",
        type: "blocks",
      });
      const removed = await project.removeRelationship({
        from_id: "A",
        to_id: "B",
        type: "blocks",
      });
      expect(removed).toEqual({ removed: true });

      const noop = await project.removeRelationship({
        from_id: "A",
        to_id: "B",
        type: "blocks",
      });
      expect(noop).toEqual({ removed: false });
    });
  });

  // --- CoordinationBackend ---

  describe("CoordinationBackend", () => {
    it("acquire returns acquired=true with a fence", async () => {
      const result = await project.acquire(
        "task-1",
        "agent-a",
        "agent-a",
        "exclusive",
        60000,
      );
      expect(result.acquired).toBe(true);
      expect(result.fence).toBeGreaterThan(0);
      expect(result.expires_at).toBeGreaterThan(Date.now() - 1000);
    });

    it("acquire blocks different holder in exclusive mode", async () => {
      await project.acquire("task-1", "agent-a", "agent-a", "exclusive", 60000);
      const result = await project.acquire(
        "task-1",
        "agent-b",
        "agent-b",
        "exclusive",
        60000,
      );
      expect(result.acquired).toBe(false);
    });

    it("renew extends expiration with valid fence", async () => {
      const acq = await project.acquire(
        "task-1",
        "agent-a",
        "agent-a",
        "exclusive",
        60000,
      );
      const renewed = await project.renew(
        "task-1",
        "agent-a",
        "agent-a",
        acq.fence,
        120000,
      );
      expect(renewed.renewed).toBe(true);
    });

    it("release frees the claim", async () => {
      const acq = await project.acquire(
        "task-1",
        "agent-a",
        "agent-a",
        "exclusive",
        60000,
      );
      await project.release("task-1", acq.fence);
      const state = await project.state("task-1");
      expect(state).toBeNull();
    });

    it("state returns null for unclaimed resource", async () => {
      const state = await project.state("unclaimed-resource");
      expect(state).toBeNull();
    });

    it("heartbeat and listPresence round-trip", async () => {
      await project.heartbeat("machine-1", { role: "builder" });
      const machines = await project.listPresence();
      expect(machines).toHaveLength(1);
      expect(machines[0].machine).toBe("machine-1");
    });
  });

  // --- JournalBackend ---

  describe("JournalBackend", () => {
    it("listJournal returns events after entity creation", async () => {
      await project.create({
        id: "task-j1",
        type: "task",
        data: { status: "open" },
        created_by: "test",
      });
      const events = await project.listJournal({});
      expect(events.length).toBeGreaterThan(0);
      expect(events[0].kind).toBe("entity.created");
      expect(events[0].resource).toBe("task-j1");
    });

    it("listJournal filters by resource", async () => {
      await project.create({
        id: "task-j2",
        type: "task",
        data: { status: "open" },
        created_by: "test",
      });
      await project.create({
        id: "bug-j1",
        type: "bug",
        data: { status: "open" },
        created_by: "test",
      });
      const events = await project.listJournal({ resource: "task-j2" });
      expect(events.every((e) => e.resource === "task-j2")).toBe(true);
    });

    it("listJournal respects limit", async () => {
      await project.create({
        id: "task-j3",
        type: "task",
        data: { status: "open" },
        created_by: "test",
      });
      const events = await project.listJournal({ limit: 1 });
      expect(events.length).toBeLessThanOrEqual(1);
    });
  });

  // --- GateBackend ---

  describe("GateBackend", () => {
    it("createGate returns a pending gate", async () => {
      const claim = await project.acquire(
        "task:gate-test",
        "test",
        "test",
        "exclusive",
        30_000,
      );
      const gate = await project.createGate(
        "task:gate-test",
        "ci",
        claim.fence,
      );
      expect(gate.id).toMatch(/^gate_/);
      expect(gate.status).toBe("pending");
      expect(gate.resource).toBe("task:gate-test");
      expect(gate.await_type).toBe("ci");
    });

    it("listGates returns created gates", async () => {
      const claim = await project.acquire(
        "task:gate-list",
        "test",
        "test",
        "exclusive",
        30_000,
      );
      await project.createGate("task:gate-list", "ci", claim.fence);
      const gates = await project.listGates({});
      expect(gates.length).toBeGreaterThan(0);
    });

    it("resolveGate changes status to resolved", async () => {
      const claim = await project.acquire(
        "task:gate-resolve",
        "test",
        "test",
        "exclusive",
        30_000,
      );
      const gate = await project.createGate(
        "task:gate-resolve",
        "human",
        claim.fence,
      );
      await project.resolveGate(gate.id, "approved");
      const gates = await project.listGates({ status: "resolved" });
      const resolved = gates.find((g) => g.id === gate.id);
      expect(resolved).toBeDefined();
      expect(resolved?.resolution).toBe("approved");
    });

    it("cancelGate changes status to cancelled", async () => {
      const claim = await project.acquire(
        "task:gate-cancel",
        "test",
        "test",
        "exclusive",
        30_000,
      );
      const gate = await project.createGate(
        "task:gate-cancel",
        "ci",
        claim.fence,
      );
      await project.cancelGate(gate.id);
      const gates = await project.listGates({ status: "cancelled" });
      const cancelled = gates.find((g) => g.id === gate.id);
      expect(cancelled).toBeDefined();
    });
  });

  // --- SignalBackend ---

  describe("SignalBackend", () => {
    it("sendSignal stores a signal and inbox returns it", async () => {
      const result = await project.sendSignal(
        { target: "*", kind: "info" },
        "local",
      );
      expect(result.id).toMatch(/^sig_/);
      const signals = await project.listSignals("local");
      const found = signals.find((s) => s.id === result.id);
      expect(found).toBeDefined();
      expect(found?.kind).toBe("info");
    });

    it("ackSignal marks signal as acknowledged", async () => {
      const result = await project.sendSignal(
        { target: "*", kind: "test-ack" },
        "local",
      );
      const ackResult = await project.ackSignal(result.id, "local");
      expect(ackResult.found).toBe(true);
      expect(ackResult.authorized).toBe(true);
    });

    it("ackSignal returns found=false for missing signal", async () => {
      const result = await project.ackSignal("sig_nonexistent", "local");
      expect(result.found).toBe(false);
    });
  });

  // --- SchemaBackend ---

  describe("SchemaBackend", () => {
    it("getCurrentSchema returns null version on fresh DB", async () => {
      const record = await project.getCurrentSchema();
      expect(record.version).toBeNull();
      expect(record.definition).toBeNull();
    });

    it("applySchema applies a valid TOML schema", async () => {
      const definition = `
schema_version = 1

[work_units.task.fields.status]
type = "string"

[work_units.task.fields.title]
type = "string"
`;
      const result = await project.applySchema({ definition });
      expect(result.ok).toBe(true);
      expect(result.version).toBe(1);

      const record = await project.getCurrentSchema();
      expect(record.version).toBe(1);
      expect(record.definition).toContain("work_units");
    });

    it("applySchema returns noChange on duplicate", async () => {
      const definition = `
schema_version = 1

[work_units.task.fields.status]
type = "string"
`;
      await project.applySchema({ definition });
      const result = await project.applySchema({ definition });
      expect(result.noChange).toBe(true);
    });
  });

  // --- SummaryBackend ---

  describe("SummaryBackend", () => {
    it("getSummary returns aggregated project data", async () => {
      await project.create({
        id: "task-s1",
        type: "task",
        data: { status: "open", title: "Summary test" },
        created_by: "test",
      });
      await project.create({
        id: "task-s2",
        type: "task",
        data: { status: "done", title: "Done task" },
        created_by: "test",
      });
      const summary = await project.getSummary();
      expect(summary.entity_count).toBe(2);
      expect(summary.entity_counts.task).toBe(2);
      expect(summary.status_counts.open).toBe(1);
      expect(summary.status_counts.done).toBe(1);
      expect(summary.recent_events.length).toBeGreaterThan(0);
      expect(summary.token_estimate).toBeGreaterThan(0);
    });
  });

  // --- CoordinationBackend.listClaims ---

  describe("CoordinationBackend.listClaims", () => {
    it("listClaims returns active claims", async () => {
      await project.acquire(
        "task:claim-test",
        "test",
        "test",
        "exclusive",
        30_000,
      );
      const claims = await project.listClaims();
      expect(claims.length).toBeGreaterThanOrEqual(1);
      const found = claims.find((c) => c.resource === "task:claim-test");
      expect(found).toBeDefined();
    });

    it("listClaims returns empty after release", async () => {
      const result = await project.acquire(
        "task:release-test",
        "test",
        "test",
        "exclusive",
        30_000,
      );
      await project.release("task:release-test", result.fence);
      const claims = await project.listClaims();
      const found = claims.find((c) => c.resource === "task:release-test");
      expect(found).toBeUndefined();
    });
  });

  // --- Idempotency ---

  describe("Idempotency", () => {
    it("check returns null for unknown key", () => {
      const result = project.checkIdempotency("unknown-key");
      expect(result).toBeNull();
    });

    it("store then check round-trips", () => {
      project.storeIdempotency("idem-1", 200, '{"ok":true}');
      const result = project.checkIdempotency("idem-1");
      expect(result).toEqual({ statusCode: 200, body: '{"ok":true}' });
    });

    it("store is idempotent (INSERT OR IGNORE)", () => {
      project.storeIdempotency("idem-2", 200, '{"first":true}');
      project.storeIdempotency("idem-2", 201, '{"second":true}');
      const result = project.checkIdempotency("idem-2");
      // First write wins
      expect(result).toEqual({ statusCode: 200, body: '{"first":true}' });
    });
  });
});
