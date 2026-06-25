/**
 * Tests for the github credential provider (C4).
 *
 * TDD: these tests are written BEFORE the implementation.
 *
 * Key assertions:
 * - mint issues the device-code POST to GitHub's device auth endpoint
 * - mint polls the token endpoint with GitHub's token URL
 * - scope "repo" is sent in the device auth request
 * - client_id comes from ProviderContext.client_id (caller-resolved), NOT a hidden fetch/fs call
 * - expires_in present → expires_at = clock.now() + expires_in * 1000
 * - expires_in absent → expires_at = null
 * - refresh delegates to mint (GitHub device tokens are not refreshable)
 * - mint with no client_id in context → typed MissingClientIdError
 */

import type { InstanceKey } from "@tila/schemas";
import { afterEach, describe, expect, it } from "vitest";
import { MissingClientIdError } from "../errors.js";
import { createGithubProvider } from "./github.js";
import { FakeClock, FakeFetch, FakePrompter, FakeRunCommand } from "./ports.js";
import type { ProviderContext, ProviderPorts } from "./types.js";

// ---------------------------------------------------------------------------
// Constants (must match the provider exactly)
// ---------------------------------------------------------------------------

const GITHUB_DEVICE_AUTH_URL = "https://github.com/login/device/code";
const GITHUB_TOKEN_URL = "https://github.com/login/oauth/access_token";
const TEST_CLIENT_ID = "Iv1.test_client_id_123";

// ---------------------------------------------------------------------------
// Response factories
// ---------------------------------------------------------------------------

function makeDeviceAuthResponse() {
  return {
    device_code: "device_code_abc",
    user_code: "USER-CODE",
    verification_uri: "https://github.com/login/device",
    expires_in: 900,
    interval: 5,
  };
}

function makeTokenResponse(opts?: {
  expires_in?: number;
  refresh_token?: string;
  scope?: string;
}) {
  return {
    access_token: "ghu_test_access_token",
    token_type: "bearer",
    ...opts,
  };
}

// ---------------------------------------------------------------------------
// Context builder
// ---------------------------------------------------------------------------

function makeCtx(
  ff: FakeFetch,
  clock: FakeClock,
  clientId?: string,
): ProviderContext {
  const ports: ProviderPorts = {
    fetch: ff.fetch,
    prompter: new FakePrompter(),
    env: { isCI: false, isTTY: true },
    clock,
    runCommand: new FakeRunCommand().run,
  };

  return {
    instance_key: "inst_test" as InstanceKey,
    worker_url: "https://tila.example.com",
    ports,
    config: { kind: "github" },
    // client_id is the caller-resolved GitHub App client_id.
    // The provider reads this from ctx.client_id (NOT from a fetch/fs side-channel).
    client_id: clientId,
  } as ProviderContext;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("github provider — mint", () => {
  it("posts to GitHub device auth endpoint with scope=repo and context client_id", async () => {
    const ff = new FakeFetch();
    const clock = new FakeClock(1_000_000_000_000);

    ff.pushJson(200, makeDeviceAuthResponse());
    ff.pushJson(200, makeTokenResponse());

    const provider = createGithubProvider();
    const ctx = makeCtx(ff, clock, TEST_CLIENT_ID);

    await provider.mint(ctx);

    // First call: device auth POST to GitHub's device auth endpoint
    expect(ff.calls[0].url).toBe(GITHUB_DEVICE_AUTH_URL);
    expect(ff.calls[0].init?.method).toBe("POST");

    // Verify request body contains ctx.client_id and scope=repo
    const body = ff.calls[0].init?.body;
    const params =
      body instanceof URLSearchParams
        ? body
        : new URLSearchParams(body as string);
    expect(params.get("client_id")).toBe(TEST_CLIENT_ID);
    expect(params.get("scope")).toBe("repo");

    ff.assertExhausted();
  });

  it("polls the GitHub token endpoint with correct fields", async () => {
    const ff = new FakeFetch();
    const clock = new FakeClock(1_000_000_000_000);

    ff.pushJson(200, makeDeviceAuthResponse());
    ff.pushJson(200, makeTokenResponse());

    const provider = createGithubProvider();
    const ctx = makeCtx(ff, clock, TEST_CLIENT_ID);

    await provider.mint(ctx);

    // Second call: token endpoint poll
    expect(ff.calls[1].url).toBe(GITHUB_TOKEN_URL);
    expect(ff.calls[1].init?.method).toBe("POST");

    const body = ff.calls[1].init?.body;
    const params =
      body instanceof URLSearchParams
        ? body
        : new URLSearchParams(body as string);
    expect(params.get("client_id")).toBe(TEST_CLIENT_ID);
    expect(params.get("device_code")).toBe("device_code_abc");
    expect(params.get("grant_type")).toBe(
      "urn:ietf:params:oauth:grant-type:device_code",
    );

    ff.assertExhausted();
  });

  it("converts expires_in to expires_at via clock.now() + expires_in * 1000", async () => {
    const ff = new FakeFetch();
    // FakeClock initial time; autoAdvance=true so sleep(5000) → currentTime += 5000
    const clock = new FakeClock(1_000_000_000_000);

    const expiresIn = 28800; // 8 hours in seconds
    ff.pushJson(200, makeDeviceAuthResponse()); // interval=5 → sleep(5000ms)
    ff.pushJson(200, makeTokenResponse({ expires_in: expiresIn }));

    const provider = createGithubProvider();
    const ctx = makeCtx(ff, clock, TEST_CLIENT_ID);

    const result = await provider.mint(ctx);

    // After one sleep(5000ms), clock.now() = 1_000_000_005_000
    // expires_at = clock.now() + expiresIn * 1000
    // clock.now() is read AFTER the sleep in the poll loop
    const expectedNow = 1_000_000_005_000;
    expect(result.expires_at).toBe(expectedNow + expiresIn * 1000);

    ff.assertExhausted();
  });

  it("maps absent expires_in to expires_at: null", async () => {
    const ff = new FakeFetch();
    const clock = new FakeClock(1_000_000_000_000);

    ff.pushJson(200, makeDeviceAuthResponse());
    ff.pushJson(200, { access_token: "ghu_no_expiry_token" });

    const provider = createGithubProvider();
    const ctx = makeCtx(ff, clock, TEST_CLIENT_ID);

    const result = await provider.mint(ctx);

    expect(result.expires_at).toBeNull();
    ff.assertExhausted();
  });

  it("returns a MintedCredential with token and token_type=github-user-token", async () => {
    const ff = new FakeFetch();
    const clock = new FakeClock(1_000_000_000_000);

    ff.pushJson(200, makeDeviceAuthResponse());
    ff.pushJson(200, makeTokenResponse({ scope: "repo" }));

    const provider = createGithubProvider();
    const ctx = makeCtx(ff, clock, TEST_CLIENT_ID);

    const result = await provider.mint(ctx);

    expect(result.token).toBe("ghu_test_access_token");
    expect(result.token_type).toBe("github-user-token");
    expect(result.scope).toBe("repo");

    ff.assertExhausted();
  });

  it("throws MissingClientIdError when no client_id in context", async () => {
    const ff = new FakeFetch();
    const clock = new FakeClock(1_000_000_000_000);

    const provider = createGithubProvider();
    // No client_id passed → ctx.client_id is undefined
    const ctx = makeCtx(ff, clock, undefined);

    await expect(provider.mint(ctx)).rejects.toThrow(MissingClientIdError);

    // No fetch calls should have been made (error is before network)
    expect(ff.calls).toHaveLength(0);
  });
});

describe("github provider — refresh", () => {
  it("delegates refresh to mint (GitHub device tokens are not refreshable)", async () => {
    const ff = new FakeFetch();
    const clock = new FakeClock(1_000_000_000_000);

    // refresh calls mint, which needs the same 2 responses
    ff.pushJson(200, makeDeviceAuthResponse());
    ff.pushJson(200, makeTokenResponse());

    const provider = createGithubProvider();
    const ctx = makeCtx(ff, clock, TEST_CLIENT_ID);

    const prior = {
      instance_key: "inst_test" as InstanceKey,
      refresh_token: "old_refresh_token",
      expires_at: null,
      obtained_at: Date.now(),
    };

    const result = await provider.refresh(ctx, prior);

    // Should succeed just like mint
    expect(result.token).toBe("ghu_test_access_token");
    // Two fetch calls: device auth + token poll (same as mint)
    expect(ff.calls).toHaveLength(2);
    expect(ff.calls[0].url).toBe(GITHUB_DEVICE_AUTH_URL);
    expect(ff.calls[1].url).toBe(GITHUB_TOKEN_URL);

    ff.assertExhausted();
  });
});

describe("github provider — revoke", () => {
  it("completes without error (clears provider-local cache — no keychain access)", async () => {
    const ff = new FakeFetch();
    const clock = new FakeClock(1_000_000_000_000);

    const provider = createGithubProvider();
    const ctx = makeCtx(ff, clock, TEST_CLIENT_ID);

    const cred = {
      instance_key: "inst_test" as InstanceKey,
      token: "ghu_test_access_token",
      token_type: "github-user-token",
      expires_at: null,
      obtained_at: Date.now(),
    };

    await expect(provider.revoke(ctx, cred)).resolves.toBeUndefined();

    // No fetch calls: revoke only clears provider-local state
    expect(ff.calls).toHaveLength(0);
  });
});

describe("github provider — kind", () => {
  it('has kind "github"', () => {
    const provider = createGithubProvider();
    expect(provider.kind).toBe("github");
  });
});

describe("createProvider factory — github", () => {
  it('createProvider("github") returns a real provider (no longer throws)', async () => {
    const { createProvider } = await import("./index.js");
    const provider = createProvider("github");
    expect(provider.kind).toBe("github");
  });
});
