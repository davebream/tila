import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ProcessAdapter } from "./process-adapter.mjs";

const roots = [];
const active = [];
const context = () => ({ signal: new AbortController().signal });
async function waitFor(adapter, attempt, state) {
  for (let i = 0; i < 200; i++) {
    const result = await adapter.inspect(attempt);
    if (result.state === state) return result;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Execution did not become ${state}`);
}
afterEach(async () => {
  for (const [adapter, attempt] of active.splice(0)) {
    const state = await adapter.inspect(attempt);
    if (state.state === "running") {
      await adapter.cancel(attempt, context());
      await waitFor(adapter, attempt, "stopped");
    }
  }
  await Promise.all(
    roots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});
async function fixture(source) {
  const root = await mkdtemp(join(tmpdir(), "tila-foreground-"));
  roots.push(root);
  const options = {
    directory: join(root, "launches"),
    executable: process.execPath,
    args: ["-e", source, join(root, "launch-count")],
    worktree: root,
  };
  const adapter = new ProcessAdapter(options);
  const attempt = { id: crypto.randomUUID() };
  active.push([adapter, attempt]);
  return { root, adapter, attempt, options };
}

describe.skipIf(process.platform === "win32")(
  "foreground adapter: real macOS/Linux processes",
  () => {
    it("deduplicates concurrent launches and reconnects with a new adapter instance", async () => {
      const f = await fixture(
        "require('node:fs').appendFileSync(process.argv[1], 'started\\n'); setTimeout(() => {}, 600)",
      );
      expect(await f.adapter.inspect(f.attempt)).toEqual({ state: "absent" });
      await Promise.all([
        f.adapter.start(f.attempt, context()),
        f.adapter.start(f.attempt, context()),
      ]);
      const recovered = new ProcessAdapter(f.options);
      const running = await recovered.inspect(f.attempt);
      expect(running.state).toBe("running");
      expect(running.session).toMatchObject({
        id: f.attempt.id,
        worktree: f.root,
      });
      await recovered.start(f.attempt, context());
      expect(
        (await waitFor(recovered, f.attempt, "stopped")).outcome.status,
      ).toBe("success");
      expect(await readFile(join(f.root, "launch-count"), "utf8")).toBe(
        "started\n",
      );
    });
    it("keeps an interrupted exclusive launch intent unknown and never starts again", async () => {
      const f = await fixture("process.exit(99)");
      await mkdir(f.adapter.path(f.attempt), { recursive: true });
      await f.adapter.start(f.attempt, context());
      expect((await f.adapter.inspect(f.attempt)).state).toBe("unknown");
      await expect(
        readFile(join(f.adapter.path(f.attempt), "state.json")),
      ).rejects.toMatchObject({ code: "ENOENT" });
    });
    it("requests cancellation through the owning wrapper and waits for observed child exit", async () => {
      const f = await fixture("setInterval(() => {}, 1000)");
      await f.adapter.start(f.attempt, context());
      await f.adapter.cancel(f.attempt, context());
      const terminal = await waitFor(f.adapter, f.attempt, "stopped");
      expect(terminal.outcome).toMatchObject({
        status: "cancelled",
        execution_stopped: true,
      });
    });
    it("uses literal arguments and records spawn failure as a stopped failure", async () => {
      const f = await fixture("process.exit(0)");
      f.adapter.executable = join(
        f.root,
        "missing executable $(touch unexpected)",
      );
      await f.adapter.start(f.attempt, context());
      expect(
        (await waitFor(f.adapter, f.attempt, "stopped")).outcome.status,
      ).toBe("failure");
    });
  },
);
