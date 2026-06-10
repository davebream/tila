import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  type EmbeddedProject,
  NotFoundError,
  ReferenceConstraintError,
} from "../src/index";
import { type Harness, makeHarness } from "./harness.bun";

describe("EmbeddedProject", () => {
  let h: Harness;
  let project: EmbeddedProject;

  beforeEach(() => {
    h = makeHarness();
    project = h.project;
  });

  afterEach(() => {
    h.close();
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
    });

    it("get returns null for non-existent entity", async () => {
      expect(await project.get("nonexistent")).toBeNull();
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

    it("addRelationship persists and listRelationships returns it; idempotent", async () => {
      const added = await project.addRelationship({
        from_id: "A",
        to_id: "B",
        type: "blocks",
      });
      expect(added).toEqual({ created: true });

      const again = await project.addRelationship({
        from_id: "A",
        to_id: "B",
        type: "blocks",
      });
      expect(again).toEqual({ created: false });

      const rels = await project.listRelationships({ from_id: "A" });
      expect(rels).toHaveLength(1);
      expect(rels[0]).toMatchObject({
        from_id: "A",
        to_id: "B",
        type: "blocks",
      });
    });

    it("removeRelationship returns removed true then false", async () => {
      await project.addRelationship({
        from_id: "A",
        to_id: "B",
        type: "blocks",
      });
      expect(
        await project.removeRelationship({
          from_id: "A",
          to_id: "B",
          type: "blocks",
        }),
      ).toEqual({ removed: true });
      expect(
        await project.removeRelationship({
          from_id: "A",
          to_id: "B",
          type: "blocks",
        }),
      ).toEqual({ removed: false });
    });
  });

  // --- EntityBackend: ready / tree / fenced update / artifact-refs (Task 6) ---

  describe("EntityBackend ready/tree/fence/artifact-refs", () => {
    it("listReady returns only unblocked tasks", async () => {
      for (const id of ["blocker", "blocked", "free"]) {
        await project.create({
          id,
          type: "task",
          data: { status: "open", title: id },
          created_by: "cli",
        });
      }
      // blocker --blocks--> blocked
      await project.addRelationship({
        from_id: "blocker",
        to_id: "blocked",
        type: "blocks",
      });

      const ready = await project.listReady({ type: "task" });
      const ids = ready.map((e) => e.id).sort();
      // blocker (no open blocker) + free are ready; blocked is not.
      expect(ids).toEqual(["blocker", "free"]);

      // Closing the blocker unblocks "blocked".
      const acq = await project.acquire(
        "task:blocker",
        "local",
        "local",
        "exclusive",
        60000,
      );
      await project.updateWithFence("blocker", { status: "closed" }, acq.fence);
      const readyAfter = (await project.listReady({ type: "task" }))
        .map((e) => e.id)
        .sort();
      expect(readyAfter).toEqual(["blocked", "free"]);
    });

    it("tree returns compact nodes + parent-child edges", async () => {
      await project.create({
        id: "root",
        type: "task",
        data: { status: "open", title: "Root" },
        created_by: "cli",
      });
      await project.create({
        id: "child",
        type: "task",
        data: { status: "open", title: "Child" },
        created_by: "cli",
      });
      await project.addRelationship({
        from_id: "root",
        to_id: "child",
        type: "parent-child",
      });

      const { nodes, edges } = await project.tree();
      const nodeIds = nodes.map((n) => n.id).sort();
      expect(nodeIds).toEqual(["child", "root"]);
      // Compact node shape carries title/status.
      const rootNode = nodes.find((n) => n.id === "root");
      expect(rootNode?.title).toBe("Root");
      expect(edges).toHaveLength(1);
      expect(edges[0]).toMatchObject({
        from_id: "root",
        to_id: "child",
        type: "parent-child",
      });
    });

    it("updateWithFence enforces the fence (stale fence throws)", async () => {
      await project.create({
        id: "fenced",
        type: "task",
        data: { status: "open" },
        created_by: "cli",
      });
      const acq = await project.acquire(
        "task:fenced",
        "local",
        "local",
        "exclusive",
        60000,
      );

      // Valid fence updates.
      const updated = await project.updateWithFence(
        "fenced",
        { status: "in-progress" },
        acq.fence,
      );
      expect(updated.data.status).toBe("in-progress");

      // Stale fence is rejected.
      expect(
        project.updateWithFence("fenced", { status: "done" }, acq.fence - 1),
      ).rejects.toThrow();
    });

    it("addArtifactRef / listArtifactRefs round-trip", async () => {
      await project.create({
        id: "withref",
        type: "task",
        data: { status: "open" },
        created_by: "cli",
      });
      // The artifact_key FK references artifact_pointers(r2_key), so the blob
      // must exist before it can be referenced (mirrors the DO 404 guard).
      await h.artifacts.put({
        key: "plans/withref/abc.md",
        body: "hello",
        sha256: "deadbeef",
        metadata: {},
        contentType: "text/markdown",
      });
      await project.addArtifactRef({
        entity_id: "withref",
        artifact_key: "plans/withref/abc.md",
        slot: "plan",
        metadata: { note: "hi" },
      });

      const refs = await project.listArtifactRefs("withref");
      expect(refs).toHaveLength(1);
      expect(refs[0]).toMatchObject({
        entity_id: "withref",
        artifact_key: "plans/withref/abc.md",
        slot: "plan",
        metadata: { note: "hi" },
      });
      expect(typeof refs[0].created_at).toBe("number");

      // Empty for an unrelated entity.
      expect(await project.listArtifactRefs("nope")).toEqual([]);
    });

    // --- addArtifactRef facade parity with the DO route (clean errors) ---

    it("addArtifactRef on a MISSING entity throws a clean NotFoundError (DO 404 parity)", async () => {
      // No raw SQLite string; same not-found semantics as the DO route ~552.
      await expect(
        project.addArtifactRef({
          entity_id: "ghost",
          artifact_key: "plans/ghost/x.md",
          slot: "plan",
        }),
      ).rejects.toBeInstanceOf(NotFoundError);
    });

    it("addArtifactRef with a MISSING artifact pointer throws a clean NotFoundError (FK translated, DO ~586)", async () => {
      await project.create({
        id: "ent-noart",
        type: "task",
        data: { status: "open" },
        created_by: "cli",
      });
      // Entity exists, but no artifact_pointers row for this key -> FK failure.
      let caught: unknown;
      try {
        await project.addArtifactRef({
          entity_id: "ent-noart",
          artifact_key: "plans/ent-noart/missing.md",
          slot: "plan",
        });
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(NotFoundError);
      // Clean message, NOT a raw "FOREIGN KEY constraint failed" string.
      expect((caught as Error).message).not.toMatch(/FOREIGN KEY/);
      expect((caught as Error).message).toMatch(/not found/i);
    });

    it("addArtifactRef with an UNDECLARED slot throws a clean ReferenceConstraintError (DO 422 parity)", async () => {
      // Schema declares entity type `doc` with a single reference slot `spec`.
      await project.applySchema({
        definition: `schema_version = 1

[work_units.doc]

[[work_units.doc.references]]
name = "spec"
kinds = ["document"]
`,
      });
      await project.create({
        id: "doc-1",
        type: "doc",
        data: { status: "open" },
        created_by: "cli",
      });
      await h.artifacts.put({
        key: "plans/doc-1/x.md",
        body: "hello",
        sha256: "deadbeef",
        metadata: {},
        contentType: "text/markdown",
      });

      let caught: unknown;
      try {
        await project.addArtifactRef({
          entity_id: "doc-1",
          artifact_key: "plans/doc-1/x.md",
          slot: "undeclared-slot",
        });
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(ReferenceConstraintError);
      expect((caught as Error).message).toMatch(/not declared/i);
      // The declared slot still works.
      await project.addArtifactRef({
        entity_id: "doc-1",
        artifact_key: "plans/doc-1/x.md",
        slot: "spec",
      });
      expect(await project.listArtifactRefs("doc-1")).toHaveLength(1);
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

    it("renew + release round-trip", async () => {
      const acq = await project.acquire(
        "task-1",
        "agent-a",
        "agent-a",
        "exclusive",
        60000,
      );
      expect(
        (await project.renew("task-1", "agent-a", "agent-a", acq.fence, 120000))
          .renewed,
      ).toBe(true);
      await project.release("task-1", acq.fence);
      expect(await project.state("task-1")).toBeNull();
    });

    it("heartbeat and listPresence round-trip", async () => {
      await project.heartbeat("machine-1", { role: "builder" });
      const machines = await project.listPresence();
      expect(machines).toHaveLength(1);
      expect(machines[0].machine).toBe("machine-1");
    });

    it("listClaims reflects acquire/release", async () => {
      const r = await project.acquire(
        "task:claim",
        "t",
        "t",
        "exclusive",
        30_000,
      );
      expect(
        (await project.listClaims()).some((c) => c.resource === "task:claim"),
      ).toBe(true);
      await project.release("task:claim", r.fence);
      expect(
        (await project.listClaims()).some((c) => c.resource === "task:claim"),
      ).toBe(false);
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
  });

  // --- GateBackend ---

  describe("GateBackend", () => {
    it("createGate -> resolveGate -> cancelGate transitions", async () => {
      const claim = await project.acquire(
        "task:gate",
        "test",
        "test",
        "exclusive",
        30_000,
      );
      const gate = await project.createGate("task:gate", "ci", claim.fence);
      expect(gate.id).toMatch(/^gate_/);
      expect(gate.status).toBe("pending");

      await project.resolveGate(gate.id, "approved");
      const resolved = (await project.listGates({ status: "resolved" })).find(
        (g) => g.id === gate.id,
      );
      expect(resolved?.resolution).toBe("approved");
    });
  });

  // --- SignalBackend ---

  describe("SignalBackend", () => {
    it("sendSignal + inbox + ack", async () => {
      const result = await project.sendSignal(
        { target: "*", kind: "info" },
        "local",
      );
      expect(result.id).toMatch(/^sig_/);
      const signals = await project.listSignals("local");
      expect(signals.some((s) => s.id === result.id)).toBe(true);
      expect((await project.ackSignal(result.id)).found).toBe(true);
      expect((await project.ackSignal("sig_nope")).found).toBe(false);
    });
  });

  // --- SchemaBackend ---

  describe("SchemaBackend", () => {
    it("getCurrentSchema null on fresh DB, then apply", async () => {
      const fresh = await project.getCurrentSchema();
      expect(fresh.version).toBeNull();

      const definition = `
schema_version = 1

[work_units.task.fields.status]
type = "string"

[records.config.fields.value]
type = "string"
`;
      const result = await project.applySchema({ definition });
      expect(result.ok).toBe(true);
      expect(result.version).toBe(1);
      const record = await project.getCurrentSchema();
      expect(record.version).toBe(1);

      const dup = await project.applySchema({ definition });
      expect(dup.noChange).toBe(true);
    });
  });

  // --- SummaryBackend ---

  describe("SummaryBackend", () => {
    it("getSummary aggregates project data", async () => {
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
      expect(summary.token_estimate).toBeGreaterThan(0);
    });
  });

  // --- Idempotency (C2: Drizzle, not raw $client) ---

  describe("Idempotency", () => {
    it("check returns null for unknown key", () => {
      expect(project.checkIdempotency("unknown")).toBeNull();
    });

    it("store then check round-trips", () => {
      project.storeIdempotency("idem-1", 200, '{"ok":true}');
      expect(project.checkIdempotency("idem-1")).toEqual({
        statusCode: 200,
        body: '{"ok":true}',
      });
    });

    it("store is first-writer-wins (onConflictDoNothing)", () => {
      project.storeIdempotency("idem-2", 200, '{"first":true}');
      project.storeIdempotency("idem-2", 201, '{"second":true}');
      expect(project.checkIdempotency("idem-2")).toEqual({
        statusCode: 200,
        body: '{"first":true}',
      });
    });
  });

  // --- RecordBackend (happy path) ---

  describe("RecordBackend happy path", () => {
    it("create -> get -> patch -> set(fence) -> history -> archive -> list", async () => {
      const created = await project.createRecord({
        type: "config",
        key: "deploy",
        value: { region: "us-east", replicas: 2 },
        tags: ["env:prod"],
        message: "initial",
      });
      expect(created.revision).toBe(1);
      expect(created.fence).toBeGreaterThan(0);
      expect(created.tags).toEqual(["env:prod"]);
      const fence1 = created.fence;

      const got = await project.getRecord("config", "deploy");
      expect(got?.value).toEqual({ region: "us-east", replicas: 2 });
      expect(got?.fence).toBe(fence1);

      // patch (fence-required); fence increments
      const patched = await project.patchRecord({
        type: "config",
        key: "deploy",
        patch: { replicas: 3 },
        fence: fence1,
      });
      expect(patched.value).toEqual({ region: "us-east", replicas: 3 });
      expect(patched.revision).toBe(2);
      expect(patched.fence).toBeGreaterThan(fence1);
      const fence2 = patched.fence;

      // set (full replace, fence-required)
      const set = await project.setRecord({
        type: "config",
        key: "deploy",
        value: { region: "eu-west" },
        fence: fence2,
      });
      expect(set.value).toEqual({ region: "eu-west" });
      expect(set.revision).toBe(3);
      expect(set.fence).toBeGreaterThan(fence2);
      const fence3 = set.fence;

      // history: newest-first, v14 revision columns present
      const history = await project.listRecordHistory("config", "deploy", {
        includeValues: true,
      });
      expect(history.items).toHaveLength(3);
      expect(history.items[0].revision).toBe(3);
      expect(history.items[0].operation).toBe("set");
      // v14 columns: actor / token_id surfaced via actor + provenance.
      // RecordHistoryItem exposes `actor` and (read-only) artifact key columns.
      for (const item of history.items) {
        expect(item.actor).toBe("local");
        expect(item).toHaveProperty("schema_version");
        expect(item).toHaveProperty("canonical_artifact_key");
      }

      // archive (fence-required)
      const archived = await project.archiveRecord({
        type: "config",
        key: "deploy",
        fence: fence3,
      });
      expect(archived.archived).toBe(1);
      expect(archived.fence).toBeGreaterThan(fence3);

      // list excludes archived by default, includes when asked
      const active = await project.listRecords({ type: "config" });
      expect(active.items).toHaveLength(0);
      const all = await project.listRecords({
        type: "config",
        includeArchived: true,
      });
      expect(all.items).toHaveLength(1);
      expect(all.items[0].archived).toBe(1);
    });

    it("unarchiveRecord restores archived=0", async () => {
      const c = await project.createRecord({
        type: "config",
        key: "k2",
        value: { a: 1 },
      });
      const a = await project.archiveRecord({
        type: "config",
        key: "k2",
        fence: c.fence,
      });
      const u = await project.unarchiveRecord({
        type: "config",
        key: "k2",
        fence: a.fence,
      });
      expect(u.archived).toBe(0);
      expect(u.fence).toBeGreaterThan(a.fence);
    });

    it("listRecordTypesInUse returns only in-use types, not declared-but-unused", async () => {
      await project.applySchema({
        definition: `
schema_version = 1

[records.declared_only.fields.value]
type = "string"

[records.config.fields.value]
type = "string"
`,
      });
      await project.createRecord({
        type: "config",
        key: "x",
        value: { value: "1" },
      });
      const types = await project.listRecordTypesInUse();
      // In-use only: `config` has an active record, so it appears.
      // `declared_only` is declared in the schema but has no record, so it is
      // EXCLUDED — the merged "declared ∪ in-use" view is composed by callers.
      expect(types).toEqual(["config"]);
    });
  });

  // --- RecordBackend (rejection paths — R3) ---

  describe("RecordBackend rejection paths", () => {
    it("setRecord with a stale fence throws fence-conflict", async () => {
      const c = await project.createRecord({
        type: "config",
        key: "rej1",
        value: { a: 1 },
      });
      // advance the fence once
      await project.patchRecord({
        type: "config",
        key: "rej1",
        patch: { a: 2 },
        fence: c.fence,
      });
      // c.fence is now stale
      await expect(
        project.setRecord({
          type: "config",
          key: "rej1",
          value: { a: 3 },
          fence: c.fence,
        }),
      ).rejects.toThrow();
    });

    it("patchRecord with a stale fence throws fence-conflict", async () => {
      const c = await project.createRecord({
        type: "config",
        key: "rej2",
        value: { a: 1 },
      });
      await project.patchRecord({
        type: "config",
        key: "rej2",
        patch: { a: 2 },
        fence: c.fence,
      });
      await expect(
        project.patchRecord({
          type: "config",
          key: "rej2",
          patch: { a: 3 },
          fence: c.fence,
        }),
      ).rejects.toThrow();
    });

    it("patchRecord on an archived record throws", async () => {
      const c = await project.createRecord({
        type: "config",
        key: "rej3",
        value: { a: 1 },
      });
      const a = await project.archiveRecord({
        type: "config",
        key: "rej3",
        fence: c.fence,
      });
      await expect(
        project.patchRecord({
          type: "config",
          key: "rej3",
          patch: { a: 2 },
          fence: a.fence,
        }),
      ).rejects.toThrow();
    });

    it("setRecord with a stale fence on an archived record throws fence-conflict", async () => {
      // DEVIATION NOTE: the task prompt claims "patchRecord/setRecord on an
      // archived record throws", but `recordOps.setRecord` does NOT guard the
      // archived flag (only `patchRecord` does — see record-ops.ts). A set with
      // a *current* fence on an archived record SUCCEEDS and leaves the record
      // archived (verified). So the rejection that setRecord actually enforces
      // is the FENCE check, which we exercise here.
      const c = await project.createRecord({
        type: "config",
        key: "rej4",
        value: { a: 1 },
      });
      const a = await project.archiveRecord({
        type: "config",
        key: "rej4",
        fence: c.fence,
      });
      // c.fence is stale after archive bumped the fence.
      await expect(
        project.setRecord({
          type: "config",
          key: "rej4",
          value: { a: 2 },
          fence: c.fence,
        }),
      ).rejects.toThrow();
      // The record remains archived and uncorrupted.
      const after = await project.getRecord("config", "rej4");
      expect(after?.archived).toBe(1);
    });

    it("setRecord with a current fence on an archived record succeeds (ops has no archived guard)", async () => {
      const c = await project.createRecord({
        type: "config",
        key: "rej5",
        value: { a: 1 },
      });
      const a = await project.archiveRecord({
        type: "config",
        key: "rej5",
        fence: c.fence,
      });
      const s = await project.setRecord({
        type: "config",
        key: "rej5",
        value: { a: 2 },
        fence: a.fence,
      });
      // Stays archived; value updated; fence/revision advance.
      expect(s.archived).toBe(1);
      expect(s.value).toEqual({ a: 2 });
      expect(s.fence).toBeGreaterThan(a.fence);
    });
  });

  // --- RecordBackend schema-constraint parity with the DO route ---

  describe("RecordBackend constraint validation (DO parity)", () => {
    const SCHEMA_REQUIRED = `
schema_version = 1

[records.config.fields.region]
type = "string"
required = true
`;

    it("createRecord rejects an undeclared record type (matches DO 422)", async () => {
      await project.applySchema({ definition: SCHEMA_REQUIRED });
      await expect(
        project.createRecord({
          type: "not_declared",
          key: "k",
          value: { region: "us" },
        }),
      ).rejects.toThrow(/not declared/);
    });

    it("createRecord rejects a value missing a required field (matches DO 422)", async () => {
      await project.applySchema({ definition: SCHEMA_REQUIRED });
      await expect(
        project.createRecord({
          type: "config",
          key: "missing",
          value: { other: "x" },
        }),
      ).rejects.toThrow(/Required field "region"/);
    });

    it("createRecord ACCEPTS a valid value (positive case)", async () => {
      await project.applySchema({ definition: SCHEMA_REQUIRED });
      const r = await project.createRecord({
        type: "config",
        key: "ok",
        value: { region: "us" },
      });
      expect(r.value).toEqual({ region: "us" });
      expect(r.revision).toBe(1);
    });

    it("setRecord rejects a value missing a required field (matches DO 422)", async () => {
      await project.applySchema({ definition: SCHEMA_REQUIRED });
      const created = await project.createRecord({
        type: "config",
        key: "s1",
        value: { region: "us" },
      });
      await expect(
        project.setRecord({
          type: "config",
          key: "s1",
          value: { other: "y" },
          fence: created.fence,
        }),
      ).rejects.toThrow(/Required field "region"/);
    });

    it("setRecord rejects an undeclared record type (matches DO 422)", async () => {
      await project.applySchema({ definition: SCHEMA_REQUIRED });
      await expect(
        project.setRecord({
          type: "not_declared",
          key: "k",
          value: { region: "us" },
          fence: 1,
        }),
      ).rejects.toThrow(/not declared/);
    });

    it("patchRecord type-checks but does NOT value-validate (DO parity)", async () => {
      await project.applySchema({ definition: SCHEMA_REQUIRED });
      const created = await project.createRecord({
        type: "config",
        key: "p1",
        value: { region: "us" },
      });
      // patch that drops the required field via null still succeeds — the DO
      // patch path does not run validateRecordValue on the merged result.
      const patched = await project.patchRecord({
        type: "config",
        key: "p1",
        patch: { region: null },
        fence: created.fence,
      });
      expect(patched.value).toEqual({});
      // but an undeclared type IS rejected on patch
      await expect(
        project.patchRecord({
          type: "not_declared",
          key: "p1",
          patch: { a: 1 },
          fence: 1,
        }),
      ).rejects.toThrow(/not declared/);
    });

    it("no validation when no schema is applied (permissive, DO parity)", async () => {
      const r = await project.createRecord({
        type: "anything",
        key: "k",
        value: { whatever: true },
      });
      expect(r.revision).toBe(1);
    });
  });

  describe("RecordBackend legacy-default enrichment on getRecord (DO parity)", () => {
    it("getRecord enriches missing fields with default_for_legacy", async () => {
      // v1: config has only `region`.
      await project.applySchema({
        definition: `
schema_version = 1

[records.config.fields.region]
type = "string"
required = true
`,
      });
      const created = await project.createRecord({
        type: "config",
        key: "legacy",
        value: { region: "us" },
      });
      expect(created.value).toEqual({ region: "us" });

      // v2: add `tier` with default_for_legacy.
      const apply = await project.applySchema({
        definition: `
schema_version = 2

[records.config.fields.region]
type = "string"
required = true

[records.config.fields.tier]
type = "string"
required = true
default_for_legacy = "standard"
`,
      });
      expect(apply.ok).toBe(true);

      // getRecord applies the legacy default for the missing `tier` field,
      // exactly as the DO GET route does (record-routes.ts ~536-539).
      const enriched = await project.getRecord("config", "legacy");
      expect(enriched?.value).toEqual({ region: "us", tier: "standard" });

      // list/history are NOT enriched (DO parity): the stored value is raw.
      const list = await project.listRecords({ type: "config" });
      expect(list.items[0].key).toBe("legacy");
      const history = await project.listRecordHistory("config", "legacy", {
        includeValues: true,
      });
      // revision 1 was written under v1 with only `region`; not enriched.
      const rev1 = history.items.find((i) => i.revision === 1);
      expect(rev1?.value).toEqual({ region: "us" });
    });
  });

  // --- Search (tagFilter pass-through) ---

  describe("search", () => {
    it("searchEntities finds created entities and respects tagFilter type", async () => {
      await project.create({
        id: "e1",
        type: "task",
        data: { name: "Deploy pipeline" },
        created_by: "test",
      });
      const results = project.searchEntities({ q: "deploy" });
      expect(results.length).toBe(1);
      expect(results[0].entity_id).toBe("e1");

      // tagFilter for an absent tag => no results (proves pass-through)
      const filtered = project.searchEntities({
        q: "deploy",
        tagFilter: ["nope"],
      });
      expect(filtered.length).toBe(0);
    });

    it("searchAll returns entity results with type field", async () => {
      await project.create({
        id: "e3",
        type: "task",
        data: { name: "Search test entity" },
        created_by: "test",
      });
      const results = project.searchAll({ q: "search" });
      const entityResult = results.find((r) => r.type === "entity");
      expect(entityResult).toBeTruthy();
    });
  });
});
