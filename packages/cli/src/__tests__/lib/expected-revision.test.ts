import { describe, expect, it, vi } from "vitest";
import {
  expectedRevision,
  integerFlag,
  principalList,
} from "../../lib/expected-revision";

describe("settings revision flags", () => {
  it("uses the reviewed revision and never reads the current one", async () => {
    const current = vi.fn(async () => 9);
    await expect(
      expectedRevision({ "expected-revision": "4" }, current),
    ).resolves.toBe(4);
    expect(current).not.toHaveBeenCalled();
  });

  it("reads the current revision only with an explicit --latest", async () => {
    await expect(
      expectedRevision({ latest: true }, async () => 9),
    ).resolves.toBe(9);
    await expect(expectedRevision({}, async () => 9)).rejects.toThrow(
      /--expected-revision <n>/,
    );
    await expect(
      expectedRevision(
        { "expected-revision": "2", latest: true },
        async () => 9,
      ),
    ).rejects.toThrow(/not both/);
    await expect(
      expectedRevision({ "expected-revision": "0" }, async () => 9),
    ).rejects.toThrow(/positive integer/);
  });

  it("parses integers and principal lists", () => {
    expect(integerFlag("ttl", undefined)).toBeUndefined();
    expect(integerFlag("ttl", "3600")).toBe(3600);
    expect(() => integerFlag("ttl", "1.5")).toThrow(/--ttl/);
    expect(principalList(" a, ,b ")).toEqual(["a", "b"]);
    expect(principalList("")).toEqual([]);
    expect(principalList(undefined)).toBeUndefined();
  });
});
