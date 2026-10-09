import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  ListPromptsResultSchema,
  ListResourcesResultSchema,
  ListToolsResultSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { RuntimeRunContext } from "@tila/schemas";
import { afterEach, expect, it, vi } from "vitest";
import { lifecycleTools } from "./lifecycle";

afterEach(() => vi.unstubAllGlobals());
it("isolates interleaved tools, resources, prompts and discovery using actual MCP requests", async () => {
  const calls: string[] = [];
  const active = new Set(["one", "two"]);
  vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
    const participant = new Headers(init.headers).get("X-Tila-Participant-Id");
    await new Promise((resolve) =>
      setTimeout(resolve, participant === "one" ? 20 : 1),
    );
    return new Response(JSON.stringify({ participant }), {
      headers: { "Content-Type": "application/json" },
    });
  });
  const base = new McpServer({ name: "runtime-test", version: "1" });
  const scoped = lifecycleTools(base, {
    mode: "remote",
    apiUrl: "https://tila.test",
    projectId: "p",
    async resolveRun(meta) {
      const id = meta?.sessionId;
      if (typeof id !== "string" || !active.has(id))
        throw new Error("runtime-session-unavailable");
      calls.push(id);
      return {
        deployment: "https://tila.test",
        context: { project_id: "p", participant_id: id } as RuntimeRunContext,
        provider: async () => ({ token: `run-${id}` }),
      };
    },
  });
  const captured = scoped.facade.summary;
  scoped.server.registerTool("who", { inputSchema: {} }, async () => ({
    content: [{ type: "text", text: JSON.stringify(await captured.get()) }],
  }));
  scoped.server.resource("who", "tila://who", async (uri) => ({
    contents: [{ uri: uri.href, text: JSON.stringify(await captured.get()) }],
  }));
  scoped.server.prompt("who", async () => ({
    messages: [
      {
        role: "user",
        content: { type: "text", text: JSON.stringify(await captured.get()) },
      },
    ],
  }));
  const client = new Client({ name: "host", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await base.connect(a);
  await client.connect(b);
  try {
    const results = await Promise.all([
      client.callTool({
        name: "who",
        arguments: {},
        _meta: { sessionId: "one" },
      }),
      client.callTool({
        name: "who",
        arguments: {},
        _meta: { sessionId: "two" },
      }),
      client.readResource({ uri: "tila://who", _meta: { sessionId: "one" } }),
      client.getPrompt({ name: "who", _meta: { sessionId: "two" } }),
    ]);
    expect(JSON.stringify(results[0])).toContain("one");
    expect(JSON.stringify(results[1])).toContain("two");
    expect(JSON.stringify(results[2])).toContain("one");
    expect(JSON.stringify(results[3])).toContain("two");
    for (const [method, schema] of [
      ["tools/list", ListToolsResultSchema],
      ["resources/list", ListResourcesResultSchema],
      ["prompts/list", ListPromptsResultSchema],
    ] as const) {
      await expect(
        client.request(
          { method, params: { _meta: { sessionId: "one" } } },
          schema,
        ),
      ).resolves.toBeDefined();
      await expect(
        client.request({ method, params: {} }, schema),
      ).rejects.toThrow("runtime-session-unavailable");
    }
    active.delete("one");
    await expect(
      client.readResource({ uri: "tila://who", _meta: { sessionId: "one" } }),
    ).rejects.toThrow("runtime-session-unavailable");
    expect(
      JSON.stringify(
        await client.callTool({
          name: "who",
          arguments: {},
          _meta: { sessionId: "two" },
        }),
      ),
    ).toContain("two");
    expect(calls.filter((id) => id === "one").length).toBeGreaterThan(2);
  } finally {
    await client.close();
    await base.close();
  }
});
