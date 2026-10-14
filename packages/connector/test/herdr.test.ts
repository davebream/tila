import { randomUUID } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { processIdentity } from "@tila/client-lifecycle";
import { HerdrProcessInfoSchema, HerdrSnapshotSchema } from "@tila/schemas";
import { expect, it } from "vitest";
import type { DiscoveredSession } from "../src/discovery";
import {
  HERDR_SUPPORT,
  type HerdrReadClient,
  HerdrRuntimeAdapter,
  HerdrSocketClient,
  requireHerdrSupport,
} from "../src/herdr";

function fixture() {
  const owner = processIdentity(process.pid);
  if (!owner) throw new Error("Test process cannot be identified");
  const session = {
    state: { owner, client: "claude-code", sessionId: "native-one" },
  } as DiscoveredSession;
  const pane = {
    pane_id: "w1:p1",
    terminal_id: "terminal-one",
    agent: "claude",
    agent_status: "idle",
    label: "coordinator",
    revision: 0,
    agent_session: {
      source: "herdr:claude",
      agent: "claude",
      kind: "id",
      value: "native-one",
    },
  };
  let instance = "instance-one";
  let pid = process.pid;
  const client: HerdrReadClient = {
    instance: () => instance,
    async request(method) {
      return method === "session.snapshot"
        ? {
            snapshot: {
              version: "0.9.3",
              protocol: 22,
              panes: [structuredClone(pane)],
            },
          }
        : {
            process_info: {
              pane_id: pane.pane_id,
              foreground_processes: [{ pid, name: "claude" }],
            },
          };
    },
  };
  const adapter = new HerdrRuntimeAdapter(randomUUID(), client);
  return {
    session,
    pane,
    client,
    adapter,
    replaceServer: () => {
      instance = "instance-two";
    },
    replaceProcess: () => {
      pid = 1;
    },
  };
}
it("uses native identity and foreground process evidence, never labels", async () => {
  const f = fixture();
  const proof = await f.adapter.observe(f.session, "w1:p1");
  expect(proof.native_session_id).toBe("native-one");
  expect(proof.owner.pid).toBe(process.pid);
  f.pane.label = "another-account";
  expect(await f.adapter.observe(f.session, "w1:p1", proof)).toEqual(proof);
  f.pane.agent_session.value = "someone-else";
  await expect(f.adapter.observe(f.session, "w1:p1", proof)).rejects.toThrow(
    "native session",
  );
  f.pane.agent_session.value = "native-one";
  f.replaceProcess();
  await expect(f.adapter.observe(f.session, "w1:p1", proof)).rejects.toThrow(
    "foreground occupant",
  );
});
it("reconciles a fresh snapshot after reconnect and rejects server or occupant replacement", async () => {
  const f = fixture();
  const proof = await f.adapter.observe(f.session, "w1:p1");
  f.replaceServer();
  await expect(f.adapter.observe(f.session, "w1:p1", proof)).rejects.toThrow(
    "replaced",
  );
  const fresh = await f.adapter.observe(f.session, "w1:p1");
  f.pane.terminal_id = "replacement-terminal";
  await expect(f.adapter.observe(f.session, "w1:p1", fresh)).rejects.toThrow(
    "replaced",
  );
});
it("treats events as invalidation and rejects a snapshot changed during process inspection", async () => {
  const f = fixture();
  const original = f.client.request.bind(f.client);
  f.client.request = async (method, params) => {
    const result = await original(method, params);
    if (method === "pane.process_info") f.adapter.invalidate();
    return result;
  };
  await expect(f.adapter.observe(f.session, "w1:p1")).rejects.toThrow(
    "changed during reconciliation",
  );
  f.client.request = async (method, params) => {
    const result = await original(method, params);
    if (method === "pane.process_info") f.pane.terminal_id = "new-terminal";
    return result;
  };
  await expect(f.adapter.observe(f.session, "w1:p1")).rejects.toThrow(
    "changed during reconciliation",
  );
});
it("uses protected read-only fixture sockets and refuses to enable unproven integration", async () => {
  const root = mkdtempSync("/tmp/tila-herdr-test-");
  const socketPath = join(root, "api.sock");
  const server = createServer((socket) => {
    let text = "";
    socket.on("data", (data) => {
      text += data;
      if (text.includes("\n")) {
        const input = JSON.parse(text);
        socket.end(
          `${JSON.stringify({ id: input.id, result: { version: "0.9.3" } })}\n`,
        );
      }
    });
  });
  try {
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
    chmodSync(socketPath, 0o600);
    const client = new HerdrSocketClient(socketPath);
    expect(await client.request("ping", {})).toEqual({ version: "0.9.3" });
    expect(() => client.request("pane.send_text" as "ping", {})).toThrow(
      "Unsupported",
    );
    chmodSync(socketPath, 0o666);
    expect(() => client.request("ping", {})).toThrow("protected");
    expect(HERDR_SUPPORT.supported).toBe(false);
    expect(requireHerdrSupport).toThrow(
      expect.objectContaining({ code: "unsupported-capability" }),
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
});

it("normalizes protocol22 absence in unrelated shell panes without trusting missing target evidence", async () => {
  const f = fixture();
  const original = f.client.request.bind(f.client);
  f.client.request = async (method, params) => {
    const result = await original(method, params);
    if (method === "session.snapshot") {
      const value = result as { snapshot: { panes: unknown[] } };
      value.snapshot.panes.push({
        pane_id: "shell",
        terminal_id: "shell-terminal",
        agent: null,
        agent_session: null,
        agent_status: "idle",
        revision: 0,
      });
      expect(
        HerdrSnapshotSchema.parse(value.snapshot).panes[1].agent,
      ).toBeUndefined();
    }
    return result;
  };
  await f.adapter.observe(f.session, "w1:p1");
  await expect(f.adapter.observe(f.session, "shell")).rejects.toThrow(
    "native session",
  );
  expect(
    HerdrProcessInfoSchema.parse({ pane_id: "shell", shell_pid: null })
      .foreground_processes,
  ).toEqual([]);
  f.client.request = async (method, params) =>
    method === "pane.process_info"
      ? { process_info: { pane_id: "w1:p1", shell_pid: null } }
      : original(method, params);
  await expect(f.adapter.observe(f.session, "w1:p1")).rejects.toThrow(
    "foreground occupant",
  );
});

it.each([
  "version",
  "protocol",
  "agent",
  "session-kind",
  "native-id",
  "terminal",
])("rejects changed %s on the final snapshot", async (field) => {
  const f = fixture();
  const original = f.client.request.bind(f.client);
  let snapshots = 0;
  f.client.request = async (method, params) => {
    const result = await original(method, params);
    if (method === "session.snapshot" && ++snapshots === 2) {
      const value = result as {
        snapshot: {
          version: string;
          protocol: number;
          panes: (typeof f.pane)[];
        };
      };
      if (field === "version") value.snapshot.version = "0.9.4";
      if (field === "protocol") value.snapshot.protocol = 21;
      if (field === "agent") value.snapshot.panes[0].agent = "codex";
      if (field === "session-kind")
        value.snapshot.panes[0].agent_session.kind = "path";
      if (field === "native-id")
        value.snapshot.panes[0].agent_session.value = "replacement";
      if (field === "terminal")
        value.snapshot.panes[0].terminal_id = "replacement";
    }
    return result;
  };
  await expect(f.adapter.observe(f.session, "w1:p1")).rejects.toThrow();
});

it.each([1, 2, 3, 4])(
  "invalidates a disconnect at observation await %s and requires fresh reconnect evidence",
  async (boundary) => {
    const f = fixture();
    const original = f.client.request.bind(f.client);
    let requests = 0;
    f.client.request = async (method, params) => {
      const result = await original(method, params);
      if (++requests === boundary) f.adapter.invalidate();
      return result;
    };
    await expect(f.adapter.observe(f.session, "w1:p1")).rejects.toThrow(
      "changed during reconciliation",
    );
    f.client.request = original;
    const proof = await f.adapter.observe(f.session, "w1:p1");
    f.adapter.invalidate();
    expect(() => f.adapter.assertCurrent(proof)).toThrow("invalidated");
    expect(await f.adapter.observe(f.session, "w1:p1", proof)).toEqual(proof);
  },
);

it("rejects a surviving background PID and reused PID start identity near the effect", async () => {
  const f = fixture();
  const original = f.client.request.bind(f.client);
  let processes = 0;
  f.client.request = async (method, params) => {
    if (method === "pane.process_info" && ++processes === 2) f.replaceProcess();
    return original(method, params);
  };
  await expect(f.adapter.observe(f.session, "w1:p1")).rejects.toThrow(
    "foreground occupant",
  );
  const reused = fixture();
  reused.session.state.owner.started = "another-process-incarnation";
  await expect(reused.adapter.observe(reused.session, "w1:p1")).rejects.toThrow(
    "changed during reconciliation",
  );
});
