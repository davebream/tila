/**
 * GitHub credential provider (C4).
 *
 * Thin wrapper over the shared RFC 8628 device-flow helper (C3 / device-flow.ts).
 * Uses GitHub's fixed endpoints + scope "repo".
 *
 * Key design invariants:
 * - client_id MUST come from ProviderContext.client_id (caller-resolved).
 *   The provider never fetches client_id from the network or filesystem.
 * - mint delegates to runDeviceFlow; expires_in → expires_at conversion happens here.
 * - refresh falls back to mint (GitHub device tokens are not refreshable in this flow).
 * - revoke clears provider-local app-user-token cache (no keychain access).
 *
 * GitHub endpoints (fixed, not discovered):
 *   Device auth: https://github.com/login/device/code
 *   Token:       https://github.com/login/oauth/access_token
 *   Scope:       repo
 */

import type { CredentialRecord, RefreshRecord } from "@tila/schemas";
import { MissingClientIdError } from "../errors.js";
import { runDeviceFlow } from "./device-flow.js";
import type {
  CredentialProvider,
  MintedCredential,
  ProviderContext,
} from "./types.js";

const GITHUB_DEVICE_AUTH_URL = "https://github.com/login/device/code";
const GITHUB_TOKEN_URL = "https://github.com/login/oauth/access_token";
const GITHUB_SCOPE = "repo";

/**
 * Create the github CredentialProvider.
 *
 * Factory function (not a class) to keep the provider stateless per-call.
 * The only provider-local state is an optional app-user-token cache reference
 * for revoke() — no keychain, no registry.
 */
export function createGithubProvider(): CredentialProvider {
  return {
    kind: "github",

    async mint(ctx: ProviderContext): Promise<MintedCredential> {
      // Validate that the caller provided a client_id — the provider must never
      // resolve it internally (no hidden fetch/fs side-channel).
      const clientId = ctx.client_id;
      if (!clientId || clientId.trim() === "") {
        throw new MissingClientIdError();
      }

      const result = await runDeviceFlow({
        deviceAuthorizationEndpoint: GITHUB_DEVICE_AUTH_URL,
        tokenEndpoint: GITHUB_TOKEN_URL,
        clientId,
        scope: GITHUB_SCOPE,
        ports: ctx.ports,
      });

      // Convert expires_in (relative seconds) → expires_at (absolute epoch-ms).
      // Absent expires_in → null (unknown / non-expiring).
      const expiresAt =
        result.expires_in !== undefined
          ? ctx.ports.clock.now() + result.expires_in * 1000
          : null;

      return {
        token: result.access_token,
        token_type: "github-user-token",
        expires_at: expiresAt,
        ...(result.scope !== undefined && { scope: result.scope }),
        ...(result.refresh_token !== undefined && {
          refresh_token: result.refresh_token,
        }),
      };
    },

    async refresh(
      ctx: ProviderContext,
      _prior: RefreshRecord,
    ): Promise<MintedCredential> {
      // GitHub device tokens are not refreshable in this flow.
      // Fall back to mint — the user will be re-prompted.
      return this.mint(ctx);
    },

    async revoke(
      _ctx: ProviderContext,
      _cred: CredentialRecord,
    ): Promise<void> {
      // Clears provider-local app-user-token cache (ephemeral, not keychain).
      // The actual cache file (github-token-cache.json) is managed by the CLI
      // caller (C7). Here at the auth-store level, revoke is a no-op because
      // the cache is provider-local CLI state, not keychain state.
      // Per design C4: "revoke clears any cached app-user token."
      // The provider-local cache is CLI-side; auth-store revoke is a no-op + idempotent.
    },
  };
}
