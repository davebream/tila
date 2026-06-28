/**
 * DPoP key management for the CLI.
 *
 * Generates a P-256 ECDSA key pair, persists the private key via the auth-store
 * SecretStore, and mints per-request DPoP proof JWTs using jose.
 *
 * IMPORTANT: Do NOT import @tila/worker here — the CLI must not pull in
 * Cloudflare Workers types. The canonicalizeHtu helper is imported from
 * @tila/schemas (platform-agnostic).
 */

import type { SecretStore } from "@tila/auth-store";
import { DPOP_ALG, DPOP_TYP, canonicalizeHtu } from "@tila/schemas";
import { SignJWT, calculateJwkThumbprint, importJWK } from "jose";

/** Service name used when storing DPoP keys in the SecretStore. */
const DPOP_SERVICE = "tila:dpop";

export interface DpopKeyResult {
  /** Public JWK (EC P-256). */
  publicJwk: JsonWebKey;
  /** JWK thumbprint (SHA-256, base64url, 43 chars) — bind into the session. */
  jkt: string;
}

/**
 * Generate a P-256 ECDSA key pair, persist the private key via the provided
 * SecretStore, and return the public JWK with its JWK thumbprint.
 *
 * The private JWK is JSON-serialized and stored as:
 *   service = "tila:dpop"
 *   account = instanceId
 *
 * @param store     SecretStore implementation (keychain in production, FakeSecretStore in tests).
 * @param instanceId Stable deployment instance identifier; used as the keychain account.
 */
export async function generateDpopKey(
  store: SecretStore,
  instanceId: string,
): Promise<DpopKeyResult> {
  const keyPair = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true, // extractable
    ["sign", "verify"],
  );

  const privateJwk = await crypto.subtle.exportKey("jwk", keyPair.privateKey);
  const publicJwk = await crypto.subtle.exportKey("jwk", keyPair.publicKey);

  // Persist the private key
  await store.set(DPOP_SERVICE, instanceId, JSON.stringify(privateJwk));

  // Compute the thumbprint of the public key (RFC 7638, SHA-256)
  const jkt = await calculateJwkThumbprint(
    publicJwk as Parameters<typeof calculateJwkThumbprint>[0],
    "sha256",
  );

  return { publicJwk, jkt };
}

/**
 * Load the private DPoP key for a given instance from the SecretStore.
 *
 * Returns null if no key has been stored yet (e.g. before first login).
 */
export async function loadDpopPrivateKey(
  store: SecretStore,
  instanceId: string,
): Promise<{ privateJwk: JsonWebKey; publicJwk: JsonWebKey } | null> {
  const raw = await store.get(DPOP_SERVICE, instanceId);
  if (raw === null) return null;

  const privateJwk = JSON.parse(raw) as JsonWebKey;

  // Derive public JWK from private JWK by dropping the private 'd' field
  const {
    d: _d,
    key_ops: _keyOps,
    ...publicJwk
  } = privateJwk as {
    d?: string;
    key_ops?: string[];
    [key: string]: unknown;
  };
  // Cast to JsonWebKey — the spread yields the correct shape
  return { privateJwk, publicJwk: publicJwk as JsonWebKey };
}

export interface SignDpopProofOptions {
  /** HTTP method (e.g. "POST"). */
  htm: string;
  /** Target URL string — will be canonicalized via canonicalizeHtu. */
  htu: string;
  /** Private JWK (EC P-256). */
  privateJwk: JsonWebKey;
}

/**
 * Sign a DPoP proof JWT for a single request.
 *
 * The proof header carries:
 *   typ: "dpop+jwt"
 *   alg: "ES256"
 *   jwk: <public key>
 *
 * The proof payload carries:
 *   htm: uppercased HTTP method
 *   htu: canonicalized target URL (via canonicalizeHtu from @tila/schemas)
 *   iat: current Unix timestamp (seconds)
 *   jti: random UUID (single-use identifier)
 */
export async function signDpopProof(
  opts: SignDpopProofOptions,
): Promise<string> {
  const privateKey = await importJWK(
    opts.privateJwk as Parameters<typeof importJWK>[0],
    DPOP_ALG,
  );

  // Derive public JWK from private JWK (drop 'd' + private key_ops)
  const {
    d: _d,
    key_ops: _keyOps,
    ...publicJwk
  } = opts.privateJwk as {
    d?: string;
    key_ops?: string[];
    [key: string]: unknown;
  };

  const htu = canonicalizeHtu(opts.htu);

  const proof = await new SignJWT({
    htm: opts.htm.toUpperCase(),
    htu,
    iat: Math.floor(Date.now() / 1000),
    jti: crypto.randomUUID(),
  })
    .setProtectedHeader({
      typ: DPOP_TYP,
      alg: DPOP_ALG,
      jwk: publicJwk,
    })
    .sign(privateKey);

  return proof;
}
