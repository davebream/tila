import { describe, expect, it } from "vitest";
import {
  MAX_TASK_DATA_BYTES,
  taskDataBytes,
  taskDataTooLargeMessage,
} from "../src/task-data";

// `{"d":""}` is 8 bytes, so a single string field of this many bytes puts the
// whole object exactly at the limit.
const FRAME_BYTES = 8;
const FIELD_BYTES = MAX_TASK_DATA_BYTES - FRAME_BYTES;

describe("MAX_TASK_DATA_BYTES", () => {
  it("is 256 KiB", () => {
    expect(MAX_TASK_DATA_BYTES).toBe(262_144);
  });
});

describe("taskDataBytes", () => {
  it("counts the braces of an empty object", () => {
    expect(taskDataBytes({})).toBe(2);
  });

  it("accepts exactly the limit and sees one more byte as over", () => {
    expect(taskDataBytes({ d: "a".repeat(FIELD_BYTES) })).toBe(
      MAX_TASK_DATA_BYTES,
    );
    expect(taskDataBytes({ d: "a".repeat(FIELD_BYTES + 1) })).toBe(
      MAX_TASK_DATA_BYTES + 1,
    );
  });

  it("counts UTF-8 bytes, not characters", () => {
    // U+20AC is 3 bytes: 87_379 of them are well under 262_144 characters
    // but 262_137 bytes, which with the frame is one byte over the limit.
    const euros = "€".repeat(87_379);
    expect(euros.length).toBeLessThan(MAX_TASK_DATA_BYTES);
    expect(taskDataBytes({ d: euros })).toBe(MAX_TASK_DATA_BYTES + 1);

    // 87_378 of them plus two ASCII characters land exactly on the limit.
    expect(taskDataBytes({ d: `${"€".repeat(87_378)}aa` })).toBe(
      MAX_TASK_DATA_BYTES,
    );
  });

  it("counts a 4-byte code point as four bytes, not two UTF-16 units", () => {
    // 65_534 emoji are 262_136 bytes: exactly FIELD_BYTES.
    expect(taskDataBytes({ d: "😀".repeat(65_534) })).toBe(MAX_TASK_DATA_BYTES);
    expect(taskDataBytes({ d: `${"😀".repeat(65_534)}a` })).toBe(
      MAX_TASK_DATA_BYTES + 1,
    );
  });

  it("counts 2-byte characters as two bytes", () => {
    expect(taskDataBytes({ d: "é".repeat(FIELD_BYTES / 2) })).toBe(
      MAX_TASK_DATA_BYTES,
    );
  });

  it("is independent of key order", () => {
    const forward = { a: "1", b: { y: 2, x: [3, { n: null }] }, c: true };
    const reversed = { c: true, b: { x: [3, { n: null }], y: 2 }, a: "1" };
    expect(taskDataBytes(forward)).toBe(taskDataBytes(reversed));
  });

  it("counts nested objects and arrays", () => {
    const inner = "z".repeat(1000);
    expect(taskDataBytes({ a: { b: [{ c: inner }] } })).toBe(
      `{"a":{"b":[{"c":"${inner}"}]}}`.length,
    );
  });

  it("counts an own __proto__ key, which a rebuilt object would drop", () => {
    const data = JSON.parse(
      `{"__proto__":"${"p".repeat(1000)}","a":1}`,
    ) as Record<string, unknown>;
    expect(Object.keys(data)).toContain("__proto__");
    expect(taskDataBytes(data)).toBe(
      `{"__proto__":"${"p".repeat(1000)}","a":1}`.length,
    );
  });
});

describe("taskDataTooLargeMessage", () => {
  it("states the size and the limit", () => {
    const message = taskDataTooLargeMessage(300_000);
    expect(message).toContain("300000 bytes");
    expect(message).toContain(`${MAX_TASK_DATA_BYTES} bytes`);
    expect(message).toContain("256 KiB");
  });

  it("explains that an oversized task may only shrink", () => {
    const message = taskDataTooLargeMessage(400_000, 350_000);
    expect(message).toContain("already 350000 bytes");
    expect(message).toContain("must make it smaller");
    expect(message).toContain("400000 bytes");
  });

  it("does not claim the task was already oversized when it was not", () => {
    expect(taskDataTooLargeMessage(300_000, 1_000)).not.toContain("already");
  });
});
