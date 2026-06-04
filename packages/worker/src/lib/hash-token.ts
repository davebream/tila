/**
 * SHA-256 hash a raw bearer token to its hex-encoded digest.
 * Used by auth middleware (validation) and T3 token creation (storage).
 */
export async function hashToken(rawToken: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(rawToken);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}
