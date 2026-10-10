import { spawn } from "node:child_process";
import { Duplex } from "node:stream";
// The alias forces the npm implementation: Bun's built-in ws shim ignores
// createConnection and would try TCP instead of the native subprocess tunnel.
import WebSocket from "ws-node";

export interface CodexDaemonConnection {
  send(message: unknown, callback?: (error?: Error) => void): void;
  close(): void;
}

/** The native proxy is a byte tunnel to a WebSocket endpoint, not JSON-lines. */
export function connectCodexDaemon(
  executable: string,
  env: NodeJS.ProcessEnv | undefined,
  receive: (message: unknown) => void,
  disconnected: () => void,
): Promise<CodexDaemonConnection> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, ["app-server", "proxy"], {
      env,
      stdio: "pipe",
    });
    child.stderr.resume();
    const tunnel = Duplex.from({
      readable: child.stdout,
      writable: child.stdin,
    });
    // The URL supplies only HTTP upgrade metadata. createConnection always uses
    // the owned subprocess pipes; no TCP listener or network fallback is opened.
    const socket = new WebSocket("ws://localhost/", {
      createConnection: () => tunnel,
      handshakeTimeout: 3000,
      maxPayload: 4 * 1024 * 1024,
      perMessageDeflate: false,
    });
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      socket.terminate();
      tunnel.destroy();
      child.kill();
      reject(new Error("Codex daemon disconnected"));
      disconnected();
    };
    child.on("error", close);
    child.on("exit", close);
    tunnel.on("error", close);
    socket.on("error", close);
    socket.on("close", close);
    socket.on("message", (data, binary) => {
      try {
        if (binary) throw new Error("Expected a JSON text frame");
        receive(JSON.parse(data.toString()));
      } catch {
        close();
      }
    });
    socket.on("open", () =>
      resolve({
        send(message, callback) {
          socket.send(JSON.stringify(message), callback);
        },
        close,
      }),
    );
  });
}
