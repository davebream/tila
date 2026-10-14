import { randomUUID } from "node:crypto";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { createConnection } from "node:net";
import { join } from "node:path";
import { LedgerV1Schema } from "@tila/schemas";
import { afterEach, expect, it } from "vitest";
import { ConnectorControl, controlRequest } from "../src/control";
import { ConnectorStore, atomicPrivate, readPrivate } from "../src/store";

const roots: string[] = [];
const controls: ConnectorControl[] = [];
afterEach(async () => {
  for (const control of controls.splice(0)) await control.close();
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
function setup() {
  const root = mkdtempSync("/tmp/tila-connector-");
  roots.push(root);
  const store = new ConnectorStore(root);
  const control = new ConnectorControl(store);
  controls.push(control);
  return { root, store, control };
}
function raw(socketPath: string, value: unknown): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let text = "";
    socket.on("error", reject);
    socket.on("connect", () => socket.end(`${JSON.stringify(value)}\n`));
    socket.on("data", (data) => {
      text += data;
    });
    socket.on("end", () => {
      try {
        resolve(JSON.parse(text));
      } catch (e) {
        reject(e);
      }
    });
  });
}
it("authenticates one host socket, rejects injected authority, and excludes a second process", async () => {
  const { root, store, control } = setup();
  const received: unknown[] = [];
  await control.listen(async (request) => {
    received.push(request);
    return { live: true };
  });
  expect(await controlRequest(store, { action: "status" })).toEqual({
    live: true,
  });
  const token = readFileSync(join(root, "control.token"), "utf8");
  expect(
    await raw(control.socket, {
      token: "x".repeat(64),
      request: { action: "status" },
    }),
  ).toMatchObject({ ok: false });
  expect(
    await raw(control.socket, {
      token,
      request: {
        action: "register",
        key: "a".repeat(64),
        expectedEpoch: 0,
        launcher: "/bin/sh",
        agent: "other",
      },
    }),
  ).toMatchObject({ ok: false });
  expect(received).toEqual([{ action: "status" }]);
  const competitor = new ConnectorControl(store);
  await expect(competitor.listen(async () => ({}))).rejects.toThrow();
  expect(await controlRequest(store, { action: "status" })).toEqual({
    live: true,
  });
  await control.close();
  await expect(controlRequest(store, { action: "status" })).rejects.toThrow();
});
it("rotates its boot token and rejects symlinked or exposed private files", async () => {
  const { root, store, control } = setup();
  await control.listen(async () => ({}));
  const old = readPrivate(join(root, "control.token"));
  await control.close();
  await control.listen(async () => ({}));
  expect(readPrivate(join(root, "control.token"))).not.toBe(old);
  expect(
    await raw(control.socket, { token: old, request: { action: "stop" } }),
  ).toMatchObject({ ok: false });
  symlinkSync(join(root, "control.token"), join(root, "alias"));
  expect(() => readPrivate(join(root, "alias"))).toThrow();
  chmodSync(join(root, "control.token"), 0o644);
  expect(() => readPrivate(join(root, "control.token"))).toThrow();
});
it("persists a validated ledger and refuses corruption instead of forgetting uncertain work", () => {
  const { root, store } = setup();
  const ledger = store.read();
  ledger.heartbeat = 42;
  store.write(ledger);
  expect(store.read()).toEqual(ledger);
  expect(readPrivate(join(root, "ledger.json"))).not.toContain("control.token");
  expect(() =>
    store.write({ ...ledger, version: 3 } as unknown as typeof ledger),
  ).toThrow();
  chmodSync(root, 0o755);
  expect(() => store.read()).toThrow();
  chmodSync(root, 0o700);
});

it("migrates v1 standalone registrations losslessly including uncertain outcomes and rejects v2 in the old reader", () => {
  const { root, store } = setup();
  const legacy = LedgerV1Schema.parse({
    version: 1,
    hostRef: randomUUID(),
    heartbeat: 42,
    registrations: [
      {
        key: "a".repeat(64),
        generation: randomUUID(),
        owner: { pid: 123, started: "fixture-start" },
        agent: "worker",
        profile: { id: "fixture-profile", revision: 3 },
        namespace: "fixture-namespace",
        actingRunId: randomUUID(),
        expectedEpoch: 7,
        allowIdleStart: false,
        relayOperationId: randomUUID(),
        relayRunId: randomUUID(),
        bindingId: randomUUID(),
        bindingEpoch: 8,
        state: "paused",
        reason: "Ambiguous wake retained",
        pending: {
          leaseToken: randomUUID(),
          leaseUntil: 12345,
          publishGen: 9,
          bindingId: randomUUID(),
          bindingEpoch: 8,
          startedAt: 100,
          outcome: "unknown",
          reported: true,
        },
      },
    ],
  });
  atomicPrivate(join(root, "ledger.json"), legacy);
  const migrated = store.read();
  expect(migrated.version).toBe(2);
  const { runtime, identity, ...preserved } = migrated.registrations[0];
  expect(runtime).toEqual({ kind: "standalone" });
  expect(identity).toBeUndefined();
  expect(preserved).toEqual(legacy.registrations[0]);
  store.write(migrated);
  expect(store.read()).toEqual(migrated);
  expect(() =>
    LedgerV1Schema.parse(JSON.parse(readPrivate(join(root, "ledger.json")))),
  ).toThrow();
});

it("rejects forged observation and target fields before any handler I/O", async () => {
  const { root, store, control } = setup();
  const received: unknown[] = [];
  await control.listen(async (request) => {
    received.push(request);
    return {};
  });
  const token = readPrivate(join(root, "control.token"));
  const request = {
    action: "inspect-herdr",
    key: "a".repeat(64),
    target: { kind: "herdr", socket: "/fixture/api.sock", paneId: "w1:p1" },
  };
  for (const input of [
    { token: "invalid", request },
    {
      token,
      request: {
        ...request,
        target: { ...request.target, server_instance: "forged" },
      },
    },
    {
      token,
      request: {
        ...request,
        target: { ...request.target, socket: "relative.sock" },
      },
    },
    {
      token,
      request: {
        ...request,
        observation: { owner: { pid: 1, started: "forged" } },
      },
    },
  ])
    expect(await raw(control.socket, input)).toMatchObject({ ok: false });
  expect(received).toEqual([]);
  expect(await controlRequest(store, request)).toEqual({});
  expect(received).toEqual([request]);
});
