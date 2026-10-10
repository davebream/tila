import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Exercise the installed MCP process with an isolated managed-run broker. */
export async function mcpSmoke({ entry, cwd, env, version }) {
  const directory = mkdtempSync(join(tmpdir(), "tila-mcp-smoke-"));
  chmodSync(directory, 0o700);
  const socket =
    process.platform === "win32"
      ? `\\\\.\\pipe\\tila-mcp-smoke-${randomUUID()}`
      : join(directory, "broker.sock");
  const capability = randomBytes(32).toString("base64url");
  const context = {
    ok: true,
    protocol: 1,
    instance_id: randomUUID(),
    project_id: "release-smoke",
    purpose: "run",
    principal_id: "release-smoke",
    enrollment_id: randomUUID(),
    workload_binding_id: null,
    run_id: randomUUID(),
    participant_id: "release-smoke",
    policy: { role: "participant", capabilities: [] },
    token_id: randomUUID(),
    expires_at: Date.now() / 1000 + 3600,
    lease_expires_at: Date.now() / 1000 + 3600,
  };
  let active = true;
  let reads = 0;
  const broker = createServer((req, res) => {
    res.setHeader("Content-Type", "application/json");
    if (
      !active ||
      req.headers.authorization !== `Bearer ${capability}` ||
      req.method !== "GET" ||
      req.url !== "/context"
    ) {
      res
        .writeHead(403)
        .end(JSON.stringify({ error: { code: "runtime-access-denied" } }));
      return;
    }
    reads++;
    res.end(
      JSON.stringify({ context, deployment: "https://release-smoke.invalid" }),
    );
  });
  let child;
  const pending = new Map();
  try {
    broker.listen(socket);
    await once(broker, "listening");
    if (process.platform !== "win32") chmodSync(socket, 0o600);
    // Do not inherit credentials, removed local-mode settings or session hooks.
    const childEnv = Object.fromEntries(
      Object.entries(env).filter(([key]) => !key.startsWith("TILA_")),
    );
    child = spawn(process.execPath, [entry], {
      cwd,
      env: {
        ...childEnv,
        TILA_HOME: directory,
        TILA_RUN_SOCKET: socket,
        TILA_RUN_CAPABILITY: capability,
        TILA_MCP_TOOLS: "all",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const closed = once(child, "close");
    let buffer = "";
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      while (buffer.includes("\n")) {
        const newline = buffer.indexOf("\n");
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        try {
          const message = JSON.parse(line);
          pending.get(message.id)?.resolve(message);
        } catch {
          /* diagnostics are not protocol replies */
        }
      }
    });
    child.on("error", (error) => {
      for (const item of pending.values()) item.reject(error);
    });
    child.on("close", () => {
      for (const item of pending.values())
        item.reject(new Error(`MCP exited: ${stderr}`));
    });
    const send = (value) => child.stdin.write(`${JSON.stringify(value)}\n`);
    const request = (id, method, params) =>
      new Promise((resolveRequest, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`MCP ${method} timed out: ${stderr}`));
        }, 30_000);
        const finish = (fn, value) => {
          clearTimeout(timer);
          pending.delete(id);
          fn(value);
        };
        pending.set(id, {
          resolve: (message) =>
            message.error
              ? finish(reject, new Error(JSON.stringify(message.error)))
              : finish(resolveRequest, message.result),
          reject: (error) => finish(reject, error),
        });
        send({ jsonrpc: "2.0", id, method, params });
      });
    try {
      const result = await request(1, "initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "release-smoke", version },
      });
      assert.equal(result.serverInfo.version, version);
      send({ jsonrpc: "2.0", method: "notifications/initialized" });
      const tools = await request(2, "tools/list", {});
      assert.ok(tools.tools.some((tool) => tool.name === "tila_task_create"));
      assert.ok(reads >= 2, "Discovery must resolve the managed run again");
      active = false;
      await assert.rejects(
        request(3, "tools/list", {}),
        /Run broker denied access|runtime-access-denied/,
      );
    } finally {
      child.kill();
      await closed;
    }
  } finally {
    child?.kill();
    await new Promise((resolveClose) => broker.close(resolveClose));
    rmSync(directory, { recursive: true, force: true });
  }
}
