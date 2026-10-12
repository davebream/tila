/**
 * Parameterized RFC 8628 device-flow helper.
 *
 * Host-agnostic: endpoints are parameters, no github.com literal is asserted
 * here (the github.com endpoint URLs legitimately live in the github provider).
 *
 * The polling loop is lifted from packages/cli/src/lib/github-oauth-device.ts
 * with the following changes:
 *   - Real setTimeout replaced by ports.clock.sleep (testable, no real timers)
 *   - Endpoint URLs are parameters, not hard-coded constants
 *   - Terminal errors → DeviceFlowError{reason} instead of plain Error
 *   - verification_uri check is parameterized: https + no-query + no-fragment,
 *     but NO hostname === "github.com" assertion
 *   - Trailing slash on verification_uri is ACCEPTED (generic OIDC providers
 *     may legitimately send one)
 *   - Returns the raw OAuth response fields only; expires_in→expires_at
 *     conversion belongs to the caller (provider layer)
 *
 * RC-2: slow_down interval is monotonically increasing.
 *   - On slow_down, interval = max(currentInterval, serverInterval ?? currentInterval) + 5
 *   - Capped at 60 seconds
 *   - Interval NEVER decreases
 */

import { DeviceFlowError } from "../errors.js";
import type { ProviderPorts } from "./types.js";

const MAX_ATTEMPTS = 120;
const MAX_INTERVAL_S = 60;
const SLOW_DOWN_INCREMENT_S = 5;

export interface DeviceFlowResult {
  access_token: string;
  expires_in?: number;
  refresh_token?: string;
  scope?: string;
}

interface DeviceAuthResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval: number;
}

interface TokenPollResponse {
  access_token?: string;
  expires_in?: number;
  refresh_token?: string;
  scope?: string;
  error?: string;
  /** Server may send a new interval on slow_down */
  interval?: number;
}

/**
 * Validate the verification_uri returned by the device authorization endpoint.
 * Security rules (parameterized — no hostname assertion):
 *   - Must be a valid URL
 *   - Protocol must be https
 *   - Must not have query params
 *   - Must not have a fragment
 *   - Trailing slash is ACCEPTED (OIDC conformant; immaterial to github which never sends one)
 */
function validateVerificationUri(uri: string): void {
  if (typeof uri !== "string" || uri.length === 0) {
    throw new Error("Invalid device flow response: missing verification_uri");
  }

  // Must be https
  if (!uri.startsWith("https://")) {
    throw new Error(`Invalid verification_uri: must use https (got: ${uri})`);
  }

  // Parse to check query and fragment
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    throw new Error(`Invalid verification_uri: not a valid URL (got: ${uri})`);
  }

  // Must not have query params
  if (parsed.search !== "") {
    throw new Error(
      `Invalid verification_uri: must not have query params (got: ${uri})`,
    );
  }

  // Must not have a fragment
  if (parsed.hash !== "") {
    throw new Error(
      `Invalid verification_uri: must not have fragment (got: ${uri})`,
    );
  }

  // NOTE: No hostname === "github.com" assertion here.
  // The github provider legitimately keeps github.com endpoint URLs, but
  // this generic helper must not assume any particular hostname.
}

/**
 * Run the RFC 8628 device authorization flow.
 *
 * 1. POST to deviceAuthorizationEndpoint to get device_code + user_code
 * 2. Display user_code + verification_uri via ports.prompter
 * 3. Poll tokenEndpoint until success or terminal error
 *
 * Returns the raw OAuth response: access_token, expires_in?, refresh_token?, scope?
 * The provider layer is responsible for converting expires_in → expires_at (epoch-ms).
 */
export async function runDeviceFlow(args: {
  deviceAuthorizationEndpoint: string;
  tokenEndpoint: string;
  clientId: string;
  scope: string;
  ports: ProviderPorts;
}): Promise<DeviceFlowResult> {
  const { deviceAuthorizationEndpoint, tokenEndpoint, clientId, scope, ports } =
    args;

  // --- Step 1: Request device + user codes ---
  const authResponse = await ports.fetch(deviceAuthorizationEndpoint, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      client_id: clientId,
      scope,
    }),
  });

  if (!authResponse.ok) {
    throw new Error(
      `Device authorization request failed: ${authResponse.status} ${authResponse.statusText}`,
    );
  }

  const authJson = (await authResponse.json()) as DeviceAuthResponse;

  // Validate verification_uri (security, parameterized — no github.com check)
  validateVerificationUri(authJson.verification_uri);

  const deviceCode: string = authJson.device_code;
  const userCode: string = authJson.user_code;
  const verificationUri: string = authJson.verification_uri;
  const expiresIn: number = authJson.expires_in ?? 900;
  let currentInterval: number = authJson.interval ?? 5;

  // --- Step 2: Display prompt ---
  await ports.prompter.displayDeviceCode({
    userCode,
    verificationUri,
    expiresIn,
  });

  // --- Step 3: Poll for token ---
  let attempts = 0;

  while (attempts < MAX_ATTEMPTS) {
    // Wait before polling (RFC 8628 mandates waiting the interval before each poll)
    await ports.clock.sleep(currentInterval * 1000);
    attempts++;

    const pollResponse = await ports.fetch(tokenEndpoint, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        client_id: clientId,
        device_code: deviceCode,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      }),
    });

    // GitHub (and most providers) return HTTP 200 for all poll responses,
    // including authorization_pending and error states.
    const json = (await pollResponse.json()) as TokenPollResponse;

    if (json.access_token) {
      return {
        access_token: json.access_token,
        ...(json.expires_in !== undefined && { expires_in: json.expires_in }),
        ...(json.refresh_token !== undefined && {
          refresh_token: json.refresh_token,
        }),
        ...(json.scope !== undefined && { scope: json.scope }),
      };
    }

    if (json.error) {
      switch (json.error) {
        case "authorization_pending":
          // Continue polling — interval stays the same
          break;

        case "slow_down": {
          // RC-2: interval is monotonically increasing, honoring the server
          // `interval` field when present, then adding SLOW_DOWN_INCREMENT_S.
          // Never drops below the current interval; capped at MAX_INTERVAL_S.
          const serverInterval =
            typeof json.interval === "number" && json.interval > 0
              ? json.interval
              : currentInterval;
          const proposed =
            Math.max(serverInterval, currentInterval) + SLOW_DOWN_INCREMENT_S;
          currentInterval = Math.min(proposed, MAX_INTERVAL_S);
          break;
        }

        case "expired_token":
          throw new DeviceFlowError(
            "expired_token",
            "Device code expired. Please restart the authentication flow.",
          );

        case "access_denied":
          throw new DeviceFlowError(
            "access_denied",
            "Access denied by user. Please restart the authentication flow.",
          );

        default:
          throw new DeviceFlowError(
            "error",
            `Device flow error: ${json.error}`,
          );
      }
    }
    // If neither access_token nor error field: treat as pending, continue loop
  }

  throw new DeviceFlowError(
    "timeout",
    `Device flow timed out after ${MAX_ATTEMPTS} polling attempts.`,
  );
}
