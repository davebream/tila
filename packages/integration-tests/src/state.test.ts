import {
  type AcquireSuccessResponse,
  AcquireSuccessResponseSchema,
  type StateListResponse,
  StateListResponseSchema,
  StateResponseSchema,
} from "@tila/schemas";
import { TilaClient } from "tila-sdk";
import { describe, expect, it } from "vitest";

const BASE_URL = process.env.TILA_BASE_URL;
const TOKEN = process.env.TILA_TOKEN;
const PROJECT_ID = process.env.TILA_PROJECT_ID ?? "default";

describe.skipIf(!BASE_URL || !TOKEN)("tila state", () => {
  const client = new TilaClient({
    baseUrl: BASE_URL ?? "http://localhost:8787",
    token: TOKEN ?? "",
  });

  const projectPath = `/projects/${PROJECT_ID}`;
  const resource1 = `state-test-res1-${Date.now()}`;
  const resource2 = `state-test-res2-${Date.now()}`;
  const holder = "state-test-holder";

  // AC-1: tila state <resource> with active claim shows machine, user, mode, fence, TTL
  it("should show claim details for a resource with an active claim", async () => {
    const acquireRes = await client.post<AcquireSuccessResponse>(
      `${projectPath}/claims/acquire`,
      {
        resource: resource1,
        mode: "exclusive",
        ttl_ms: 60_000,
      },
      { schema: AcquireSuccessResponseSchema, validate: true },
    );

    expect(acquireRes.ok).toBe(true);
    expect(acquireRes.fence).toBeGreaterThan(0);
    expect(acquireRes.expires_at).toBeGreaterThan(Date.now());

    const stateRes = await client.get(
      `${projectPath}/claims/state/${resource1}`,
      { schema: StateResponseSchema, validate: true },
    );

    expect(stateRes.ok).toBe(true);
    expect(stateRes.claim).not.toBeNull();
    expect(stateRes.claim?.resource).toBe(resource1);
    expect(stateRes.claim?.machine).toBeTruthy();
    expect(stateRes.claim?.user).toBeTruthy();
    expect(stateRes.claim?.mode).toBe("exclusive");
    expect(stateRes.claim?.fence).toBe(acquireRes.fence);
    expect(stateRes.claim?.expires_at).toBe(acquireRes.expires_at);
  });

  // AC-3: tila state <resource> with no claim shows "unclaimed"
  it("should return null claim for a resource with no active claim", async () => {
    const neverClaimed = `never-claimed-${Date.now()}`;

    const res = await client.get(
      `${projectPath}/claims/state/${neverClaimed}`,
      { schema: StateResponseSchema, validate: true },
    );

    expect(res.ok).toBe(true);
    expect(res.claim).toBeNull();
  });

  // AC-2: tila state list shows all active claims
  it("should list all active claims across resources", async () => {
    // Acquire claim on resource2 (resource1 already claimed in first test)
    await client.post(
      `${projectPath}/claims/acquire`,
      {
        resource: resource2,
        mode: "exclusive",
        ttl_ms: 60_000,
      },
      { schema: AcquireSuccessResponseSchema, validate: true },
    );

    const res = await client.get(`${projectPath}/claims`, {
      schema: StateListResponseSchema,
      validate: true,
    });

    expect(res.ok).toBe(true);
    expect(res.claims.length).toBeGreaterThanOrEqual(2);

    // Find our two resources in the list
    const ourClaims = res.claims.filter(
      (c: StateListResponse["claims"][number]) =>
        c.resource === resource1 || c.resource === resource2,
    );
    expect(ourClaims.length).toBe(2);

    for (const claim of ourClaims) {
      expect(claim.machine).toBeTruthy();
      expect(claim.user).toBeTruthy();
      expect(claim.mode).toBe("exclusive");
      expect(claim.fence).toBeGreaterThan(0);
      expect(claim.expires_at).toBeGreaterThan(Date.now());
    }
  });

  // AC-7: tila state --json outputs valid JSON matching StateResponseSchema
  it("should return valid JSON matching StateResponseSchema", async () => {
    const res = await client.get(`${projectPath}/claims/state/${resource1}`, {
      schema: StateResponseSchema,
      validate: true,
    });

    // If we reach here without throwing, the Zod schema parse succeeded
    expect(res.ok).toBe(true);
    // Verify the claim object has all expected fields when present
    if (res.claim) {
      expect(typeof res.claim.resource).toBe("string");
      expect(typeof res.claim.machine).toBe("string");
      expect(typeof res.claim.user).toBe("string");
      expect(typeof res.claim.mode).toBe("string");
      expect(typeof res.claim.fence).toBe("number");
      expect(typeof res.claim.acquired_at).toBe("number");
      expect(typeof res.claim.expires_at).toBe("number");
    }
  });
});
