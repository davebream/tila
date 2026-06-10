/**
 * `createTila(config, token?)` — uniform resource-method facade over the local
 * (better-sqlite3 + node:fs) and cloudflare (HTTP) backends.
 *
 * The contract this test pins: a consumer calls the SAME resource methods
 * (same names + same argument shapes) regardless of backend. The local branch
 * hits a real `createTilaLocal` temp-dir store; the cloudflare branch hits a
 * mocked `fetch`. HTTP-only resources (token issuance) throw in local.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TilaProjectConfig } from "@tila/schemas";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTila } from "../client";

function baseConfig(
  overrides: Partial<TilaProjectConfig> = {},
): TilaProjectConfig {
  return {
    project_id: "proj-1",
    schema_version: 1,
    tila_version: "0.0.0",
    created_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

describe("createTila — local backend", () => {
  let dir: string;
  let tila: Awaited<ReturnType<typeof createTila>>;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "create-tila-"));
    tila = await createTila(
      baseConfig({
        backend: "local",
        local: {
          db_path: join(dir, "project.db"),
          artifacts_path: join(dir, "artifacts"),
          org: "test-org",
        },
      }),
    );
  });

  afterEach(() => {
    tila.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("exposes the uniform resource surface", () => {
    expect(typeof tila.tasks.create).toBe("function");
    expect(typeof tila.records.set).toBe("function");
    expect(typeof tila.claims.acquire).toBe("function");
    expect(typeof tila.artifacts.writeText).toBe("function");
  });

  it("tasks.create hits the local store", async () => {
    const res = await tila.tasks.create("task-1", "task", {
      title: "local task",
    });
    expect(res.entity.id).toBe("task-1");
    const got = await tila.tasks.get("task-1");
    expect(got.entity.id).toBe("task-1");
  });

  it("tasks.list honors tagFilter locally (only tagged tasks returned)", async () => {
    // Create one tagged + one untagged task through the facade.
    await tila.tasks.create("tagged-1", "task", { title: "has x" }, ["x"]);
    await tila.tasks.create("untagged-1", "task", { title: "no tag" });

    // Sanity: both exist when not filtering.
    const all = await tila.tasks.list({ type: "task" });
    expect(all.entities.map((e) => e.id).sort()).toEqual([
      "tagged-1",
      "untagged-1",
    ]);

    // Filtering by tag "x" returns ONLY the tagged task — proving tagFilter is
    // threaded through to entityOps.list (not silently dropped).
    const filtered = await tila.tasks.list({ tagFilter: ["x"] });
    expect(filtered.entities.map((e) => e.id)).toEqual(["tagged-1"]);
    expect(filtered.entities[0].tags).toContain("x");
  });

  it("records.set + claims.acquire + artifacts.writeText round-trip locally", async () => {
    const created = await tila.records.create("note", {
      key: "k1",
      value: { body: "v1" },
    });
    expect(created.ok).toBe(true);
    expect(created.record.key).toBe("k1");

    const set = await tila.records.set("note", "k1", {
      value: { body: "v2" },
      fence: created.fence,
    });
    expect(set.record.value).toMatchObject({ body: "v2" });

    const acquired = await tila.claims.acquire("res-1", "exclusive", 30_000);
    expect(acquired.fence).toBeGreaterThan(0);

    const art = await tila.artifacts.writeText("hello\n", {
      kind: "text",
      mimeType: "text/plain",
    });
    const read = await tila.artifacts.readText(art.key);
    expect(read?.content).toBe("hello\n");
  });

  it("token issuance throws in local mode", async () => {
    await expect(tila.tokens.issue("agent-1")).rejects.toThrow(
      /not available in local/i,
    );
  });
});

describe("createTila — cloudflare backend", () => {
  const mockFetch = vi.fn();

  beforeEach(() => {
    mockFetch.mockReset();
    vi.stubGlobal("fetch", mockFetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function mockResponse(body: unknown, status = 200) {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }

  it("exposes the SAME resource surface as local", async () => {
    const tila = await createTila(
      baseConfig({
        backend: "cloudflare",
        worker_url: "https://api.test",
      }),
      "tok",
    );
    expect(typeof tila.tasks.create).toBe("function");
    expect(typeof tila.records.set).toBe("function");
    expect(typeof tila.claims.acquire).toBe("function");
    expect(typeof tila.artifacts.writeText).toBe("function");
  });

  it("tasks.create hits HTTP (mock fetch), same call site as local", async () => {
    mockFetch.mockResolvedValueOnce(
      mockResponse({ ok: true, entity: { id: "task-1", type: "task" } }),
    );
    const tila = await createTila(
      baseConfig({ backend: "cloudflare", worker_url: "https://api.test" }),
      "tok",
    );
    const res = await tila.tasks.create("task-1", "task", { title: "remote" });
    expect(res.entity.id).toBe("task-1");
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toContain("/projects/proj-1/tasks");
    expect(init.method).toBe("POST");
  });

  it("claims.acquire posts to the HTTP claims route", async () => {
    mockFetch.mockResolvedValueOnce(
      mockResponse({ ok: true, fence: 7, expires_at: 1, resource: "res-1" }),
    );
    const tila = await createTila(
      baseConfig({ backend: "cloudflare", worker_url: "https://api.test" }),
      "tok",
    );
    const res = await tila.claims.acquire("res-1", "exclusive", 30_000);
    expect(res.fence).toBe(7);
    const [url] = mockFetch.mock.calls[0];
    expect(url).toContain("/projects/proj-1/claims/acquire");
  });
});
