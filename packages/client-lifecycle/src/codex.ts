import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { createInterface } from "node:readline";

/** Live observation uses the existing daemon; credential probes use isolated stdio. */
export class CodexObserver {
  private child?: ChildProcessWithoutNullStreams;
  private nextId = 0;
  private pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  private ready?: Promise<void>;
  constructor(
    private readonly executable = "codex",
    private readonly env?: NodeJS.ProcessEnv,
    private readonly purpose: "observation" | "credentials" = "observation",
  ) {}
  private connect(): Promise<void> {
    if (this.ready) return this.ready;
    const child = spawn(
      this.executable,
      ["app-server", this.purpose === "credentials" ? "--stdio" : "proxy"],
      {
        stdio: "pipe",
        env: this.env,
      },
    );
    this.child = child;
    child.stderr.resume();
    const lines = createInterface({ input: child.stdout });
    lines.on("line", (line) => {
      try {
        const response = JSON.parse(line);
        const pending = this.pending.get(response.id);
        if (!pending) return;
        this.pending.delete(response.id);
        if (response.error)
          pending.reject(new Error("Codex status request failed"));
        else pending.resolve(response.result);
      } catch {
        /* Ignore non-response notifications; never persist conversation content. */
      }
    });
    const fail = () => {
      for (const pending of this.pending.values())
        pending.reject(new Error("Codex observer disconnected"));
      this.pending.clear();
      this.ready = undefined;
      this.child = undefined;
      lines.close();
    };
    child.on("error", fail);
    child.on("exit", fail);
    this.ready = this.request("initialize", {
      clientInfo: { name: "tila-lifecycle", version: "1" },
      capabilities: {},
    }).then((result) => {
      if (this.purpose === "credentials") {
        const home = (result as { codexHome?: unknown } | null)?.codexHome;
        if (
          typeof home !== "string" ||
          !this.env?.CODEX_HOME ||
          realpathSync(home) !== realpathSync(this.env.CODEX_HOME)
        )
          throw new Error("Codex credential probe used a different profile");
      }
      child.stdin.write(`${JSON.stringify({ method: "initialized" })}\n`);
    });
    return this.ready;
  }
  private request(method: string, params: unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = ++this.nextId;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("Codex status timed out"));
      }, 1500);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      this.child?.stdin.write(
        `${JSON.stringify({ id, method, params })}\n`,
        (error) => {
          if (error) {
            clearTimeout(timer);
            this.pending.delete(id);
            reject(error);
          }
        },
      );
    });
  }
  async alive(sessionId: string): Promise<boolean> {
    if (this.purpose === "credentials")
      throw new Error("Credential probes cannot observe live sessions");
    try {
      await this.connect();
    } catch (error) {
      this.close();
      throw error;
    }
    const result = (await this.request("thread/read", {
      threadId: sessionId,
      includeTurns: false,
    })) as { thread?: { status?: { type?: string } } };
    const status = result.thread?.status?.type;
    if (!status) throw new Error("Codex did not return session status");
    return status === "active" || status === "idle";
  }
  async account(): Promise<string | null> {
    await this.connect();
    const result = (await this.request("account/read", {
      refreshToken: false,
    })) as { account?: { type?: string; email?: string } | null };
    return result.account?.type === "chatgpt" &&
      typeof result.account.email === "string"
      ? result.account.email
      : null;
  }
  close(): void {
    this.child?.kill();
  }
}
