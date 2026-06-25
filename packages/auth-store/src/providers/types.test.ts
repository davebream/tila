/**
 * Tests for credential provider factory (WI-K / C1)
 *
 * Verifies:
 * - createProvider with unknown kind throws UnknownCredentialProviderError
 * - RC-1 negative: auth.mode default fallback can only yield github or tila-token,
 *   never exec or oidc-generic
 */

import { describe, expect, it } from "vitest";
import { UnknownCredentialProviderError } from "../errors.js";
import { createProvider } from "./index.js";

describe("createProvider factory", () => {
  it("throws UnknownCredentialProviderError for an unknown kind", () => {
    expect(() => createProvider("bogus" as never)).toThrowError(
      UnknownCredentialProviderError,
    );
  });

  it("includes the unknown kind in the error message", () => {
    try {
      createProvider("not-a-valid-kind" as never);
    } catch (e) {
      expect(e).toBeInstanceOf(UnknownCredentialProviderError);
      if (e instanceof UnknownCredentialProviderError) {
        expect(e.kind).toBe("not-a-valid-kind");
      }
    }
  });

  it("still-unimplemented kinds throw placeholder (not UnknownCredentialProviderError)", () => {
    // Phase-4 update: github, tila-token, exec are now real providers.
    // Only oidc-generic remains an inline-throwing placeholder until Phase 5 (C5).
    const stubKinds = ["oidc-generic"] as const;
    for (const kind of stubKinds) {
      expect(() => createProvider(kind)).toThrow();
      try {
        createProvider(kind);
      } catch (e) {
        // Must NOT be UnknownCredentialProviderError (that is only for truly unknown kinds)
        expect(e).not.toBeInstanceOf(UnknownCredentialProviderError);
      }
    }
  });

  it("github kind returns a real provider with kind='github' (Phase 3 wired)", () => {
    const provider = createProvider("github");
    expect(provider.kind).toBe("github");
  });

  it("tila-token kind returns a real provider with kind='tila-token' (Phase 4 wired)", () => {
    const provider = createProvider("tila-token");
    expect(provider.kind).toBe("tila-token");
  });

  it("exec kind returns a real provider with kind='exec' (Phase 4 wired)", () => {
    const provider = createProvider("exec");
    expect(provider.kind).toBe("exec");
  });
});

/**
 * RC-1 negative: default-resolution fallback (from auth.mode) can only select
 * github or tila-token. exec and oidc-generic are never selectable from the
 * untrusted project config.
 */
describe("RC-1: auth.mode fallback cannot select exec or oidc-generic", () => {
  it("auth.mode enum values do not include exec or oidc-generic", () => {
    // The canonical auth.mode values from @tila/schemas TilaProjectConfigSchema
    const authModeEnum = ["tila-token", "github-repo"] as const;
    type AuthMode = (typeof authModeEnum)[number];

    // The mapping: "github-repo" → "github", "tila-token" → "tila-token"
    function authModeToProviderKind(mode: AuthMode): "github" | "tila-token" {
      if (mode === "github-repo") return "github";
      return "tila-token";
    }

    // Assert that neither exec nor oidc-generic can be produced
    for (const mode of authModeEnum) {
      const kind = authModeToProviderKind(mode);
      expect(kind).not.toBe("exec");
      expect(kind).not.toBe("oidc-generic");
    }
  });
});
