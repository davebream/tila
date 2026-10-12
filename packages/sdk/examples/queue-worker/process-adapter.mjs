import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, stat } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export async function durableWrite(path, value) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  const file = await open(temporary, "w", 0o600);
  try {
    await file.writeFile(JSON.stringify(value));
    await file.sync();
  } finally {
    await file.close();
  }
  await rename(temporary, path);
  const directory = await open(dirname(path), "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

/** Foreground-command reference, not a daemon/container/process-tree supervisor. */
export class ProcessAdapter {
  constructor({ directory, executable, args = [], worktree = process.cwd() }) {
    this.directory = resolve(directory);
    this.executable = executable;
    this.args = args;
    this.worktree = resolve(worktree);
  }
  path(attempt) {
    return join(
      this.directory,
      createHash("sha256").update(attempt.id).digest("hex"),
    );
  }
  async inspect(attempt) {
    const directory = this.path(attempt);
    try {
      const record = JSON.parse(
        await readFile(join(directory, "state.json"), "utf8"),
      );
      if (record.attempt_id !== attempt.id)
        return { state: "unknown", reason: "Launch record identity mismatch" };
      if (record.state === "stopped")
        return { state: "stopped", outcome: record.outcome };
      if (record.state === "running" && Date.now() - record.updated_at < 2_000)
        return { state: "running", session: record.session };
      return {
        state: "unknown",
        reason:
          "Wrapper heartbeat is stale; external execution may still exist",
      };
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      try {
        await readFile(join(directory, "intent.json"));
      } catch (missing) {
        if (missing.code !== "ENOENT") throw missing;
        // Even an empty directory means exclusive launch ownership was taken.
        try {
          await stat(directory);
        } catch (absent) {
          if (absent.code === "ENOENT") return { state: "absent" };
          throw absent;
        }
      }
      return {
        state: "unknown",
        reason: "Durable launch intent has no acknowledged execution",
      };
    }
  }
  async start(attempt, { signal }) {
    signal.throwIfAborted();
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const directory = this.path(attempt);
    try {
      await mkdir(directory, { mode: 0o700 });
    } catch (error) {
      if (error.code === "EEXIST") return;
      throw error;
    }
    const parent = await open(this.directory, "r");
    try {
      await parent.sync();
    } finally {
      await parent.close();
    }
    await durableWrite(join(directory, "intent.json"), {
      attempt_id: attempt.id,
      executable: this.executable,
      args: this.args,
      worktree: this.worktree,
      session: {
        provider: "foreground-command",
        id: attempt.id,
        host_id: hostname(),
        worktree: this.worktree,
      },
    });
    signal.throwIfAborted();
    const wrapper = spawn(
      process.execPath,
      [
        fileURLToPath(new URL("./process-wrapper.mjs", import.meta.url)),
        directory,
      ],
      { detached: true, stdio: "ignore", shell: false },
    );
    await new Promise((resolve, reject) => {
      wrapper.once("spawn", resolve);
      wrapper.once("error", reject);
    });
    wrapper.unref();
    for (let count = 0; count < 100; count++) {
      signal.throwIfAborted();
      const observed = await this.inspect(attempt);
      if (observed.state === "running" || observed.state === "stopped") return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(
      "Launch acknowledgement is unknown; inspect before retrying",
    );
  }
  async cancel(attempt, { signal }) {
    signal.throwIfAborted();
    // The owning wrapper signals its own foreground child. Never signal a PID
    // loaded from disk: it may have been reused by an unrelated process.
    await durableWrite(join(this.path(attempt), "cancel.json"), {
      requested: true,
    });
  }
}
