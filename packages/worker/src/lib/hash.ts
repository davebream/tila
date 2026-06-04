export { hashToken } from "./hash-token";

/**
 * Generate a cryptographically random token with the tila_ prefix.
 * Format: tila_ + 64 hex characters (32 bytes = 256-bit entropy).
 */
export function generateToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const hex = Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `tila_${hex}`;
}
