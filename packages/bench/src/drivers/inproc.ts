/**
 * In-process tier: the real Worker route modules mounted on a Hono app that
 * talks to the real DO router over an in-memory SQLite database. One
 * `TilaClient` per participant routes through the app via the SDK's custom
 * `fetch` option, so scenarios use the same facade as the http tier.
 *
 * What this tier skips, deliberately: authentication, D1 lookups, the
 * idempotency and cache middleware, the transfer-status pre-flight DO call,
 * Analytics Engine, and the network. It measures Worker-route + DO-router +
 * SQLite cost only. Identity is derived from the bearer token string
 * (`token:<bearer>`) and the `X-Tila-Participant-Id` header, exactly as the
 * production request-identity middleware would resolve a D1 token.
 */
import { Hono } from "hono";
import { TilaClient } from "tila-sdk";
import { createProjectRouter } from "../../../backend-do/src/project-do-router";
import type { RouterDeps } from "../../../backend-do/src/routes/types";
import {
  type TestDb,
  createTestDb,
} from "../../../backend-do/test/helpers/create-test-db";
import { errorHandler } from "../../../worker/src/middleware/error";
import { artifacts } from "../../../worker/src/routes/artifacts";
import { claims } from "../../../worker/src/routes/claims";
import { continuity } from "../../../worker/src/routes/continuity";
import { entities } from "../../../worker/src/routes/entities";
import { journal } from "../../../worker/src/routes/journal";
import { presence } from "../../../worker/src/routes/presence";
import { records } from "../../../worker/src/routes/records";
import { signals } from "../../../worker/src/routes/signals";
import { summary } from "../../../worker/src/routes/summary";
import type { Env, HonoVariables } from "../../../worker/src/types";
import { HARNESS_VERSION } from "../result-schema";
import type { Driver, Participant } from "../types";
import { facadeFromClient } from "./facade";
import { createMemoryR2 } from "./r2-mock";
import { sampleSqlite, sweepSqlite } from "./sqlite-sampling";

const PROJECT_ID = "bench";
const ORIGIN = "http://inproc";

type AppEnv = { Bindings: Env; Variables: HonoVariables };

export interface InprocDriverOptions {
  runId: string;
}

export function createInprocDriver(opts: InprocDriverOptions): Driver {
  const testDb: TestDb = createTestDb();
  const r2 = createMemoryR2();
  const deps: RouterDeps = {
    db: testDb.db as RouterDeps["db"],
    ctx: {
      storage: {
        sql: {
          exec: (s: string, ...bindings: unknown[]) => ({
            toArray: () => testDb.sqlite.prepare(s).all(...bindings),
          }),
        },
        getAlarm: async () => null,
        setAlarm: async () => {},
      },
    } as unknown as DurableObjectState,
    enrichOpts: () => undefined as never,
    artifacts: r2.bucket,
  };
  const doApp = createProjectRouter(deps);
  const doStub = {
    fetch: (request: Request) => doApp.fetch(request),
  } as unknown as DurableObjectStub;

  const env = {
    ARTIFACTS: r2.bucket,
    ANALYTICS: { writeDataPoint: () => {} },
  } as unknown as Env;
  const executionCtx = {
    waitUntil: () => {},
    passThroughOnException: () => {},
  } as unknown as ExecutionContext;

  const app = new Hono<AppEnv>();
  app.onError(errorHandler);
  app.get("/api/whoami", (c) => {
    const bearer = bearerOf(c.req.header("Authorization"));
    return c.json({ ok: true, principal_id: `token:${bearer}` });
  });
  const project = new Hono<AppEnv>();
  project.use("*", async (c, next) => {
    const bearer = bearerOf(c.req.header("Authorization"));
    const participantId = c.req.header("X-Tila-Participant-Id");
    if (!participantId)
      return c.json(
        {
          ok: false,
          error: {
            code: "participant-required",
            message: "X-Tila-Participant-Id is required",
            retryable: false,
          },
        },
        400,
      );
    c.set("tokenResult", {
      kind: "d1-token",
      projectId: PROJECT_ID,
      name: bearer,
      scopes: "full",
      tokenId: bearer,
    });
    c.set("projectId", PROJECT_ID);
    c.set("principalId", `token:${bearer}`);
    c.set("participantId", participantId);
    c.set("environment", { client_name: "tila-bench" });
    c.set("doStub", doStub);
    await next();
  });
  project.route("/tasks", entities);
  project.route("/claims", claims);
  project.route("/artifacts", artifacts);
  project.route("/", continuity);
  project.route("/journal", journal);
  project.route("/presence", presence);
  project.route("/signals", signals);
  project.route("/summary", summary);
  project.route("/records", records);
  app.route("/projects/:projectId", project);

  const inprocFetch: typeof globalThis.fetch = async (input, init) =>
    app.request(
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input,
      init as RequestInit,
      env,
      executionCtx,
    );

  const participants: Participant[] = [];

  return {
    tier: "inproc",
    describe: () => ({
      deployed: false,
      notes: [
        "Worker route modules + DO router over in-memory better-sqlite3.",
        "No auth, D1, idempotency, cache, transfer-status pre-flight, analytics, or network.",
      ],
    }),
    async participants(n, principals) {
      for (let i = 0; i < n; i++) {
        const bearer = principals > 1 ? `bench-${i % principals}` : "bench";
        const participantId = `bench-${opts.runId}-p${i}`;
        const client = new TilaClient({
          baseUrl: ORIGIN,
          token: bearer,
          participantId,
          environment: {
            client_name: "tila-bench",
            client_version: HARNESS_VERSION,
          },
          timeoutMs: 120_000,
          fetch: inprocFetch,
        });
        participants.push({
          index: i,
          participantId,
          projectId: PROJECT_ID,
          principalId: `token:${bearer}`,
          tila: facadeFromClient(client, PROJECT_ID),
          rawFetch: (path, init) =>
            inprocFetch(new URL(path, ORIGIN).toString(), {
              ...init,
              headers: {
                Authorization: `Bearer ${bearer}`,
                "X-Tila-Participant-Id": participantId,
                ...(init?.headers as Record<string, string> | undefined),
              },
            }),
        });
      }
      return participants;
    },
    async sampleStore() {
      return sampleSqlite(testDb.db as never, testDb.sqlite);
    },
    async sweep() {
      return sweepSqlite(testDb.db as never);
    },
    async cleanup() {
      testDb.sqlite.close();
    },
  };
}

function bearerOf(header: string | undefined): string {
  return header?.replace(/^Bearer\s+/i, "") || "bench";
}
