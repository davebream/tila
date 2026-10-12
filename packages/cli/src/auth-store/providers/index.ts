/**
 * Credential provider factory — createProvider(kind) registry.
 *
 * Phase-5 update: all four providers are now wired with real implementations.
 *   - github: RFC 8628 device flow over fixed GitHub endpoints
 *   - tila-token: static bearer token from caller context
 *   - exec: subprocess vending machine (shell:false)
 *   - oidc-generic: RFC 8628 device flow over RFC 8414 discovered endpoints
 */

import { UnknownCredentialProviderError } from "../errors.js";
import { createExecProvider } from "./exec.js";
import { createGithubProvider } from "./github.js";
import { createOidcGenericProvider } from "./oidc-generic.js";
import { createTilaTokenProvider } from "./tila-token.js";
import type { CredentialKind, CredentialProvider } from "./types.js";

/**
 * Return a CredentialProvider for the given kind.
 *
 * Phase 5: all four providers are wired with real implementations.
 */
export function createProvider(kind: CredentialKind): CredentialProvider {
  switch (kind) {
    case "github":
      return createGithubProvider();
    case "tila-token":
      return createTilaTokenProvider();
    case "exec":
      return createExecProvider();
    case "oidc-generic":
      return createOidcGenericProvider();
    default: {
      // Exhaustiveness check: TypeScript will error here if a CredentialKind is unhandled.
      const _exhaustive: never = kind;
      throw new UnknownCredentialProviderError(_exhaustive as string);
    }
  }
}
