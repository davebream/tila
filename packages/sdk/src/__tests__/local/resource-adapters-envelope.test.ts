import { okEnvelope } from "@tila/schemas";
import type { RecordRow } from "@tila/schemas";
import { describe, expect, it } from "vitest";

/**
 * C7 — local adapter envelope migration.
 *
 * Verifies that `toRecordMutateResponse`, `toRecordGetResponse`, and the
 * acquire-claim response in `resource-adapters.ts` produce output identical
 * to `okEnvelope(...)` from `@tila/schemas`.
 */
describe("local adapter envelopes use the shared okEnvelope factory (C7)", () => {
  // Minimal RecordRow fixture — only fields used by toRecord*Response
  const fakeRow = {
    id: "r-1",
    type: "deploy-config",
    key: "prod",
    schema_version: 1,
    value: { raw: "{}" },
    value_sha256: "abc",
    revision: 2,
    archived: 0,
    created_at: 1000,
    updated_at: 2000,
    updated_by: "local",
    tags: [],
    fence: 42,
  } as RecordRow;

  it("toRecordMutateResponse deep-equals okEnvelope({ record, fence, revision })", async () => {
    const { testRecordEnvelopes } = await import(
      "../../local/resource-adapters.js"
    );

    const { fence, ...record } = fakeRow;
    const expected = okEnvelope({ record, fence, revision: fakeRow.revision });
    const actual = testRecordEnvelopes(fakeRow).mutate;

    expect(actual).toEqual(expected);
    expect(actual.ok).toBe(true);
  });

  it("toRecordGetResponse deep-equals okEnvelope({ record, fence })", async () => {
    const { testRecordEnvelopes } = await import(
      "../../local/resource-adapters.js"
    );

    const { fence, ...record } = fakeRow;
    const expected = okEnvelope({ record, fence });
    const actual = testRecordEnvelopes(fakeRow).get;

    expect(actual).toEqual(expected);
    expect(actual.ok).toBe(true);
    expect(actual.fence).toBe(42);
  });

  it("heartbeat response deep-equals okEnvelope({})", async () => {
    const mockProject = {
      heartbeat: async () => {},
      listPresence: async () => [],
      listAllPresence: async () => [],
    } as never;

    const { buildLocalPresenceMethodsForTest } = await import(
      "../../local/resource-adapters.js"
    );
    const presence = buildLocalPresenceMethodsForTest(mockProject);
    const result = await presence.heartbeat("machine-1");

    // heartbeat returns okEnvelope({}) = { ok: true }
    expect(result).toEqual(okEnvelope({}));
    expect(result.ok).toBe(true);
  });

  it("okEnvelope shape contract: ok=true and payload merged at top level", () => {
    const payload = { fence: 99, expires_at: 12345 };
    const env = okEnvelope(payload);
    expect(env).toStrictEqual({ ok: true, fence: 99, expires_at: 12345 });
  });
});
