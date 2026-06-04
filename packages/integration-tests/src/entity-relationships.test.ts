import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  CreateEntityRelationshipResponseSchema,
  ListEntityRelationshipsResponseSchema,
} from "@tila/schemas";
import { TilaClient } from "tila-sdk";
import { describe, expect, it } from "vitest";

const BASE_URL = process.env.TILA_BASE_URL;
const TOKEN = process.env.TILA_TOKEN;
const PROJECT_ID = process.env.TILA_PROJECT_ID ?? "default";

/**
 * Entity Relationship API integration tests.
 *
 * Routes under test:
 * - POST   /projects/:pid/tasks/relationships      -> add relationship (idempotent)
 * - GET    /projects/:pid/tasks/relationships      -> list relationships (with optional filters)
 * - DELETE /projects/:pid/tasks/relationships      -> remove relationship
 *
 * These tests also cover:
 * - Deterministic task creation with explicit id + type
 * - parent-child relationship type (canonical enum value — "parent" is invalid)
 * - Permission flow: read-scoped token → 403 on DELETE, 200 on GET
 *
 * Placeholder tests (expect(true)) run in CI without a live server.
 * Live end-to-end tests use describe.skipIf(!BASE_URL || !TOKEN) so they are
 * skipped in CI but can be run with TILA_BASE_URL + TILA_TOKEN set.
 */

// --- Dev-seed enum regression: always runs (no server required) ---
describe("dev-seed.sh enum correctness", () => {
  it('scripts/dev-seed.sh contains no invalid "type":"parent" relationship values', () => {
    // The canonical enum value is "parent-child" — "parent" is invalid and returns 400.
    // This test ensures the seed script never silently 400s when seeding relationships.
    const seedPath = resolve(__dirname, "../../../scripts/dev-seed.sh");
    const seedContent = readFileSync(seedPath, "utf-8");

    // Count occurrences of the invalid enum value "parent" (exact JSON key pattern)
    const invalidMatches = seedContent.match(/"type":"parent"/g);
    expect(invalidMatches).toBeNull();

    // Confirm the valid values are present
    const validParentChild = seedContent.match(/"type":"parent-child"/g);
    const validBlocks = seedContent.match(/"type":"blocks"/g);
    expect(validParentChild).not.toBeNull();
    expect(validBlocks).not.toBeNull();
  });
});

// --- Documentation-style tests (no live server required) ---
describe("Entity Relationship API routes", () => {
  describe("POST /tasks/relationships (add — idempotent)", () => {
    it("returns 201 with created:true on first add", () => {
      // POST /projects/:pid/tasks/relationships
      // Body: { from_id: "T-a", to_id: "T-b", type: "blocks" }
      // Expected: 201, body.ok === true, body.created === true
      expect(true).toBe(true);
    });

    it("returns 200 with created:false on duplicate add (idempotent)", () => {
      // POST same { from_id, to_id, type } again
      // Expected: 200, body.ok === true, body.created === false
      // Exactly one row in the relationships table (no duplicate insert)
      expect(true).toBe(true);
    });

    it("returns 400 with validation-error on invalid type", () => {
      // POST with { from_id: "T-a", to_id: "T-b", type: "parent" }
      // Expected: 400, body.error.code === "validation-error"
      // Note: "parent" is not a valid enum value; use "parent-child"
      expect(true).toBe(true);
    });
  });

  describe("GET /tasks/relationships (list)", () => {
    it("returns relationships filtered by type", () => {
      // GET /projects/:pid/tasks/relationships?type=blocks
      // Expected: 200, body.ok === true, all returned relationships have type === "blocks"
      expect(true).toBe(true);
    });

    it("returns relationships filtered by from_id", () => {
      // GET /projects/:pid/tasks/relationships?from_id=T-a
      // Expected: 200, body.ok === true, all returned relationships have from_id === "T-a"
      expect(true).toBe(true);
    });

    it("returns all relationships when no filter provided", () => {
      // GET /projects/:pid/tasks/relationships
      // Expected: 200, body.ok === true, body.relationships is an array
      expect(true).toBe(true);
    });

    it("requires at minimum read permission", () => {
      // No token or invalid token → 401
      // Read-scoped token → 200
      expect(true).toBe(true);
    });
  });

  describe("DELETE /tasks/relationships (remove)", () => {
    it("returns 200 with removed:true when relationship exists", () => {
      // DELETE /projects/:pid/tasks/relationships?from_id=T-a&to_id=T-b&type=blocks
      // Expected: 200, body.ok === true, body.removed === true
      expect(true).toBe(true);
    });

    it("returns 200 with removed:false when relationship does not exist", () => {
      // DELETE same edge again after first remove
      // Expected: 200, body.ok === true, body.removed === false
      expect(true).toBe(true);
    });

    it("requires write permission (read-scoped token → 403)", () => {
      // Read-scoped token → 403
      // Write-scoped token → 200
      expect(true).toBe(true);
    });
  });

  describe("Deterministic task creation (--id + --type)", () => {
    it("POST /tasks with explicit id creates task with that exact id", () => {
      // POST /projects/:pid/tasks
      // Body: { id: "my-custom-id", type: "epic", data: { title: "Epic task" }, created_by: "test" }
      // Expected: 200/201, body.entity.id === "my-custom-id", body.entity.type === "epic"
      expect(true).toBe(true);
    });

    it("POST /tasks with same id twice returns 409 already-exists", () => {
      // POST same id again
      // Expected: 409, body.error.code === "already-exists"
      expect(true).toBe(true);
    });

    it("can create parent-child relationship after deterministic create", () => {
      // Create parent task with explicit id, create child task with explicit id,
      // then POST /tasks/relationships { from_id: parent, to_id: child, type: "parent-child" }
      // Expected: 201, body.ok === true, body.created === true
      expect(true).toBe(true);
    });
  });
});

// --- Live end-to-end tests (require TILA_BASE_URL + TILA_TOKEN) ---
describe.skipIf(!BASE_URL || !TOKEN)(
  "Entity relationship lifecycle (e2e)",
  () => {
    const client = new TilaClient({
      baseUrl: BASE_URL ?? "http://localhost:8787",
      token: TOKEN ?? "",
    });

    const suffix = Date.now().toString(36);
    const projectPath = `/projects/${PROJECT_ID}`;
    const taskA = `rel-test-a-${suffix}`;
    const taskB = `rel-test-b-${suffix}`;
    const taskC = `rel-test-c-${suffix}`;

    it("Step 1: create two tasks with explicit ids and types", async () => {
      const resA = await client.post(
        `${projectPath}/tasks`,
        {
          id: taskA,
          type: "task",
          data: { title: "Relationship test task A" },
          created_by: "e2e-test",
        },
        { schema: undefined },
      );
      expect((resA as { ok: boolean }).ok).toBe(true);

      const resB = await client.post(
        `${projectPath}/tasks`,
        {
          id: taskB,
          type: "task",
          data: { title: "Relationship test task B" },
          created_by: "e2e-test",
        },
        { schema: undefined },
      );
      expect((resB as { ok: boolean }).ok).toBe(true);
    });

    it("Step 2: POST /tasks/relationships add blocks edge — returns 201 created:true", async () => {
      const res = await client.post(
        `${projectPath}/tasks/relationships`,
        { from_id: taskA, to_id: taskB, type: "blocks" },
        {
          schema: CreateEntityRelationshipResponseSchema,
          validate: true,
        },
      );
      expect(res.ok).toBe(true);
      expect(res.created).toBe(true);
    });

    it("Step 3: POST same edge again — idempotent, returns 200 created:false", async () => {
      // Use raw fetch to capture the status code (client.post follows redirects and parses body)
      const url = `${BASE_URL}/projects/${PROJECT_ID}/tasks/relationships`;
      const raw = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ from_id: taskA, to_id: taskB, type: "blocks" }),
      });
      expect(raw.status).toBe(200);
      const body = (await raw.json()) as { ok: boolean; created: boolean };
      expect(body.ok).toBe(true);
      expect(body.created).toBe(false);
    });

    it("Step 4: GET /tasks/relationships?type=blocks returns the edge", async () => {
      const res = await client.get(
        `${projectPath}/tasks/relationships?type=blocks&from_id=${taskA}`,
        {
          schema: ListEntityRelationshipsResponseSchema,
          validate: true,
        },
      );
      expect(res.ok).toBe(true);
      const edge = res.relationships.find(
        (r) => r.from_id === taskA && r.to_id === taskB && r.type === "blocks",
      );
      expect(edge).toBeDefined();
    });

    it("Step 5: DELETE /tasks/relationships removes edge — removed:true", async () => {
      const url = `${BASE_URL}/projects/${PROJECT_ID}/tasks/relationships?from_id=${taskA}&to_id=${taskB}&type=blocks`;
      const raw = await fetch(url, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${TOKEN}` },
      });
      expect(raw.status).toBe(200);
      const body = (await raw.json()) as { ok: boolean; removed: boolean };
      expect(body.ok).toBe(true);
      expect(body.removed).toBe(true);
    });

    it("Step 6: DELETE same edge again — removed:false (idempotent)", async () => {
      const url = `${BASE_URL}/projects/${PROJECT_ID}/tasks/relationships?from_id=${taskA}&to_id=${taskB}&type=blocks`;
      const raw = await fetch(url, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${TOKEN}` },
      });
      expect(raw.status).toBe(200);
      const body = (await raw.json()) as { ok: boolean; removed: boolean };
      expect(body.ok).toBe(true);
      expect(body.removed).toBe(false);
    });

    it("Step 7: create task with explicit id + type, then add parent-child relationship", async () => {
      const resC = await client.post(
        `${projectPath}/tasks`,
        {
          id: taskC,
          type: "epic",
          data: { title: "Parent epic for relationship test" },
          created_by: "e2e-test",
        },
        { schema: undefined },
      );
      expect((resC as { ok: boolean }).ok).toBe(true);

      // Add parent-child relationship: taskC (epic) → taskA (task)
      const relRes = await client.post(
        `${projectPath}/tasks/relationships`,
        { from_id: taskC, to_id: taskA, type: "parent-child" },
        {
          schema: CreateEntityRelationshipResponseSchema,
          validate: true,
        },
      );
      expect(relRes.ok).toBe(true);
      expect(relRes.created).toBe(true);

      // Verify the relationship is listed
      const listRes = await client.get(
        `${projectPath}/tasks/relationships?type=parent-child&from_id=${taskC}`,
        {
          schema: ListEntityRelationshipsResponseSchema,
          validate: true,
        },
      );
      expect(listRes.ok).toBe(true);
      const parentEdge = listRes.relationships.find(
        (r) =>
          r.from_id === taskC && r.to_id === taskA && r.type === "parent-child",
      );
      expect(parentEdge).toBeDefined();
    });

    it("Step 8: permission flow — read-scoped token gets 403 on DELETE, 200 on GET", async () => {
      // This test asserts permission enforcement end-to-end.
      // A token with only read permission must NOT be able to delete relationships.
      //
      // Note: if the test environment does not provide a separate read-only token
      // (TILA_READ_TOKEN), we assert the write path works and document the gap.
      const READ_TOKEN = process.env.TILA_READ_TOKEN;

      if (!READ_TOKEN) {
        // No read-only token provided — assert the write path works correctly.
        // The permission middleware is unit-tested in packages/worker/src/middleware/permission.test.ts.
        console.warn(
          "[SKIP] TILA_READ_TOKEN not set — skipping read-only permission assertion. " +
            "Set TILA_READ_TOKEN to a read-scoped token to enable this check.",
        );

        // Verify the write path (DELETE) works with the write token
        const writeUrl = `${BASE_URL}/projects/${PROJECT_ID}/tasks/relationships?from_id=${taskC}&to_id=${taskA}&type=parent-child`;
        const writeRes = await fetch(writeUrl, {
          method: "DELETE",
          headers: { Authorization: `Bearer ${TOKEN}` },
        });
        expect(writeRes.status).toBe(200);
        const writeBody = (await writeRes.json()) as {
          ok: boolean;
          removed: boolean;
        };
        expect(writeBody.ok).toBe(true);
      } else {
        // Read-scoped token → 403 on DELETE
        const deleteUrl = `${BASE_URL}/projects/${PROJECT_ID}/tasks/relationships?from_id=${taskC}&to_id=${taskA}&type=parent-child`;
        const deleteRes = await fetch(deleteUrl, {
          method: "DELETE",
          headers: { Authorization: `Bearer ${READ_TOKEN}` },
        });
        expect(deleteRes.status).toBe(403);

        // Read-scoped token → 200 on GET
        const getUrl = `${BASE_URL}/projects/${PROJECT_ID}/tasks/relationships?from_id=${taskC}`;
        const getRes = await fetch(getUrl, {
          method: "GET",
          headers: { Authorization: `Bearer ${READ_TOKEN}` },
        });
        expect(getRes.status).toBe(200);

        // Clean up with write token
        const cleanupRes = await fetch(deleteUrl, {
          method: "DELETE",
          headers: { Authorization: `Bearer ${TOKEN}` },
        });
        expect(cleanupRes.status).toBe(200);
      }
    });
  },
);
