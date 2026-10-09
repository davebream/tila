import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

test(
  "compiled host connector authenticates sockets and preserves native wake request shapes",
  {
    skip:
      process.platform === "win32"
        ? "Host connector supports macOS/Linux"
        : false,
  },
  () => {
    const root = mkdtempSync(join(tmpdir(), "tila-connector-native-"));
    try {
      const source = join(root, "fixture.ts");
      const binary = join(root, "connector-test");
      writeFileSync(
        source,
        `
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, chmodSync } from "node:fs";
import { createServer } from "node:net";
import { randomUUID } from "node:crypto";
import { ConnectorStore, ConnectorControl, controlRequest, wakeCodex, wakeClaude } from ${JSON.stringify(resolve("packages/connector/src/index.ts"))};
const root = mkdtempSync("/tmp/tila-native-");
const store = new ConnectorStore(root); const control = new ConnectorControl(store);
try {
  await control.listen(async request => ({ action: request.action }));
  assert.deepEqual(await controlRequest(store, { action: "status" }), { action: "status" });
  await assert.rejects(controlRequest(store, { action: "register", key: "a".repeat(64), expectedEpoch: 0, allowIdleStart: false, launcher: "/bin/sh" }));
  const requests = [];
  const rpc = { async request(method, params) { requests.push([method, params]); return method === "thread/read" ? { thread: { id: "fixture", status: { type: "active" } } } : {}; }, close() {} };
  assert.equal(await wakeCodex(rpc, { start: true, steer: true, queue: false }, "fixture", randomUUID(), { allowIdleStart: false, urgent: true, expectedTurnId: "turn-1" }), "accepted");
  assert.deepEqual(Object.keys(requests[1][1]).sort(), ["expectedTurnId", "input", "threadId"]);
  assert.equal(requests[1][1].expectedTurnId, "turn-1");
  let received = ""; let delivered;
  const delivery = new Promise(resolve => { delivered = resolve; });
  const peer = createServer(socket => { socket.on("data", data => { received += data; }); socket.on("end", delivered); });
  const socketPath = root + "/peer.sock";
  await new Promise(resolve => peer.listen(socketPath, resolve)); chmodSync(socketPath, 0o600);
  try {
    assert.equal(await wakeClaude({ socket: socketPath, token: "fixture-token", idle: true }, randomUUID(), { directory: root }), "deferred");
    await delivery;
    assert.match(received, /Automated Tila notice/); assert.match(received, /fixture-token/);
  } finally { await new Promise(resolve => peer.close(resolve)); }
  console.log("compiled connector verified");
} finally { await control.close(); rmSync(root, { recursive: true, force: true }); }
`,
      );
      const built = spawnSync(
        "bun",
        [
          "build",
          "--compile",
          "--tsconfig-override",
          resolve("tsconfig.json"),
          source,
          "--outfile",
          binary,
        ],
        { encoding: "utf8", timeout: 120_000 },
      );
      assert.equal(built.status, 0, built.stderr);
      const ran = spawnSync(binary, [], { encoding: "utf8", timeout: 30_000 });
      assert.equal(ran.status, 0, `${ran.stderr}\n${ran.stdout}`);
      assert.match(ran.stdout, /compiled connector verified/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
