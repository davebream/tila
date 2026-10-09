import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Hono } from "hono";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createCredentialFixture } from "../../backend-d1/test/helpers/credential-fixture";
import { hashToken } from "../src/lib/hash";
import { createAuthMiddleware } from "../src/middleware/auth";
import { capabilityMiddleware } from "../src/middleware/capability";
import { projectMembershipMiddleware } from "../src/middleware/membership";
import { projectMiddleware } from "../src/middleware/project";
import { requestIdentityMiddleware } from "../src/middleware/request-identity";
import { runtimeRoutes } from "../src/routes/runtime";
import type { Env, HonoVariables } from "../src/types";

const home = mkdtempSync(join(tmpdir(), "tila-run-process-"));
const entry = resolve(import.meta.dirname, "../../cli/src/index.ts");
const f = createCredentialFixture();
const app = new Hono<{ Bindings: Env; Variables: HonoVariables }>();
app.route("/", runtimeRoutes);
const project = new Hono<{ Bindings: Env; Variables: HonoVariables }>();
project.use(
  "*",
  createAuthMiddleware(),
  requestIdentityMiddleware(),
  projectMiddleware,
  projectMembershipMiddleware(),
  capabilityMiddleware(),
);
project.all("*", async (c) => {
  if (c.req.path.endsWith("/handoffs"))
    return c.json({
      ok: true,
      handoff: {
        ...(await c.req.json()),
        creator: {
          principal_id: "service:fixture",
          participant_id: c.get("participantId"),
          environment: {},
        },
        created_at: 0,
        created_seq: 0,
        active_claims: [],
      },
    });
  if (c.req.path.includes("/journal/cursor"))
    return c.json({ ok: true, cursor: { seq: 0, updated_at: null } });
  return c.json({
    ok: true,
    entities: [],
    participant: c.get("participantId"),
  });
});
app.route("/projects/:projectId", project);
const env = {
  DB: f.db,
  PROJECT: { idFromName: () => "p", get: () => ({}) },
  ANALYTICS: { writeDataPoint() {} },
} as unknown as Env;
let origin: string;
const server = createServer(async (req, res) => {
  try {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    const response = await app.request(
      `${origin}${req.url}`,
      {
        method: req.method,
        headers: req.headers as HeadersInit,
        ...(body.length ? { body } : {}),
      },
      env,
      {
        waitUntil() {},
        passThroughOnException() {},
      } as unknown as ExecutionContext,
    );
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch {
    res.writeHead(500);
    res.end();
  }
});
beforeAll(async () => {
  await f.legacy.issue({
    projectId: "p",
    tokenHash: await hashToken("tila_test_owner", undefined),
    name: "owner",
    createdAt: 0,
    createdBy: "fixture",
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("No fixture address");
  origin = `http://127.0.0.1:${address.port}`;
});
afterAll(async () => {
  await new Promise<void>((done) => server.close(() => done()));
  f.sqlite.close();
  rmSync(home, { recursive: true, force: true });
});
async function cli(args: string[], input?: string) {
  const child = spawn(
    "bun",
    [
      entry,
      "--instance",
      origin,
      "--project",
      "p",
      "--non-interactive",
      ...args,
    ],
    {
      cwd: home,
      env: {
        ...process.env,
        HOME: home,
        TILA_HOME: home,
        CI: "1",
        CODEX_THREAD_ID: "",
        TILA_LIFECYCLE_KEY: "",
        TILA_RUN_SOCKET: "",
        TILA_RUN_CAPABILITY: "",
        TILA_API_TOKEN: "",
        TILA_TOKEN: "",
        NO_COLOR: "1",
      },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  const timeout = setTimeout(() => child.kill("SIGKILL"), 20_000);
  child.stdout.on("data", (chunk) => stdout.push(chunk));
  child.stderr.on("data", (chunk) => stderr.push(chunk));
  child.stdin.end(input);
  const status = await new Promise<number | null>((done, reject) => {
    child.once("exit", done);
    child.once("error", reject);
  });
  clearTimeout(timeout);
  return {
    status,
    stdout: Buffer.concat(stdout).toString(),
    stderr: Buffer.concat(stderr).toString(),
  };
}
it("enrolls unattended without an owner credential and executes two separate managed runs", async () => {
  const authorize = await cli([
    "--token",
    "tila_test_owner",
    "machine",
    "authorize",
    "--name",
    "Runner",
    "--json",
  ]);
  expect(authorize.status, authorize.stderr + authorize.stdout).toBe(0);
  const body = JSON.parse(authorize.stdout);
  const invitation = body.result?.invitation ?? body.invitation;
  expect(typeof invitation).toBe("string");
  const enroll = await cli(
    [
      "machine",
      "enroll",
      "--invitation-stdin",
      "--file-store",
      join(home, "secrets"),
      "--json",
    ],
    invitation,
  );
  expect(enroll.status, enroll.stderr + enroll.stdout).toBe(0);
  expect(enroll.stdout).not.toContain(invitation);
  const participants: string[] = [];
  for (let i = 0; i < 2; i++) {
    const result = await cli([
      "run",
      "exec",
      "--",
      "bun",
      "-e",
      "console.log(JSON.stringify({participant: process.env.TILA_PARTICIPANT_ID, broker: !!process.env.TILA_RUN_SOCKET, owner: !!process.env.TILA_API_TOKEN, enrollment: !!process.env.TILA_ENROLLMENT_TOKEN}))",
    ]);
    expect(result.status, result.stderr + result.stdout).toBe(0);
    const child = JSON.parse(result.stdout);
    expect(child).toMatchObject({
      broker: true,
      owner: false,
      enrollment: false,
    });
    participants.push(child.participant);
  }
  expect(new Set(participants).size).toBe(2);
  expect(
    f.sqlite
      .prepare("SELECT COUNT(*) n FROM _runtime_runs WHERE state='closed'")
      .get(),
  ).toEqual({ n: 2 });
  expect(
    f.sqlite.prepare("SELECT COUNT(*) n FROM _service_accounts").get(),
  ).toEqual({ n: 1 });
}, 30_000);
