import { describe, expect, it } from "vitest";
import {
  SchemaApplyResponseSchema,
  SchemaGetResponseSchema,
  SchemaHistoryResponseSchema,
} from "../src/api";
import {
  GitHubExchangeResponseSchema,
  SessionPayloadSchema,
} from "../src/session";

describe("SchemaGetResponseSchema", () => {
  it("parses a valid schema-get response with unknown schema field", () => {
    const raw = {
      ok: true,
      schema: { entities: { task: { fields: [] } } },
      version: 1,
    };
    const result = SchemaGetResponseSchema.safeParse(raw);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.ok).toBe(true);
      expect(result.data.version).toBe(1);
    }
  });

  it("parses with a null schema field", () => {
    const raw = { ok: true, schema: null, version: 0 };
    const result = SchemaGetResponseSchema.safeParse(raw);
    expect(result.success).toBe(true);
  });

  it("parses with schema as a string (arbitrary caller-defined content)", () => {
    const raw = { ok: true, schema: "raw toml string", version: 2 };
    const result = SchemaGetResponseSchema.safeParse(raw);
    expect(result.success).toBe(true);
  });
});

describe("SchemaApplyResponseSchema", () => {
  it("parses a valid schema-apply response with diff field", () => {
    const raw = {
      ok: true,
      diff: { added: ["field_a"], removed: [] },
      version: 3,
    };
    const result = SchemaApplyResponseSchema.safeParse(raw);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.ok).toBe(true);
      expect(result.data.version).toBe(3);
    }
  });

  it("parses with diff as null", () => {
    const raw = { ok: true, diff: null, version: 1 };
    const result = SchemaApplyResponseSchema.safeParse(raw);
    expect(result.success).toBe(true);
  });

  it("parses with diff as a string", () => {
    const raw = { ok: true, diff: "no changes", version: 0 };
    const result = SchemaApplyResponseSchema.safeParse(raw);
    expect(result.success).toBe(true);
  });
});

describe("SchemaHistoryResponseSchema", () => {
  it("parses a schema-history response with entries array", () => {
    const raw = {
      ok: true,
      entries: [
        { version: 1, applied_at: 1000000 },
        { version: 2, applied_at: 2000000 },
      ],
    };
    const result = SchemaHistoryResponseSchema.safeParse(raw);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.ok).toBe(true);
      expect(result.data.entries).toHaveLength(2);
    }
  });

  it("parses with an empty entries array", () => {
    const raw = { ok: true, entries: [] };
    const result = SchemaHistoryResponseSchema.safeParse(raw);
    expect(result.success).toBe(true);
  });

  it("entries are unknown (arbitrary objects pass)", () => {
    const raw = {
      ok: true,
      entries: [{ arbitrary: true }, "string-entry", 42],
    };
    const result = SchemaHistoryResponseSchema.safeParse(raw);
    expect(result.success).toBe(true);
  });
});

describe("SessionPayloadSchema — instance_id field", () => {
  const basePayload = {
    project_id: "proj-abc",
    github_host: "github.com",
    github_repo_id: 12345,
    github_login: "alice",
    github_user_id: 9999,
    permission: "read" as const,
    expires_at: 1800000000,
    issued_at: 1700000000,
  };

  it("parses a payload WITH instance_id and preserves the field", () => {
    const raw = { ...basePayload, instance_id: "deployment-uuid-abc123" };
    const result = SessionPayloadSchema.safeParse(raw);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.instance_id).toBe("deployment-uuid-abc123");
    }
  });

  it("parses a payload WITHOUT instance_id (optional — legacy tokens must still parse)", () => {
    const result = SessionPayloadSchema.safeParse(basePayload);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.instance_id).toBeUndefined();
    }
  });
});

describe("GitHubExchangeResponseSchema — instance_id field", () => {
  const baseResponse = {
    ok: true as const,
    session_token: "tila_s.abc.def.ghi",
    expires_at: 1800000000,
    project_id: "proj-abc",
    github_login: "alice",
    github_repo_id: 12345,
    permission: "read" as const,
  };

  it("parses a response WITH instance_id and preserves the field", () => {
    const raw = { ...baseResponse, instance_id: "deployment-uuid-abc123" };
    const result = GitHubExchangeResponseSchema.safeParse(raw);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.instance_id).toBe("deployment-uuid-abc123");
    }
  });

  it("parses a response WITHOUT instance_id (optional — legacy responses still valid)", () => {
    const result = GitHubExchangeResponseSchema.safeParse(baseResponse);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.instance_id).toBeUndefined();
    }
  });
});
