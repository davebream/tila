import { describe, expect, it, vi } from "vitest";
import { createR2JournalArchiveReader } from "./journal-archive-reader";

describe("R2 journal archive reader", () => {
  it("paginates object listings and skips ranges outside replay bounds", async () => {
    const list = vi
      .fn()
      .mockResolvedValueOnce({
        objects: [
          {
            key: "journal-archive/p/old.jsonl",
            customMetadata: { first_seq: "1", last_seq: "9" },
          },
        ],
        truncated: true,
        cursor: "next",
      })
      .mockResolvedValueOnce({
        objects: [
          { key: "journal-archive/p/legacy.jsonl" },
          {
            key: "journal-archive/p/new.jsonl",
            customMetadata: { first_seq: "11", last_seq: "12" },
          },
        ],
        truncated: false,
      });
    const get = vi.fn().mockImplementation((key: string) =>
      Promise.resolve({
        body: new Response(
          JSON.stringify({ seq: key.includes("legacy") ? 10 : 11 }),
        ).body,
      }),
    );
    const reader = createR2JournalArchiveReader(
      { list, get } as unknown as R2Bucket,
      "p",
    );
    const rows = [];
    for await (const row of reader.read(9, 11)) rows.push(row);
    expect(rows).toEqual([{ seq: 10 }, { seq: 11 }]);
    expect(get).toHaveBeenCalledTimes(2);
    expect(list.mock.calls[1][0]).toMatchObject({
      cursor: "next",
      prefix: "journal-archive/p/",
    });
  });
  it("does not silently ignore missing or corrupt objects", async () => {
    for (const value of [null, { body: new Response("{bad json").body }]) {
      const reader = createR2JournalArchiveReader(
        {
          list: async () => ({
            objects: [{ key: "journal-archive/p/a.jsonl" }],
            truncated: false,
          }),
          get: async () => value,
        } as unknown as R2Bucket,
        "p",
      );
      const consume = async () => {
        for await (const _row of reader.read(0, 1)) {
          /* consume */
        }
      };
      await expect(consume()).rejects.toThrow();
    }
  });
});
