import { describe, expect, it } from "vitest";
import { JournalResponseSchema } from "../src/api";
import {
  JournalReplayResponseSchema,
  ReentryResponseSchema,
} from "../src/continuity";

const event = {
  seq: 41,
  t: 1_700_000_000_000,
  kind: "entity.created",
  resource: "task-1",
  principal_id: "principal-1",
  participant_id: "participant-1",
  environment: {},
  token_id: null,
  fence: null,
  data: {},
};

describe("JournalResponseSchema archive metadata", () => {
  it("keeps the watermark a cursor read reports below the archive boundary", () => {
    const wire = {
      ok: true,
      events: [],
      archived: true,
      lastArchivedSeq: 40,
    };

    expect(JournalResponseSchema.parse(wire)).toEqual(wire);
  });

  it("keeps an unarchived read and a null watermark before any archival", () => {
    const wire = {
      ok: true,
      events: [event],
      archived: false,
      lastArchivedSeq: null,
    };

    const parsed = JournalResponseSchema.parse(wire);

    expect(parsed.archived).toBe(false);
    expect(parsed.lastArchivedSeq).toBeNull();
    expect(parsed.events).toHaveLength(1);
  });

  it("still accepts responses without either field", () => {
    // The embedded and local backends and older Workers emit only ok and events.
    const parsed = JournalResponseSchema.parse({ ok: true, events: [event] });

    expect(parsed.archived).toBeUndefined();
    expect(parsed.lastArchivedSeq).toBeUndefined();
    expect("archived" in parsed).toBe(false);
    expect("lastArchivedSeq" in parsed).toBe(false);
  });

  it.each([
    ["a negative watermark", { lastArchivedSeq: -1 }],
    ["a fractional watermark", { lastArchivedSeq: 1.5 }],
    ["an unsafe integer watermark", { lastArchivedSeq: 2 ** 53 }],
    ["a string watermark", { lastArchivedSeq: "40" }],
    ["a non-finite watermark", { lastArchivedSeq: Number.NaN }],
    ["a non-boolean archived flag", { archived: "yes" }],
  ])("rejects %s", (_name, extra) => {
    expect(
      JournalResponseSchema.safeParse({ ok: true, events: [], ...extra })
        .success,
    ).toBe(false);
  });

  it("accepts the largest safe integer watermark", () => {
    const parsed = JournalResponseSchema.parse({
      ok: true,
      events: [],
      archived: true,
      lastArchivedSeq: Number.MAX_SAFE_INTEGER,
    });

    expect(parsed.lastArchivedSeq).toBe(Number.MAX_SAFE_INTEGER);
  });
});

describe("types derived from the journal list response", () => {
  it("does not gain list-only archive metadata on replay or re-entry changes", () => {
    // Replay already includes archived history and never emits these fields.
    const replayKeys = Object.keys(JournalReplayResponseSchema.shape).sort();

    expect(replayKeys).toEqual(
      ["events", "has_more", "next_after_seq", "ok", "through_seq"].sort(),
    );
    expect(
      Object.keys(ReentryResponseSchema.shape.changes.shape).sort(),
    ).toEqual(replayKeys);
  });
});
