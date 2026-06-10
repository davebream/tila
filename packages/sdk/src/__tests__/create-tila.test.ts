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
import { createTila, isTilaApiError } from "../client";

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

  it("claims.renew on a missing claim throws a 409 TilaApiError (not {ok:true})", async () => {
    // No claim was ever acquired for this resource — renew must FAIL, mirroring
    // the DO 409 `renew-failed`, NOT silently report success.
    let caught: unknown;
    try {
      await tila.claims.renew("never-claimed", 1, 30_000);
    } catch (err) {
      caught = err;
    }
    expect(isTilaApiError(caught)).toBe(true);
    if (isTilaApiError(caught)) {
      expect(caught.status).toBe(409);
      expect(caught.code).toBe("renew-failed");
    }
  });

  it("claims.renew after release throws 409 (lost-claim contract)", async () => {
    const acq = await tila.claims.acquire("r-renew", "exclusive", 30_000);
    // A valid renew first returns the REAL expiry (not a recomputed value).
    const ok = await tila.claims.renew("r-renew", acq.fence, 30_000);
    expect(ok.ok).toBe(true);
    expect(ok.expires_at).toBeGreaterThan(0);
    // After releasing, the holder has lost the claim → renew must 409.
    await tila.claims.release("r-renew", acq.fence);
    await expect(
      tila.claims.renew("r-renew", acq.fence, 30_000),
    ).rejects.toMatchObject({ status: 409, code: "renew-failed" });
  });

  // Smoke coverage for the previously cast-heavy adapters — proves their wire
  // shapes are correct now that the `as unknown as` casts are removed.
  it("cast-heavy adapters return correct wire shapes", async () => {
    // records.patch / archive / history
    const rec = await tila.records.create("note", {
      key: "rk",
      value: { n: 1 },
    });
    const patched = await tila.records.patch("note", "rk", {
      patch: { n: 2 },
      fence: rec.fence,
    });
    expect(patched.ok).toBe(true);
    expect(patched.record.value).toMatchObject({ n: 2 });
    const archived = await tila.records.archive("note", "rk", {
      fence: patched.fence,
    });
    expect(archived.record.archived).toBe(1);
    const hist = await tila.records.history("note", "rk");
    expect(hist.ok).toBe(true);
    expect(Array.isArray(hist.items)).toBe(true);
    expect(typeof hist.meta.total).toBe("number");

    // claims.get returns { ok, claim }
    const acq = await tila.claims.acquire("smoke-res", "exclusive", 30_000);
    const got = await tila.claims.get("smoke-res");
    expect(got.claim?.fence).toBe(acq.fence);

    // journal.query returns wire events with the full field set
    const journal = await tila.journal.query({ limit: "10" });
    expect(journal.ok).toBe(true);
    expect(journal.events.length).toBeGreaterThan(0);
    const ev = journal.events[0];
    expect(ev).toHaveProperty("token_id");
    expect(ev).toHaveProperty("data");
    expect(ev).toHaveProperty("source");

    // presence.list returns { ok, machines } (NOT { presence })
    await tila.presence.heartbeat("m-1");
    const presence = await tila.presence.list();
    expect(Array.isArray(presence.machines)).toBe(true);
    expect(presence.machines.some((m) => m.machine === "m-1")).toBe(true);

    // schema.get / apply
    const sg = await tila.schema.get();
    expect(sg.ok).toBe(true);
    expect(typeof sg.version).toBe("number");

    // summary.get → { ok, project }
    const summary = await tila.summary.get();
    expect(summary.ok).toBe(true);
    expect(typeof summary.project.entity_count).toBe("number");

    // search.search → { ok, results, total }
    const search = await tila.search.search("smoke");
    expect(search.ok).toBe(true);
    expect(Array.isArray(search.results)).toBe(true);
    expect(typeof search.total).toBe("number");
  });

  it("templates.instantiate returns the wire shape", async () => {
    // Apply a schema (TOML) with a template that has a {{title}} variable.
    const schemaToml = [
      "schema_version = 1",
      "",
      "[work_units.task]",
      "",
      "[templates.sprint]",
      "",
      "[templates.sprint.entities.root]",
      'type = "task"',
      'data = { title = "{{title}}" }',
    ].join("\n");
    await tila.schema.apply(schemaToml);

    // templates.list derives `variables` from the {{...}} placeholders.
    const list = await tila.templates.list();
    const sprint = list.templates.find((t) => t.name === "sprint");
    expect(sprint?.variables).toEqual(["title"]);

    const inst = await tila.templates.instantiate({
      template_name: "sprint",
      root_id: "S1",
      vars: { title: "Sprint One" },
    });
    expect(inst.ok).toBe(true);
    expect(inst.created_entities.length).toBeGreaterThan(0);
    expect(typeof inst.journal_seq).toBe("number");
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

  it("claims.renew rejects with a 409 TilaApiError on the Worker's renew-failed (parity with local)", async () => {
    // The Worker returns 409 `renew-failed`; the HTTP layer surfaces it as a
    // TilaApiError — the SAME error class/branch the local backend now throws.
    mockFetch.mockResolvedValueOnce(
      mockResponse(
        {
          ok: false,
          error: {
            code: "renew-failed",
            message: "Claim not found, expired, or holder mismatch",
            retryable: false,
          },
        },
        409,
      ),
    );
    const tila = await createTila(
      baseConfig({ backend: "cloudflare", worker_url: "https://api.test" }),
      "tok",
    );
    let caught: unknown;
    try {
      await tila.claims.renew("task:T-1", 1, 30_000);
    } catch (err) {
      caught = err;
    }
    expect(isTilaApiError(caught)).toBe(true);
    if (isTilaApiError(caught)) {
      expect(caught.status).toBe(409);
      expect(caught.code).toBe("renew-failed");
    }
  });

  it("claims.acquire rejects with 409 already-held on the Worker's conflict", async () => {
    // The local backend's hardcoded "local" holder makes a true conflict
    // unreachable locally (same holder re-acquires idempotently), but the
    // contract — 409 `already-held` surfaced as a TilaApiError — is exercised
    // here against the remote, the path the adapter guard mirrors.
    mockFetch.mockResolvedValueOnce(
      mockResponse(
        {
          ok: false,
          error: {
            code: "already-held",
            message: "Resource res-1 already held",
            retryable: false,
          },
        },
        409,
      ),
    );
    const tila = await createTila(
      baseConfig({ backend: "cloudflare", worker_url: "https://api.test" }),
      "tok",
    );
    await expect(
      tila.claims.acquire("res-1", "exclusive", 30_000),
    ).rejects.toMatchObject({ status: 409, code: "already-held" });
  });
});

describe("createTila — local & cloudflare expose an IDENTICAL key set", () => {
  const mockFetch = vi.fn();
  let dir: string;
  let local: Awaited<ReturnType<typeof createTila>>;

  beforeEach(async () => {
    vi.stubGlobal("fetch", mockFetch);
    dir = mkdtempSync(join(tmpdir(), "create-tila-keys-"));
    local = await createTila(
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
    local.close();
    rmSync(dir, { recursive: true, force: true });
    vi.unstubAllGlobals();
  });

  it("every resource has the SAME method names across both backends", async () => {
    const remote = await createTila(
      baseConfig({ backend: "cloudflare", worker_url: "https://api.test" }),
      "tok",
    );

    // Every facade key is a resource object except `close` (a function).
    const resourceKeys = (
      Object.keys(local) as Array<keyof typeof local>
    ).filter((k) => k !== "close");

    // The two facades must expose the SAME resource keys.
    expect(resourceKeys.sort()).toEqual(
      (Object.keys(remote) as Array<keyof typeof remote>)
        .filter((k) => k !== "close")
        .sort(),
    );

    // And for EACH resource, the SAME method names — so a missing or misnamed
    // adapter method fails here (belt-and-suspenders with the compile-time
    // _assertLocalSurfaceMatchesFacade contract in resource-adapters.ts).
    for (const key of resourceKeys) {
      const localMethods = Object.keys(
        local[key] as Record<string, unknown>,
      ).sort();
      const remoteMethods = Object.keys(
        remote[key] as Record<string, unknown>,
      ).sort();
      expect(
        localMethods,
        `resource "${String(key)}" method-name parity`,
      ).toEqual(remoteMethods);
    }
  });
});
