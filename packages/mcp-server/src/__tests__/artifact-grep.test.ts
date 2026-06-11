import { describe, expect, it } from "vitest";
import { registerArtifactTools } from "../tools/artifacts";
import {
  type MockServer,
  asFacade,
  asServer,
  createMockFacade,
  createMockServer,
  findToolHandler,
} from "./helpers/mock-facade";

const PROJECT_ID = "test-project";

describe("tila_artifact_grep MCP tool", () => {
  function setupTools() {
    const server = createMockServer();
    const facade = createMockFacade();
    registerArtifactTools(asServer(server), asFacade(facade), PROJECT_ID);
    return { server, facade };
  }

  const findHandler = (server: MockServer, name: string) =>
    findToolHandler(server, name);

  it("is registered as tila_artifact_grep", () => {
    const { server } = setupTools();
    const toolNames = server.tool.mock.calls.map((c: unknown[]) => c[0]);
    expect(toolNames).toContain("tila_artifact_grep");
  });

  it("description contains col-is-char-offset note", () => {
    const { server } = setupTools();
    const call = server.tool.mock.calls.find(
      (c: unknown[]) => c[0] === "tila_artifact_grep",
    );
    if (!call) throw new Error("tila_artifact_grep not registered");
    const description = call[1] as string;
    expect(description).toContain("col");
    expect(description.toLowerCase()).toMatch(/exact|substring|regex/);
  });

  it("forwards grep request to artifacts.grep", async () => {
    const { server, facade } = setupTools();
    facade.artifacts.grep.mockResolvedValue({
      ok: true,
      results: [],
      scanned: 0,
      skipped: 0,
      truncated: false,
    });

    const handler = findHandler(server, "tila_artifact_grep");
    await handler({ pattern: "hello", limit: 20 });

    expect(facade.artifacts.grep).toHaveBeenCalledWith(
      "hello",
      expect.objectContaining({ limit: 20 }),
    );
  });

  it("passes kind, resource, regex, and limit to artifacts.grep", async () => {
    const { server, facade } = setupTools();
    facade.artifacts.grep.mockResolvedValue({
      ok: true,
      results: [],
      scanned: 0,
      skipped: 0,
      truncated: false,
    });

    const handler = findHandler(server, "tila_artifact_grep");
    await handler({
      pattern: "x",
      kind: "plan",
      resource: "T-1",
      regex: true,
      limit: 10,
    });

    expect(facade.artifacts.grep).toHaveBeenCalledWith("x", {
      kind: "plan",
      resource: "T-1",
      regex: true,
      limit: 10,
    });
  });

  it("returns JSON-stringified response as text content", async () => {
    const { server, facade } = setupTools();
    const mockResponse = {
      ok: true,
      results: [
        {
          key: "k",
          kind: "plan",
          resource: null,
          lines: [{ line: 1, text: "match", col: 1 }],
        },
      ],
      scanned: 1,
      skipped: 0,
      truncated: false,
    };
    facade.artifacts.grep.mockResolvedValue(mockResponse);

    const handler = findHandler(server, "tila_artifact_grep");
    const result = await handler({ pattern: "match" });

    expect(result.content[0].type).toBe("text");
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.ok).toBe(true);
    expect(parsed.results).toHaveLength(1);
  });

  it("caps total match lines at max_matches and marks truncation", async () => {
    const { server, facade } = setupTools();
    const five = Array.from({ length: 5 }, (_, i) => ({
      line: i + 1,
      text: "m",
      col: 1,
    }));
    facade.artifacts.grep.mockResolvedValue({
      ok: true,
      results: [
        { key: "a", kind: "plan", resource: null, lines: five },
        { key: "b", kind: "plan", resource: null, lines: five },
      ],
      scanned: 2,
      skipped: 0,
      truncated: false,
    });

    const handler = findHandler(server, "tila_artifact_grep");
    const result = await handler({ pattern: "m", max_matches: 7 });
    const parsed = JSON.parse(result.content[0].text);
    const returned = parsed.results.reduce(
      (n: number, r: { lines: unknown[] }) => n + r.lines.length,
      0,
    );

    expect(returned).toBe(7);
    expect(parsed.matches_truncated).toBe(true);
    expect(parsed.matches_total).toBe(10);
  });

  it("does not add a truncation marker when under max_matches", async () => {
    const { server, facade } = setupTools();
    facade.artifacts.grep.mockResolvedValue({
      ok: true,
      results: [
        {
          key: "a",
          kind: "plan",
          resource: null,
          lines: [{ line: 1, text: "m", col: 1 }],
        },
      ],
      scanned: 1,
      skipped: 0,
      truncated: false,
    });

    const handler = findHandler(server, "tila_artifact_grep");
    const result = await handler({ pattern: "m" });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.matches_truncated).toBeUndefined();
  });

  it("returns results unchanged when total equals max_matches", async () => {
    const { server, facade } = setupTools();
    const five = Array.from({ length: 5 }, (_, i) => ({
      line: i + 1,
      text: "m",
      col: 1,
    }));
    facade.artifacts.grep.mockResolvedValue({
      ok: true,
      results: [{ key: "a", kind: "plan", resource: null, lines: five }],
      scanned: 1,
      skipped: 0,
      truncated: false,
    });

    const handler = findHandler(server, "tila_artifact_grep");
    const result = await handler({ pattern: "m", max_matches: 5 });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.matches_truncated).toBeUndefined();
    expect(parsed.results[0].lines).toHaveLength(5);
  });

  it("passes through empty results untouched", async () => {
    const { server, facade } = setupTools();
    facade.artifacts.grep.mockResolvedValue({
      ok: true,
      results: [],
      scanned: 0,
      skipped: 0,
      truncated: false,
    });

    const handler = findHandler(server, "tila_artifact_grep");
    const result = await handler({ pattern: "m", max_matches: 10 });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.results).toHaveLength(0);
    expect(parsed.matches_truncated).toBeUndefined();
  });

  it("drops an entire result when max_matches is exhausted before it", async () => {
    const { server, facade } = setupTools();
    const five = Array.from({ length: 5 }, (_, i) => ({
      line: i + 1,
      text: "m",
      col: 1,
    }));
    facade.artifacts.grep.mockResolvedValue({
      ok: true,
      results: [
        { key: "a", kind: "plan", resource: null, lines: five },
        { key: "b", kind: "plan", resource: null, lines: five },
      ],
      scanned: 2,
      skipped: 0,
      truncated: false,
    });

    const handler = findHandler(server, "tila_artifact_grep");
    const result = await handler({ pattern: "m", max_matches: 5 });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.results).toHaveLength(1);
    expect(parsed.results[0].key).toBe("a");
    expect(parsed.matches_truncated).toBe(true);
    expect(parsed.matches_total).toBe(10);
  });

  it("error message contains no platform-internal tokens (R2, DO, SQLite, isolate, Worker)", async () => {
    const { server, facade } = setupTools();
    facade.artifacts.grep.mockRejectedValue(
      new Error("artifact lookup failed"),
    );

    const handler = findHandler(server, "tila_artifact_grep");
    let errorMessage = "";
    try {
      await handler({ pattern: "x" });
    } catch (err) {
      errorMessage = err instanceof Error ? err.message : String(err);
    }

    expect(errorMessage).not.toMatch(/\bR2\b/);
    expect(errorMessage).not.toMatch(/\bDurable Object\b/i);
    expect(errorMessage).not.toMatch(/\bSQLite\b/i);
    expect(errorMessage).not.toMatch(/\bisolate\b/i);
    expect(errorMessage).not.toMatch(/\bWorker\b/);
  });
});
