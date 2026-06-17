/**
 * Hash a raw bearer/session token to a hex digest for storage and lookup.
 *
 * When a `pepper` (the `HASH_PEPPER` Worker secret) is provided, the token is
 * hashed with keyed **HMAC-SHA-256**, so a leaked hash digest is useless to an
 * attacker who does not also hold the secret. When no pepper is set, this falls
 * back to plain SHA-256 (the historical behavior), so the function is a no-op
 * until the secret is configured.
 *
 * The `pepper` parameter is **required** (`string | undefined`, not optional) by
 * design: every callsite must pass `c.env.HASH_PEPPER` (or an explicit
 * `undefined` when intentionally testing the bare fallback). This makes a silent
 * bare `hashToken(raw)` a compile error, so no one can reintroduce a peppered
 * lookup against a bare mint — the SEC-1 mint/lookup consistency is
 * type-enforced, not just convention.
 *
 * Activation note: setting (or rotating) `HASH_PEPPER` changes the digest of
 * every token. Existing SHA-256-hashed D1 API tokens must be re-issued, and
 * cookie sessions re-authenticate within their TTL. (A zero-downtime dual-verify
 * migration is a tracked follow-up.)
 */
export async function hashToken(
  rawToken: string,
  pepper: string | undefined,
): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(rawToken);

  if (pepper) {
    const key = await crypto.subtle.importKey(
      "raw",
      encoder.encode(pepper),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const sig = await crypto.subtle.sign("HMAC", key, data);
    return toHex(new Uint8Array(sig));
  }

  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  return toHex(new Uint8Array(hashBuffer));
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
