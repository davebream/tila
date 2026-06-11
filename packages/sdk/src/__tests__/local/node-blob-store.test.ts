import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NodeBlobStore } from "../../local/node-blob-store";

describe("NodeBlobStore — containment guard", () => {
  let root: string;
  let store: NodeBlobStore;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "tila-blob-"));
    store = new NodeBlobStore(root);
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("accepts a normal content-addressed key", async () => {
    const { bytes } = await store.write("org/proj/abc123.txt", "hello");
    expect(bytes).toBe(5);
    expect(await store.read("org/proj/abc123.txt")).toBe("hello");
  });

  it("rejects a key that escapes the artifacts root via ..", async () => {
    await expect(store.write("../escape.txt", "x")).rejects.toThrow(
      /escapes the artifacts root/,
    );
    await expect(store.read("../../etc/passwd")).rejects.toThrow(
      /escapes the artifacts root/,
    );
  });

  it("rejects deeper traversal escaping the root", async () => {
    await expect(store.read("a/../../../escape")).rejects.toThrow(
      /escapes the artifacts root/,
    );
  });
});
