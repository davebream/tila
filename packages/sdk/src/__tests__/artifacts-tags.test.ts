import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createArtifactMethods } from "../artifacts";
import { TilaClient } from "../client";

describe("artifact upload with tags (SDK)", () => {
  const mockFetch = vi.fn();

  beforeEach(() => {
    mockFetch.mockReset();
    vi.stubGlobal("fetch", mockFetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("appends tags as JSON to FormData on File/Blob upload", async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ ok: true, key: "k", bytes: 4, deduplicated: false }),
        { status: 200 },
      ),
    );

    const client = new TilaClient({ baseUrl: "https://api.test", token: "t" });
    const artifacts = createArtifactMethods(client, "proj-1");

    const file = new File(["data"], "test.json", { type: "application/json" });
    await artifacts.upload(file, {
      kind: "output",
      tags: ["team:eng", "env:prod"],
    });

    const [, init] = mockFetch.mock.calls[0];
    const body = init.body as FormData;
    expect(body.get("tags")).toBe(JSON.stringify(["team:eng", "env:prod"]));
  });

  it("appends tags as JSON to FormData on ReadableStream upload", async () => {
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

    await artifacts.upload(stream, {
      kind: "output",
      mimeType: "text/plain",
      tags: ["repo:api"],
    });

    const [, init] = mockFetch.mock.calls[0];
    const body = init.body as FormData;
    expect(body.get("tags")).toBe(JSON.stringify(["repo:api"]));
  });

  it("omits tags from FormData when not provided on File upload", async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ ok: true, key: "k", bytes: 4, deduplicated: false }),
        { status: 200 },
      ),
    );

    const client = new TilaClient({ baseUrl: "https://api.test", token: "t" });
    const artifacts = createArtifactMethods(client, "proj-1");

    const file = new File(["data"], "test.json", { type: "application/json" });
    await artifacts.upload(file, { kind: "output" });

    const [, init] = mockFetch.mock.calls[0];
    const body = init.body as FormData;
    expect(body.get("tags")).toBeNull();
  });

  it("list response surfaces tags from server", async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          ok: true,
          pointers: [
            {
              r2_key: "sources/abc.txt",
              kind: "output",
              resource: null,
              mime_type: "text/plain",
              tags: ["team:eng"],
              created_at: 1000,
              bytes: 4,
            },
          ],
          total: 1,
        }),
        { status: 200 },
      ),
    );

    const client = new TilaClient({ baseUrl: "https://api.test", token: "t" });
    const artifacts = createArtifactMethods(client, "proj-1");

    const result = await artifacts.list();
    const pointers = (result as Record<string, unknown>).pointers as Array<
      Record<string, unknown>
    >;
    expect(pointers[0].tags).toEqual(["team:eng"]);
  });
});
