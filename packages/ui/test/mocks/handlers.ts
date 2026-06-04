import { http, HttpResponse } from "msw";

export const handlers = [
  // List entities
  http.get("*/projects/*/tasks", () => {
    return HttpResponse.json({
      ok: true,
      entities: [
        {
          id: "entity-1",
          type: "task",
          schema_version: 1,
          data: { title: "Test Task 1" },
          archived: 0,
          created_at: Date.now() - 10000,
          updated_at: Date.now() - 5000,
          created_by: "test-user",
        },
        {
          id: "entity-2",
          type: "document",
          schema_version: 1,
          data: { title: "Test Document" },
          archived: 0,
          created_at: Date.now() - 20000,
          updated_at: Date.now() - 10000,
          created_by: "test-user",
        },
        {
          id: "entity-3",
          type: "task",
          schema_version: 1,
          data: { title: "Test Task 2", status: "active" },
          archived: 0,
          created_at: Date.now() - 30000,
          updated_at: Date.now() - 15000,
          created_by: "another-user",
        },
      ],
    });
  }),

  // Get entity detail
  http.get("*/projects/*/tasks/:id", ({ params }) => {
    const { id } = params;
    return HttpResponse.json({
      ok: true,
      entity: {
        id: id as string,
        type: "task",
        schema_version: 1,
        data: { title: "Test Task Detail" },
        archived: 0,
        created_at: Date.now() - 10000,
        updated_at: Date.now() - 5000,
        created_by: "test-user",
      },
    });
  }),

  // List journal events
  http.get("*/projects/*/journal", () => {
    return HttpResponse.json({
      ok: true,
      events: [
        {
          seq: 1,
          t: Date.now() - 30000,
          kind: "entity.created",
          resource: "entity:entity-1",
          actor: "test-user",
          token_id: null,
          fence: null,
          data: { type: "task" },
          source: "cli",
          source_version: "0.4.2",
        },
        {
          seq: 2,
          t: Date.now() - 20000,
          kind: "claim.acquired",
          resource: "claim:claim-1",
          actor: "test-user",
          token_id: null,
          fence: 1,
          data: { fence: 1 },
          source: "mcp",
          source_version: "0.3.1",
        },
        {
          seq: 3,
          t: Date.now() - 10000,
          kind: "artifact.produced",
          resource: "artifact:test.txt",
          actor: "test-user",
          token_id: null,
          fence: null,
          data: { mime_type: "text/plain" },
          source: null,
          source_version: null,
        },
        {
          seq: 4,
          t: Date.now() - 5000,
          kind: "schema.applied",
          resource: "schema:task",
          actor: "test-user",
          token_id: null,
          fence: null,
          data: { version: 2 },
          source: "dashboard",
          source_version: null,
        },
      ],
    });
  }),

  // List presence
  http.get("*/projects/*/presence/all", () => {
    return HttpResponse.json({
      ok: true,
      sessions: [
        {
          actor: "test-user",
          last_seen: Date.now() - 1000,
          active_claims: ["claim-1"],
        },
      ],
    });
  }),

  // List artifacts
  http.get("*/projects/*/artifacts", () => {
    return HttpResponse.json({
      ok: true,
      artifacts: [
        {
          r2_key: "test/artifact-1/abc123.txt",
          resource: "entity:entity-1",
          kind: "output",
          sha256: "abc123",
          bytes: 1024,
          mime_type: "text/plain",
          produced_at: Date.now() - 10000,
          produced_by: "test-user",
          expires_at: null,
          tombstoned: 0,
        },
      ],
    });
  }),

  // Search artifacts
  http.get("*/projects/*/artifacts/search", () => {
    return HttpResponse.json({
      ok: true,
      results: [],
    });
  }),

  // List claims (stub)
  http.get("*/projects/*/claims", () => {
    return HttpResponse.json({
      ok: true,
      claims: [],
    });
  }),

  // Entity artifact refs (stub)
  http.get("*/projects/*/tasks/:id/artifact-refs", () => {
    return HttpResponse.json({
      ok: true,
      references: [],
    });
  }),

  // Artifact blob (stub)
  http.get("*/projects/*/artifacts/*", () => {
    return new HttpResponse("test artifact content", { status: 200 });
  }),

  // Session exchange
  http.post("*/auth/session", () => {
    return HttpResponse.json({ ok: true }, { status: 200 });
  }),

  // Session status
  http.get("*/auth/session/status", () => {
    return HttpResponse.json({
      ok: true,
      projectId: "test-project",
    });
  }),

  // Session logout
  http.post("*/auth/logout", () => {
    return HttpResponse.json({ ok: true }, { status: 200 });
  }),
];
