import { FakeSecretStore } from "@tila/auth-store";
import { calculateJwkThumbprint, importJWK, jwtVerify } from "jose";
import { describe, expect, it } from "vitest";
import {
  generateDpopKey,
  loadDpopPrivateKey,
  signDpopProof,
} from "../../lib/dpop-key";

describe("generateDpopKey", () => {
  it("returns a public JWK and a 43-char base64url jkt", async () => {
    const store = new FakeSecretStore();
    const { publicJwk, jkt } = await generateDpopKey(store, "inst-1");

    expect(publicJwk.kty).toBe("EC");
    expect(publicJwk.crv).toBe("P-256");
    // A SHA-256 JWK thumbprint is 32 bytes = 43 base64url chars (no padding)
    expect(jkt).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("persists the private key in the store under 'tila:dpop' / instanceId", async () => {
    const store = new FakeSecretStore();
    await generateDpopKey(store, "inst-abc");

    const raw = await store.get("tila:dpop", "inst-abc");
    expect(raw).not.toBeNull();
    if (raw === null) return;
    const parsed = JSON.parse(raw);
    expect(parsed.kty).toBe("EC");
    // The stored JWK must contain the private component 'd'
    expect(parsed.d).toBeDefined();
  });

  it("generate→store→load round-trip preserves the key", async () => {
    const store = new FakeSecretStore();
    const { jkt } = await generateDpopKey(store, "inst-rt");

    const loaded = await loadDpopPrivateKey(store, "inst-rt");
    expect(loaded).not.toBeNull();
    if (loaded === null) return;

    // Recompute jkt from the loaded public JWK
    const recomputedJkt = await calculateJwkThumbprint(
      loaded.publicJwk as Parameters<typeof calculateJwkThumbprint>[0],
      "sha256",
    );
    expect(recomputedJkt).toBe(jkt);
  });

  it("jkt reported by generateDpopKey equals the thumbprint of the embedded public key", async () => {
    const store = new FakeSecretStore();
    const { publicJwk, jkt } = await generateDpopKey(store, "inst-jkt");

    const recomputed = await calculateJwkThumbprint(
      publicJwk as Parameters<typeof calculateJwkThumbprint>[0],
      "sha256",
    );
    expect(recomputed).toBe(jkt);
  });
});

describe("loadDpopPrivateKey", () => {
  it("returns null when no key has been stored", async () => {
    const store = new FakeSecretStore();
    const result = await loadDpopPrivateKey(store, "unknown-inst");
    expect(result).toBeNull();
  });

  it("public JWK derived from loaded key does NOT contain 'd'", async () => {
    const store = new FakeSecretStore();
    await generateDpopKey(store, "inst-pub");
    const loaded = await loadDpopPrivateKey(store, "inst-pub");
    expect(loaded).not.toBeNull();
    if (loaded === null) return;
    expect((loaded.publicJwk as { d?: string }).d).toBeUndefined();
  });
});

describe("signDpopProof", () => {
  it("produces a valid ES256 DPoP proof JWT verifiable with the public key", async () => {
    const store = new FakeSecretStore();
    const { publicJwk, jkt } = await generateDpopKey(store, "inst-sign");
    const loaded = await loadDpopPrivateKey(store, "inst-sign");
    expect(loaded).not.toBeNull();
    if (loaded === null) return;

    const proof = await signDpopProof({
      htm: "POST",
      htu: "https://example.workers.dev/api/tasks",
      privateJwk: loaded.privateJwk,
    });

    // Import the public key for verification
    const verifyKey = await importJWK(
      publicJwk as Parameters<typeof importJWK>[0],
      "ES256",
    );

    const { payload, protectedHeader } = await jwtVerify(proof, verifyKey, {
      // We verify structure manually; typ is non-standard and jwtVerify doesn't
      // enforce it by default in jose v6, but we can check the decoded header.
      clockTolerance: 10,
    });

    // Header checks
    expect(protectedHeader.typ).toBe("dpop+jwt");
    expect(protectedHeader.alg).toBe("ES256");
    expect(protectedHeader.jwk).toBeDefined();

    // Payload checks
    expect(payload.htm).toBe("POST");
    // htu should be canonicalized (no query/fragment, lowercase scheme+host)
    expect(payload.htu).toBe("https://example.workers.dev/api/tasks");
    expect(typeof payload.iat).toBe("number");
    expect(typeof payload.jti).toBe("string");
    expect(payload.jti).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );

    // The embedded jwk thumbprint must equal the reported jkt
    const embeddedJkt = await calculateJwkThumbprint(
      protectedHeader.jwk as Parameters<typeof calculateJwkThumbprint>[0],
      "sha256",
    );
    expect(embeddedJkt).toBe(jkt);
  });

  it("canonicalizes htu: strips query string and fragment", async () => {
    const store = new FakeSecretStore();
    const { publicJwk } = await generateDpopKey(store, "inst-htu");
    const loaded = await loadDpopPrivateKey(store, "inst-htu");
    expect(loaded).not.toBeNull();
    if (loaded === null) return;

    const proof = await signDpopProof({
      htm: "GET",
      htu: "https://example.workers.dev/api/tasks?foo=bar#section",
      privateJwk: loaded.privateJwk,
    });

    const verifyKey = await importJWK(
      publicJwk as Parameters<typeof importJWK>[0],
      "ES256",
    );
    const { payload } = await jwtVerify(proof, verifyKey, {
      clockTolerance: 10,
    });

    // Query string and fragment must be stripped
    expect(payload.htu).toBe("https://example.workers.dev/api/tasks");
  });

  it("uppercases the htm claim regardless of input casing", async () => {
    const store = new FakeSecretStore();
    const { publicJwk } = await generateDpopKey(store, "inst-htm");
    const loaded = await loadDpopPrivateKey(store, "inst-htm");
    expect(loaded).not.toBeNull();
    if (loaded === null) return;

    const proof = await signDpopProof({
      htm: "post", // lowercase input
      htu: "https://example.workers.dev/api/tasks",
      privateJwk: loaded.privateJwk,
    });

    const verifyKey = await importJWK(
      publicJwk as Parameters<typeof importJWK>[0],
      "ES256",
    );
    const { payload } = await jwtVerify(proof, verifyKey, {
      clockTolerance: 10,
    });
    expect(payload.htm).toBe("POST");
  });
});
