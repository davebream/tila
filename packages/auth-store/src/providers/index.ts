/**
 * Credential provider factory — createProvider(kind) registry.
 *
 * Phase-1 contract: known kinds are inline-throwing stubs (no imports of
 * unwritten modules). Each later phase replaces the placeholder with a real
 * import. Unknown kinds throw UnknownCredentialProviderError immediately.
 */

import { UnknownCredentialProviderError } from "../errors.js";
import type { CredentialKind, CredentialProvider } from "./types.js";

/**
 * Return a CredentialProvider for the given kind.
 *
 * Phase 1: github, oidc-generic, tila-token, exec are wired as inline-throwing
 * placeholders so pnpm run typecheck stays green with no unwritten imports.
 * Phase 2+: placeholders are replaced with real implementations.
 */
export function createProvider(kind: CredentialKind): CredentialProvider {
  switch (kind) {
    case "github":
      throw new Error(
        "github provider not implemented until Phase 3 (Task 4 / C4)",
      );
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
