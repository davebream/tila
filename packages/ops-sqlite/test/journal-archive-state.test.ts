import { describe, expect, it } from "vitest";
import { journalArchiveState } from "../src/journal-ops";

describe("journalArchiveState", () => {
  it("reports archived=false when no watermark exists", () => {
    const state = journalArchiveState(undefined, null);
    expect(state.archived).toBe(false);
    expect(state.lastArchivedSeq).toBeNull();
  });

  it("reports archived=false when no after_seq cursor is supplied", () => {
    // A recent {limit:N} read with no cursor is never an archived-range read.
    const state = journalArchiveState(undefined, { lastArchivedSeq: 100 });
    expect(state.archived).toBe(false);
    expect(state.lastArchivedSeq).toBe(100);
  });

  it("reports archived=true when the cursor is below the watermark", () => {
    const state = journalArchiveState(5, { lastArchivedSeq: 100 });
    expect(state.archived).toBe(true);
    expect(state.lastArchivedSeq).toBe(100);
  });

  it("reports archived=false when the cursor is at or above the watermark", () => {
    const atWatermark = journalArchiveState(100, { lastArchivedSeq: 100 });
    expect(atWatermark.archived).toBe(false);
    expect(atWatermark.lastArchivedSeq).toBe(100);

    const aboveWatermark = journalArchiveState(200, { lastArchivedSeq: 100 });
    expect(aboveWatermark.archived).toBe(false);
    expect(aboveWatermark.lastArchivedSeq).toBe(100);
  });
});
