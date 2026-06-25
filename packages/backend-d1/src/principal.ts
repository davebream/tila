/**
 * Canonical principal identity helper for WI-C (epic #122).
 *
 * Every write of a principal identity (_admin_grants, _revoked_subjects) and
 * the auth.ts verifier derive their (identity_host, subject_id) pair through
 * this one function — canonicalization parity is enforced by construction.
 */

export interface CanonicalPrincipal {
  identityHost: string;
  subjectId: string;
}

/**
 * Canonicalize a (host, subject) identity pair.
 *
 * - `identityHost`: lowercased + trimmed host; null/undefined → "github.com".
 * - `subjectId`: stringified + trimmed subject.
 * - Throws on an empty canonical subject so a degenerate identity can never
 *   be silently recorded or matched against a tombstone.
 */
export function canonicalizePrincipal(
  host: string | null | undefined,
  subject: string | number,
): CanonicalPrincipal {
  const identityHost = (host ?? "github.com").trim().toLowerCase();
  const subjectId = String(subject).trim();

  if (subjectId === "") {
    throw new Error(
      "canonicalizePrincipal: empty subject after canonicalization",
    );
  }

  return { identityHost, subjectId };
}
