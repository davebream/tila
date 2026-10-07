import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Lifecycle, SessionStore } from "@tila/client-lifecycle";
import type { TilaFacade } from "tila-sdk";
import { afterEach, expect, it, vi } from "vitest";
import { lifecycleTools } from "./lifecycle";
const mocks = vi.hoisted(() => ({ build: vi.fn() }));
vi.mock("./facade", () => ({ buildFacade: mocks.build }));
afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetAllMocks();
});
it("routes interleaved shared-daemon calls by session metadata, including captured resource methods", async () => {
  const root = mkdtempSync(join(tmpdir(), "tila-mcp-lifecycle-"));
  vi.stubEnv("TILA_HOME", root);
  vi.stubEnv("TILA_LIFECYCLE_CLIENT", "codex");
  const store = new SessionStore();
  const namespace = JSON.stringify(["https://tila.example", "test"]);
  const lifecycle = new Lifecycle(store, namespace, async () => {
    throw new Error("offline start");
  });
  const start = (session_id: string) =>
    lifecycle.start(
      "codex",
      { session_id, cwd: root, hook_event_name: "SessionStart" },
      null,
      { client_name: "codex" },
    );
  const [a, b] = await Promise.all([start("one"), start("two")]);
  const closed: string[] = [];
  mocks.build.mockImplementation(async (_config, identity) => ({
    claims: {
      list: async () => {
        await new Promise((resolve) =>
          setTimeout(
            resolve,
            identity.participantId === a.state.participantId ? 20 : 1,
          ),
        );
        return identity.participantId;
      },
    },
    close: () => closed.push(identity.participantId),
  }));
  let handler: (...args: unknown[]) => Promise<unknown> = async () => undefined;
  const server = {
    tool: (...args: unknown[]) => {
      handler = args.at(-1) as typeof handler;
    },
  } as unknown as McpServer;
  const scoped = lifecycleTools(
    server,
    {
      mode: "remote",
      apiUrl: "https://tila.example",
      projectId: "test",
      authMode: "tila-token",
      getToken: async () => "test",
    },
    {} as TilaFacade,
  );
  const captured = scoped.facade.claims;
  scoped.server.tool("test", "test", {}, async () => ({
    content: [{ type: "text", text: JSON.stringify(await captured.list()) }],
  }));
  try {
    const results = await Promise.all([
      handler({}, { _meta: { sessionId: "one", threadId: "child-one" } }),
      handler({}, { _meta: { sessionId: "two" } }),
    ]);
    expect(JSON.stringify(results[0])).toContain(a.state.participantId);
    expect(JSON.stringify(results[1])).toContain(b.state.participantId);
    expect(closed.sort()).toEqual(
      [a.state.participantId, b.state.participantId].sort(),
    );
    await expect(handler({}, {})).rejects.toThrow(
      "per-request session metadata",
    );
    await lifecycle.end(a.state.key);
    await expect(handler({}, { _meta: { sessionId: "one" } })).rejects.toThrow(
      "no unambiguous active session",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
it("leaves unconfigured servers untouched", () => {
  vi.stubEnv("TILA_LIFECYCLE_CLIENT", "");
  const server = {} as McpServer;
  const facade = {} as TilaFacade;
  expect(
    lifecycleTools(
      server,
      {
        mode: "local",
        projectId: "test",
        dbPath: "unused",
        artifactsPath: "unused",
        org: "test",
      },
      facade,
    ),
  ).toEqual({ server, facade });
});
