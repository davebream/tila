/**
 * Constant-time secret comparison.
 *
 * Both inputs are run through a fixed-key HMAC-SHA-256 before comparison, so the
 * comparison loop always runs over equal-length digests and never short-circuits
 * on the first differing byte — closing the timing side-channel a naive `===` on
 * raw secret strings would open.
 */
async function hmacDigest(input: string): Promise<Uint8Array> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode("tila-secret-compare"),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(
    await crypto.subtle.sign("HMAC", key, encoder.encode(input)),
  );
}

export async function constantTimeSecretMatch(
  provided: string | undefined,
  expected: string,
): Promise<boolean> {
  const left = await hmacDigest(provided ?? "");
  const right = await hmacDigest(expected);
  let diff = 0;
  for (let i = 0; i < left.length; i++) {
    diff |= left[i] ^ right[i];
  }
  return diff === 0;
}
