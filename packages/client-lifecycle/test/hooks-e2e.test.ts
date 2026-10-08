import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { expect, it } from "vitest";
import { SessionStore, processAlive } from "../src/index";
import { harness } from "./helpers";

it("drives real CLI hooks and detached helpers for concurrent native sessions and SIGKILL", async () => {
  const root = mkdtempSync(join(tmpdir(), "tila-hooks-e2e-"));
  const h = harness(root);
  const store = new SessionStore(join(root, "client-lifecycle"));
  const clients: ChildProcess[] = [];
  const server = createServer(async (request, response) => {
    try {
      const state = store
        .list()
        .find(
          (entry) =>
            entry.participantId === request.headers["x-tila-participant-id"],
        );
      if (!state) throw new Error("Unknown hook identity");
      const api = await h.facade(state);
      const url = new URL(request.url ?? "/", "http://fixture");
      let text = "";
      for await (const chunk of request) text += chunk;
      const body = text ? JSON.parse(text) : {};
      const path = url.pathname.replace("/projects/test", "");
      let result: unknown;
      if (path === "/journal/cursor")
        result =
          request.method === "GET"
            ? await api.journal.getCursor()
            : await api.journal.acknowledge(body);
      else if (path === "/reentry")
        result = await api.reentry({
          after_seq: Number(url.searchParams.get("after_seq")),
          limit: 20,
        });
      else if (path === "/presence/heartbeat")
        result = await api.presence.heartbeat(body.info);
      else if (path === "/handoffs") result = await api.handoffs.create(body);
      else if (path === "/claims/release")
        result = await api.claims.release(body.resource, body.fence);
      else if (request.method === "GET" && path.startsWith("/claims/state/"))
        result = await api.claims.get(
          decodeURIComponent(path.slice("/claims/state/".length)),
        );
      else throw new Error(`Unexpected request: ${path}`);
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify(result));
    } catch (error) {
      response.statusCode = 500;
      response.end(JSON.stringify({ error: String(error) }));
    }
  });
  const until = async (ready: () => boolean) => {
    const deadline = Date.now() + 25_000;
    while (!ready()) {
      if (Date.now() > deadline)
        throw new Error("Timed out waiting for hook lifecycle");
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  };
  try {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("No fixture port");
    mkdirSync(join(root, ".tila"));
    writeFileSync(
      join(root, ".tila/config.toml"),
      `project_id="test"\nworker_url="http://127.0.0.1:${address.port}"\nbackend="cloudflare"\nschema_version=1\ntila_version="0.2.7"\ncreated_at="2026-10-07"\n`,
    );
    // Match a native CLI executable without launching a model-backed client.
    const executable = join(root, "claude");
    copyFileSync(
      execFileSync("bun", ["-p", "process.execPath"], {
        encoding: "utf8",
      }).trim(),
      executable,
    );
    chmodSync(executable, 0o700);
    const launch = async (session: string) => {
      const child = spawn(
        executable,
        [
          new URL("./fixtures/hook-client.mjs", import.meta.url).pathname,
          resolve("../.."),
          root,
          session,
        ],
        {
          stdio: ["ignore", "ignore", "pipe", "ipc"],
          env: {
            ...process.env,
            PATH: `${root}${delimiter}${process.env.PATH}`,
            TILA_HOME: root,
            TILA_API_TOKEN: "fixture-only",
            TILA_LIFECYCLE_KEY: "",
            TILA_PARTICIPANT_ID: "",
            CLAUDE_ENV_FILE: "",
          },
        },
      );
      clients.push(child);
      let stderr = "";
      child.stderr?.on("data", (chunk) => {
        stderr += chunk;
      });
      const output = await new Promise<unknown>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`Client hook did not start: ${stderr}`)),
          10_000,
        );
        child.once("message", (value) => {
          clearTimeout(timer);
          resolve(value);
        });
        child.once("exit", () => {
          clearTimeout(timer);
          reject(new Error(`Fixture client exited before its hook: ${stderr}`));
        });
        child.once("error", (error) => {
          clearTimeout(timer);
          reject(error);
        });
      });
      const context = JSON.parse(
        JSON.parse(String(output)).hookSpecificOutput.additionalContext,
      );
      expect(context.degraded).toBeUndefined();
      return child;
    };
    const [one, two] = await Promise.all([launch("one"), launch("two")]);
    const a = store.list().find((state) => state.sessionId === "one");
    const b = store.list().find((state) => state.sessionId === "two");
    if (!a || !b) throw new Error("Missing session state");
    expect(a.participantId).not.toBe(b.participantId);
    expect(a.owner?.pid).toBe(one.pid);
    expect(b.owner?.pid).toBe(two.pid);
    const apiA = await h.facade(a);
    const apiB = await h.facade(b);
    await apiA.claims.acquire("task:crashed", "exclusive", 100);
    await apiB.claims.acquire("task:clean", "exclusive", 60_000);
    await until(() =>
      store.list().every((state) => state.lastHeartbeat !== null),
    );
    const killed = once(one, "exit");
    one.kill("SIGKILL");
    await killed;
    const ended = once(two, "exit");
    two.send("end");
    await ended;
    await until(
      () =>
        store.read(a.key)?.phase === "crashed" &&
        store.read(b.key)?.phase === "closed",
    );
    expect((await apiA.journal.getCursor()).cursor.seq).toBe(0);
    const handoffs = (await apiB.handoffs.list()).handoffs;
    expect(handoffs).toHaveLength(1);
    expect(handoffs[0].creator.participant_id).toBe(b.participantId);
    expect((await apiA.claims.get("task:crashed")).claim).toBeNull();
    expect((await apiB.claims.get("task:clean")).claim).toBeNull();
  } finally {
    for (const child of clients)
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, "exit");
        child.kill();
        await exited;
      }
    for (const state of store.list())
      if (state.worker && processAlive(state.worker))
        process.kill(state.worker.pid, "SIGTERM");
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    h.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 40_000);
