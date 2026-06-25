/**
 * Credential provider factory — createProvider(kind) registry.
 *
 * Phase-4 update: tila-token and exec providers are now wired with real implementations.
 * oidc-generic remains an inline-throwing placeholder until Phase 5 (Task 6 / C5).
 */

import { UnknownCredentialProviderError } from "../errors.js";
import { createExecProvider } from "./exec.js";
import { createGithubProvider } from "./github.js";
import { createTilaTokenProvider } from "./tila-token.js";
import type { CredentialKind, CredentialProvider } from "./types.js";

/**
 * Return a CredentialProvider for the given kind.
 *
 * Phase 4: github, tila-token, and exec are wired with real implementations.
 * oidc-generic remains an inline-throwing placeholder.
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
      throw new Error(
        "oidc-generic provider not implemented until Phase 5 (Task 6 / C5)",
      );
    default: {
      // Exhaustiveness check: TypeScript will error here if a CredentialKind is unhandled.
      const _exhaustive: never = kind;
      throw new UnknownCredentialProviderError(_exhaustive as string);
    }
  }
}
