import { describe, expect, it, vi } from "vitest";

/**
 * Artifact lifecycle integration tests.
 *
 * These tests validate the R2 artifact put/get/list contract using a mock
 * R2Bucket implementation. Full Worker-level integration tests (multipart upload
 * through Hono routes, DO pointer registration) require
 * @cloudflare/vitest-pool-workers setup, which is a prerequisite outside T5 scope.
 *
 * Acceptance criteria coverage:
 * - AC1: PUT produced artifact -> correct R2 key format (produced/<resource>/<sha256>.<ext>)
 * - AC2: PUT source artifact -> correct R2 key format (sources/<sha256>.<ext>)
 * - AC3: Duplicate write -> bytes: 0 (dedup hit)
 * - AC4: GET artifact -> correct Content-Type from httpMetadata
 * - AC5: LIST with prefix -> only matching keys
 * - AC6: x-amz-meta-tila-* metadata keys passed through to R2
 */

type MockEntry = {
  body: ArrayBuffer;
  httpMetadata: { contentType: string };
  customMetadata: Record<string, string>;
};

function createMockBucket(): R2Bucket {
  const store = new Map<string, MockEntry>();

  return {
    put: vi.fn(
      async (
        key: string,
        body: ArrayBuffer | ReadableStream | string,
        opts?: R2PutOptions,
      ) => {
        if (opts?.onlyIf && "etagDoesNotMatch" in opts.onlyIf) {
          if (opts.onlyIf.etagDoesNotMatch === "*" && store.has(key)) {
            return null; // dedup hit
          }
        }
        const buf = body instanceof ArrayBuffer ? body : new ArrayBuffer(0);
        store.set(key, {
          body: buf,
          httpMetadata: {
            contentType:
              (opts?.httpMetadata as { contentType?: string } | undefined)
                ?.contentType ?? "application/octet-stream",
          },
          customMetadata:
            (opts?.customMetadata as Record<string, string>) ?? {},
        });
        return { size: buf.byteLength };
      },
    ),
    get: vi.fn(async (key: string) => {
      const entry = store.get(key);
      if (!entry) return null;
      return {
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array(entry.body));
            controller.close();
          },
        }),
        httpMetadata: entry.httpMetadata,
        customMetadata: entry.customMetadata,
      };
    }),
    list: vi.fn(async (opts?: { prefix?: string }) => {
      const objects = Array.from(store.entries())
        .filter(([key]) => !opts?.prefix || key.startsWith(opts.prefix))
        .map(([key, val]) => ({ key, size: val.body.byteLength }));
      return { objects };
    }),
    delete: vi.fn(),
    head: vi.fn(),
    createMultipartUpload: vi.fn(),
    resumeMultipartUpload: vi.fn(),
  } as unknown as R2Bucket;
}

describe("Artifact lifecycle (mock R2)", () => {
  it("AC1: produced artifact gets correct key format", async () => {
    const { R2ArtifactBackend } = await import("@tila/backend-r2");
    const bucket = createMockBucket();
    const backend = new R2ArtifactBackend(bucket);

    const key = "produced/T-142/deadbeef.md";
    const result = await backend.put({
      key,
      body: new TextEncoder().encode("hello").buffer as ArrayBuffer,
      sha256: "deadbeef",
      metadata: { "tila-task": "T-142", "tila-kind": "output" },
      contentType: "text/markdown",
    });

    expect(result.key).toBe("produced/T-142/deadbeef.md");
    expect(result.bytes).toBeGreaterThan(0);
  });

  it("AC2: source artifact gets correct key format", async () => {
    const { R2ArtifactBackend } = await import("@tila/backend-r2");
    const bucket = createMockBucket();
    const backend = new R2ArtifactBackend(bucket);

    const key = "sources/cafebabe.txt";
    const result = await backend.put({
      key,
      body: new TextEncoder().encode("source data").buffer as ArrayBuffer,
      sha256: "cafebabe",
      metadata: {},
      contentType: "text/plain",
    });

    expect(result.key).toBe("sources/cafebabe.txt");
    expect(result.bytes).toBeGreaterThan(0);
  });

  it("AC3: duplicate write returns bytes: 0 (deduplicated)", async () => {
    const { R2ArtifactBackend } = await import("@tila/backend-r2");
    const bucket = createMockBucket();
    const backend = new R2ArtifactBackend(bucket);

    const key = "produced/T-1/abc123.md";
    const opts = {
      key,
      body: new TextEncoder().encode("content").buffer as ArrayBuffer,
      sha256: "abc123",
      metadata: {},
      contentType: "text/markdown",
    };

    // First write
    const first = await backend.put(opts);
    expect(first.bytes).toBeGreaterThan(0);

    // Second write (same key) — dedup
    const second = await backend.put(opts);
    expect(second.bytes).toBe(0);
  });

  it("AC4: GET returns correct contentType from httpMetadata", async () => {
    const { R2ArtifactBackend } = await import("@tila/backend-r2");
    const bucket = createMockBucket();
    const backend = new R2ArtifactBackend(bucket);

    await backend.put({
      key: "produced/T-1/abc123.md",
      body: new TextEncoder().encode("# Hello").buffer as ArrayBuffer,
      sha256: "abc123",
      metadata: {},
      contentType: "text/markdown",
    });

    const result = await backend.get("produced/T-1/abc123.md");
    expect(result).not.toBeNull();
    expect(result?.contentType).toBe("text/markdown");
  });

  it("AC5: LIST with prefix returns only matching keys", async () => {
    const { R2ArtifactBackend } = await import("@tila/backend-r2");
    const bucket = createMockBucket();
    const backend = new R2ArtifactBackend(bucket);

    await backend.put({
      key: "produced/T-1/aaa.md",
      body: new TextEncoder().encode("a").buffer as ArrayBuffer,
      sha256: "aaa",
      metadata: {},
      contentType: "text/plain",
    });
    await backend.put({
      key: "produced/T-2/bbb.md",
      body: new TextEncoder().encode("b").buffer as ArrayBuffer,
      sha256: "bbb",
      metadata: {},
      contentType: "text/plain",
    });

    const result = await backend.list("produced/T-1/");
    expect(result).toHaveLength(1);
    expect(result[0].key).toBe("produced/T-1/aaa.md");
  });

  it.todo(
    "Reconcile AC1: dry-run reports orphan when R2 blob has no pointer row",
  );
  // Scenario: upload artifact, manually delete pointer row from DO,
  // POST /artifacts/reconcile (no ?apply), expect orphans_found: 1, status: "skipped"

  it.todo("Reconcile AC2: --apply recovers orphan and creates pointer row");
  // Scenario: same as above but POST /artifacts/reconcile?apply=true,
  // expect orphans_recovered: 1, then GET /artifacts/list shows the pointer

  it.todo(
    "Reconcile AC3: reports unrecoverable when R2 blob has no tila-kind metadata",
  );
  // Scenario: upload raw blob to R2 without tila-* metadata, run reconcile,
  // expect orphans_unrecoverable: 1

  it.todo("Reconcile AC4: clean state reports 0 orphans");
  // Scenario: upload artifact normally (pointer exists), run reconcile,
  // expect orphans_found: 0

  it("AC6: metadata keys are passed through to R2", async () => {
    const { R2ArtifactBackend } = await import("@tila/backend-r2");
    const bucket = createMockBucket();
    const backend = new R2ArtifactBackend(bucket);

    const metadata = {
      "tila-task": "T-142",
      "tila-fence": "5",
      "tila-machine": "agent-1",
      "tila-kind": "output",
      "tila-sha256": "deadbeef",
      "tila-mime": "text/markdown",
    };

    await backend.put({
      key: "produced/T-142/deadbeef.md",
      body: new TextEncoder().encode("content").buffer as ArrayBuffer,
      sha256: "deadbeef",
      metadata,
      contentType: "text/markdown",
    });

    expect(bucket.put).toHaveBeenCalledWith(
      "produced/T-142/deadbeef.md",
      expect.anything(),
      expect.objectContaining({
        customMetadata: metadata,
      }),
    );
  });
});

/**
 * Search indexing on write path -- normalizeArtifactText integration.
 *
 * These tests verify the Worker-side text extraction step (T5 C1) using
 * normalizeArtifactText directly, since full Worker-level multipart upload
 * tests require @cloudflare/vitest-pool-workers which is outside T5 scope.
 * The DO-side atomic transaction and FTS5 indexing are covered by
 * packages/backend-do/test/artifact-ops-search.test.ts.
 *
 * Acceptance criteria coverage (write-path Worker step):
 * - Searchable kind + text/markdown -> normalized title + body_text non-null
 * - Searchable kind + text/plain -> normalized title + body_text non-null
 * - Unsupported MIME (image/png) + searchable kind -> null (no search doc written)
 * - Oversized artifact -> null (size gate, no search doc written)
 * - Source artifact (no resource) -> normalized correctly (fence not required)
 * - Dedup scenario: same bytes -> same normalized output (deterministic)
 */
describe("Search indexing on write path (normalizeArtifactText integration)", () => {
  it("text/markdown artifact produces non-null normalized text with title", async () => {
    const { normalizeArtifactText } = await import(
      "../../worker/src/lib/normalize-text"
    );
    const content =
      "# My Architecture Decision\n\nWe chose SQLite for persistence.";
    const bytes = new TextEncoder().encode(content).buffer as ArrayBuffer;

    const result = normalizeArtifactText(bytes, "text/markdown");

    expect(result).not.toBeNull();
    expect(result?.title).toBe("My Architecture Decision");
    expect(result?.body_text).toContain("SQLite");
  });

  it("text/plain artifact produces non-null normalized text", async () => {
    const { normalizeArtifactText } = await import(
      "../../worker/src/lib/normalize-text"
    );
    const content = "Plain text lesson content\nSecond line";
    const bytes = new TextEncoder().encode(content).buffer as ArrayBuffer;

    const result = normalizeArtifactText(bytes, "text/plain");

    expect(result).not.toBeNull();
    expect(result?.body_text).toContain("Plain text lesson content");
  });

  it("image/png artifact returns null (unsupported MIME -> no search doc)", async () => {
    const { normalizeArtifactText } = await import(
      "../../worker/src/lib/normalize-text"
    );
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47])
      .buffer as ArrayBuffer;

    const result = normalizeArtifactText(bytes, "image/png");

    expect(result).toBeNull();
  });

  it("oversized artifact returns null (size gate -> no search doc)", async () => {
    const { normalizeArtifactText, MAX_BYTES_FOR_NORMALIZATION } = await import(
      "../../worker/src/lib/normalize-text"
    );
    const oversized = new ArrayBuffer(MAX_BYTES_FOR_NORMALIZATION + 1);

    const result = normalizeArtifactText(oversized, "text/markdown");

    expect(result).toBeNull();
  });

  it("source artifact (no resource/fence) normalizes correctly", async () => {
    const { normalizeArtifactText } = await import(
      "../../worker/src/lib/normalize-text"
    );
    const content =
      "# Lesson from production\n\nKey insight: monitor your queues.";
    const bytes = new TextEncoder().encode(content).buffer as ArrayBuffer;

    // Source artifacts have no resource or fence -- normalization is pure function of bytes+mime
    const result = normalizeArtifactText(bytes, "text/markdown");

    expect(result).not.toBeNull();
    expect(result?.title).toBe("Lesson from production");
  });

  it("same bytes produce deterministic output (dedup idempotency)", async () => {
    const { normalizeArtifactText } = await import(
      "../../worker/src/lib/normalize-text"
    );
    const content = "# Stable Content\n\nSame bytes, same result.";
    const bytes = new TextEncoder().encode(content).buffer as ArrayBuffer;

    const first = normalizeArtifactText(bytes, "text/markdown");
    const second = normalizeArtifactText(bytes, "text/markdown");

    expect(first).toEqual(second);
  });

  it("search_title null-coalesced when normalize returns null title", async () => {
    const { normalizeArtifactText } = await import(
      "../../worker/src/lib/normalize-text"
    );
    // text/plain with no recognizable title line
    const content = "";
    const bytes = new TextEncoder().encode(content).buffer as ArrayBuffer;

    const result = normalizeArtifactText(bytes, "text/plain");

    // Empty content still returns a result (empty body), title is null
    // The worker passes: search_title: result?.title ?? null
    const searchTitle = result?.title ?? null;
    expect(searchTitle).toBeNull();
  });
});
