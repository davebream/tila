import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { CodexProxy } from "../src/codex";

it.each(["matching", "different", "disconnect"])(
  "uses a native WebSocket tunnel and fails closed on %s peer state",
  async (mode) => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "tila-proxy-")));
    const launcher = join(root, "codex");
    const log = join(root, "requests.jsonl");
    const wsPath = createRequire(
      new URL("../../client-lifecycle/package.json", import.meta.url),
    ).resolve("ws-node");
    writeFileSync(
      launcher,
      `#!/usr/bin/env node
const fs = require("node:fs");
const {createServer} = require("node:http");
const {Duplex} = require("node:stream");
const {WebSocketServer} = require(${JSON.stringify(wsPath)});
fs.appendFileSync(${JSON.stringify(log)},JSON.stringify(process.argv.slice(2))+"\\n");
const server = createServer();
new WebSocketServer({server}).on("connection", socket => socket.on("message", data => {
  const message = JSON.parse(data.toString());
  fs.appendFileSync(${JSON.stringify(log)},JSON.stringify(message)+"\\n");
  if (message.id === undefined) return;
  if (${JSON.stringify(mode)} === "disconnect" && message.method === "account/read") {socket.close(); return;}
  socket.send(JSON.stringify({id:message.id,result:message.method === "initialize" ? {codexHome:${JSON.stringify(mode === "different" ? tmpdir() : root)}} : {account:{type:"chatgpt",email:"fixture@example.test"}}}));
}));
server.emit("connection",Duplex.from({readable:process.stdin,writable:process.stdout}));
`,
      { mode: 0o700 },
    );
    const rpc = new CodexProxy({
      id: "fixture",
      revision: 1,
      harness: "codex",
      launcher,
      config_dir: root,
      credential_store: "auto",
      account_ref: "fixture",
      env_allowlist: [],
    });
    try {
      await expect(rpc.request("thread/resume", {})).rejects.toThrow(
        "Unsupported Codex request",
      );
      expect(existsSync(log)).toBe(false);
      const response = rpc.request("account/read", { refreshToken: false });
      if (mode === "matching")
        await expect(response).resolves.toMatchObject({
          account: { type: "chatgpt" },
        });
      else
        await expect(response).rejects.toThrow(
          mode === "different" ? "profile mismatch" : "disconnected",
        );
      const requests = readFileSync(log, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(requests[0]).toEqual(["app-server", "proxy"]);
      expect(requests.slice(1).map((row) => row.method)).toEqual(
        mode === "different"
          ? ["initialize"]
          : ["initialize", "initialized", "account/read"],
      );
      if (mode !== "different")
        expect(requests.at(-1).params).toEqual({ refreshToken: false });
    } finally {
      rpc.close();
      rmSync(root, { recursive: true, force: true });
    }
  },
);
