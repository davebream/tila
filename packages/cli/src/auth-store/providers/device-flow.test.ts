/**
 * Tests for the parameterized RFC 8628 device-flow helper.
 *
 * Uses FakeFetch + FakeClock — NO real timers.
 * Verifies: pending→poll, slow_down monotonic interval (RC-2), success, error
 * states, attempt cap, verification_uri validation.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DeviceFlowError } from "../errors.js";
import { runDeviceFlow } from "./device-flow.js";
import { FakeClock, FakeFetch, FakePrompter } from "./ports.js";
import type { ProviderPorts } from "./types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDeviceAuthResponse(overrides: Record<string, unknown> = {}) {
  return {
    device_code: "dev_code_abc",
    user_code: "ABCD-1234",
    verification_uri: "https://example.com/activate",
    expires_in: 900,
    interval: 5,
    ...overrides,
  };
}

function makePorts(fakeFetch: FakeFetch, fakeClock: FakeClock): ProviderPorts {
  return {
    fetch: fakeFetch.fetch,
    prompter: new FakePrompter(),
    env: { isCI: false, isTTY: true },
    clock: fakeClock,
    runCommand: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
  };
}

const DEVICE_AUTH_URL = "https://example.com/device/code";
const TOKEN_URL = "https://example.com/token";
const CLIENT_ID = "client-test-123";
const SCOPE = "openid profile";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("runDeviceFlow", () => {
  let fakeFetch: FakeFetch;
  let fakeClock: FakeClock;
  let ports: ProviderPorts;

  beforeEach(() => {
    fakeFetch = new FakeFetch();
    fakeClock = new FakeClock();
    ports = makePorts(fakeFetch, fakeClock);
  });

  afterEach(() => {
    fakeFetch.assertExhausted();
  });

  // --- Success path ---

  it("returns token on immediate success", async () => {
    fakeFetch.pushJson(200, makeDeviceAuthResponse());
    fakeFetch.pushJson(200, {
      access_token: "tok_abc",
      expires_in: 3600,
      scope: "openid",
    });

    const result = await runDeviceFlow({
      deviceAuthorizationEndpoint: DEVICE_AUTH_URL,
      tokenEndpoint: TOKEN_URL,
      clientId: CLIENT_ID,
      scope: SCOPE,
      ports,
    });

    expect(result.access_token).toBe("tok_abc");
    expect(result.expires_in).toBe(3600);
    expect(result.scope).toBe("openid");
  });

  it("returns refresh_token when present", async () => {
    fakeFetch.pushJson(200, makeDeviceAuthResponse());
    fakeFetch.pushJson(200, {
      access_token: "tok_abc",
      refresh_token: "ref_xyz",
    });

    const result = await runDeviceFlow({
      deviceAuthorizationEndpoint: DEVICE_AUTH_URL,
      tokenEndpoint: TOKEN_URL,
      clientId: CLIENT_ID,
      scope: SCOPE,
      ports,
    });

    expect(result.refresh_token).toBe("ref_xyz");
  });

  // --- authorization_pending: polls again ---

  it("polls again on authorization_pending, then succeeds", async () => {
    fakeFetch.pushJson(200, makeDeviceAuthResponse({ interval: 5 }));
    // first poll: pending
    fakeFetch.pushJson(200, { error: "authorization_pending" });
    // second poll: success
    fakeFetch.pushJson(200, { access_token: "tok_success" });

    // We need to advance the clock for each sleep
    // The device flow will sleep(5000) before first poll
    fakeClock.autoAdvance = true;

    const result = await runDeviceFlow({
      deviceAuthorizationEndpoint: DEVICE_AUTH_URL,
      tokenEndpoint: TOKEN_URL,
      clientId: CLIENT_ID,
      scope: SCOPE,
      ports,
    });

    expect(result.access_token).toBe("tok_success");
    // Clock was advanced twice (2 × 5000ms)
    expect(fakeClock.totalSlept).toBe(10000);
  });

  // --- slow_down: interval must be monotonically increasing (RC-2) ---

  it("increases interval on slow_down and never decreases (RC-2)", async () => {
    fakeFetch.pushJson(200, makeDeviceAuthResponse({ interval: 5 }));
    // First poll: slow_down (should increase interval from 5 to 10)
    fakeFetch.pushJson(200, { error: "slow_down" });
    // Second poll: slow_down again (should increase interval from 10 to 15)
    fakeFetch.pushJson(200, { error: "slow_down" });
    // Third poll: success
    fakeFetch.pushJson(200, { access_token: "tok_slow" });

    fakeClock.autoAdvance = true;

    await runDeviceFlow({
      deviceAuthorizationEndpoint: DEVICE_AUTH_URL,
      tokenEndpoint: TOKEN_URL,
      clientId: CLIENT_ID,
      scope: SCOPE,
      ports,
    });

    // Sleeps: 5000 + 10000 + 15000 = 30000ms (intervals: 5s, 10s, 15s)
    expect(fakeClock.sleepHistory).toEqual([5000, 10000, 15000]);
    // Verify monotonically increasing
    for (let i = 1; i < fakeClock.sleepHistory.length; i++) {
      expect(fakeClock.sleepHistory[i]).toBeGreaterThan(
        fakeClock.sleepHistory[i - 1],
      );
    }
  });

  it("honors server-sent interval from slow_down response", async () => {
    // Server sends interval:10 in the slow_down response itself
    fakeFetch.pushJson(200, makeDeviceAuthResponse({ interval: 5 }));
    fakeFetch.pushJson(200, { error: "slow_down", interval: 10 });
    fakeFetch.pushJson(200, { access_token: "tok_ok" });

    fakeClock.autoAdvance = true;

    await runDeviceFlow({
      deviceAuthorizationEndpoint: DEVICE_AUTH_URL,
      tokenEndpoint: TOKEN_URL,
      clientId: CLIENT_ID,
      scope: SCOPE,
      ports,
    });

    // First sleep is 5s, after slow_down with interval=10, second sleep is 10+5=15s
    expect(fakeClock.sleepHistory[0]).toBe(5000);
    // After slow_down, interval increases — must be > 5000 and >= 15000 (server says 10, +5 = 15)
    expect(fakeClock.sleepHistory[1]).toBeGreaterThanOrEqual(15000);
  });

  it("caps slow_down interval at 60 seconds", async () => {
    fakeFetch.pushJson(200, makeDeviceAuthResponse({ interval: 55 }));
    // slow_down when already at 55 → 55+5=60 (at cap)
    fakeFetch.pushJson(200, { error: "slow_down" });
    // slow_down again → stays at 60 (cap)
    fakeFetch.pushJson(200, { error: "slow_down" });
    fakeFetch.pushJson(200, { access_token: "tok_capped" });

    fakeClock.autoAdvance = true;

    await runDeviceFlow({
      deviceAuthorizationEndpoint: DEVICE_AUTH_URL,
      tokenEndpoint: TOKEN_URL,
      clientId: CLIENT_ID,
      scope: SCOPE,
      ports,
    });

    // Intervals: 55s, 60s, 60s (capped)
    expect(fakeClock.sleepHistory[0]).toBe(55000);
    expect(fakeClock.sleepHistory[1]).toBe(60000);
    expect(fakeClock.sleepHistory[2]).toBe(60000);
  });

  // --- expired_token → DeviceFlowError ---

  it("throws DeviceFlowError with reason expired_token on expired_token", async () => {
    fakeFetch.pushJson(200, makeDeviceAuthResponse());
    fakeFetch.pushJson(200, { error: "expired_token" });

    fakeClock.autoAdvance = true;

    await expect(
      runDeviceFlow({
        deviceAuthorizationEndpoint: DEVICE_AUTH_URL,
        tokenEndpoint: TOKEN_URL,
        clientId: CLIENT_ID,
        scope: SCOPE,
        ports,
      }),
    ).rejects.toSatisfy(
      (e) => e instanceof DeviceFlowError && e.reason === "expired_token",
    );
  });

  // --- access_denied → DeviceFlowError ---

  it("throws DeviceFlowError with reason access_denied on access_denied", async () => {
    fakeFetch.pushJson(200, makeDeviceAuthResponse());
    fakeFetch.pushJson(200, { error: "access_denied" });

    fakeClock.autoAdvance = true;

    await expect(
      runDeviceFlow({
        deviceAuthorizationEndpoint: DEVICE_AUTH_URL,
        tokenEndpoint: TOKEN_URL,
        clientId: CLIENT_ID,
        scope: SCOPE,
        ports,
      }),
    ).rejects.toSatisfy(
      (e) => e instanceof DeviceFlowError && e.reason === "access_denied",
    );
  });

  // --- Attempt cap → timeout ---

  it("throws DeviceFlowError with reason timeout after 120 attempts", async () => {
    fakeFetch.pushJson(200, makeDeviceAuthResponse({ interval: 1 }));
    // 120 pending responses
    for (let i = 0; i < 120; i++) {
      fakeFetch.pushJson(200, { error: "authorization_pending" });
    }
    // Mark as non-exhausted (we push extra just in case but won't consume)
    fakeFetch.relaxedExhaustion = true;

    fakeClock.autoAdvance = true;

    await expect(
      runDeviceFlow({
        deviceAuthorizationEndpoint: DEVICE_AUTH_URL,
        tokenEndpoint: TOKEN_URL,
        clientId: CLIENT_ID,
        scope: SCOPE,
        ports,
      }),
    ).rejects.toSatisfy(
      (e) => e instanceof DeviceFlowError && e.reason === "timeout",
    );
  });

  // --- verification_uri validation ---

  it("rejects verification_uri with query params", async () => {
    fakeFetch.pushJson(
      200,
      makeDeviceAuthResponse({
        verification_uri: "https://example.com/activate?foo=bar",
      }),
    );
    fakeFetch.relaxedExhaustion = true;

    await expect(
      runDeviceFlow({
        deviceAuthorizationEndpoint: DEVICE_AUTH_URL,
        tokenEndpoint: TOKEN_URL,
        clientId: CLIENT_ID,
        scope: SCOPE,
        ports,
      }),
    ).rejects.toThrow(/verification_uri/i);
  });

  it("rejects verification_uri with fragment", async () => {
    fakeFetch.pushJson(
      200,
      makeDeviceAuthResponse({
        verification_uri: "https://example.com/activate#step",
      }),
    );
    fakeFetch.relaxedExhaustion = true;

    await expect(
      runDeviceFlow({
        deviceAuthorizationEndpoint: DEVICE_AUTH_URL,
        tokenEndpoint: TOKEN_URL,
        clientId: CLIENT_ID,
        scope: SCOPE,
        ports,
      }),
    ).rejects.toThrow(/verification_uri/i);
  });

  it("rejects non-https verification_uri", async () => {
    fakeFetch.pushJson(
      200,
      makeDeviceAuthResponse({
        verification_uri: "http://example.com/activate",
      }),
    );
    fakeFetch.relaxedExhaustion = true;

    await expect(
      runDeviceFlow({
        deviceAuthorizationEndpoint: DEVICE_AUTH_URL,
        tokenEndpoint: TOKEN_URL,
        clientId: CLIENT_ID,
        scope: SCOPE,
        ports,
      }),
    ).rejects.toThrow(/verification_uri/i);
  });

  it("accepts trailing slash on verification_uri for generic providers", async () => {
    // Trailing slash must be accepted for generic OIDC providers
    fakeFetch.pushJson(
      200,
      makeDeviceAuthResponse({
        verification_uri: "https://example.com/activate/",
      }),
    );
    fakeFetch.pushJson(200, { access_token: "tok_slash_ok" });

    fakeClock.autoAdvance = true;

    const result = await runDeviceFlow({
      deviceAuthorizationEndpoint: DEVICE_AUTH_URL,
      tokenEndpoint: TOKEN_URL,
      clientId: CLIENT_ID,
      scope: SCOPE,
      ports,
    });

    expect(result.access_token).toBe("tok_slash_ok");
  });

  it("does NOT assert hostname === 'github.com' in device-flow.ts", async () => {
    // Non-github.com hostname must be accepted by the generic helper
    fakeFetch.pushJson(
      200,
      makeDeviceAuthResponse({
        verification_uri: "https://auth.mycompany.com/device",
      }),
    );
    fakeFetch.pushJson(200, { access_token: "tok_generic" });

    fakeClock.autoAdvance = true;

    const result = await runDeviceFlow({
      deviceAuthorizationEndpoint: DEVICE_AUTH_URL,
      tokenEndpoint: TOKEN_URL,
      clientId: CLIENT_ID,
      scope: SCOPE,
      ports,
    });

    expect(result.access_token).toBe("tok_generic");
  });

  // --- Token endpoint POST body ---

  it("sends correct POST body to token endpoint", async () => {
    fakeFetch.pushJson(200, makeDeviceAuthResponse({ device_code: "DEV123" }));
    fakeFetch.pushJson(200, { access_token: "tok_body" });

    fakeClock.autoAdvance = true;

    await runDeviceFlow({
      deviceAuthorizationEndpoint: DEVICE_AUTH_URL,
      tokenEndpoint: TOKEN_URL,
      clientId: CLIENT_ID,
      scope: SCOPE,
      ports,
    });

    const tokenCall = fakeFetch.calls[1];
    const body = tokenCall.init?.body as URLSearchParams;
    expect(body.get("client_id")).toBe(CLIENT_ID);
    expect(body.get("device_code")).toBe("DEV123");
    expect(body.get("grant_type")).toBe(
      "urn:ietf:params:oauth:grant-type:device_code",
    );
  });

  // --- Device auth POST body ---

  it("sends correct POST body to device authorization endpoint", async () => {
    fakeFetch.pushJson(200, makeDeviceAuthResponse());
    fakeFetch.pushJson(200, { access_token: "tok_auth_body" });

    fakeClock.autoAdvance = true;

    await runDeviceFlow({
      deviceAuthorizationEndpoint: DEVICE_AUTH_URL,
      tokenEndpoint: TOKEN_URL,
      clientId: CLIENT_ID,
      scope: SCOPE,
      ports,
    });

    const authCall = fakeFetch.calls[0];
    const body = authCall.init?.body as URLSearchParams;
    expect(body.get("client_id")).toBe(CLIENT_ID);
    expect(body.get("scope")).toBe(SCOPE);
  });
});
