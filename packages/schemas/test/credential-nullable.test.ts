/**
 * Tests for CredentialRecordSchema — nullable expires_at (WI-K / C1)
 *
 * Verifies:
 * - null expires_at is accepted and round-trips correctly
 * - non-null number is still accepted
 * - A parsed record with null expires_at round-trips through JSON
 */

import { describe, expect, it } from "vitest";
import { CredentialRecordSchema } from "../src/credential";
import type { InstanceKey } from "../src/instance-registry";

const makeKey = (s: string) => s as InstanceKey;

describe("CredentialRecordSchema — nullable expires_at (WI-K)", () => {
  it("accepts null expires_at (non-expiring credential)", () => {
    const parsed = CredentialRecordSchema.parse({
      instance_key: makeKey("key-001"),
      token: "tok_abc",
      token_type: "bearer",
      expires_at: null,
      scope: "repo",
      obtained_at: 1700000000000,
    });
    expect(parsed.expires_at).toBeNull();
  });

  it("accepts a numeric expires_at (timestamped credential)", () => {
    const parsed = CredentialRecordSchema.parse({
      instance_key: makeKey("key-001"),
      token: "tok_abc",
      token_type: "bearer",
      expires_at: 1800000000000,
      obtained_at: 1700000000000,
    });
    expect(parsed.expires_at).toBe(1800000000000);
  });

  it("round-trips null expires_at through JSON serialization", () => {
    const original = {
      instance_key: makeKey("key-002"),
      token: "tok_xyz",
      token_type: "github-user-token",
      expires_at: null,
      obtained_at: 1700000000000,
    };
    const serialized = JSON.stringify(CredentialRecordSchema.parse(original));
    const parsed = CredentialRecordSchema.parse(JSON.parse(serialized));
    expect(parsed.expires_at).toBeNull();
    expect(parsed.token).toBe("tok_xyz");
  });

  it("rejects missing expires_at (field is required)", () => {
    expect(() =>
      CredentialRecordSchema.parse({
        instance_key: makeKey("key-003"),
        token: "tok_abc",
        token_type: "bearer",
        obtained_at: 1700000000000,
        // expires_at intentionally omitted
      }),
    ).toThrow();
  });

  it("rejects non-integer expires_at", () => {
    expect(() =>
      CredentialRecordSchema.parse({
        instance_key: makeKey("key-004"),
        token: "tok_abc",
        token_type: "bearer",
        expires_at: 1700000000000.5,
        obtained_at: 1700000000000,
      }),
    ).toThrow();
  });
});
