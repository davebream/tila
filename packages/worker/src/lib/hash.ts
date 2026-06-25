export { hashToken } from "./hash-token";
import { mintD1Token } from "./token-format";

/**
 * Generate a cryptographically random D1 token.
 * Format: tila_d1_<64 hex entropy><8 hex checksum> (80 chars total).
 * Uses mintD1Token() from token-format.ts (WebCrypto-based).
 */
export async function generateToken(): Promise<string> {
  return mintD1Token();
}
