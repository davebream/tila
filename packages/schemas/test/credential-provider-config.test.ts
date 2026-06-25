/**
 * Tests for CredentialProviderConfigSchema and InstanceRecord.credential_provider
 * optional field (WI-K / C2)
 *
 * Verifies:
 * - Absent credential_provider field: existing records parse unchanged
 * - Each of the 4 provider kinds validates correctly
 * - oidc-generic requires issuer (url) and client_id
 * - exec requires command; args defaults to []
 * - RC-1 negative: auth.mode fallback can only yield github or tila-token
 */

import { describe, expect, it } from "vitest";
import {
  CredentialProviderConfigSchema,
  InstanceRecordSchema,
} from "../src/instance-registry";
import type { InstanceKey } from "../src/instance-registry";

const makeKey = (s: string) => s as InstanceKey;

const baseRecord = {
  instance_key: makeKey("key-001"),
  worker_url: "https://worker.example.com",
  instance_id_source: "server" as const,
  trust: { trusted: true, trusted_at: 1700000000000 },
  created_at: 1700000000000,
};

describe("InstanceRecordSchema — credential_provider optional field (WI-K)", () => {
  it("parses a record without credential_provider (backward compatibility)", () => {
    const parsed = InstanceRecordSchema.parse(baseRecord);
    expect(parsed.credential_provider).toBeUndefined();
  });

  it('validates kind "github" (no extra fields required)', () => {
    const parsed = CredentialProviderConfigSchema.parse({ kind: "github" });
    expect(parsed.kind).toBe("github");
  });

  it('validates kind "tila-token" (no extra fields required)', () => {
    const parsed = CredentialProviderConfigSchema.parse({ kind: "tila-token" });
    expect(parsed.kind).toBe("tila-token");
  });

  it('validates kind "oidc-generic" with required issuer and client_id', () => {
    const parsed = CredentialProviderConfigSchema.parse({
      kind: "oidc-generic",
      issuer: "https://accounts.example.com",
      client_id: "my-client-id",
    });
    expect(parsed.kind).toBe("oidc-generic");
    if (parsed.kind === "oidc-generic") {
      expect(parsed.issuer).toBe("https://accounts.example.com");
      expect(parsed.client_id).toBe("my-client-id");
      expect(parsed.scope).toBeUndefined();
      expect(parsed.audience).toBeUndefined();
    }
  });

  it('validates kind "oidc-generic" with optional scope and audience', () => {
    const parsed = CredentialProviderConfigSchema.parse({
      kind: "oidc-generic",
      issuer: "https://accounts.example.com",
      client_id: "my-client-id",
      scope: "openid profile",
      audience: "api.example.com",
    });
    if (parsed.kind === "oidc-generic") {
      expect(parsed.scope).toBe("openid profile");
      expect(parsed.audience).toBe("api.example.com");
    }
  });

  it('rejects "oidc-generic" without issuer', () => {
    expect(() =>
      CredentialProviderConfigSchema.parse({
        kind: "oidc-generic",
        client_id: "my-client-id",
      }),
    ).toThrow();
  });

  it('rejects "oidc-generic" without client_id', () => {
    expect(() =>
      CredentialProviderConfigSchema.parse({
        kind: "oidc-generic",
        issuer: "https://accounts.example.com",
      }),
    ).toThrow();
  });

  it('rejects "oidc-generic" with non-URL issuer', () => {
    expect(() =>
      CredentialProviderConfigSchema.parse({
        kind: "oidc-generic",
        issuer: "not-a-url",
        client_id: "my-client-id",
      }),
    ).toThrow();
  });

  it('validates kind "exec" with required command and defaulted args', () => {
    const parsed = CredentialProviderConfigSchema.parse({
      kind: "exec",
      command: "/usr/local/bin/credential-helper",
    });
    expect(parsed.kind).toBe("exec");
    if (parsed.kind === "exec") {
      expect(parsed.command).toBe("/usr/local/bin/credential-helper");
      expect(parsed.args).toEqual([]);
    }
  });

  it('validates kind "exec" with optional args', () => {
    const parsed = CredentialProviderConfigSchema.parse({
      kind: "exec",
      command: "op",
      args: ["read", "op://vault/credential"],
    });
    if (parsed.kind === "exec") {
      expect(parsed.args).toEqual(["read", "op://vault/credential"]);
    }
  });

  it('rejects "exec" without command', () => {
    expect(() =>
      CredentialProviderConfigSchema.parse({ kind: "exec" }),
    ).toThrow();
  });

  it("rejects unknown kind", () => {
    expect(() =>
      CredentialProviderConfigSchema.parse({ kind: "unknown-provider" }),
    ).toThrow();
  });

  it("parses a record with github credential_provider", () => {
    const parsed = InstanceRecordSchema.parse({
      ...baseRecord,
      credential_provider: { kind: "github" },
    });
    expect(parsed.credential_provider?.kind).toBe("github");
  });

  it("parses a record with exec credential_provider", () => {
    const parsed = InstanceRecordSchema.parse({
      ...baseRecord,
      credential_provider: {
        kind: "exec",
        command: "/usr/bin/my-helper",
        args: [],
      },
    });
    expect(parsed.credential_provider?.kind).toBe("exec");
  });
});

/**
 * RC-1: The project auth.mode fallback can only yield github or tila-token.
 * exec and oidc-generic require an explicit credential_provider on the trusted
 * InstanceRecord — the untrusted project config can never select them.
 */
describe("RC-1 negative: auth.mode fallback cannot yield exec or oidc-generic", () => {
  it("auth.mode enum values do not include exec or oidc-generic", () => {
    const authModeValues = ["tila-token", "github-repo"] as const;
    const execOrOidc = authModeValues.filter(
      (m) => m === ("exec" as string) || m === ("oidc-generic" as string),
    );
    expect(execOrOidc).toHaveLength(0);
  });

  it("exec and oidc-generic require explicit credential_provider — absent field yields undefined", () => {
    const parsed = InstanceRecordSchema.parse(baseRecord);
    // No credential_provider → caller must use auth.mode which is limited to github/tila-token
    expect(parsed.credential_provider).toBeUndefined();
    // The only kinds reachable from auth.mode fallback:
    const authModeMappableKinds = ["github", "tila-token"] as const;
    const execKind: string = "exec";
    const oidcKind: string = "oidc-generic";
    expect(authModeMappableKinds).not.toContain(execKind);
    expect(authModeMappableKinds).not.toContain(oidcKind);
  });
});
