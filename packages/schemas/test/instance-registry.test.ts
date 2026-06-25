import { describe, expect, it } from "vitest";
import {
  type CredentialRecord,
  CredentialRecordSchema,
} from "../src/credential";
import {
  InstanceKey,
  type InstanceRecord,
  InstanceRecordSchema,
  InstanceRegistrySchema,
} from "../src/instance-registry";
import { type RefreshRecord, RefreshRecordSchema } from "../src/refresh";

describe("InstanceKey brand", () => {
  it("accepts a valid string", () => {
    const result = InstanceKey.safeParse("inst_abc-123");
    expect(result.success).toBe(true);
  });

  it("rejects a non-string", () => {
    const result = InstanceKey.safeParse(42);
    expect(result.success).toBe(false);
  });
});

describe("InstanceRecordSchema round-trip", () => {
  const validRecord: InstanceRecord = {
    instance_key: "my-instance" as string & { readonly __brand: "InstanceKey" },
    label: "My Instance",
    worker_url: "https://worker.example.com",
    instance_id_source: "server",
    trust: { trusted: false, trusted_at: null },
    created_at: 1700000000000,
  };

  it("accepts a valid instance record", () => {
    const result = InstanceRecordSchema.safeParse(validRecord);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.instance_key).toBe(validRecord.instance_key);
      expect(result.data.created_at).toBe(1700000000000);
    }
  });

  it("accepts instance_id_source=client-uuid", () => {
    const rec = { ...validRecord, instance_id_source: "client-uuid" };
    const result = InstanceRecordSchema.safeParse(rec);
    expect(result.success).toBe(true);
  });

  it("rejects unknown instance_id_source", () => {
    const rec = { ...validRecord, instance_id_source: "magic" };
    const result = InstanceRecordSchema.safeParse(rec);
    expect(result.success).toBe(false);
  });

  it("rejects non-integer timestamps", () => {
    const rec = { ...validRecord, created_at: 1700000000.5 };
    const result = InstanceRecordSchema.safeParse(rec);
    expect(result.success).toBe(false);
  });

  it("rejects missing required fields", () => {
    const { instance_key: _, ...rest } = validRecord;
    const result = InstanceRecordSchema.safeParse(rest);
    expect(result.success).toBe(false);
  });
});

describe("InstanceRegistrySchema round-trip", () => {
  it("accepts a valid registry with null current_context", () => {
    const registry = {
      version: 1,
      current_context: null,
      instances: [],
    };
    const result = InstanceRegistrySchema.safeParse(registry);
    expect(result.success).toBe(true);
  });

  it("accepts a registry with a current_context key", () => {
    const registry = {
      version: 1,
      current_context: "my-inst",
      instances: [
        {
          instance_key: "my-inst",
          worker_url: "https://example.com",
          instance_id_source: "server",
          trust: { trusted: true, trusted_at: 1700000000000 },
          created_at: 1700000000000,
        },
      ],
    };
    const result = InstanceRegistrySchema.safeParse(registry);
    expect(result.success).toBe(true);
  });

  it("rejects missing version", () => {
    const result = InstanceRegistrySchema.safeParse({
      current_context: null,
      instances: [],
    });
    expect(result.success).toBe(false);
  });
});

describe("CredentialRecordSchema round-trip", () => {
  const validCred: CredentialRecord = {
    instance_key: "my-instance" as string & { readonly __brand: "InstanceKey" },
    token: "tok_abc123",
    token_type: "bearer",
    expires_at: 1800000000000,
    obtained_at: 1700000000000,
  };

  it("accepts a valid credential record", () => {
    const result = CredentialRecordSchema.safeParse(validCred);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.token).toBe("tok_abc123");
    }
  });

  it("accepts optional scope field", () => {
    const rec = { ...validCred, scope: "repo read:org" };
    const result = CredentialRecordSchema.safeParse(rec);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.scope).toBe("repo read:org");
  });

  it("rejects missing token", () => {
    const { token: _, ...rest } = validCred;
    const result = CredentialRecordSchema.safeParse(rest);
    expect(result.success).toBe(false);
  });

  it("rejects non-integer expires_at", () => {
    const rec = { ...validCred, expires_at: 1800000000.5 };
    const result = CredentialRecordSchema.safeParse(rec);
    expect(result.success).toBe(false);
  });
});

describe("RefreshRecordSchema round-trip", () => {
  const validRefresh: RefreshRecord = {
    instance_key: "my-instance" as string & { readonly __brand: "InstanceKey" },
    refresh_token: "rt_xyz",
    expires_at: null,
    obtained_at: 1700000000000,
  };

  it("accepts a valid refresh record with null expires_at", () => {
    const result = RefreshRecordSchema.safeParse(validRefresh);
    expect(result.success).toBe(true);
  });

  it("accepts a refresh record with non-null expires_at", () => {
    const rec = { ...validRefresh, expires_at: 1900000000000 };
    const result = RefreshRecordSchema.safeParse(rec);
    expect(result.success).toBe(true);
  });

  it("rejects non-integer expires_at when non-null", () => {
    const rec = { ...validRefresh, expires_at: 1900000000.5 };
    const result = RefreshRecordSchema.safeParse(rec);
    expect(result.success).toBe(false);
  });

  it("rejects missing refresh_token", () => {
    const { refresh_token: _, ...rest } = validRefresh;
    const result = RefreshRecordSchema.safeParse(rest);
    expect(result.success).toBe(false);
  });
});
