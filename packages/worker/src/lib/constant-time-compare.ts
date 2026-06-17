/**
 * Constant-time secret comparison.
 *
 * Both inputs are run through a keyed HMAC-SHA-256 before comparison, so the
 * comparison loop always runs over equal-length digests and never short-circuits
 * on the first differing byte — closing the timing side-channel a naive `===` on
 * raw secret strings would open.
 *
 * The HMAC `key` is an explicit, per-call namespace label. Callers MUST keep
 * their keys distinct (e.g. "tila-secret-compare" for infra, "tila-sweep-compare"
 * for sweep): both sides of a single comparison are hashed under the same key, so
 * the value chosen is a domain separator — it must not be collapsed across
 * independent secret domains.
 */
async function hmacDigest(input: string, key: string): Promise<Uint8Array> {
  const encoder = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    encoder.encode(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(
    await crypto.subtle.sign("HMAC", cryptoKey, encoder.encode(input)),
  );
}

export async function constantTimeSecretMatch(
  provided: string | undefined,
  expected: string,
  key: string,
): Promise<boolean> {
  const left = await hmacDigest(provided ?? "", key);
  const right = await hmacDigest(expected, key);
  let diff = 0;
  for (let i = 0; i < left.length; i++) {
    diff |= left[i] ^ right[i];
  }
  return diff === 0;
}
