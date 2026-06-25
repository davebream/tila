import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

// Mock child_process.execSync
const mockExecSync = vi.fn();
vi.mock("node:child_process", () => ({
  execSync: (...args: unknown[]) => mockExecSync(...args),
}));

// Import after mock
const { deriveRepo, generateRawToken, verifyD1TokenChecksum } = await import(
  "./provisioning"
);

// ---------------------------------------------------------------------------
// Cross-runtime parity fixture (same as Worker token-format.test.ts Task 1)
// entropy = 0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20
// expected checksum = ae216c2e
// ---------------------------------------------------------------------------
const FIXTURE_ENTROPY_HEX =
  "0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20";
const FIXTURE_CHECKSUM = "ae216c2e";
const FIXTURE_TOKEN = `tila_d1_${FIXTURE_ENTROPY_HEX}${FIXTURE_CHECKSUM}`;

describe("generateRawToken", () => {
  it("matches the tila_d1_ format: prefix + 64-hex entropy + 8-hex checksum", () => {
    const token = generateRawToken();
    expect(token).toMatch(/^tila_d1_[0-9a-f]{72}$/);
  });

  it("produces tokens of exactly 80 chars (8 prefix + 64 entropy + 8 checksum)", () => {
    const token = generateRawToken();
    expect(token.length).toBe(80);
  });

  it("generates unique tokens on repeated calls", () => {
    const t1 = generateRawToken();
    const t2 = generateRawToken();
    expect(t1).not.toBe(t2);
  });
});

describe("verifyD1TokenChecksum", () => {
  it("round-trip: a freshly generated token verifies as 'ok'", () => {
    const token = generateRawToken();
    expect(verifyD1TokenChecksum(token)).toBe("ok");
  });

  it("cross-runtime fixture: fixed entropy yields expected checksum ae216c2e", () => {
    // Compute from raw bytes (same algorithm as Worker WebCrypto path)
    const entropyBytes = Buffer.from(FIXTURE_ENTROPY_HEX, "hex");
    const computed = createHash("sha256")
      .update(entropyBytes)
      .digest("hex")
      .slice(0, 8);
    expect(computed).toBe(FIXTURE_CHECKSUM);
    expect(verifyD1TokenChecksum(FIXTURE_TOKEN)).toBe("ok");
  });

  it("tamper entropy: flip one hex char in entropy region → 'bad-checksum'", () => {
    const body = FIXTURE_TOKEN.slice("tila_d1_".length);
    // Flip the first char of entropy (0→1)
    const tampered = `tila_d1_1${body.slice(1)}`;
    expect(verifyD1TokenChecksum(tampered)).toBe("bad-checksum");
  });

  it("tamper checksum: flip one hex char in checksum region → 'bad-checksum'", () => {
    // Flip the last char of the checksum
    const lastChar = FIXTURE_TOKEN[FIXTURE_TOKEN.length - 1];
    const flipped = lastChar === "e" ? "f" : "e";
    const tampered = `${FIXTURE_TOKEN.slice(0, FIXTURE_TOKEN.length - 1)}${flipped}`;
    expect(verifyD1TokenChecksum(tampered)).toBe("bad-checksum");
  });

  it("truncated body → 'bad-checksum'", () => {
    expect(verifyD1TokenChecksum(`tila_d1_${"a".repeat(71)}`)).toBe(
      "bad-checksum",
    );
  });

  it("uppercase hex on tila_d1_ token → 'bad-checksum'", () => {
    // Body is 72 hex chars but uppercase
    expect(verifyD1TokenChecksum(`tila_d1_${"A".repeat(72)}`)).toBe(
      "bad-checksum",
    );
  });

  it("non-hex chars on tila_d1_ token → 'bad-checksum'", () => {
    expect(verifyD1TokenChecksum(`tila_d1_${"z".repeat(72)}`)).toBe(
      "bad-checksum",
    );
  });

  it("legacy tila_<64hex> token → 'not-d1-token'", () => {
    expect(verifyD1TokenChecksum(`tila_${"a".repeat(64)}`)).toBe(
      "not-d1-token",
    );
  });

  it("dev bootstrap token tila_dev_token_localonly → 'not-d1-token'", () => {
    expect(verifyD1TokenChecksum("tila_dev_token_localonly")).toBe(
      "not-d1-token",
    );
  });

  it("empty string → 'not-d1-token'", () => {
    expect(verifyD1TokenChecksum("")).toBe("not-d1-token");
  });

  it("never throws — arbitrary garbage input returns a valid result", () => {
    expect(() => verifyD1TokenChecksum("garbage!!!")).not.toThrow();
    expect(verifyD1TokenChecksum("garbage!!!")).toBe("not-d1-token");
  });
});

describe("deriveRepo", () => {
  it("parses HTTPS remote URL", () => {
    mockExecSync.mockReturnValue("https://github.com/davebream/tila.git\n");
    const result = deriveRepo("/some/dir");
    expect(result).toEqual({ owner: "davebream", repo: "tila" });
  });

  it("parses HTTPS remote URL without .git suffix", () => {
    mockExecSync.mockReturnValue("https://github.com/davebream/tila\n");
    const result = deriveRepo("/some/dir");
    expect(result).toEqual({ owner: "davebream", repo: "tila" });
  });

  it("parses SSH remote URL", () => {
    mockExecSync.mockReturnValue("git@github.com:davebream/tila.git\n");
    const result = deriveRepo("/some/dir");
    expect(result).toEqual({ owner: "davebream", repo: "tila" });
  });

  it("parses SSH remote URL without .git suffix", () => {
    mockExecSync.mockReturnValue("git@github.com:davebream/tila\n");
    const result = deriveRepo("/some/dir");
    expect(result).toEqual({ owner: "davebream", repo: "tila" });
  });

  it("returns null when not a git repo", () => {
    mockExecSync.mockImplementation(() => {
      throw new Error("not a git repository");
    });
    const result = deriveRepo("/some/dir");
    expect(result).toBeNull();
  });

  it("returns null for unrecognized URL format", () => {
    mockExecSync.mockReturnValue("svn://example.com/repo\n");
    const result = deriveRepo("/some/dir");
    expect(result).toBeNull();
  });
});
