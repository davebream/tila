/**
 * Credential provider factory — createProvider(kind) registry.
 *
 * Phase-3 update: github provider is now wired with a real implementation.
 * oidc-generic, tila-token, exec remain inline-throwing placeholders until
 * their respective phases (4 and 5).
 */

import { UnknownCredentialProviderError } from "../errors.js";
import { createGithubProvider } from "./github.js";
import type { CredentialKind, CredentialProvider } from "./types.js";

/**
 * Return a CredentialProvider for the given kind.
 *
 * Phase 3: github is wired with a real implementation (C4).
 * oidc-generic, tila-token, exec remain inline-throwing placeholders.
 */
export function createProvider(kind: CredentialKind): CredentialProvider {
  switch (kind) {
    case "github":
      return createGithubProvider();
    case "oidc-generic":
      throw new Error(
        "oidc-generic provider not implemented until Phase 5 (Task 6 / C5)",
      );
    case "tila-token":
      throw new Error(
        "tila-token provider not implemented until Phase 4 (Task 5 / C6)",
      );
    case "exec":
      throw new Error(
        "exec provider not implemented until Phase 4 (Task 5 / C6)",
      );
    default: {
      // Exhaustiveness check: TypeScript will error here if a CredentialKind is unhandled.
      const _exhaustive: never = kind;
      throw new UnknownCredentialProviderError(_exhaustive as string);
    }
  }
}
