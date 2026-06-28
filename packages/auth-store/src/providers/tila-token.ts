/**
 * tila-token credential provider (C6).
 *
 * Returns a pre-minted bearer token supplied by the caller via ProviderContext.
 * No network calls, no subprocess — pure config read.
 *
 * Precedence logic (flag → env → config) is the caller's responsibility (CLI / C7).
 * The provider receives the already-resolved token in `ctx.resolved_token`.
 *
 * Key invariants:
 * - expires_at is always null (caller does not know the expiry; token is long-lived
 *   until explicitly revoked).
 * - refresh re-mints (returns the same static token).
 * - revoke is a local no-op (no keychain, no network revocation).
 */

import type { CredentialRecord, RefreshRecord } from "@tila/schemas";
import { MissingTokenError } from "../errors.js";
import type {
  CredentialProvider,
  MintedCredential,
  ProviderContext,
} from "./types.js";

/**
 * Create the tila-token CredentialProvider.
 */
export function createTilaTokenProvider(): CredentialProvider {
  return {
    kind: "tila-token",

    async mint(ctx: ProviderContext): Promise<MintedCredential> {
      const token = ctx.resolved_token;

      if (token === undefined || token.trim() === "") {
        throw new MissingTokenError();
      }

      return {
        token,
        token_type: "bearer",
        expires_at: null,
      };
    },

    async refresh(
      ctx: ProviderContext,
      _prior: RefreshRecord,
    ): Promise<MintedCredential> {
      // tila-token tokens do not refresh via a network call.
      // Re-mint returns the same static token from context.
      return this.mint(ctx);
    },

    async revoke(
      _ctx: ProviderContext,
      _cred: CredentialRecord,
    ): Promise<void> {
      // Revoke is local-only. The tila-token provider has no network revocation
      // endpoint. Callers should delete the stored credential from the keychain
      // separately. This method is intentionally a no-op.
    },
  };
}
