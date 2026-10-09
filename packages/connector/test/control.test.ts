import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { createConnection } from "node:net";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { ConnectorControl, controlRequest } from "../src/control";
import { ConnectorStore, readPrivate } from "../src/store";

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
    store.write({ ...ledger, version: 2 } as unknown as typeof ledger),
  ).toThrow();
  chmodSync(root, 0o755);
  expect(() => store.read()).toThrow();
  chmodSync(root, 0o700);
});
