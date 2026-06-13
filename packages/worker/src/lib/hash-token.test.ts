import { describe, expect, it } from "vitest";
import { hashToken } from "./hash-token";

describe("hashToken", () => {
  it("returns a 64-char lowercase hex string", async () => {
    const hash = await hashToken("test-token-abc123");
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("produces deterministic output", async () => {
    const a = await hashToken("same-input");
    const b = await hashToken("same-input");
    expect(a).toBe(b);
  });

  it("produces different output for different inputs", async () => {
    const a = await hashToken("token-a");
    const b = await hashToken("token-b");
    expect(a).not.toBe(b);
  });

  it("returns the known SHA-256 digest for the empty string", async () => {
    const hash = await hashToken("");
    expect(hash).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });

  it("hashes empty string without error", async () => {
    await expect(hashToken("")).resolves.not.toThrow();
  });

  describe("with a HASH_PEPPER", () => {
    it("returns a deterministic HMAC digest that differs from the unpeppered hash", async () => {
      const plain = await hashToken("tila_secret");
      const peppered = await hashToken("tila_secret", "pepper-1");
      const again = await hashToken("tila_secret", "pepper-1");
      expect(peppered).toMatch(/^[0-9a-f]{64}$/);
      expect(peppered).toBe(again);
      expect(peppered).not.toBe(plain);
    });

    it("different peppers produce different digests for the same token", async () => {
      const a = await hashToken("tila_secret", "pepper-1");
      const b = await hashToken("tila_secret", "pepper-2");
      expect(a).not.toBe(b);
    });

    it("treats an empty-string pepper as no pepper (SHA-256 fallback)", async () => {
      const plain = await hashToken("tila_secret");
      const empty = await hashToken("tila_secret", "");
      expect(empty).toBe(plain);
    });
  });
});
