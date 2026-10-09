import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, unlinkSync, writeFileSync } from "node:fs";
import {
  type Server,
  type Socket,
  createConnection,
  createServer,
} from "node:net";
import { join } from "node:path";
import { processAlive, processIdentity } from "@tila/client-lifecycle";
import {
  type ControlRequest,
  ControlRequestSchema,
  ProcessIdentitySchema,
} from "@tila/schemas";
import lockfile from "proper-lockfile";
import {
  type ConnectorStore,
  atomicPrivate,
  privatePath,
  readPrivate,
} from "./store";

export { ControlRequestSchema, type ControlRequest } from "@tila/schemas";

function remove(path: string): void {
  try {
    unlinkSync(path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
}
function equal(left: unknown, right: string): boolean {
  if (typeof left !== "string" || left.length !== right.length) return false;
  const bytes = Buffer.from(left);
  return (
    bytes.length === Buffer.byteLength(right) &&
    timingSafeEqual(bytes, Buffer.from(right))
  );
}
/** A single boot owns both the lock and token. Control never accepts launchers or credentials. */
export class ConnectorControl {
  private server?: Server;
  private release?: () => Promise<void>;
  private ownsFiles = false;
  private readonly sockets = new Set<Socket>();
  readonly socket: string;
  constructor(readonly store: ConnectorStore) {
    this.socket = join(store.root, "control.sock");
  }
  async listen(
    handle: (request: ControlRequest) => Promise<unknown>,
  ): Promise<void> {
    this.release = await lockfile.lock(this.store.root, {
      realpath: false,
      stale: 60_000,
      update: 10_000,
      retries: 0,
    });
    try {
      try {
        const owner = ProcessIdentitySchema.parse(
          JSON.parse(readPrivate(join(this.store.root, "owner.json"))),
        );
        if (processAlive(owner))
          throw new Error(
            "Connector process is still alive; refusing takeover",
          );
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      }
      const owner = processIdentity(process.pid);
      if (!owner) throw new Error("Cannot verify connector process identity");
      atomicPrivate(join(this.store.root, "owner.json"), owner);
      this.ownsFiles = true;
      const token = randomBytes(32).toString("hex");
      remove(join(this.store.root, "control.token"));
      writeFileSync(join(this.store.root, "control.token"), token, {
        flag: "wx",
        mode: 0o600,
      });
      remove(this.socket);
      this.server = createServer((socket) => {
        this.sockets.add(socket);
        socket.on("close", () => this.sockets.delete(socket));
        socket.on("error", () => {});
        socket.setTimeout(30_000, () => socket.destroy());
        let buffer = "";
        let consumed = false;
        socket.on("data", (chunk) => {
          if (consumed) return;
          buffer += chunk.toString("utf8");
          if (Buffer.byteLength(buffer) > 8192) {
            consumed = true;
            socket.destroy();
            return;
          }
          if (!buffer.includes("\n")) return;
          consumed = true;
          void (async () => {
            try {
              const input = JSON.parse(buffer.slice(0, buffer.indexOf("\n")));
              if (!equal(input.token, token))
                throw new Error("Authentication failed");
              const request = ControlRequestSchema.parse(input.request);
              socket.end(
                `${JSON.stringify({ ok: true, result: await handle(request) })}\n`,
              );
            } catch {
              socket.end(
                `${JSON.stringify({ ok: false, error: "Connector request rejected; inspect connector status locally" })}\n`,
              );
            }
          })();
        });
      });
      await new Promise<void>((resolve, reject) => {
        this.server?.once("error", reject);
        this.server?.listen(this.socket, () => {
          chmodSync(this.socket, 0o600);
          resolve();
        });
      });
    } catch (error) {
      if (this.ownsFiles) await this.close();
      else {
        await this.release();
        this.release = undefined;
      }
      throw error;
    }
  }
  async close(): Promise<void> {
    if (!this.release) return;
    for (const socket of this.sockets) socket.destroy();
    if (this.server?.listening)
      await new Promise<void>((resolve) => this.server?.close(() => resolve()));
    remove(this.socket);
    remove(join(this.store.root, "control.token"));
    remove(join(this.store.root, "owner.json"));
    await this.release();
    this.release = undefined;
    this.ownsFiles = false;
  }
}
export async function controlRequest(
  store: ConnectorStore,
  request: ControlRequest,
): Promise<unknown> {
  const token = readPrivate(join(store.root, "control.token"));
  const path = join(store.root, "control.sock");
  privatePath(path, "socket");
  return new Promise((resolve, reject) => {
    const socket = createConnection(path);
    let buffer = "";
    const timer = setTimeout(
      () => socket.destroy(new Error("Connector control timed out")),
      30_000,
    );
    socket.on("connect", () =>
      socket.write(
        `${JSON.stringify({ token, request: ControlRequestSchema.parse(request) })}\n`,
      ),
    );
    socket.on("error", reject);
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      if (Buffer.byteLength(buffer) > 1024 * 1024)
        socket.destroy(new Error("Connector response is too large"));
    });
    socket.on("end", () => {
      try {
        const value = JSON.parse(buffer);
        if (!value.ok) throw new Error(value.error);
        resolve(value.result);
      } catch (e) {
        reject(e);
      }
    });
    socket.on("close", () => clearTimeout(timer));
  });
}
