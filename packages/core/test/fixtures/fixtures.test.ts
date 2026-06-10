import { describe, expect, it } from "vitest";
import {
  EntityNotFoundError,
  InMemoryArtifactBackend,
  InMemoryCoordinationBackend,
  InMemoryEntityBackend,
} from "./index";

describe("InMemoryEntityBackend", () => {
  it("create returns entity with server-generated fields", async () => {
    const backend = new InMemoryEntityBackend();
    const entity = await backend.create({
      id: "T-1",
      type: "task",
      data: { title: "Test" },
      created_by: "alice",
    });

    expect(entity.id).toBe("T-1");
    expect(entity.type).toBe("task");
    expect(entity.schema_version).toBe(1);
    expect(entity.archived).toBe(0);
    expect(entity.created_at).toBeGreaterThan(0);
    expect(entity.updated_at).toBeGreaterThan(0);
    expect(entity.created_by).toBe("alice");
  });

  it("list filters by type", async () => {
    const backend = new InMemoryEntityBackend();
    await backend.create({
      id: "T-1",
      type: "task",
      data: {},
      created_by: "alice",
    });
    await backend.create({
      id: "E-1",
      type: "epic",
      data: {},
      created_by: "alice",
    });

    const tasks = await backend.list({ type: "task" });
    expect(tasks).toHaveLength(1);
    expect(tasks[0].type).toBe("task");
  });

  it("list filters by archived", async () => {
    const backend = new InMemoryEntityBackend();
    await backend.create({
      id: "T-1",
      type: "task",
      data: {},
      created_by: "alice",
    });
    await backend.archive("T-1");

    const active = await backend.list({ archived: 0 });
    expect(active).toHaveLength(0);

    const archived = await backend.list({ archived: 1 });
    expect(archived).toHaveLength(1);
  });

  it("update merges data instead of replacing", async () => {
    const backend = new InMemoryEntityBackend();
    await backend.create({
      id: "T-1",
      type: "task",
      data: { title: "Test", priority: "high" },
      created_by: "alice",
    });
    const updated = await backend.update("T-1", { priority: "low" });

    expect(updated.data.title).toBe("Test");
    expect(updated.data.priority).toBe("low");
  });

  it("archive sets archived to 1", async () => {
    const backend = new InMemoryEntityBackend();
    await backend.create({
      id: "T-1",
      type: "task",
      data: {},
      created_by: "alice",
    });
    await backend.archive("T-1");

    const entity = await backend.get("T-1");
    expect(entity?.archived).toBe(1);
  });

  it("getJournal tracks events", async () => {
    const backend = new InMemoryEntityBackend();
    await backend.create({
      id: "T-1",
      type: "task",
      data: {},
      created_by: "alice",
    });
    await backend.update("T-1", { title: "Updated" });

    const journal = backend.getJournal();
    expect(journal).toHaveLength(2);
    expect(journal[0].kind).toBe("entity.created");
    expect(journal[1].kind).toBe("entity.updated");
  });

  it("update on missing entity throws EntityNotFoundError", async () => {
    const backend = new InMemoryEntityBackend();
    await expect(backend.update("missing", {})).rejects.toThrow(
      EntityNotFoundError,
    );
  });
});

describe("InMemoryCoordinationBackend", () => {
  it("first acquire returns acquired=true with fence=1", async () => {
    const backend = new InMemoryCoordinationBackend();
    const result = await backend.acquire(
      "task:T-1",
      "agent-1",
      "agent-1",
      "exclusive",
      30_000,
    );

    expect(result.acquired).toBe(true);
    expect(result.fence).toBe(1);
    expect(result.expires_at).toBeGreaterThan(Date.now() - 1000);
  });

  it("second acquire by different holder returns acquired=false (exclusive)", async () => {
    const backend = new InMemoryCoordinationBackend();
    await backend.acquire(
      "task:T-1",
      "agent-1",
      "agent-1",
      "exclusive",
      30_000,
    );
    const result = await backend.acquire(
      "task:T-1",
      "agent-2",
      "agent-2",
      "exclusive",
      30_000,
    );

    expect(result.acquired).toBe(false);
  });

  it("expired claim returns null from state (lazy expiry)", async () => {
    const backend = new InMemoryCoordinationBackend();
    await backend.acquire("task:T-1", "agent-1", "agent-1", "exclusive", 1); // 1ms TTL

    // Wait for expiry
    await new Promise((r) => setTimeout(r, 10));

    const claim = await backend.state("task:T-1");
    expect(claim).toBeNull();
  });

  it("renew extends expires_at", async () => {
    const backend = new InMemoryCoordinationBackend();
    const { fence } = await backend.acquire(
      "task:T-1",
      "agent-1",
      "agent-1",
      "exclusive",
      1_000,
    );

    const renewed = await backend.renew(
      "task:T-1",
      "agent-1",
      "agent-1",
      fence,
      60_000,
    );
    expect(renewed.renewed).toBe(true);

    const claim = await backend.state("task:T-1");
    if (!claim) throw new Error("claim should not be null after renew");
    expect(claim.expires_at).toBeGreaterThan(Date.now() + 50_000);
  });

  it("release removes claim", async () => {
    const backend = new InMemoryCoordinationBackend();
    const { fence } = await backend.acquire(
      "task:T-1",
      "agent-1",
      "agent-1",
      "exclusive",
      30_000,
    );

    await backend.release("task:T-1", fence);
    const claim = await backend.state("task:T-1");
    expect(claim).toBeNull();
  });

  it("heartbeat and listPresence round-trip", async () => {
    const backend = new InMemoryCoordinationBackend();
    await backend.heartbeat("machine-1", { cpu: 0.5 });
    await backend.heartbeat("machine-2");

    const presence = await backend.listPresence();
    expect(presence).toHaveLength(2);
    expect(presence.find((p) => p.machine === "machine-1")?.info).toEqual({
      cpu: 0.5,
    });
  });
});

describe("InMemoryArtifactBackend", () => {
  it("put then get returns same body", async () => {
    const backend = new InMemoryArtifactBackend();
    await backend.put({
      key: "tasks/T-1/abc.md",
      body: "hello world",
      sha256: "abc123",
      metadata: { author: "alice" },
      contentType: "text/markdown",
    });

    const result = await backend.get("tasks/T-1/abc.md");
    if (!result) throw new Error("result should not be null after put");
    expect(result.metadata.author).toBe("alice");

    // Read body from ReadableStream
    const reader = result.body.getReader();
    const { value } = await reader.read();
    const text = new TextDecoder().decode(value);
    expect(text).toBe("hello world");
  });

  it("list filters by prefix", async () => {
    const backend = new InMemoryArtifactBackend();
    await backend.put({
      key: "tasks/T-1/a.md",
      body: "a",
      sha256: "a",
      metadata: {},
      contentType: "text/plain",
    });
    await backend.put({
      key: "tasks/T-2/b.md",
      body: "b",
      sha256: "b",
      metadata: {},
      contentType: "text/plain",
    });
    await backend.put({
      key: "epics/E-1/c.md",
      body: "c",
      sha256: "c",
      metadata: {},
      contentType: "text/plain",
    });

    const results = await backend.list("tasks/");
    expect(results).toHaveLength(2);
  });

  it("delete removes key", async () => {
    const backend = new InMemoryArtifactBackend();
    await backend.put({
      key: "tasks/T-1/a.md",
      body: "a",
      sha256: "a",
      metadata: {},
      contentType: "text/plain",
    });
    await backend.delete("tasks/T-1/a.md");

    const result = await backend.get("tasks/T-1/a.md");
    expect(result).toBeNull();
  });
});
