import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
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
import { Hono } from "hono";
import { expect, it } from "vitest";
import {
  RuntimeEnrollmentStore,
  RuntimeFileSecretStore,
} from "../../auth-store/src/runtime-store";
import { createCredentialFixture } from "../../backend-d1/test/helpers/credential-fixture";
import { SessionStore, processAlive } from "../../client-lifecycle/src/index";
import {
  generateRuntimeKey,
  runtimeBinding,
} from "../../client-lifecycle/src/runtime-proof";
import { harness } from "../../client-lifecycle/test/helpers";
import { RuntimeClient } from "../../sdk/src/runtime";
import { hashToken } from "../src/lib/hash";
import { createAuthMiddleware } from "../src/middleware/auth";
import { requestIdentityMiddleware } from "../src/middleware/request-identity";
import { runtimeRoutes } from "../src/routes/runtime";
import type { Env, HonoVariables } from "../src/types";

function stopDetachedHelper(pid: number): void {
  try {
    process.kill(pid, "SIGTERM");
  } catch (error) {
    // A detached helper can exit after the liveness check.
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

it("drives real CLI hooks and detached helpers for concurrent native sessions and SIGKILL", async () => {
  const root = mkdtempSync(join(tmpdir(), "tila-hooks-e2e-"));
  const h = harness(root);
  const store = new SessionStore(join(root, "client-lifecycle"));
  const clients: ChildProcess[] = [];
  const serverErrors: string[] = [];
  const f = createCredentialFixture();
  f.sqlite
    .prepare("UPDATE _projects SET project_id='test' WHERE project_id='p'")
    .run();
  await f.legacy.issue({
    projectId: "test",
    tokenHash: await hashToken("fixture-owner", undefined),
    name: "owner",
    createdBy: "fixture",
    createdAt: 0,
  });
  const app = new Hono<{ Bindings: Env; Variables: HonoVariables }>();
  app.route("/", runtimeRoutes);
  app.use(
    "/projects/:projectId/*",
    createAuthMiddleware(),
    requestIdentityMiddleware(),
  );
  app.all("/projects/:projectId/*", async (c) => {
    const request = c.req.raw;
    try {
      const state = store
        .list()
        .find((entry) => entry.participantId === c.get("participantId"));
      if (!state) throw new Error("Unknown hook identity");
      const api = await h.facade(state);
      const url = new URL(request.url);
      const text = await request.text();
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
      return c.json(result as Record<string, unknown>);
    } catch (error) {
      serverErrors.push(String(error));
      return c.json({ error: String(error) }, 500);
    }
  });
  let origin = "";
  const env = {
    DB: f.db,
    ANALYTICS: { writeDataPoint() {} },
  } as unknown as Env;
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    const result = await app.request(
      `${origin}${request.url}`,
      {
        method: request.method,
        headers: request.headers as HeadersInit,
        ...(body.length ? { body } : {}),
      },
      env,
      { waitUntil() {} } as unknown as ExecutionContext,
    );
    response.writeHead(result.status, Object.fromEntries(result.headers));
    response.end(Buffer.from(await result.arrayBuffer()));
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
    // Prepare the fixture before accepting concurrent requests. Real services
    // initialize storage before serving; this test targets hooks, not cold DDL.
    await h.facade({ participantId: "fixture-setup", environment: {} });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("No fixture port");
    origin = `http://127.0.0.1:${address.port}`;
    const owner = new RuntimeClient(
      { baseUrl: origin, token: "fixture-owner" },
      "test",
    );
    const invite = await owner.authorize("Native fixture");
    const privateJwk = await generateRuntimeKey();
    const key = await runtimeBinding(privateJwk, origin, () => true);
    const installationId = crypto.randomUUID();
    const enrollmentId = crypto.randomUUID();
    const parent = await owner.enroll(
      {
        operation_id: enrollmentId,
        installation_id: installationId,
        name: "Native fixture",
        jkt: key.jkt,
      },
      key,
      invite.invitation,
    );
    const selection = { deployment: origin, projectId: "test" };
    const reference = {
      ...selection,
      instanceId: parent.context.instance_id,
      enrollmentId,
      fileStore: join(root, "secrets"),
    };
    await new RuntimeEnrollmentStore(
      new RuntimeFileSecretStore(reference.fileStore),
    ).save({
      ...reference,
      version: 1,
      installationId,
      privateJwk,
      token: parent.token,
    });
    mkdirSync(join(root, "runtime"), { mode: 0o700 });
    writeFileSync(
      join(
        root,
        "runtime",
        `${createHash("sha256").update(JSON.stringify(selection)).digest("hex")}.json`,
      ),
      JSON.stringify(reference),
    );
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
          new URL(
            "../../client-lifecycle/test/fixtures/hook-client.mjs",
            import.meta.url,
          ).pathname,
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
            TILA_API_TOKEN: "",
            TILA_TOKEN: "",
            CODEX_THREAD_ID: "",
            TILA_RUN_SOCKET: "",
            TILA_RUN_CAPABILITY: "",
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
          20_000,
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
      expect(
        context.degraded,
        JSON.stringify({ stderr, serverErrors }),
      ).toBeUndefined();
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
        stopDetachedHelper(state.worker.pid);
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    h.close();
    f.sqlite.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 60_000);
