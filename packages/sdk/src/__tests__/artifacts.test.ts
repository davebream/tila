import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createArtifactMethods } from "../artifacts";
import { TilaClient } from "../client";

describe("createArtifactMethods", () => {
  const mockFetch = vi.fn();

  beforeEach(() => {
    mockFetch.mockReset();
    vi.stubGlobal("fetch", mockFetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("encodes version keys and forwards history options and restore idempotency", async () => {
    mockFetch.mockImplementation(
      async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );
    const methods = createArtifactMethods(
      new TilaClient({ baseUrl: "https://api.test", token: "t" }),
      "p1",
    );
    const key = "versioned/p1/report/1/abc.txt";
    await methods.history(key, { limit: 2, cursor: "next+page" });
    expect(mockFetch.mock.calls[0][0]).toBe(
      `https://api.test/projects/p1/artifacts/~/history/${encodeURIComponent(key)}?limit=2&cursor=next%2Bpage`,
    );
    await methods.meta(key);
    expect(mockFetch.mock.calls[1][0]).toBe(
      `https://api.test/projects/p1/artifacts/${encodeURIComponent(key)}/meta`,
    );
    await methods.restore(key, {
      fence: 7,
      tags: [],
      idempotencyKey: "retry-key",
    });
    expect(mockFetch.mock.calls[2][1].headers["Idempotency-Key"]).toBe(
      "retry-key",
    );
    expect(JSON.parse(mockFetch.mock.calls[2][1].body)).toEqual({
      fence: 7,
      tags: [],
    });
  });

  it("passes deletion fences and group destruction idempotency through the SDK", async () => {
    mockFetch.mockImplementation(
      async () => new Response(JSON.stringify({ ok: true }), { status: 202 }),
    );
    const methods = createArtifactMethods(
      new TilaClient({ baseUrl: "https://api.test", token: "t" }),
      "p1",
    );
    const key = "versioned/p1/report/1/hash.txt";
    await methods.delete(key, { fence: 7, idempotencyKey: "delete" });
    expect(mockFetch.mock.calls[0][0]).toBe(
      `https://api.test/projects/p1/artifacts/${encodeURIComponent(key)}?fence=7`,
    );
    expect(mockFetch.mock.calls[0][1].headers["Idempotency-Key"]).toBe(
      "delete",
    );
    await methods.destroyLineage("report", {
      fence: 7,
      idempotencyKey: "destroy",
    });
    expect(mockFetch.mock.calls[1][0]).toBe(
      "https://api.test/projects/p1/artifacts/~/destroy/report",
    );
    expect(JSON.parse(mockFetch.mock.calls[1][1].body)).toEqual({ fence: 7 });
    expect(mockFetch.mock.calls[1][1].headers["Idempotency-Key"]).toBe(
      "destroy",
    );
  });

  it("throws TypeError synchronously when mimeType absent and file.type is empty", () => {
    const client = new TilaClient({ baseUrl: "https://api.test", token: "t" });
    const artifacts = createArtifactMethods(client, "proj-1");

    const file = new File(["data"], "test.bin", { type: "" });
    expect(() => artifacts.upload(file, { kind: "output" })).toThrow(TypeError);
    expect(() => artifacts.upload(file, { kind: "output" })).toThrow(
      "contentType is required",
    );
    // fetch should not have been called
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("uses file.type as contentType when mimeType not provided", async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ ok: true, key: "k", bytes: 10, deduplicated: false }),
        { status: 200 },
      ),
    );
    const client = new TilaClient({ baseUrl: "https://api.test", token: "t" });
    const artifacts = createArtifactMethods(client, "proj-1");

    const file = new File(["data"], "test.json", { type: "application/json" });
    await artifacts.upload(file, { kind: "output" });

    expect(mockFetch).toHaveBeenCalledOnce();
  });

  it.each([
    ["typed Blob", "blob", undefined],
    ["Blob MIME override", "blob", "application/octet-stream"],
    ["untyped Blob with MIME option", "blob", "application/gzip"],
    ["named File", "report.json.gz", undefined],
    ["empty-named File", "blob", undefined],
    ["stream", "blob", "application/gzip"],
  ])(
    "serializes %s with a filename and unchanged binary bytes",
    async (label, filename, mimeType) => {
      const bytes = new Uint8Array([31, 139, 0, 255, 13, 10, 128]);
      const blob = new Blob([bytes], {
        type:
          label === "untyped Blob with MIME option" ? "" : "application/gzip",
      });
      const input =
        label === "named File"
          ? new File([blob], "report.json.gz", { type: blob.type })
          : label === "empty-named File"
            ? new File([blob], "", { type: blob.type })
            : blob;
      mockFetch.mockImplementation(async (url, init) => {
        const request = new Request(url, init);
        const wire = await request.clone().text();
        expect(wire).toContain(`filename="${filename}"`);
        const form = await request.formData();
        expect(form.get("mime_type")).toBe(mimeType || blob.type);
        const file = form.get("file") as File;
        expect(file).toBeInstanceOf(File);
        expect(file.name).toBe(filename);
        expect(new Uint8Array(await file.arrayBuffer())).toEqual(bytes);
        return Response.json({
          ok: true,
          key: "k",
          bytes: bytes.length,
          deduplicated: false,
        });
      });
      const methods = createArtifactMethods(
        new TilaClient({ baseUrl: "https://api.test", token: "t" }),
        "p1",
      );
      if (label === "stream") {
        await methods.upload(blob.stream(), {
          kind: "source",
          mimeType: "application/gzip",
        });
      } else {
        await methods.upload(input, { kind: "source", mimeType });
      }
      expect(mockFetch).toHaveBeenCalledOnce();
    },
  );

  it("rejects an untyped Blob synchronously before fetching", () => {
    const methods = createArtifactMethods(
      new TilaClient({ baseUrl: "https://api.test", token: "t" }),
      "p1",
    );
    expect(() =>
      methods.upload(new Blob(["data"]), { kind: "source" }),
    ).toThrow(
      "File.type or Blob.type is empty. Pass opts.mimeType explicitly.",
    );
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("serializes Blob, File and stream uploads with Bun's native FormData", () => {
    const artifactsPath = fileURLToPath(
      new URL("../artifacts.ts", import.meta.url),
    );
    const clientPath = fileURLToPath(new URL("../client.ts", import.meta.url));
    const root = fileURLToPath(new URL("../../../../", import.meta.url));
    const output = execFileSync(
      "bun",
      [
        "--eval",
        `
      import assert from "node:assert/strict";
      import { createArtifactMethods } from ${JSON.stringify(artifactsPath)};
      import { TilaClient } from ${JSON.stringify(clientPath)};
      const bytes = new Uint8Array([31, 139, 0, 255, 13, 10, 128]);
      const blob = new Blob([bytes], { type: "application/gzip" });
      const cases = [
        [blob, "blob", undefined],
        [blob, "blob", "application/octet-stream"],
        [new Blob([bytes]), "blob", "application/gzip"],
        [new File([bytes], "report.json.gz", { type: blob.type }), "report.json.gz", undefined],
        [new File([bytes], "", { type: blob.type }), "blob", undefined],
        [blob.stream(), "blob", "application/gzip"],
      ];
      let requests = 0;
      for (const [input, filename, mimeType] of cases) {
        const client = new TilaClient({
          baseUrl: "https://api.test", token: "t",
          fetch: async (url, init) => {
            requests++;
            const request = new Request(url, init);
            assert.ok((await request.clone().text()).includes('filename="' + filename + '"'));
            const form = await request.formData();
            assert.equal(form.get("mime_type"), mimeType || blob.type);
            const file = form.get("file");
            assert.ok(file instanceof File);
            assert.equal(file.name, filename);
            assert.deepEqual(new Uint8Array(await file.arrayBuffer()), bytes);
            return Response.json({ ok: true, key: "k", bytes: bytes.length, deduplicated: false });
          },
        });
        await createArtifactMethods(client, "p1").upload(input, { kind: "source", mimeType });
      }
      assert.equal(requests, cases.length);
      console.log("verified " + requests + " Bun uploads");
    `,
      ],
      { cwd: root, encoding: "utf8", timeout: 20_000 },
    );
    expect(output.trim()).toBe("verified 6 Bun uploads");
  });

  it("attaches fence to FormData when provided", async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ ok: true, key: "k", bytes: 10, deduplicated: false }),
        { status: 200 },
      ),
    );
    const client = new TilaClient({ baseUrl: "https://api.test", token: "t" });
    const artifacts = createArtifactMethods(client, "proj-1");

    const file = new File(["data"], "test.json", { type: "application/json" });
    await artifacts.upload(file, { kind: "output", fence: 42 });

    const [, init] = mockFetch.mock.calls[0];
    const body = init.body as FormData;
    expect(body.get("fence")).toBe("42");
  });

  it("throws TypeError when ReadableStream provided without mimeType", () => {
    const client = new TilaClient({ baseUrl: "https://api.test", token: "t" });
    const artifacts = createArtifactMethods(client, "proj-1");

    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("data"));
        controller.close();
      },
    });

    // @ts-expect-error -- mimeType intentionally omitted to test runtime guard
    expect(() => artifacts.upload(stream, { kind: "output" })).toThrow(
      TypeError,
    );
    // @ts-expect-error -- mimeType intentionally omitted to test runtime guard
    expect(() => artifacts.upload(stream, { kind: "output" })).toThrow(
      "mimeType is required when uploading a ReadableStream",
    );
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("uploads ReadableStream with mimeType successfully", async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ ok: true, key: "k", bytes: 4, deduplicated: false }),
        { status: 200 },
      ),
    );
    const client = new TilaClient({ baseUrl: "https://api.test", token: "t" });
    const artifacts = createArtifactMethods(client, "proj-1");

    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("data"));
        controller.close();
      },
    });

    const result = await artifacts.upload(stream, {
      kind: "output",
      mimeType: "text/plain",
    });

    expect(mockFetch).toHaveBeenCalledOnce();
    expect(result.ok).toBe(true);
    expect(result.key).toBe("k");
    // Verify mime_type was set in FormData
    const [, init] = mockFetch.mock.calls[0];
    const body = init.body as FormData;
    expect(body.get("mime_type")).toBe("text/plain");
  });

  it("passes deduplicated flag through for ReadableStream upload", async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ ok: true, key: "k", bytes: 4, deduplicated: true }),
        { status: 200 },
      ),
    );
    const client = new TilaClient({ baseUrl: "https://api.test", token: "t" });
    const artifacts = createArtifactMethods(client, "proj-1");

    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("data"));
        controller.close();
      },
    });

    const result = await artifacts.upload(stream, {
      kind: "output",
      mimeType: "text/plain",
    });

    expect(result.deduplicated).toBe(true);
  });

  it("download returns typed { body, contentType, contentLength }", async () => {
    mockFetch.mockResolvedValueOnce(
      new Response("binary-data", {
        status: 200,
        headers: {
          "content-type": "image/png",
          "content-length": "11",
        },
      }),
    );
    const client = new TilaClient({ baseUrl: "https://api.test", token: "t" });
    const artifacts = createArtifactMethods(client, "proj-1");

    const result = await artifacts.download("some/key/abc123.png");
    expect(result.contentType).toBe("image/png");
    expect(result.contentLength).toBe(11);
    expect(result.body).toBeInstanceOf(ReadableStream);
  });

  it("getLatest returns null on a 404 (requestRaw throws first)", async () => {
    // requestRaw throws TilaApiError before returning a Response, so the 404
    // must be honored via the catch path, not a status check on a Response.
    mockFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          ok: false,
          error: {
            code: "NOT_FOUND",
            message: "no latest artifact for kind/resource",
            retryable: false,
          },
        }),
        { status: 404, headers: { "Content-Type": "application/json" } },
      ),
    );
    const client = new TilaClient({ baseUrl: "https://api.test", token: "t" });
    const artifacts = createArtifactMethods(client, "proj-1");

    const result = await artifacts.getLatest("design", "homepage");
    expect(result).toBeNull();
    expect(mockFetch).toHaveBeenCalledOnce();
  });

  it("getLatest returns the pointer on a 200", async () => {
    const pointer = {
      key: "design/homepage/abc123.md",
      kind: "design",
      resource: "homepage",
      sha256: "abc123",
      created_at: "2026-01-01T00:00:00Z",
    };
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true, pointer }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const client = new TilaClient({ baseUrl: "https://api.test", token: "t" });
    const artifacts = createArtifactMethods(client, "proj-1");

    const result = await artifacts.getLatest("design", "homepage");
    expect(result).toEqual(pointer);
  });

  it("getLatest rethrows non-404 errors", async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          ok: false,
          error: { code: "INTERNAL", message: "boom", retryable: false },
        }),
        { status: 500, headers: { "Content-Type": "application/json" } },
      ),
    );
    const client = new TilaClient({ baseUrl: "https://api.test", token: "t" });
    const artifacts = createArtifactMethods(client, "proj-1");

    await expect(artifacts.getLatest("design", "homepage")).rejects.toThrow();
  });
});
