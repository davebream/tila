import { beforeEach, describe, expect, it, vi } from "vitest";

// ---- Mock seams -----------------------------------------------------------
// Controllable mock state, read by the module mocks below.
const mockState: {
  oidcConfig: { issuer: string; audience: string } | null;
  resolveJwksUri: () => Promise<string>;
  verifyOidcJwt: () => Promise<{
    header: Record<string, unknown>;
    payload: Record<string, unknown>;
  }>;
  principal: { permission: string } | null;
  idempotencyCached: Record<string, unknown> | null;
  stored: Array<{ key: string; body: string }>;
} = {
  oidcConfig: { issuer: "https://idp.example.com", audience: "tila-rp" },
  resolveJwksUri: async () => "https://idp.example.com/keys",
  verifyOidcJwt: async () => ({
    header: {},
    payload: { sub: "workload-1", jti: "jti-1", iat: 1_700_000_000 },
  }),
  principal: { permission: "write" },
  idempotencyCached: null,
  stored: [],
};

vi.mock("@tila/backend-d1", async () => {
  const actual =
    await vi.importActual<typeof import("@tila/backend-d1")>(
      "@tila/backend-d1",
    );
  return {
    ...actual,
    D1ProjectRegistry: class {
      async getOidcConfig() {
        return mockState.oidcConfig;
      }
    },
    OidcPrincipalsStore: class {
      async isAllowed() {
        return mockState.principal;
      }
    },
    D1IdempotencyStore: class {
      async check() {
        return mockState.idempotencyCached
          ? { body: JSON.stringify(mockState.idempotencyCached) }
          : null;
      }
      async store(key: string, _p: string, _s: number, body: string) {
        mockState.stored.push({ key, body });
      }
    },
  };
});

vi.mock("../lib/oidc-discovery", async () => {
  const actual = await vi.importActual<typeof import("../lib/oidc-discovery")>(
    "../lib/oidc-discovery",
  );
  return {
    ...actual,
    resolveJwksUri: () => mockState.resolveJwksUri(),
  };
});

vi.mock("../lib/oidc-verify", async () => {
  const actual =
    await vi.importActual<typeof import("../lib/oidc-verify")>(
      "../lib/oidc-verify",
    );
  return { ...actual, verifyOidcJwt: () => mockState.verifyOidcJwt() };
});

vi.mock("../lib/deployment-instance", () => ({
  ensureDeploymentInstanceId: async () => "inst-test",
}));

import { OidcDiscoveryError } from "../lib/oidc-discovery";
import { OidcVerificationError } from "../lib/oidc-verify";
import type { Env } from "../types";
import { authOidc } from "./auth-oidc";

const TEST_HMAC_KEY = btoa("test-hmac-key-this-is-32-bytes!!")
  .replace(/\+/g, "-")
  .replace(/\//g, "_")
  .replace(/=+$/, "");

const analyticsCalls: Array<{ blobs?: unknown[] }> = [];

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    DB: {} as D1Database,
    PROJECT: {} as DurableObjectNamespace,
    ARTIFACTS: {} as R2Bucket,
    ANALYTICS: {
      writeDataPoint: (d: { blobs?: unknown[] }) => {
        analyticsCalls.push(d);
      },
    } as unknown as AnalyticsEngineDataset,
    GITHUB_SESSION_HMAC_KEY: TEST_HMAC_KEY,
    ...overrides,
  } as unknown as Env;
}

const mockCtx = {
  waitUntil: vi.fn(),
  passThroughOnException: vi.fn(),
} as unknown as ExecutionContext;

function post(body: unknown, env: Env): Promise<Response> {
  return authOidc.fetch(
    new Request("http://localhost/exchange", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "CF-Connecting-IP": "1.2.3.4",
      },
      body: JSON.stringify(body),
    }),
    env,
    mockCtx,
  );
}

const VALID = { project_id: "proj-1", oidc_token: "tok" };

beforeEach(() => {
  analyticsCalls.length = 0;
  mockState.oidcConfig = {
    issuer: "https://idp.example.com",
    audience: "tila-rp",
  };
  mockState.resolveJwksUri = async () => "https://idp.example.com/keys";
  mockState.verifyOidcJwt = async () => ({
    header: {},
    payload: { sub: "workload-1", jti: "jti-1", iat: 1_700_000_000 },
  });
  mockState.principal = { permission: "write" };
  mockState.idempotencyCached = null;
  mockState.stored = [];
});

describe("POST /api/auth/oidc/exchange", () => {
  it("happy path mints an oidc-session", async () => {
    const res = await post(VALID, makeEnv());
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(typeof body.session_token).toBe("string");
    expect((body.session_token as string).startsWith("tila_s.")).toBe(true);
    expect(body.oidc_issuer).toBe("https://idp.example.com");
    expect(body.oidc_subject).toBe("workload-1");
    expect(body.permission).toBe("write");
  });

  it("rejects invalid JSON body with 400", async () => {
    const res = await authOidc.fetch(
      new Request("http://localhost/exchange", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{not json",
      }),
      makeEnv(),
      mockCtx,
    );
    expect(res.status).toBe(400);
  });

  it("returns 500 when HMAC key is unset", async () => {
    const res = await post(
      VALID,
      makeEnv({ GITHUB_SESSION_HMAC_KEY: undefined }),
    );
    expect(res.status).toBe(500);
  });

  it("returns 404 oidc-not-configured when project has no OIDC config", async () => {
    mockState.oidcConfig = null;
    const res = await post(VALID, makeEnv());
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("oidc-not-configured");
  });

  it("returns 502 + issuer-rejected analytics when discovery fails", async () => {
    mockState.resolveJwksUri = async () => {
      throw new OidcDiscoveryError("discovery-unreachable", "boom");
    };
    const res = await post(VALID, makeEnv());
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("issuer-discovery-failed");
    expect(
      analyticsCalls.some((c) =>
        (c.blobs as string[])?.includes("issuer_rejected"),
      ),
    ).toBe(true);
  });

  it("returns 401 + issuer-rejected analytics on an invalid-issuer token", async () => {
    mockState.verifyOidcJwt = async () => {
      throw new OidcVerificationError("oidc-invalid-issuer", "bad iss");
    };
    const res = await post(VALID, makeEnv());
    expect(res.status).toBe(401);
    expect(
      analyticsCalls.some((c) =>
        (c.blobs as string[])?.includes("issuer_rejected"),
      ),
    ).toBe(true);
  });

  it("returns 502 jwks-unavailable (with jwks-empty analytics) when keys are unavailable", async () => {
    mockState.verifyOidcJwt = async () => {
      throw new OidcVerificationError("oidc-jwks-unavailable", "no keys");
    };
    const res = await post(VALID, makeEnv());
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("jwks-unavailable");
    expect(
      analyticsCalls.some((c) => (c.blobs as string[])?.includes("jwks-empty")),
    ).toBe(true);
  });

  it("returns 403 + principal-not-allowed analytics when no principal row", async () => {
    mockState.principal = null;
    const res = await post(VALID, makeEnv());
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("principal-not-allowed");
    expect(
      analyticsCalls.some((c) =>
        (c.blobs as string[])?.includes("principal_not_allowed"),
      ),
    ).toBe(true);
  });

  it("returns 401 when the token has no subject", async () => {
    mockState.verifyOidcJwt = async () => ({
      header: {},
      payload: { jti: "j", iat: 1 },
    });
    const res = await post(VALID, makeEnv());
    expect(res.status).toBe(401);
  });

  it("returns 401 when the token lacks both jti and a numeric iat", async () => {
    mockState.verifyOidcJwt = async () => ({
      header: {},
      payload: { sub: "workload-1" },
    });
    const res = await post(VALID, makeEnv());
    expect(res.status).toBe(401);
  });

  it("returns the cached body on idempotent replay", async () => {
    mockState.idempotencyCached = {
      ok: true,
      session_token: "tila_s.cached",
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      project_id: "proj-1",
      oidc_issuer: "https://idp.example.com",
      oidc_subject: "workload-1",
      permission: "read",
    };
    const res = await post(VALID, makeEnv());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { session_token: string };
    expect(body.session_token).toBe("tila_s.cached");
  });

  it("defaults an unrecognized principal permission to read", async () => {
    mockState.principal = { permission: "superuser" };
    const res = await post(VALID, makeEnv());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { permission: string };
    expect(body.permission).toBe("read");
  });
});
