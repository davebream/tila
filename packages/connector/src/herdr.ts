import { createHash, randomUUID } from "node:crypto";
import { lstatSync } from "node:fs";
import { createConnection } from "node:net";
import { dirname } from "node:path";
import { processAlive } from "@tila/client-lifecycle";
import {
  type HerdrObservation,
  HerdrProcessInfoSchema,
  HerdrSnapshotSchema,
} from "@tila/schemas";
import type { DiscoveredSession } from "./discovery";

export const HERDR_CONTRACT = {
  version: "0.9.3",
  commit: "7b116c05bfda646af39d2524c54e70c751f57ee8",
} as const;
export const HERDR_SUPPORT = {
  supported: false,
  reason:
    "Native multi-account discovery, draft preservation and authenticated cold restoration have not passed on macOS and Linux",
  evidence: "docs/evidence/issue-283-herdr-0-9-3-v1.json",
} as const;
export function requireHerdrSupport(): void {
  if (!HERDR_SUPPORT.supported)
    throw Object.assign(new Error(HERDR_SUPPORT.reason), {
      code: "unsupported-capability",
    });
}
/** The socket inode identifies one server incarnation, not a reusable pane label. */
export function herdrServerInstance(socket: string): string {
  const parent = lstatSync(dirname(socket));
  const stat = lstatSync(socket);
  const uid = process.getuid?.();
  if (
    parent.isSymbolicLink() ||
    !parent.isDirectory() ||
    parent.uid !== uid ||
    (parent.mode & 0o022) !== 0 ||
    stat.isSymbolicLink() ||
    !stat.isSocket() ||
    stat.uid !== uid ||
    (stat.mode & 0o077) !== 0
  )
    throw new Error("Herdr socket is not owned and protected");
  return createHash("sha256")
    .update(
      JSON.stringify([stat.dev, stat.ino, stat.birthtimeMs, stat.ctimeMs]),
    )
    .digest("hex");
}
export interface HerdrReadClient {
  instance(): string;
  request(
    method: "ping" | "session.snapshot" | "pane.process_info",
    params: Record<string, unknown>,
  ): Promise<unknown>;
}
/** Read-only transport. Every connection requires a fresh authoritative snapshot. */
export class HerdrSocketClient implements HerdrReadClient {
  constructor(readonly socket: string) {}
  instance(): string {
    return herdrServerInstance(this.socket);
  }
  request(
    method: "ping" | "session.snapshot" | "pane.process_info",
    params: Record<string, unknown>,
  ): Promise<unknown> {
    if (!["ping", "session.snapshot", "pane.process_info"].includes(method))
      throw new Error("Unsupported Herdr observation request");
    const instance = this.instance();
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const socket = createConnection(this.socket);
      let buffer = "";
      let settled = false;
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        reject(error);
        socket.destroy();
      };
      socket.setTimeout(3000, () =>
        fail(new Error("Herdr observation timed out")),
      );
      socket.on("error", () =>
        fail(new Error("Herdr observation disconnected")),
      );
      socket.on("close", () => {
        if (!settled) fail(new Error("Herdr observation disconnected"));
      });
      socket.on("connect", () =>
        socket.write(`${JSON.stringify({ id, method, params })}\n`),
      );
      socket.on("data", (chunk) => {
        buffer += chunk.toString("utf8");
        if (Buffer.byteLength(buffer) > 1024 * 1024) {
          fail(new Error("Herdr response limit exceeded"));
          return;
        }
        const newline = buffer.indexOf("\n");
        if (newline < 0) return;
        try {
          const response = JSON.parse(buffer.slice(0, newline));
          if (
            response.id !== id ||
            response.error ||
            instance !== this.instance()
          )
            throw new Error("Herdr observation invalidated");
          settled = true;
          resolve(response.result);
          socket.destroy();
        } catch {
          fail(new Error("Herdr observation invalidated"));
        }
      });
    });
  }
}
export class HerdrRuntimeAdapter {
  private invalidation = 0;
  constructor(
    readonly serverRef: string,
    readonly client: HerdrReadClient,
  ) {}
  /** Events only invalidate observations; they never grant or transfer authority. */
  invalidate(): void {
    this.invalidation++;
  }
  async observe(
    session: DiscoveredSession,
    paneId: string,
    expected?: HerdrObservation,
  ): Promise<HerdrObservation> {
    const invalidation = this.invalidation;
    const instance = this.client.instance();
    const raw = (await this.client.request("session.snapshot", {})) as {
      snapshot?: unknown;
    };
    const snapshot = HerdrSnapshotSchema.parse(raw.snapshot);
    if (snapshot.version !== HERDR_CONTRACT.version)
      throw new Error("Herdr version is outside the evaluated contract");
    const pane = snapshot.panes.find((row) => row.pane_id === paneId);
    const harness =
      session.state.client === "claude-code" ? "claude" : session.state.client;
    if (
      !pane ||
      pane.agent_session?.kind !== "id" ||
      pane.agent_session.value !== session.state.sessionId ||
      pane.agent_session.agent !== harness ||
      pane.agent !== harness
    )
      throw new Error(
        "Herdr pane does not describe the discovered native session",
      );
    const processes = (await this.client.request("pane.process_info", {
      pane_id: paneId,
    })) as { process_info?: unknown };
    const current = HerdrProcessInfoSchema.parse(processes.process_info);
    if (
      current.pane_id !== paneId ||
      !current.foreground_processes.some(
        (p) => p.pid === session.state.owner.pid,
      ) ||
      !processAlive(session.state.owner)
    )
      throw new Error(
        "Herdr foreground occupant does not match the verified process",
      );
    const observation: HerdrObservation = {
      server_ref: this.serverRef,
      server_instance: instance,
      pane_id: paneId,
      terminal_id: pane.terminal_id,
      native_session_id: session.state.sessionId,
      owner: session.state.owner,
    };
    if (expected && JSON.stringify(expected) !== JSON.stringify(observation))
      throw new Error("Herdr occupant or server was replaced");
    const after = (await this.client.request("session.snapshot", {})) as {
      snapshot?: unknown;
    };
    const final = HerdrSnapshotSchema.parse(after.snapshot).panes.find(
      (row) => row.pane_id === paneId,
    );
    if (
      invalidation !== this.invalidation ||
      instance !== this.client.instance() ||
      !final ||
      final.terminal_id !== pane.terminal_id ||
      JSON.stringify(final.agent_session) !==
        JSON.stringify(pane.agent_session) ||
      !processAlive(session.state.owner)
    )
      throw new Error("Herdr observation changed during reconciliation");
    return observation;
  }
}
