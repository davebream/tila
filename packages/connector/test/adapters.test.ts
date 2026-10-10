import { randomUUID } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { validateClaudeEndpoint, wakeClaude } from "../src/claude";
import { type CodexRpc, wakeCodex } from "../src/codex";

it("sends an authenticated, body-free Claude notice and records only deferred socket delivery", async () => {
  const root = mkdtempSync("/tmp/tila-peer-");
  const path = join(root, "session.sock");
  let received = "";
  let finish: () => void = () => {};
  const ended = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const server = createServer((socket) => {
    socket.on("data", (data) => {
      received += data;
    });
    socket.on("end", finish);
  });
  try {
    await new Promise<void>((resolve) => server.listen(path, resolve));
    chmodSync(path, 0o600);
    const nonce = randomUUID();
    expect(
      await wakeClaude(
        { socket: path, token: "fixture-token", idle: true },
        nonce,
        { directory: root },
      ),
    ).toBe("deferred");
    await ended;
    const lines = received.trim().split("\n");
    expect(JSON.parse(lines[0])).toEqual({
      type: "auth",
      token: "fixture-token",
    });
    expect(lines[1]).toContain(`Automated Tila notice (${nonce})`);
    expect(lines[1]).toContain("not a user instruction or approval");
    expect(lines).toHaveLength(2);
    expect(
      await wakeClaude({ socket: path, idle: false }, randomUUID(), {
        directory: root,
      }),
    ).toBe("deferred");
    const linked = join(root, "alias.sock");
    symlinkSync(path, linked);
    expect(() =>
      validateClaudeEndpoint({ socket: linked, idle: true }, root),
    ).toThrow();
    chmodSync(root, 0o755);
    expect(() =>
      validateClaudeEndpoint({ socket: path, idle: true }, root),
    ).toThrow();
    chmodSync(root, 0o700);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
});
it("negotiates idle and busy Codex behavior without request configuration overrides", async () => {
  let state = "idle";
  const request = vi.fn(async (method: string) =>
    method === "thread/read"
      ? { thread: { id: "thread-1", status: { type: state } } }
      : { turn: { id: "turn-1" } },
  );
  const rpc: CodexRpc = { request, close() {} };
  const capabilities = { start: true, steer: true, queue: false as const };
  expect(
    await wakeCodex(rpc, capabilities, "thread-1", randomUUID(), {
      allowIdleStart: false,
      urgent: false,
    }),
  ).toBe("deferred");
  expect(request.mock.calls.map(([method]) => method)).toEqual(["thread/read"]);
  const nonce = randomUUID();
  expect(
    await wakeCodex(rpc, capabilities, "thread-1", nonce, {
      allowIdleStart: true,
      urgent: false,
    }),
  ).toBe("accepted");
  const start = (
    request.mock.calls as unknown as [string, Record<string, unknown>][]
  ).find(([method]) => method === "turn/start");
  expect(Object.keys(start?.[1] ?? {}).sort()).toEqual(["input", "threadId"]);
  state = "active";
  request.mockClear();
  expect(
    await wakeCodex(rpc, capabilities, "thread-1", nonce, {
      allowIdleStart: true,
      urgent: false,
    }),
  ).toBe("deferred");
  expect(
    await wakeCodex(rpc, capabilities, "thread-1", nonce, {
      allowIdleStart: true,
      urgent: true,
    }),
  ).toBe("deferred");
  expect(
    await wakeCodex(rpc, capabilities, "thread-1", nonce, {
      allowIdleStart: false,
      urgent: true,
      expectedTurnId: "turn-1",
    }),
  ).toBe("accepted");
  const steer = (
    request.mock.calls as unknown as [string, Record<string, unknown>][]
  ).find(([method]) => method === "turn/steer");
  expect(Object.keys(steer?.[1] ?? {}).sort()).toEqual([
    "expectedTurnId",
    "input",
    "threadId",
  ]);
  expect(steer?.[1].expectedTurnId).toBe("turn-1");
});
it("preserves ambiguous native outcomes and refuses a mismatched Codex session", async () => {
  const rpc: CodexRpc = {
    async request(method) {
      if (method === "thread/read")
        return { thread: { id: "thread-1", status: { type: "idle" } } };
      throw new Error("disconnected after write");
    },
    close() {},
  };
  expect(
    await wakeCodex(
      rpc,
      { start: true, steer: false, queue: false },
      "thread-1",
      randomUUID(),
      { allowIdleStart: true, urgent: false },
    ),
  ).toBe("unknown");
  await expect(
    wakeCodex(
      rpc,
      { start: true, steer: false, queue: false },
      "other",
      randomUUID(),
      { allowIdleStart: true, urgent: false },
    ),
  ).rejects.toThrow("session mismatch");
});
