/**
 * oidc-generic credential provider (C5).
 *
 * Implements RFC 8628 Device Authorization Grant over a discovered OIDC issuer.
 *
 * mint(ctx):
 *   1. Run RFC 8414 discovery (NOT persisted — fully restartable across retries).
 *   2. Run runDeviceFlow with discovered device_authorization_endpoint + token_endpoint.
 *   3. Convert expires_in → expires_at (absent → null).
 *
 * refresh(ctx, prior):
 *   - If prior.refresh_token is absent/empty → throw RefreshExpiredError (terminal).
 *   - If prior.expires_at is not null and <= clock.now() → throw RefreshExpiredError (terminal).
 *   - Otherwise: run discovery + POST refresh_token grant to token_endpoint.
 *   - Does NOT silently fall through to interactive device flow on expiry (RC-3 / design).
 *
 * revoke(ctx, cred):
 *   - If discovery advertises revocation_endpoint → best-effort POST.
 *   - Otherwise: no-op (idempotent).
 *
 * Mid-poll token-endpoint response classification (RC-3):
 *   - 5xx during polling → retryable (treated as authorization_pending internally)
 *   - 4xx during polling → terminal (throws DeviceFlowError)
 *   Both behaviors are implemented by passing a custom tokenFetch to runDeviceFlow
 *   that classifies 5xx as retryable pending vs 4xx terminal.
 *
 * Key invariant: auth-store must NOT import @clack/prompts, node:child_process,
 * or any worker-runtime module.
 */

import type { CredentialRecord, RefreshRecord } from "@tila/schemas";
import {
  DeviceFlowError,
  OidcDiscoveryError,
  RefreshExpiredError,
} from "../errors.js";
import { runDeviceFlow } from "./device-flow.js";
import { oidcEgressFetch } from "./egress.js";
import { resolveOidcEndpoints } from "./oidc-discovery.js";
import type {
  CredentialProvider,
  MintedCredential,
  ProviderContext,
} from "./types.js";

/**
 * Build a wrapped fetch function that classifies token-endpoint poll responses:
 *   - 5xx: treated as retryable (returns a 200 with error:"authorization_pending")
 *   - 4xx: treated as terminal (returns the error response as-is → DeviceFlowError)
 *
 * This implements RC-3 from the plan-review findings.
 *
 * Note: Discovery requests use oidcEgressFetch directly (not this wrapper).
 * Only the token endpoint polling path goes through this function.
 */
function makeTokenFetch(
  fetchFn: typeof globalThis.fetch,
  tokenEndpoint: string,
): typeof globalThis.fetch {
  return async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : (input as Request).url;

    // Only intercept calls to the token endpoint for 5xx/4xx classification.
    // Pass through all other calls (device_authorization_endpoint) unchanged.
    if (url !== tokenEndpoint) {
      return fetchFn(input, init);
    }

    const res = await fetchFn(input, init);

    // 5xx: retryable — return a synthetic authorization_pending response
    if (res.status >= 500 && res.status < 600) {
      return new Response(JSON.stringify({ error: "authorization_pending" }), {
        status: 200,
        headers: new Headers({ "content-type": "application/json" }),
      }) as Response;
    }

    // 4xx: terminal — parse the error body and throw DeviceFlowError
    if (res.status >= 400 && res.status < 500) {
      let errorCode = "error";
      try {
        const body = (await res.json()) as { error?: string };
        if (typeof body.error === "string" && body.error) {
          errorCode = body.error;
        }
      } catch {
        // ignore parse error
      }
      throw new DeviceFlowError(
        "error",
        `Token endpoint returned ${res.status}: ${errorCode}`,
      );
    }

    return res;
  };
}

/**
 * Create the oidc-generic CredentialProvider.
 */
export function createOidcGenericProvider(): CredentialProvider {
  return {
    kind: "oidc-generic",

    async mint(ctx: ProviderContext): Promise<MintedCredential> {
      if (ctx.config.kind !== "oidc-generic") {
        throw new Error(
          `oidc-generic provider received wrong config kind: "${ctx.config.kind}"`,
        );
      }

      const { issuer, client_id, scope = "openid" } = ctx.config;

      // 1. Run RFC 8414 discovery (not persisted — restartable on retry).
      const endpoints = await resolveOidcEndpoints(issuer, ctx.ports.fetch);

      // 2. Build a token fetch with RC-3 5xx/4xx classification.
      const tokenFetch = makeTokenFetch(
        ctx.ports.fetch,
        endpoints.tokenEndpoint,
      );

      // 3. Run RFC 8628 device flow with discovered endpoints.
      const result = await runDeviceFlow({
        deviceAuthorizationEndpoint: endpoints.deviceAuthorizationEndpoint,
        tokenEndpoint: endpoints.tokenEndpoint,
        clientId: client_id,
        scope,
        ports: {
          ...ctx.ports,
          fetch: tokenFetch,
        },
      });

      // 4. Convert expires_in (relative seconds) → expires_at (absolute epoch-ms).
      // Absent expires_in → null (unknown / non-expiring per MintedCredential contract).
      const expiresAt =
        result.expires_in !== undefined
          ? ctx.ports.clock.now() + result.expires_in * 1000
          : null;

      return {
        token: result.access_token,
        token_type: "bearer",
        expires_at: expiresAt,
        ...(result.scope !== undefined && { scope: result.scope }),
        ...(result.refresh_token !== undefined && {
          refresh_token: result.refresh_token,
        }),
      };
    },

    async refresh(
      ctx: ProviderContext,
      prior: RefreshRecord,
    ): Promise<MintedCredential> {
      if (ctx.config.kind !== "oidc-generic") {
        throw new Error(
          `oidc-generic provider received wrong config kind: "${ctx.config.kind}"`,
        );
      }

      // Terminal guard: absent/empty refresh_token → throw immediately.
      if (!prior.refresh_token || prior.refresh_token.trim() === "") {
        throw new RefreshExpiredError(
          "Refresh token is absent — re-authentication required",
        );
      }

      // Terminal guard: expired refresh token → throw immediately.
      // null expires_at = non-expiring (always valid).
      if (
        prior.expires_at !== null &&
        prior.expires_at <= ctx.ports.clock.now()
      ) {
        throw new RefreshExpiredError(
          `Refresh token expired at ${prior.expires_at} (now: ${ctx.ports.clock.now()}) — re-authentication required`,
        );
      }

      const { issuer, client_id, scope = "openid" } = ctx.config;

      // Discover token endpoint (not persisted).
      const endpoints = await resolveOidcEndpoints(issuer, ctx.ports.fetch);

      // POST refresh_token grant to token_endpoint.
      const body = new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: prior.refresh_token,
        client_id,
        scope,
      });

      const res = await oidcEgressFetch(
        endpoints.tokenEndpoint,
        {
          method: "POST",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body,
        },
        ctx.ports.fetch,
      );

      interface TokenResponse {
        access_token: string;
        expires_in?: number;
        refresh_token?: string;
        scope?: string;
        token_type?: string;
      }

      const json = (await res.json()) as TokenResponse;

      if (!json.access_token) {
        throw new OidcDiscoveryError(
          "Refresh grant response missing access_token",
          "missing-endpoint",
        );
      }

      const expiresAt =
        json.expires_in !== undefined
          ? ctx.ports.clock.now() + json.expires_in * 1000
          : null;

      return {
        token: json.access_token,
        token_type: json.token_type ?? "bearer",
        expires_at: expiresAt,
        ...(json.scope !== undefined && { scope: json.scope }),
        ...(json.refresh_token !== undefined && {
          refresh_token: json.refresh_token,
        }),
      };
    },

    async revoke(ctx: ProviderContext, _cred: CredentialRecord): Promise<void> {
      if (ctx.config.kind !== "oidc-generic") {
        return; // wrong config — no-op
      }

      const { issuer } = ctx.config;

      // Best-effort: discover revocation_endpoint.
      let endpoints: Awaited<ReturnType<typeof resolveOidcEndpoints>>;
      try {
        endpoints = await resolveOidcEndpoints(issuer, ctx.ports.fetch);
      } catch {
        // Discovery failed — revocation is best-effort, no-op on failure.
        return;
      }

      if (!endpoints.revocationEndpoint) {
        // No revocation endpoint advertised → no-op.
        return;
      }

      // Best-effort POST to revocation endpoint — ignore errors.
      try {
        await oidcEgressFetch(
          endpoints.revocationEndpoint,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/x-www-form-urlencoded",
            },
            body: new URLSearchParams({ token: _cred.token }),
          },
          ctx.ports.fetch,
        );
      } catch {
        // Best-effort — ignore errors during revocation.
      }
    },
  };
}
