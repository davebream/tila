import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createCustomDomain,
  resolveZoneId,
} from "../../lib/cloudflare-resources";

describe("resolveZoneId", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns zone_id when zone is found for bare domain", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          result: [{ id: "zone-abc-123", name: "acme.com" }],
        }),
        { status: 200 },
      ),
    );

    const zoneId = await resolveZoneId("token123", "account456", "acme.com");

    expect(zoneId).toBe("zone-abc-123");
    expect(fetch).toHaveBeenCalledWith(
      "https://api.cloudflare.com/client/v4/zones?name=acme.com&account.id=account456",
      expect.objectContaining({
        headers: { Authorization: "Bearer token123" },
      }),
    );
  });

  it("extracts domain from subdomain hostname (tila.acme.com → tries acme.com)", async () => {
    // First call for "acme.com" (the candidate from stripping "tila.")
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          result: [{ id: "zone-xyz-789", name: "acme.com" }],
        }),
        { status: 200 },
      ),
    );

    const zoneId = await resolveZoneId(
      "token123",
      "account456",
      "tila.acme.com",
    );

    expect(zoneId).toBe("zone-xyz-789");
    // Should have called with acme.com (the domain portion)
    expect(fetch).toHaveBeenCalledWith(
      "https://api.cloudflare.com/client/v4/zones?name=acme.com&account.id=account456",
      expect.anything(),
    );
  });

  it("throws when zone is not found (empty result)", async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ result: [] }), { status: 200 }),
    );

    await expect(
      resolveZoneId("token123", "account456", "unknown.example.com"),
    ).rejects.toThrow(/No Cloudflare zone found/);
  });

  it("throws with API error response", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response("Unauthorized", { status: 401 }),
    );

    await expect(
      resolveZoneId("bad-token", "account456", "acme.com"),
    ).rejects.toThrow(/HTTP 401/);
  });

  it("handles multi-level subdomain (a.b.acme.com) by finding acme.com", async () => {
    // First candidate "b.acme.com" → no results
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ result: [] }), { status: 200 }),
    );
    // Second candidate "acme.com" → zone found
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          result: [{ id: "zone-deep-123", name: "acme.com" }],
        }),
        { status: 200 },
      ),
    );

    const zoneId = await resolveZoneId(
      "token123",
      "account456",
      "a.b.acme.com",
    );

    expect(zoneId).toBe("zone-deep-123");
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});

describe("createCustomDomain", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const opts = {
    apiToken: "token123",
    accountId: "account456",
    zoneId: "zone-abc",
    hostname: "tila.acme.com",
    service: "tila",
  };

  it("resolves on success (200)", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(
        JSON.stringify({ result: { id: "domain-1" }, success: true }),
        { status: 200 },
      ),
    );

    await expect(createCustomDomain(opts)).resolves.toBeUndefined();

    expect(fetch).toHaveBeenCalledWith(
      "https://api.cloudflare.com/client/v4/accounts/account456/workers/domains",
      expect.objectContaining({
        method: "PUT",
        headers: expect.objectContaining({
          Authorization: "Bearer token123",
          "Content-Type": "application/json",
        }),
      }),
    );

    // Verify body contents
    const call = vi.mocked(fetch).mock.calls[0];
    const body = JSON.parse(call[1]?.body as string);
    expect(body).toEqual({
      zone_id: "zone-abc",
      hostname: "tila.acme.com",
      service: "tila",
      environment: "production",
    });
  });

  it("does not throw on 409 (idempotent — domain already attached)", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ errors: [{ code: 10013 }] }), {
        status: 409,
      }),
    );

    await expect(createCustomDomain(opts)).resolves.toBeUndefined();
  });

  it("throws on 400 error", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          errors: [{ message: "zone not active" }],
        }),
        { status: 400 },
      ),
    );

    await expect(createCustomDomain(opts)).rejects.toThrow(/HTTP 400/);
  });

  it("throws on 500 error", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response("Internal Server Error", { status: 500 }),
    );

    await expect(createCustomDomain(opts)).rejects.toThrow(/HTTP 500/);
  });

  it("uses 'production' as default environment", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ success: true }), { status: 200 }),
    );

    await createCustomDomain(opts);

    const call = vi.mocked(fetch).mock.calls[0];
    const body = JSON.parse(call[1]?.body as string);
    expect(body.environment).toBe("production");
  });

  it("allows overriding environment", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ success: true }), { status: 200 }),
    );

    await createCustomDomain({ ...opts, environment: "staging" });

    const call = vi.mocked(fetch).mock.calls[0];
    const body = JSON.parse(call[1]?.body as string);
    expect(body.environment).toBe("staging");
  });
});
