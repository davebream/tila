import { describe, expect, it } from "vitest";
import {
  RecordHistoryItemSchema,
  RecordHistoryResponseSchema,
} from "../src/index";

const item = {
  type: "config",
  key: "main",
  revision: 2,
  operation: "set" as const,
  schema_version: 1,
  value_sha256: "a".repeat(64),
  canonical_artifact_key: null,
  source_artifact_key: null,
  actor: "deploy-bot",
  created_at: 1_700_000_000_000,
  message: null,
};

describe("record history item authorship", () => {
  it("carries the principal and token beside the unchanged actor", () => {
    const parsed = RecordHistoryItemSchema.parse({
      ...item,
      principal_id: "service:deploy",
      token_id: "5f0f4a5e-7d57-4d9c-9c36-3f4a4c1a6b11",
    });
    expect(parsed).toMatchObject({
      actor: "deploy-bot",
      principal_id: "service:deploy",
      token_id: "5f0f4a5e-7d57-4d9c-9c36-3f4a4c1a6b11",
    });
  });

  it("accepts explicit nulls for revisions with no recorded author or token", () => {
    const parsed = RecordHistoryItemSchema.parse({
      ...item,
      principal_id: null,
      token_id: null,
    });
    expect(parsed.principal_id).toBeNull();
    expect(parsed.token_id).toBeNull();
  });

  it("still parses a response from a Worker that predates the fields", () => {
    const parsed = RecordHistoryResponseSchema.parse({
      ok: true,
      items: [item],
      meta: { total: 1, limit: 20, next_cursor: null },
    });
    expect(parsed.items[0]?.principal_id).toBeUndefined();
    expect(parsed.items[0]?.token_id).toBeUndefined();
  });

  it.each([
    ["principal_id", 7],
    ["token_id", { id: "x" }],
  ])("rejects a non-string %s", (field, value) => {
    expect(
      RecordHistoryItemSchema.safeParse({ ...item, [field]: value }).success,
    ).toBe(false);
  });
});
