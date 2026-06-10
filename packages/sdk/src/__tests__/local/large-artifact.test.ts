/**
 * Large-artifact streaming correctness over the Node blob store (R7):
 *
 *  - a multi-MB artifact written then read back via the Node `readStream`
 *    (`Readable.toWeb`) is byte-for-byte identical;
 *  - `grepArtifacts` over a multi-chunk blob produces the expected line matches.
 *    This exercises the chunk-boundary TextDecoder flush + line-split logic in
 *    `embedded-artifact-backend.ts` against the Node fs stream's chunking (which
 *    differs from bun's), so a chunk-boundary regression would surface here.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { type TilaLocal, createTilaLocal } from "../../local/index";

describe("large-artifact streaming + grep parity (R7)", () => {
  let dir: string;
  let local: TilaLocal;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "tila-large-"));
    local = await createTilaLocal({
      dbPath: join(dir, "p.db"),
      artifactsPath: join(dir, "artifacts"),
      project: "p",
      skipFilesystemCheck: true,
    });
  });
  afterEach(() => {
    local.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("round-trips a multi-MB artifact byte-for-byte via readStream", async () => {
    // ~3 MB of deterministic content spanning many fs read chunks (64KB each).
    const line = "the quick brown fox jumps over the lazy dog 0123456789\n";
    const repeat = Math.ceil((3 * 1024 * 1024) / line.length);
    const content = line.repeat(repeat);

    const { key, bytes } = await local.artifacts.writeText(content, {
      kind: "text",
      mimeType: "text/plain",
    });
    expect(bytes).toBe(Buffer.byteLength(content, "utf-8"));

    // Read back through the artifact backend's get() -> Node readStream path.
    const got = await local.artifacts.get(key);
    expect(got).not.toBeNull();
    const buf = Buffer.from(await new Response(got?.body).arrayBuffer());
    expect(buf.byteLength).toBe(Buffer.byteLength(content, "utf-8"));
    expect(buf.toString("utf-8")).toBe(content);
  });

  it("greps a multi-chunk blob with correct line matches", async () => {
    // Build content where a known marker appears on specific, widely-spaced
    // lines so matches span multiple fs read chunks (exercising the decoder
    // flush + cross-chunk line split). Total stays well under the 1 MB
    // per-blob grep byte cap so no match is truncated, while comfortably
    // exceeding a single 64 KB fs read chunk (so it IS multi-chunk).
    const filler = "x".repeat(80);
    const lines: string[] = [];
    const markerLines: number[] = [];
    for (let i = 1; i <= 5000; i++) {
      if (i % 1000 === 0) {
        lines.push(`MARKER line ${i}`);
        markerLines.push(i);
      } else {
        lines.push(`${filler} ${i}`);
      }
    }
    const content = `${lines.join("\n")}\n`;
    // Sanity: multi-chunk (>64 KB) yet under the 1 MB per-blob grep cap.
    expect(Buffer.byteLength(content, "utf-8")).toBeGreaterThan(64 * 1024);
    expect(Buffer.byteLength(content, "utf-8")).toBeLessThan(1_048_576);

    const { key } = await local.artifacts.writeText(content, {
      kind: "text",
      mimeType: "text/plain",
    });
    expect(key).toBeDefined();

    const res = await local.artifacts.grepArtifacts({
      pattern: "MARKER",
      regex: false,
    });
    expect(res.ok).toBe(true);
    expect(res.results.length).toBe(1);
    const hit = res.results[0];
    // One match per marker line, at the correct 1-based line numbers.
    expect(hit.lines.map((l) => l.line)).toEqual(markerLines);
    for (const l of hit.lines) {
      expect(l.text).toContain("MARKER");
    }
  });
});
