import { accessTokenHash, canonicalizeHtu } from "@tila/schemas";
import type { DpopBinding } from "tila-sdk";

export async function generateRuntimeKey(): Promise<JsonWebKey> {
  const key = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  return crypto.subtle.exportKey("jwk", key.privateKey);
}
const encode = (value: unknown) =>
  Buffer.from(JSON.stringify(value)).toString("base64url");

/** A key cannot sign for arbitrary services or control endpoints. */
export async function runtimeBinding(
  privateJwk: JsonWebKey,
  deployment: string,
  permits: (path: string, method: string) => boolean,
): Promise<DpopBinding> {
  const publicJwk = {
    crv: privateJwk.crv,
    kty: privateJwk.kty,
    x: privateJwk.x,
    y: privateJwk.y,
  };
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(publicJwk)),
  );
  const jkt = Buffer.from(digest).toString("base64url");
  const key = await crypto.subtle.importKey(
    "jwk",
    privateJwk,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
  const origin = new URL(deployment).origin;
  return {
    jkt,
    async signProof(context) {
      context.signal.throwIfAborted();
      const url = new URL(context.htu);
      if (
        url.origin !== origin ||
        url.username ||
        url.password ||
        !permits(url.pathname, context.htm.toUpperCase())
      )
        throw new Error(
          "runtime-binding-mismatch: proof target is outside runtime authority",
        );
      if (context.ath !== (await accessTokenHash(context.accessToken)))
        throw new Error("runtime-binding-mismatch: incorrect token hash");
      const unsigned = `${encode({ typ: "dpop+jwt", alg: "ES256", jwk: publicJwk })}.${encode({ htm: context.htm.toUpperCase(), htu: canonicalizeHtu(url.toString()), ath: context.ath, iat: Math.floor(Date.now() / 1000), jti: crypto.randomUUID() })}`;
      const signature = await crypto.subtle.sign(
        { name: "ECDSA", hash: "SHA-256" },
        key,
        new TextEncoder().encode(unsigned),
      );
      return `${unsigned}.${Buffer.from(signature).toString("base64url")}`;
    },
  };
}

export function runtimeEndpointPolicy(
  projectId: string,
  purpose: "enrollment" | "run",
) {
  const root = `/projects/${encodeURIComponent(projectId)}/`;
  return (path: string, method: string) => {
    if (path === "/api/runtime/context") return method === "GET";
    if (!path.startsWith(root) || /%2f|%5c|%2e/i.test(path)) return false;
    return purpose === "enrollment"
      ? path.startsWith(`${root}runtime/`)
      : !path.startsWith(`${root}runtime/`);
  };
}
