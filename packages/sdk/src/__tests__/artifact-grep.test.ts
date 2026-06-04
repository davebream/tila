import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createArtifactMethods } from "../artifacts";
import { TilaClient } from "../client";

describe("createArtifactMethods.grep", () => {
  const mockFetch = vi.fn();

  beforeEach(() => {
    mockFetch.mockReset();
    vi.stubGlobal("fetch", mockFetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const mockGrepResponse = {
    ok: true as const,
    results: [
      {
        key: "produced/T-1/abc.md",
        kind: "plan",
        resource: null,
        lines: [{ line: 3, text: "hello world", col: 1 }],
      },
    ],
    scanned: 1,
    skipped: 0,
    truncated: false,
  };

  it("calls GET .../grep with pattern only", async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify(mockGrepResponse), { status: 200 }),
    );
    const client = new TilaClient({ baseUrl: "https://api.test", token: "t" });
    const artifacts = createArtifactMethods(client, "proj-1");

    await artifacts.grep("hello");

    const [url] = mockFetch.mock.calls[0];
    expect(url).toContain("/projects/proj-1/artifacts/grep");
    expect(url).toContain("pattern=hello");
    // regex should NOT be present when not set
    expect(url).not.toContain("regex=");
    // limit should NOT be present when not set
    expect(url).not.toContain("limit=");
  });

  it("builds query field-by-field, NOT a spread — regex serialized as 'true' string only when true", async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify(mockGrepResponse), { status: 200 }),
    );
    const client = new TilaClient({ baseUrl: "https://api.test", token: "t" });
    const artifacts = createArtifactMethods(client, "proj-1");

    await artifacts.grep("pattern", { regex: true });

    const [url] = mockFetch.mock.calls[0];
    expect(url).toContain("regex=true");
    // The boolean false must never be serialized
  });

  it("does not include regex param when regex is false", async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify(mockGrepResponse), { status: 200 }),
    );
    const client = new TilaClient({ baseUrl: "https://api.test", token: "t" });
    const artifacts = createArtifactMethods(client, "proj-1");

    await artifacts.grep("pattern", { regex: false });

    const [url] = mockFetch.mock.calls[0];
    expect(url).not.toContain("regex=");
  });

  it("serializes limit as string", async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify(mockGrepResponse), { status: 200 }),
    );
    const client = new TilaClient({ baseUrl: "https://api.test", token: "t" });
    const artifacts = createArtifactMethods(client, "proj-1");

    await artifacts.grep("x", { limit: 10 });

    const [url] = mockFetch.mock.calls[0];
    expect(url).toContain("limit=10");
  });

  it("includes kind and resource when provided", async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify(mockGrepResponse), { status: 200 }),
    );
    const client = new TilaClient({ baseUrl: "https://api.test", token: "t" });
    const artifacts = createArtifactMethods(client, "proj-1");

    await artifacts.grep("x", { kind: "plan", resource: "T-1" });

    const [url] = mockFetch.mock.calls[0];
    expect(url).toContain("kind=plan");
    expect(url).toContain("resource=T-1");
  });

  it("returns typed ArtifactGrepResponse", async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify(mockGrepResponse), { status: 200 }),
    );
    const client = new TilaClient({ baseUrl: "https://api.test", token: "t" });
    const artifacts = createArtifactMethods(client, "proj-1");

    const result = await artifacts.grep("hello");

    expect(result.ok).toBe(true);
    expect(result.results).toHaveLength(1);
    expect(result.results[0].key).toBe("produced/T-1/abc.md");
    expect(result.results[0].lines[0]).toEqual({
      line: 3,
      text: "hello world",
      col: 1,
    });
    expect(result.scanned).toBe(1);
    expect(result.skipped).toBe(0);
    expect(result.truncated).toBe(false);
  });
});
