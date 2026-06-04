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
});
