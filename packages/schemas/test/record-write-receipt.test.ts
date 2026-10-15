import { describe, expect, it } from "vitest";
import {
  McpPrimitiveResults,
  McpWorkflowResults,
  RecordMutateResponseSchema,
  RecordWriteReceiptResponseSchema,
  RecordWriteResponseSchema,
  type RecordWriteResult,
  isRecordWriteReceipt,
} from "../src";

const full = {
  ok: true as const,
  record: {
    type: "question",
    key: "q1/x",
    schema_version: 1,
    value: { text: "hello" },
    value_sha256: "abc",
    revision: 2,
    archived: 0,
    created_at: 1,
    updated_at: 2,
    updated_by: "worker",
    tags: ["t"],
  },
  fence: 4,
  revision: 2,
};
const receipt = {
  ok: true as const,
  receipt: true as const,
  type: "question",
  key: "q1/x",
  fence: 4,
};

describe("record write responses", () => {
  it("accepts the full response exactly as before", () => {
    expect(RecordMutateResponseSchema.parse(full)).toEqual(full);
    const parsed = RecordWriteResponseSchema.parse(full);
    expect(parsed).toEqual(full);
    expect(isRecordWriteReceipt(parsed)).toBe(false);
  });

  it("accepts a receipt and recognises it", () => {
    const parsed = RecordWriteResponseSchema.parse(receipt);
    expect(parsed).toEqual(receipt);
    expect(isRecordWriteReceipt(parsed)).toBe(true);
    expect(RecordWriteReceiptResponseSchema.safeParse(receipt).success).toBe(
      true,
    );
  });

  it("does not let a receipt pass as a full record", () => {
    expect(RecordMutateResponseSchema.safeParse(receipt).success).toBe(false);
  });

  it("does not accept stored state smuggled into a receipt", () => {
    // The receipt schema names its fields; extra stored state is stripped on
    // parse so a client never surfaces it as part of the contract.
    const parsed = RecordWriteReceiptResponseSchema.parse({
      ...receipt,
      tags: ["stored"],
      archived: 1,
      created_at: 3,
      record: { value: {} },
    });
    expect(parsed).toEqual(receipt);
  });

  it("treats `receipt: true` as authoritative over stored fields riding along", () => {
    // A response that is both flagged a receipt and shaped like a full record
    // must come back as the receipt, with the stored state stripped: the flag
    // is the server saying this caller may not read it.
    const hybrid = {
      ...receipt,
      record: full.record,
      revision: full.revision,
    };
    const parsed = RecordWriteResponseSchema.parse(hybrid);
    expect(parsed).toEqual(receipt);
    expect(isRecordWriteReceipt(parsed)).toBe(true);
  });

  it("tells a backend receipt from a flat row (RecordWriteResult)", () => {
    const row: RecordWriteResult = { ...full.record, fence: 4 };
    const asReceipt: RecordWriteResult = receipt;

    expect(isRecordWriteReceipt(row)).toBe(false);
    expect(isRecordWriteReceipt(asReceipt)).toBe(true);

    const results: RecordWriteResult[] = [row, asReceipt];
    const revisions = results.map((r) =>
      isRecordWriteReceipt(r) ? null : r.revision,
    );
    expect(revisions).toEqual([2, null]);
  });

  it("rejects a response with neither shape", () => {
    expect(
      RecordWriteResponseSchema.safeParse({ ok: true, fence: 1 }).success,
    ).toBe(false);
    expect(
      RecordWriteResponseSchema.safeParse({ ...receipt, receipt: false })
        .success,
    ).toBe(false);
  });

  it("is what the MCP set, put and publish results accept", () => {
    for (const response of [full, receipt]) {
      expect(
        McpPrimitiveResults.tila_record_set.safeParse(response).success,
      ).toBe(true);
      expect(
        McpPrimitiveResults.tila_record_put.safeParse(response).success,
      ).toBe(true);
      expect(McpWorkflowResults.tila_publish.safeParse(response).success).toBe(
        true,
      );
    }
  });

  it("keeps patch, archive and unarchive on the full response", () => {
    for (const tool of [
      "tila_record_patch",
      "tila_record_archive",
      "tila_record_unarchive",
    ] as const) {
      expect(McpPrimitiveResults[tool].safeParse(full).success).toBe(true);
      expect(McpPrimitiveResults[tool].safeParse(receipt).success).toBe(false);
    }
  });
});
