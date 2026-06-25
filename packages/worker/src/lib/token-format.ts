/**
 * D1 token format helpers — Worker (WebCrypto) implementation.
 *
 * Format specification (single source of truth — see design C1):
 *   token       = "tila_d1_" + entropyHex(64) + checksumHex(8)   // 80 chars total
 *   entropy     = 32 random bytes (crypto.getRandomValues)
 *   checksumHex = hex(SHA-256(entropy_BYTES)).slice(0, 8)         // raw bytes, NOT hex string; pre-pepper, public
 *   storageHash = hashToken(token, HASH_PEPPER)                   // over FULL string — unchanged, do not alter hash-token.ts
 *
 * The checksum is a structural integrity tag only — it is not a MAC and makes no
 * secrecy claim. It is computed before the pepper and is pepper-independent, so it
 * can be verified without any secret material (pre-network / pre-hash).
 *
 * Cross-runtime parity: the CLI (Phase 2, packages/cli/src/lib/provisioning.ts) implements
 * the same spec using Node `crypto` (synchronous). Both must produce the same checksum
 * for the same raw entropy bytes. See the fixed-entropy fixture test for the anchor value.
 */

export const D1_TOKEN_PREFIX = "tila_d1_";

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Mint a new D1 token in the format: tila_d1_<64 entropy hex><8 checksum hex>.
 * Uses WebCrypto for both random generation and SHA-256.
 * Total length: 8 + 64 + 8 = 80 chars.
 */
export async function mintD1Token(): Promise<string> {
  const entropy = new Uint8Array(32);
  crypto.getRandomValues(entropy);

  const entropyHex = toHex(entropy);

  // Checksum: first 4 bytes (8 hex chars) of SHA-256 over the RAW entropy bytes
  // (not the hex string — this is the cross-runtime parity anchor)
  const hashBuffer = await crypto.subtle.digest("SHA-256", entropy);
  const checksumHex = toHex(new Uint8Array(hashBuffer)).slice(0, 8);

  return D1_TOKEN_PREFIX + entropyHex + checksumHex;
}

/**
 * Verify the embedded checksum of a D1 token.
 *
 * Returns:
 *   "ok"            — token has the tila_d1_ prefix and checksum matches
 *   "bad-checksum"  — token has the tila_d1_ prefix but checksum is wrong or body is malformed
 *   "not-d1-token"  — token does not have the tila_d1_ prefix (legacy/session/other); skip, never reject
 *
 * This function is total: it never throws, even if the hex decode fails. All error
 * conditions map to "bad-checksum" for tila_d1_ tokens.
 *
 * Security note: a "not-d1-token" result means the caller should fall through to the
 * existing hash/D1 validation path — this is what keeps legacy tila_<hex> and
 * tila_dev_token_localonly tokens working unchanged (migration-free).
 */
export async function verifyD1TokenChecksum(
  token: string,
): Promise<"ok" | "bad-checksum" | "not-d1-token"> {
  if (!token.startsWith(D1_TOKEN_PREFIX)) {
    return "not-d1-token";
  }

  const body = token.slice(D1_TOKEN_PREFIX.length);

  // Body must be exactly 72 lowercase hex chars (64 entropy + 8 checksum)
  if (!/^[0-9a-f]{72}$/.test(body)) {
    return "bad-checksum";
  }

  const entropyHex = body.slice(0, 64);
  const embeddedChecksum = body.slice(64); // 8 hex chars

  // Decode entropy hex to raw bytes — guard against any malformed input
  let entropyBytes: Uint8Array;
  try {
    entropyBytes = new Uint8Array(32);
    for (let i = 0; i < 32; i++) {
      const byte = Number.parseInt(entropyHex.slice(i * 2, i * 2 + 2), 16);
      if (Number.isNaN(byte)) {
        return "bad-checksum";
      }
      entropyBytes[i] = byte;
    }
  } catch {
    return "bad-checksum";
  }

  // Recompute checksum from raw bytes
  let recomputedChecksum: string;
  try {
    const hashBuffer = await crypto.subtle.digest("SHA-256", entropyBytes);
    recomputedChecksum = toHex(new Uint8Array(hashBuffer)).slice(0, 8);
  } catch {
    return "bad-checksum";
  }

  // Simple string equality is fine here: the checksum is not secret (public integrity tag)
  // and timing side-channels are not a concern for a non-MAC value.
  return recomputedChecksum === embeddedChecksum ? "ok" : "bad-checksum";
}
