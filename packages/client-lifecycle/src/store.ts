import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import {
  type LifecycleClient,
  type LifecycleState,
  LifecycleStateSchema,
} from "@tila/schemas";
import lockfile from "proper-lockfile";

export type ProcessIdentity = NonNullable<LifecycleState["owner"]>;
export function processIdentity(pid: number): ProcessIdentity | null {
  try {
    const started = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], {
      encoding: "utf8",
      timeout: 500,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return started ? { pid, started } : null;
  } catch {
    return null;
  }
}
export function processAlive(owner: ProcessIdentity | null): boolean {
  return (
    owner !== null && processIdentity(owner.pid)?.started === owner.started
  );
}
/** Match executable names, never read command arguments (which may contain secrets). */
export function clientOwner(
  client: LifecycleClient,
  initialPid = process.ppid,
): ProcessIdentity | null {
  let pid = initialPid;
  for (let depth = 0; pid > 1 && depth < 12; depth++) {
    try {
      const row = execFileSync("ps", ["-o", "ppid=,comm=", "-p", String(pid)], {
        encoding: "utf8",
        timeout: 500,
      }).trim();
      const match = row.match(/^(\d+)\s+(.+)$/);
      if (!match) return null;
      const executable = match[2];
      if (
        client === "codex"
          ? basename(executable) === "codex"
          : basename(executable) === "claude" ||
            executable.includes("/claude/versions/")
      )
        return processIdentity(pid);
      pid = Number(match[1]);
    } catch {
      return null;
    }
  }
  return null;
}
export function sessionKey(
  namespace: string,
  client: LifecycleClient,
  sessionId: string,
): string {
  return createHash("sha256")
    .update(JSON.stringify([namespace, client, sessionId]))
    .digest("hex");
}
export class SessionStore {
  constructor(
    readonly root = join(
      process.env.TILA_HOME || join(homedir(), ".tila"),
      "client-lifecycle",
    ),
  ) {}
  private path(key: string): string {
    if (!/^[a-f0-9]{64}$/.test(key))
      throw new Error("Invalid lifecycle session key");
    return join(this.root, `${key}.json`);
  }
  read(key: string): LifecycleState | null {
    try {
      return LifecycleStateSchema.parse(
        JSON.parse(readFileSync(this.path(key), "utf8")),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }
  write(state: LifecycleState): void {
    const validated = LifecycleStateSchema.parse(state);
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    const destination = this.path(state.key);
    const tmp = `${destination}.${randomUUID()}.tmp`;
    try {
      writeFileSync(tmp, JSON.stringify(validated), {
        mode: 0o600,
        flag: "wx",
      });
      renameSync(tmp, destination);
    } finally {
      rmSync(tmp, { force: true });
    }
  }
  list(): LifecycleState[] {
    if (!existsSync(this.root)) return [];
    return readdirSync(this.root)
      .filter((name) => /^[a-f0-9]{64}\.json$/.test(name))
      .map((name) => this.read(name.slice(0, -5)))
      .filter((state): state is LifecycleState => state !== null);
  }
  async locked<T>(key: string, run: () => Promise<T>): Promise<T> {
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    const release = await lockfile.lock(this.path(key), {
      realpath: false,
      stale: 10_000,
      update: 2000,
      retries: { retries: 50, factor: 1, minTimeout: 50, maxTimeout: 50 },
    });
    try {
      return await run();
    } finally {
      await release();
    }
  }
}
