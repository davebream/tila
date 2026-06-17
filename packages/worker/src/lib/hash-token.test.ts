import { describe, expect, it } from "vitest";
import { hashToken } from "./hash-token";

// `pepper` is a required parameter (`string | undefined`); the bare-SHA-256
// fallback is exercised by passing `undefined` explicitly. A no-arg
// `hashToken(raw)` is intentionally a compile error (SEC-1 type enforcement).

describe("hashToken", () => {
  it("returns a 64-char lowercase hex string", async () => {
    const hash = await hashToken("test-token-abc123", undefined);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("produces deterministic output", async () => {
    const a = await hashToken("same-input", undefined);
    const b = await hashToken("same-input", undefined);
    expect(a).toBe(b);
  });

  it("produces different output for different inputs", async () => {
    const a = await hashToken("token-a", undefined);
    const b = await hashToken("token-b", undefined);
    expect(a).not.toBe(b);
  });

  it("returns the known SHA-256 digest for the empty string", async () => {
    const hash = await hashToken("", undefined);
    expect(hash).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });

  it("hashes empty string without error", async () => {
    await expect(hashToken("", undefined)).resolves.not.toThrow();
  });

  describe("with a HASH_PEPPER", () => {
    it("returns a deterministic HMAC digest that differs from the unpeppered hash", async () => {
      const plain = await hashToken("tila_secret", undefined);
      const peppered = await hashToken("tila_secret", "pepper-1");
      const again = await hashToken("tila_secret", "pepper-1");
      expect(peppered).toMatch(/^[0-9a-f]{64}$/);
      expect(peppered).toBe(again);
      expect(peppered).not.toBe(plain);
    });

    it("rotating the pepper changes the digest — hash(raw, A) !== hash(raw, B)", async () => {
      // Rotating HASH_PEPPER (A → B) produces a different digest for the same
      // raw token, so credentials hashed under the old pepper stop matching —
      // the same break as enabling the pepper for the first time.
      const underA = await hashToken("tila_secret", "pepper-A");
      const underB = await hashToken("tila_secret", "pepper-B");
      expect(underA).not.toBe(underB);
    });

    it("treats an empty-string pepper as no pepper (SHA-256 fallback)", async () => {
      const plain = await hashToken("tila_secret", undefined);
      const empty = await hashToken("tila_secret", "");
      expect(empty).toBe(plain);
    });
  });
});
