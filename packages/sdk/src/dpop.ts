import { accessTokenHash } from "@tila/schemas";
import { abortable } from "./abort";
import {
  type DpopBinding,
  type DpopProofContext,
  TokenProviderError,
} from "./token-provider";

/** Check the callback's proof contract before sending credentials to the server. */
export async function providerProof(
  binding: DpopBinding,
  context: DpopProofContext,
): Promise<string> {
  context.signal.throwIfAborted();
  const proof = await abortable(
    Promise.resolve().then(() => binding.signProof(context)),
    context.signal,
  );
  try {
    const parts = proof.split(".");
    if (
      parts.length !== 3 ||
      !parts.every((part) => /^[A-Za-z0-9_-]+$/.test(part))
    )
      throw new Error();
    const decode = (part: string) =>
      JSON.parse(atob(part.replace(/-/g, "+").replace(/_/g, "/")));
    const header = decode(parts[0]);
    const payload = decode(parts[1]);
    const jwk = header.jwk;
    if (
      header.typ !== "dpop+jwt" ||
      header.alg !== "ES256" ||
      !jwk ||
      jwk.d !== undefined ||
      jwk.kty !== "EC" ||
      jwk.crv !== "P-256" ||
      typeof jwk.x !== "string" ||
      typeof jwk.y !== "string" ||
      payload.htm !== context.htm ||
      payload.htu !== context.htu ||
      payload.ath !== context.ath ||
      typeof payload.jti !== "string" ||
      !payload.jti ||
      !Number.isFinite(payload.iat)
    )
      throw new Error();
    const jkt = await abortable(
      accessTokenHash(
        JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y }),
      ),
      context.signal,
    );
    if (jkt !== binding.jkt) throw new Error();
  } catch {
    if (context.signal.aborted) throw context.signal.reason;
    throw new TokenProviderError(
      "invalid-dpop-proof",
      "Provider proof does not match the credential and request",
    );
  }
  return proof;
}
