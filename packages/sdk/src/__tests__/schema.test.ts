import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TilaClient } from "../client";
import { createSchemaMethods } from "../schema";

describe("createSchemaMethods — outgoing request shape", () => {
  const mockFetch = vi.fn();

  beforeEach(() => {
    mockFetch.mockReset();
    vi.stubGlobal("fetch", mockFetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function ok(body: unknown) {
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  function schema() {
    const client = new TilaClient({ baseUrl: "https://api.test", token: "t" });
    return createSchemaMethods(client, "proj-1");
  }

  it("apply() POSTs /projects/:id/schema with { definition, strategy }", async () => {
    mockFetch.mockResolvedValueOnce(ok({ ok: true, version: 2, diff: {} }));

    await schema().apply("schema_version = 1\n", "relax");

    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe("https://api.test/projects/proj-1/schema");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({
      definition: "schema_version = 1\n",
      strategy: "relax",
    });
    // Must NOT use the non-existent /schema/apply route or the `schema` body key.
    expect(url).not.toContain("/schema/apply");
  });

  it("apply() stringifies a non-string definition and omits strategy when unset", async () => {
    mockFetch.mockResolvedValueOnce(ok({ ok: true, version: 1, diff: {} }));

    await schema().apply({ a: 1 });

    const [, init] = mockFetch.mock.calls[0];
    const body = JSON.parse(init.body);
    expect(body.definition).toBe(JSON.stringify({ a: 1 }));
    expect(body.strategy).toBeUndefined();
  });
});
