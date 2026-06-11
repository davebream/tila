import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { McpServerConfig } from "../config";
import { MCP_VERSION, buildFacade } from "../facade";

/**
 * Remote-mode attribution guard: the MCP must tag its HTTP traffic as
 * mcp-server/<version> via X-Tila-Source (a deliberate, standardized client
 * attribution header). The pre-facade TilaClient set this via extraHeaders;
 * this test proves the createTila path preserves it.
 */
describe("MCP source-header attribution (remote mode)", () => {
  const mockFetch = vi.fn();

  beforeEach(() => {
    mockFetch.mockReset();
    vi.stubGlobal("fetch", mockFetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("remote requests carry X-Tila-Source: mcp-server/<version>", async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ ok: true, entity: { id: "T-1", type: "task" } }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const config: McpServerConfig = {
      mode: "remote",
      apiUrl: "https://api.test",
      projectId: "proj-1",
      authMode: "tila-token",
      getToken: () => Promise.resolve("tok"),
    };

    const facade = await buildFacade(config);
    await facade.tasks.create("T-1", "task", {});

    expect(mockFetch).toHaveBeenCalledOnce();
    const [, init] = mockFetch.mock.calls[0];
    expect(init.headers["X-Tila-Source"]).toBe(`mcp-server/${MCP_VERSION}`);
    // The version is non-empty and semver-shaped.
    expect(MCP_VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });
});
