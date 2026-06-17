import type { TilaInfraConfig } from "@tila/schemas";
import { generateRawToken } from "./provisioning";

/**
 * Pure merge decision for the infra admin token. Mirrors how `hmac_key` is
 * handled: generate-if-absent, preserve otherwise, regenerate on rotate.
 *
 *   - rotate            → always generate a fresh token.
 *   - existing present  → preserve it (the RNG seam is NOT touched).
 *   - existing absent   → generate a fresh token.
 *
 * `generateRawToken()` is the only RNG seam and is called solely on the
 * generate/rotate branches, so the preserve branch is fully deterministic.
 */
export function ensureInfraAdminToken(
  infraConfig: TilaInfraConfig | null,
  opts: { rotate?: boolean },
): { token: string; generated: boolean } {
  if (opts.rotate) {
    return { token: generateRawToken(), generated: true };
  }

  // Treat a blank/whitespace-only token as absent — same predicate as
  // resolveInfraAdminToken, so the two helpers agree on "is a token present?".
  const existing = infraConfig?.infra_admin_token;
  if (existing && existing.trim().length > 0) {
    return { token: existing, generated: false };
  }

  return { token: generateRawToken(), generated: true };
}
