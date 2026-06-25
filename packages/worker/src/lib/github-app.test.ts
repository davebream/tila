import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  GitHubAppTokenError,
  checkUserMembership,
  checkUserMembershipStatus,
  getInstallationAccessToken,
  listInstallationRepositories,
  mintAppJwt,
} from "./github-app";
import { exchangeOAuthCode } from "./github-client";

describe("mintAppJwt", () => {
  let testAppId: number;
  let testPrivateKeyPem: string;
  let testPublicKeyPem: string;

  beforeEach(async () => {
    testAppId = 123456;

    // Generate test RSA key pair
    const keyPair = await crypto.subtle.generateKey(
      {
        name: "RSASSA-PKCS1-v1_5",
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: "SHA-256",
      },
      true,
      ["sign", "verify"],
    );

    const privateKeyDer = await crypto.subtle.exportKey(
      "pkcs8",
      keyPair.privateKey,
    );
    const publicKeyDer = await crypto.subtle.exportKey(
      "spki",
      keyPair.publicKey,
    );

    const privateKeyBase64 = btoa(
      String.fromCharCode(...new Uint8Array(privateKeyDer)),
    );
    const publicKeyBase64 = btoa(
      String.fromCharCode(...new Uint8Array(publicKeyDer)),
    );

    testPrivateKeyPem = `-----BEGIN PRIVATE KEY-----\n${privateKeyBase64}\n-----END PRIVATE KEY-----`;
    testPublicKeyPem = `-----BEGIN PUBLIC KEY-----\n${publicKeyBase64}\n-----END PUBLIC KEY-----`;
  });

  it("should generate a valid JWT with correct structure", async () => {
    const jwt = await mintAppJwt(testAppId, testPrivateKeyPem);

    const parts = jwt.split(".");
    expect(parts).toHaveLength(3);

    const header = JSON.parse(
      new TextDecoder().decode(
        Uint8Array.from(
          atob(parts[0].replace(/-/g, "+").replace(/_/g, "/")),
          (c) => c.charCodeAt(0),
        ),
      ),
    );
    expect(header.alg).toBe("RS256");
    expect(header.typ).toBe("JWT");

    const payload = JSON.parse(
      new TextDecoder().decode(
        Uint8Array.from(
          atob(parts[1].replace(/-/g, "+").replace(/_/g, "/")),
          (c) => c.charCodeAt(0),
        ),
      ),
    );
    expect(payload.iss).toBe(testAppId);
    expect(payload.iat).toBeTypeOf("number");
    expect(payload.exp).toBeTypeOf("number");
    expect(payload.exp - payload.iat).toBe(600); // 10 minutes
  });

  it("should generate different JWTs for different app IDs", async () => {
    const jwt1 = await mintAppJwt(111, testPrivateKeyPem);
    const jwt2 = await mintAppJwt(222, testPrivateKeyPem);

    expect(jwt1).not.toBe(jwt2);

    const payload1 = JSON.parse(
      new TextDecoder().decode(
        Uint8Array.from(
          atob(jwt1.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")),
          (c) => c.charCodeAt(0),
        ),
      ),
    );
    const payload2 = JSON.parse(
      new TextDecoder().decode(
        Uint8Array.from(
          atob(jwt2.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")),
          (c) => c.charCodeAt(0),
        ),
      ),
    );

    expect(payload1.iss).toBe(111);
    expect(payload2.iss).toBe(222);
  });
});

describe("getInstallationAccessToken", () => {
  it("should return token on successful response", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ token: "ghs_test_token" }),
    });
    global.fetch = mockFetch;

    const result = await getInstallationAccessToken("app_jwt", 789);

    expect(result).toBe("ghs_test_token");
    expect(mockFetch).toHaveBeenCalledWith(
      "https://api.github.com/app/installations/789/access_tokens",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer app_jwt",
        }),
      }),
    );
  });

  it("should throw on non-200 response", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
    });
    global.fetch = mockFetch;

    await expect(
      getInstallationAccessToken("invalid_jwt", 789),
    ).rejects.toThrow("GitHub API returned 401");
  });

  it("should respect custom apiBase", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ token: "ghs_test_token" }),
    });
    global.fetch = mockFetch;

    await getInstallationAccessToken("app_jwt", 789, "https://ghe.example.com");

    expect(mockFetch).toHaveBeenCalledWith(
      "https://ghe.example.com/app/installations/789/access_tokens",
      expect.any(Object),
    );
  });
});

describe("checkUserMembership", () => {
  it("should return permission on 200 response", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ permission: "admin" }),
    });
    global.fetch = mockFetch;

    const result = await checkUserMembership(
      "installation_token",
      "octocat",
      "hello-world",
      "monalisa",
    );

    expect(result).toBe("admin");
    expect(mockFetch).toHaveBeenCalledWith(
      "https://api.github.com/repos/octocat/hello-world/collaborators/monalisa/permission",
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer installation_token",
        }),
      }),
    );
  });

  it("should return null on non-200 response", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
    });
    global.fetch = mockFetch;

    const result = await checkUserMembership(
      "installation_token",
      "octocat",
      "private-repo",
      "stranger",
    );

    expect(result).toBeNull();
  });

  it("should return null on fetch error", async () => {
    const mockFetch = vi.fn().mockRejectedValue(new Error("Network error"));
    global.fetch = mockFetch;

    const result = await checkUserMembership(
      "installation_token",
      "octocat",
      "hello-world",
      "monalisa",
    );

    expect(result).toBeNull();
  });

  it("should respect custom apiBase", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ permission: "write" }),
    });
    global.fetch = mockFetch;

    await checkUserMembership(
      "installation_token",
      "octocat",
      "hello-world",
      "monalisa",
      "https://ghe.example.com",
    );

    expect(mockFetch).toHaveBeenCalledWith(
      "https://ghe.example.com/repos/octocat/hello-world/collaborators/monalisa/permission",
      expect.any(Object),
    );
  });
});

describe("exchangeOAuthCode", () => {
  it("should return accessToken on successful response", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ access_token: "ghu_xxx" }),
    });
    global.fetch = mockFetch;

    const result = await exchangeOAuthCode(
      "client_id",
      "client_secret",
      "auth_code",
      "https://example.com/callback",
    );

    expect(result).toEqual({ accessToken: "ghu_xxx" });
    expect(mockFetch).toHaveBeenCalledWith(
      "https://github.com/login/oauth/access_token",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Accept: "application/json",
          "Content-Type": "application/json",
        }),
      }),
    );
  });

  it("should throw when GitHub returns error JSON", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ error: "bad_verification_code" }),
    });
    global.fetch = mockFetch;

    await expect(
      exchangeOAuthCode(
        "client_id",
        "client_secret",
        "bad_code",
        "https://example.com/callback",
      ),
    ).rejects.toThrow("GitHub OAuth error: bad_verification_code");
  });

  it("should throw on non-200 response", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
    });
    global.fetch = mockFetch;

    await expect(
      exchangeOAuthCode(
        "client_id",
        "client_secret",
        "code",
        "https://example.com/callback",
      ),
    ).rejects.toThrow("GitHub OAuth token exchange failed: 500");
  });
});

describe("listInstallationRepositories", () => {
  it("should return mapped repos on successful response", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        repositories: [
          {
            id: 1,
            full_name: "octocat/hello-world",
            owner: { login: "octocat" },
            name: "hello-world",
          },
          {
            id: 2,
            full_name: "octocat/other-repo",
            owner: { login: "octocat" },
            name: "other-repo",
          },
        ],
      }),
    });
    global.fetch = mockFetch;

    const result = await listInstallationRepositories("installation_token");

    expect(result).toEqual([
      {
        id: 1,
        fullName: "octocat/hello-world",
        owner: "octocat",
        name: "hello-world",
      },
      {
        id: 2,
        fullName: "octocat/other-repo",
        owner: "octocat",
        name: "other-repo",
      },
    ]);
    expect(mockFetch).toHaveBeenCalledWith(
      "https://api.github.com/installation/repositories?per_page=100&page=1",
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer installation_token",
        }),
      }),
    );
  });

  it("should return empty array when no repositories exist", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ repositories: [] }),
    });
    global.fetch = mockFetch;

    const result = await listInstallationRepositories("installation_token");

    expect(result).toEqual([]);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("should paginate when first page is full", async () => {
    const page1Repos = Array.from({ length: 100 }, (_, i) => ({
      id: i + 1,
      full_name: `octocat/repo-${i + 1}`,
      owner: { login: "octocat" },
      name: `repo-${i + 1}`,
    }));
    const page2Repos = [
      {
        id: 101,
        full_name: "octocat/repo-101",
        owner: { login: "octocat" },
        name: "repo-101",
      },
    ];

    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ repositories: page1Repos }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ repositories: page2Repos }),
      });
    global.fetch = mockFetch;

    const result = await listInstallationRepositories("installation_token");

    expect(result).toHaveLength(101);
    expect(result[100]).toEqual({
      id: 101,
      fullName: "octocat/repo-101",
      owner: "octocat",
      name: "repo-101",
    });
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(mockFetch).toHaveBeenNthCalledWith(
      2,
      "https://api.github.com/installation/repositories?per_page=100&page=2",
      expect.any(Object),
    );
  });

  it("should throw on non-200 response", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
    });
    global.fetch = mockFetch;

    await expect(listInstallationRepositories("invalid_token")).rejects.toThrow(
      "GitHub API returned 401",
    );
  });
});

describe("checkUserMembershipStatus", () => {
  it("returns {kind:'permission',value} on 200 response", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ permission: "admin" }),
    });
    global.fetch = mockFetch;

    const result = await checkUserMembershipStatus(
      "installation_token",
      "octocat",
      "hello-world",
      "monalisa",
    );

    expect(result).toEqual({ kind: "permission", value: "admin" });
  });

  it("returns {kind:'absent'} on 404 response", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
    });
    global.fetch = mockFetch;

    const result = await checkUserMembershipStatus(
      "installation_token",
      "octocat",
      "private-repo",
      "stranger",
    );

    expect(result).toEqual({ kind: "absent" });
  });

  it("returns {kind:'error'} on non-200/non-404 response (500)", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
    });
    global.fetch = mockFetch;

    const result = await checkUserMembershipStatus(
      "installation_token",
      "octocat",
      "hello-world",
      "monalisa",
    );

    expect(result).toEqual({ kind: "error" });
  });

  it("returns {kind:'error'} on network throw", async () => {
    const mockFetch = vi.fn().mockRejectedValue(new Error("Network error"));
    global.fetch = mockFetch;

    const result = await checkUserMembershipStatus(
      "installation_token",
      "octocat",
      "hello-world",
      "monalisa",
    );

    expect(result).toEqual({ kind: "error" });
  });
});

describe("checkUserMembership (thin wrapper over checkUserMembershipStatus)", () => {
  it("returns permission value on 200", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ permission: "admin" }),
    });
    global.fetch = mockFetch;

    const result = await checkUserMembership(
      "installation_token",
      "octocat",
      "hello-world",
      "monalisa",
    );

    expect(result).toBe("admin");
  });

  it("returns null on 404", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
    });
    global.fetch = mockFetch;

    const result = await checkUserMembership(
      "installation_token",
      "octocat",
      "private-repo",
      "stranger",
    );

    expect(result).toBeNull();
  });

  it("returns null on 500", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
    });
    global.fetch = mockFetch;

    const result = await checkUserMembership(
      "installation_token",
      "octocat",
      "hello-world",
      "monalisa",
    );

    expect(result).toBeNull();
  });
});

describe("GitHubAppTokenError", () => {
  it("getInstallationAccessToken throws GitHubAppTokenError with .status on 404", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
    });
    global.fetch = mockFetch;

    const err = await getInstallationAccessToken("app_jwt", 789).catch(
      (e) => e,
    );
    expect(err).toBeInstanceOf(GitHubAppTokenError);
    expect((err as GitHubAppTokenError).status).toBe(404);
  });

  it("getInstallationAccessToken throws GitHubAppTokenError with .status on 500", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
    });
    global.fetch = mockFetch;

    const err = await getInstallationAccessToken("app_jwt", 789).catch(
      (e) => e,
    );
    expect(err).toBeInstanceOf(GitHubAppTokenError);
    expect((err as GitHubAppTokenError).status).toBe(500);
  });
});
