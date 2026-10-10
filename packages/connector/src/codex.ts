import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  type CodexDaemonConnection,
  connectCodexDaemon,
  profileEnvironment,
} from "@tila/client-lifecycle";
import type { CredentialProfile } from "@tila/schemas";
import { type WakeOutcome, wakeNotice } from "./claude";
import { privateDirectory } from "./store";

export interface CodexCapabilities {
  start: boolean;
  steer: boolean;
  queue: false;
}
/** Inspect the installed executable's own contract, not a guessed runtime version. */
export function codexCapabilities(
  profile: CredentialProfile,
  root: string,
): CodexCapabilities {
  privateDirectory(root);
  const output = mkdtempSync(join(root, "protocol-"));
  try {
    execFileSync(
      profile.launcher,
      ["app-server", "generate-json-schema", "--out", output],
      { env: profileEnvironment(profile), timeout: 15_000, stdio: "ignore" },
    );
    const request = readFileSync(join(output, "ClientRequest.json"), "utf8");
    const steer = JSON.parse(
      readFileSync(join(output, "v2/TurnSteerParams.json"), "utf8"),
    );
    const start = JSON.parse(
      readFileSync(join(output, "v2/TurnStartParams.json"), "utf8"),
    );
    return {
      start:
        request.includes('"turn/start"') &&
        start.required?.includes("threadId") &&
        !!start.properties?.input,
      steer:
        request.includes('"turn/steer"') &&
        steer.required?.includes("expectedTurnId") &&
        steer.required?.includes("input"),
      // No shipping native queue contract yet. Never substitute an ordinary steer.
      queue: false,
    };
  } finally {
    rmSync(output, { recursive: true, force: true });
  }
}
export interface CodexRpc {
  request(method: string, params: unknown): Promise<unknown>;
  close(): void;
}
/** Only attaches to the profile's existing daemon; never starts one implicitly. */
export class CodexProxy implements CodexRpc {
  private connection?: CodexDaemonConnection;
  private ready?: Promise<void>;
  private id = 0;
  private pending = new Map<
    number,
    {
      resolve(value: unknown): void;
      reject(error: Error): void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  constructor(readonly profile: CredentialProfile) {}
  private connect(): Promise<void> {
    if (this.ready) return this.ready;
    this.ready = (async () => {
      this.connection = await connectCodexDaemon(
        this.profile.launcher,
        profileEnvironment(this.profile),
        (response) => {
          const message = response as {
            id: number;
            error?: unknown;
            result?: unknown;
          };
          const pending = this.pending.get(message.id);
          if (!pending) return; // Never persist native notifications or transcript content.
          this.pending.delete(message.id);
          clearTimeout(pending.timer);
          if (message.error)
            pending.reject(new Error("Codex request rejected"));
          else pending.resolve(message.result);
        },
        () => this.close(),
      );
      const initialized = (await this.send("initialize", {
        clientInfo: { name: "tila-connector", version: "1" },
        capabilities: {},
      })) as { codexHome?: string };
      if (
        !initialized.codexHome ||
        realpathSync(initialized.codexHome) !==
          realpathSync(this.profile.config_dir)
      ) {
        this.close();
        throw new Error("Codex daemon profile mismatch");
      }
      this.connection?.send({ method: "initialized" });
    })();
    return this.ready;
  }
  private send(method: string, params: unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = ++this.id;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("Codex request outcome unknown"));
      }, 3000);
      this.pending.set(id, { resolve, reject, timer });
      this.connection?.send({ id, method, params }, (error) => {
        if (error) this.close();
      });
    });
  }
  async request(method: string, params: unknown): Promise<unknown> {
    if (
      !["thread/read", "account/read", "turn/start", "turn/steer"].includes(
        method,
      )
    )
      throw new Error("Unsupported Codex request");
    await this.connect();
    return this.send(method, params);
  }
  close(): void {
    const connection = this.connection;
    this.connection = undefined;
    connection?.close();
    this.ready = undefined;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("Codex proxy disconnected; outcome unknown"));
    }
    this.pending.clear();
  }
}
export async function codexThread(
  rpc: CodexRpc,
  threadId: string,
): Promise<{ state: string; turnId?: string }> {
  const response = (await rpc.request("thread/read", {
    threadId,
    includeTurns: false,
  })) as {
    thread?: {
      id?: string;
      status?: { type?: string; activeTurnId?: string };
      activeTurnId?: string;
    };
  };
  if (response.thread?.id !== threadId)
    throw new Error("Codex native session mismatch");
  return {
    state: response.thread.status?.type ?? "unknown",
    turnId:
      response.thread.activeTurnId ?? response.thread.status?.activeTurnId,
  };
}
export async function wakeCodex(
  rpc: CodexRpc,
  capabilities: CodexCapabilities,
  threadId: string,
  nonce: string,
  policy: { allowIdleStart: boolean; urgent: boolean; expectedTurnId?: string },
): Promise<WakeOutcome> {
  const status = await codexThread(rpc, threadId);
  const input = [{ type: "text", text: wakeNotice(nonce) }];
  if (status.state === "idle" && policy.allowIdleStart && capabilities.start) {
    try {
      await rpc.request("turn/start", { threadId, input });
      return "accepted";
    } catch {
      return "unknown";
    }
  }
  if (
    status.state === "active" &&
    policy.urgent &&
    capabilities.steer &&
    policy.expectedTurnId
  ) {
    try {
      await rpc.request("turn/steer", {
        threadId,
        input,
        expectedTurnId: policy.expectedTurnId,
      });
      return "accepted";
    } catch {
      return "unknown";
    }
  }
  return "deferred";
}
