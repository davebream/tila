import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { coordinationOps } from "@tila/ops-sqlite";
import { type Harness, makeHarness } from "./harness.bun";

let h: Harness;
let fence: number;
beforeEach(() => {
  h = makeHarness();
  fence = coordinationOps.acquire(
    h.db,
    "artifact:report",
    {
      principalId: "test",
      participantId: "test",
      environment: {},
      actor: "test",
    },
    "exclusive",
    60_000,
  ).fence;
});
afterEach(() => h.close());

describe("embedded revision parity", () => {
  it("writes, restores identical content, retains tags and reads distinct revision keys", async () => {
    const one = await h.artifacts.writeText("first", {
      kind: "report",
      lineageId: "report",
      lineageFence: fence,
      tags: ["Env:Prod"],
    });
    const two = await h.artifacts.writeText("second", {
      kind: "report",
      lineageId: "report",
      lineageFence: fence,
    });
    const three = await h.artifacts.restore(one.key, {
      fence,
      idempotencyKey: "restore",
    });
    expect((await h.artifacts.readText(three.key))?.content).toBe("first");
    expect(three.key).not.toBe(one.key);
    expect(three.pointer.tags).toEqual(["env:prod"]);
    await expect(
      h.artifacts.put({
        key: one.key,
        body: "overwrite",
        sha256: "",
        metadata: {},
        contentType: "text/plain",
        tags: [],
      }),
    ).rejects.toMatchObject({ status: 400 });
    expect((await h.artifacts.readText(one.key))?.content).toBe("first");
    expect(
      await h.artifacts.restore(one.key, { fence, idempotencyKey: "restore" }),
    ).toEqual(three);
    const history = await h.artifacts.history(two.key);
    expect(history.items.map((p) => p.revision)).toEqual([3, 2, 1]);
    expect(
      (await h.artifacts.restore(three.key, { fence, tags: [] })).pointer.tags,
    ).toEqual([]);
  });

  it("resumes accepted publication after a commit-record write fails", async () => {
    const original = h.blobs.write.bind(h.blobs);
    let fail = true;
    h.blobs.write = async (key, body) => {
      if (key.endsWith(".commit.json") && fail)
        throw new Error("storage unavailable");
      return original(key, body);
    };
    const options = {
      kind: "report",
      lineageId: "report",
      lineageFence: fence,
      idempotencyKey: "same",
    };
    await expect(h.artifacts.writeText("first", options)).rejects.toThrow(
      "storage unavailable",
    );
    fail = false;
    const result = await h.artifacts.writeText("first", options);
    expect((await h.artifacts.history(result.key)).items).toHaveLength(1);
  });

  it("returns unavailable for an adopted source whose blob disappeared", async () => {
    const source = await h.artifacts.writeText("legacy", {
      kind: "report",
      tags: ["legacy"],
    });
    await h.blobs.unlink(source.key);
    await expect(
      h.artifacts.restore(source.key, { lineage_id: "report", fence }),
    ).rejects.toMatchObject({ status: 410 });
    expect((await h.artifacts.meta(source.key)).pointer.tags).toEqual([
      "legacy",
    ]);
  });
});
