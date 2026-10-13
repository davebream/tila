import { describe, expect, it } from "vitest";
import {
  JournalAppendRequestSchema,
  journalValidationCode,
} from "../src/custom-journal";

const report = {
  event_name: "pipeline.tests_passed",
  event_version: 1,
  target: { kind: "project" },
  data: {},
};
describe("custom journal contract", () => {
  it("accepts unknown project names and versions without interpreting payload instructions", () => {
    const input = {
      ...report,
      event_name: "entity.updated",
      event_version: 42,
      data: { principal_id: "not-identity", html: "<script>alert(1)</script>" },
      occurred_at: "2026-10-12T12:00:00+02:00",
    };
    expect(JournalAppendRequestSchema.parse(input)).toEqual(input);
  });
  it.each([
    { kind: "entity.updated" },
    { seq: 1 },
    { principal_id: "fake" },
    { participant_id: "fake" },
    { t: 0 },
    { fence: 1 },
    { event_name: "unnamespaced" },
    { event_name: "a.b\n" },
    { event_name: `a.${"x".repeat(127)}` },
    { event_version: 0 },
    { event_version: 2_147_483_648 },
    { event_version: 1.5 },
    { occurred_at: "yesterday" },
    { occurred_at: "2026-02-30T00:00:00Z" },
    { occurred_at: "2026-10-12T12:00:00" },
    { target: { kind: "project", resource: "secret" } },
    { target: { kind: "resource", resource: "task:one", fence: 1 } },
    { corrects_seq: 0 },
    { correlation_id: "line\nbreak" },
    { artifact_refs: Array(11).fill("a/b") },
    { data: [] },
    { data: { value: undefined } },
    { data: { value: Number.NaN } },
    { data: { value: BigInt(1) } },
    { data: { value: new Date() } },
  ])("rejects invalid contract %#", (change) => {
    expect(
      JournalAppendRequestSchema.safeParse({ ...report, ...change }).success,
    ).toBe(false);
  });
  it("bounds UTF-8 bytes and container depth, including cycles", () => {
    const oversized = JournalAppendRequestSchema.safeParse({
      ...report,
      data: { text: "🌍".repeat(4096) },
    });
    expect(oversized.success).toBe(false);
    if (!oversized.success)
      expect(journalValidationCode(oversized.error)).toBe("payload-too-large");
    let data: Record<string, unknown> = { leaf: true };
    for (let i = 1; i < 16; i++) data = { data };
    expect(
      JournalAppendRequestSchema.safeParse({ ...report, data }).success,
    ).toBe(true);
    expect(
      JournalAppendRequestSchema.safeParse({ ...report, data: { data } })
        .success,
    ).toBe(false);
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    expect(
      JournalAppendRequestSchema.safeParse({ ...report, data: cycle }).success,
    ).toBe(false);
  });
});
