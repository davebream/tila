import { describe, expect, it } from "vitest";
import {
  JOURNAL_REPLAY_SCAN_BUDGET,
  JournalReplayRequestSchema,
  ReentryRequestSchema,
} from "../src/continuity";
import {
  InspectRequestSchema,
  SessionRequestSchema,
} from "../src/mcp-workflow";

describe("journal replay request filters", () => {
  it("accepts exact event_name and correlation_id filters", () => {
    expect(
      JournalReplayRequestSchema.parse({
        after_seq: 0,
        event_name: "pipeline.tests_passed",
        correlation_id: "run-123",
      }),
    ).toEqual({
      after_seq: 0,
      limit: 100,
      event_name: "pipeline.tests_passed",
      correlation_id: "run-123",
    });
  });

  it("leaves unfiltered requests byte-for-byte as before", () => {
    expect(JournalReplayRequestSchema.parse({ after_seq: 3 })).toEqual({
      after_seq: 3,
      limit: 100,
    });
  });

  it("rejects values that no report can carry instead of returning empty pages", () => {
    for (const bad of [
      { event_name: "" },
      { event_name: "Not A Name" },
      { event_name: "x".repeat(129) },
      { correlation_id: "" },
      { correlation_id: "has\nnewline" },
      { correlation_id: "x".repeat(129) },
    ])
      expect(
        JournalReplayRequestSchema.safeParse({ after_seq: 0, ...bad }).success,
      ).toBe(false);
  });

  it("keeps re-entry unfiltered: filters are not part of its request", () => {
    const parsed = ReentryRequestSchema.parse({
      after_seq: 1,
      event_name: "pipeline.tests_passed",
      correlation_id: "run-123",
    });
    expect(parsed).not.toHaveProperty("event_name");
    expect(parsed).not.toHaveProperty("correlation_id");
    expect(parsed).toMatchObject({ after_seq: 1 });
    expect(Object.keys(ReentryRequestSchema.shape)).not.toContain("event_name");
    expect(Object.keys(ReentryRequestSchema.shape)).not.toContain(
      "correlation_id",
    );
  });

  it("offers filters on inspect changes only, never on session open", () => {
    const filters = {
      event_name: "pipeline.tests_passed",
      correlation_id: "run-123",
    };
    expect(
      InspectRequestSchema.safeParse({
        action: "changes",
        after_seq: 0,
        ...filters,
      }).success,
    ).toBe(true);
    expect(
      InspectRequestSchema.safeParse({
        action: "changes",
        after_seq: 0,
        event_name: "Not A Name",
      }).success,
    ).toBe(false);
    expect(
      SessionRequestSchema.safeParse({ action: "open", ...filters }).success,
    ).toBe(false);
  });

  it("documents a scan budget that is a whole number of maximum pages", () => {
    expect(JOURNAL_REPLAY_SCAN_BUDGET).toBeGreaterThan(200);
    expect(JOURNAL_REPLAY_SCAN_BUDGET % 200).toBe(0);
  });
});
