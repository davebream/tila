import { createHash } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { projectTransferOps, schema } from "@tila/ops-sqlite";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  exportProjectBackup,
  importProjectBackup,
  inspectProjectBackup,
} from "../../sdk/src/backup";
import {
  type RouterDeps,
  createProjectRouter,
} from "../../worker/src/do/project-do-router";
import { createBackupRoutes } from "../../worker/src/routes/backup";
import type { Env, HonoVariables } from "../../worker/src/types";
import { createCredentialFixture } from "../../worker/test/d1/helpers/credential-fixture";
import { createTestDb } from "../../worker/test/do/helpers/create-test-db";

// Hold the actual archive verification stream without replacing its parser or
// checksum checks. Other reads (including migrations) use the real filesystem.
const verification = vi.hoisted(() => ({
  hold: undefined as (() => Promise<void>) | undefined,
  cancelled: false,
}));
vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs")>();
  const { Readable } = await import("node:stream");
  return {
    ...fs,
    createReadStream: (...args: Parameters<typeof fs.createReadStream>) => {
      const hold = verification.hold;
      if (!hold) return fs.createReadStream(...args);
      verification.hold = undefined;
      const bytes = fs.readFileSync(args[0]);
      let started = false;
      return new Readable({
        read() {
          if (started) return;
          started = true;
          void hold().then(() => {
            if (!this.destroyed) {
              this.push(bytes);
              this.push(null);
            }
          });
        },
        destroy(error, callback) {
          verification.cancelled = error !== null;
          callback(error);
        },
      });
    },
  };
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function untilAborted(promise: Promise<void>, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    void promise.then(resolve, reject).finally(() => {
      signal.removeEventListener("abort", abort);
    });
  });
}

const artifact = Buffer.from(
  "artifact streamed across multiple lease renewals\n",
);
const sha = createHash("sha256").update(artifact).digest("hex");
const artifactKey = `produced/export-lease/${sha}.bin`;
const journalKey = "journal-archive/p/1-1.jsonl";
const journal = Buffer.from('{"seq":1,"kind":"entity.created"}\n');
const source = {
  backend: "cloud" as const,
  projectId: "p",
  baseUrl: "https://export.test",
  token: "owner-token",
  participantId: "export-participant" as string | undefined,
};
type Phase = "metadata" | "journal" | "blob" | "verification";
type Call = { path: string; headers: Headers; sessionId?: string };
let root: string;
let db: ReturnType<typeof createTestDb>;
let d1: ReturnType<typeof createCredentialFixture>;
let sql: projectTransferOps.ProjectSqlStorage;
let output: string;
let calls: Call[];
let phase: Phase | undefined;
let reached: ReturnType<typeof deferred>;
let release: ReturnType<typeof deferred>;
let renewReached: ReturnType<typeof deferred>;
let renewRelease: ReturnType<typeof deferred>;
let cleanupReached: ReturnType<typeof deferred>;
let renewal:
  | "reject"
  | "transport"
  | "timeout"
  | "timeout-body"
  | "slow"
  | "replace"
  | undefined;
let cleanup: "reject" | "timeout" | undefined;
let badMetadata: boolean;
let badBlob: boolean;
let bodyAborted: boolean;
let stopAfterPromotion: boolean;
let promotedSession: string | undefined;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "tila-export-lease-"));
  output = join(root, "project.tila-backup");
  db = createTestDb({ foreignKeys: "on" });
  d1 = createCredentialFixture();
  calls = [];
  phase = undefined;
  renewal = undefined;
  cleanup = undefined;
  badMetadata = false;
  badBlob = false;
  bodyAborted = false;
  stopAfterPromotion = false;
  promotedSession = undefined;
  reached = deferred();
  release = deferred();
  renewReached = deferred();
  renewRelease = deferred();
  cleanupReached = deferred();
  verification.hold = undefined;
  verification.cancelled = false;
  db.db
    .insert(schema.artifactPointers)
    .values({
      r2_key: artifactKey,
      resource: null,
      kind: "binary",
      sha256: sha,
      bytes: artifact.length,
      mime_type: "application/octet-stream",
      produced_at: 1,
      produced_by: "fixture",
    })
    .run();
  db.sqlite.exec(
    "INSERT OR REPLACE INTO _journal_archive_watermark (id, last_archived_seq, archived_at) VALUES (1, 1, 1)",
  );
  sql = {
    exec(statement: string, ...bindings: unknown[]) {
      const query = db.sqlite.prepare(statement);
      const rows = query.reader
        ? (query.all(...bindings) as Record<string, unknown>[])
        : [];
      if (!query.reader) query.run(...bindings);
      return { toArray: () => rows };
    },
  };
  const doApp = createProjectRouter({
    db: db.db as RouterDeps["db"],
    ctx: {
      storage: {
        sql,
        transactionSync: (fn: () => unknown) => db.sqlite.transaction(fn)(),
      },
    } as unknown as DurableObjectState,
    enrichOpts: () => ({}),
  } as RouterDeps);
  const objects = new Map([
    [artifactKey, artifact],
    [journalKey, journal],
  ]);
  const bucket = {
    head: async (key: string) => ({
      size: (objects.get(key)?.length ?? 0) + (badMetadata ? 1 : 0),
      httpMetadata: { contentType: "application/octet-stream" },
      customMetadata: { fixture: "export-lease" },
    }),
    get: async (key: string) => ({
      body: new Response(
        new Uint8Array(
          badBlob && key === artifactKey
            ? Buffer.alloc(artifact.length)
            : (objects.get(key) ?? []),
        ),
      ).body,
      httpEtag: "fixture",
      customMetadata: {},
      writeHttpMetadata: () => {},
    }),
    list: async () => ({
      objects: [{ key: journalKey, size: journal.length, customMetadata: {} }],
      truncated: false,
    }),
  };
  const app = new Hono<{ Bindings: Env; Variables: HonoVariables }>();
  app.use("*", async (c, next) => {
    c.set("projectId", "p");
    c.set("tokenResult", {
      kind: "d1-token",
      scopes: "full",
      tokenId: "fixture-owner",
    } as HonoVariables["tokenResult"]);
    c.set("doStub", {
      fetch: (req: Request) => doApp.fetch(req),
    } as DurableObjectStub);
    await next();
  });
  app.route(
    "/projects/p/admin/backup",
    createBackupRoutes({ projectTokenAuth: true }),
  );
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const path = url.pathname;
    const body =
      request.method === "POST"
        ? ((await request.clone().json()) as { sessionId?: string })
        : undefined;
    calls.push({
      path,
      headers: request.headers,
      sessionId:
        body?.sessionId ?? url.searchParams.get("sessionId") ?? undefined,
    });
    if (path.endsWith("/transfer/renew") && renewal) {
      renewReached.resolve();
      if (renewal === "reject")
        return new Response("renewal refused", { status: 503 });
      if (renewal === "transport") throw new Error("renewal network failure");
      if (renewal === "timeout-body") {
        return new Response(
          new ReadableStream({
            start(controller) {
              request.signal.addEventListener(
                "abort",
                () => {
                  controller.error(
                    new DOMException("Body aborted", "AbortError"),
                  );
                },
                { once: true },
              );
            },
          }),
        );
      }
      if (renewal === "timeout" || renewal === "slow")
        await untilAborted(renewRelease.promise, request.signal);
      if (renewal === "replace") {
        projectTransferOps.finishTransfer(sql, body?.sessionId ?? "");
        projectTransferOps.beginTransfer(sql, {
          sessionId: "replacement",
          mode: "export",
          owner: "token:fixture-owner",
          ttlMs: 300_000,
        });
      }
    }
    if (path.endsWith("/transfer/complete-export")) {
      cleanupReached.resolve();
      expect(request.signal.aborted).toBe(false);
      if (cleanup === "reject")
        return new Response("cleanup refused", { status: 503 });
      if (cleanup === "timeout")
        await untilAborted(new Promise(() => {}), request.signal);
      expect(existsSync(output)).toBe(false);
    }
    if (phase === "metadata" && path.endsWith("/object-metadata")) {
      reached.resolve();
      await untilAborted(release.promise, request.signal);
    }
    if (stopAfterPromotion && path.endsWith("/transfer/promote")) {
      expect(projectTransferOps.getTransferState(sql)).toMatchObject({
        mode: "export",
        session_id: body?.sessionId,
      });
      promotedSession = body?.sessionId;
    }
    if (
      stopAfterPromotion &&
      request.method === "PUT" &&
      path.endsWith("/object")
    )
      return new Response("stop after promotion", { status: 503 });
    const response = await app.fetch(request, {
      DB: d1.db,
      ARTIFACTS: bucket,
    } as unknown as Env);
    const key = url.searchParams.get("key");
    if (
      path.endsWith("/object") &&
      ((phase === "journal" && key === journalKey) ||
        (phase === "blob" && key === artifactKey))
    ) {
      phase = undefined;
      const bytes = new Uint8Array(await response.arrayBuffer());
      return new Response(
        new ReadableStream({
          async start(controller) {
            controller.enqueue(bytes.subarray(0, 1));
            reached.resolve();
            try {
              await untilAborted(release.promise, request.signal);
              controller.enqueue(bytes.subarray(1));
              controller.close();
            } catch (error) {
              bodyAborted = true;
              controller.error(error);
            }
          },
        }),
      );
    }
    return response;
  });
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  vi.setSystemTime(new Date("2026-10-17T12:00:00Z"));
});

afterEach(async () => {
  release.resolve();
  renewRelease.resolve();
  verification.hold = undefined;
  vi.useRealTimers();
  vi.restoreAllMocks();
  db.sqlite.close();
  d1.sqlite.close();
  await rm(root, { recursive: true, force: true });
});

function startExport(overrides: { participantId?: string } = {}) {
  if (phase === "verification") {
    verification.hold = async () => {
      reached.resolve();
      await release.promise;
    };
  }
  const result = exportProjectBackup({
    source: { ...source, ...overrides },
    output,
  });
  void result.catch(() => {});
  return result;
}

function assertUnlocked() {
  expect(projectTransferOps.getTransferState(sql)).toBeNull();
  db.db
    .insert(schema.entities)
    .values({
      id: "after-export",
      type: "task",
      schema_version: 1,
      data: "{}",
      created_at: Date.now(),
      updated_at: Date.now(),
      created_by: "fixture",
    })
    .run();
  expect(db.db.select().from(schema.entities).all()).toHaveLength(1);
}

function assertNoOutput() {
  expect(readdirSync(root)).toEqual([]);
  expect(vi.getTimerCount()).toBe(0);
}

describe("cloud export lease", () => {
  it.each<Phase>(["metadata", "journal", "blob", "verification"])(
    "renews during a %s phase longer than the original TTL",
    async (heldPhase) => {
      phase = heldPhase;
      const result = startExport();
      await Promise.race([reached.promise, result]);
      await vi.advanceTimersByTimeAsync(360_000);
      expect(
        calls.filter(({ path }) => path.endsWith("/transfer/renew")),
      ).toHaveLength(6);
      expect(
        projectTransferOps.getTransferState(sql)?.expires_at,
      ).toBeGreaterThan(Date.now());
      release.resolve();
      const manifest = await result;
      const inspected = await inspectProjectBackup(output);
      expect(inspected.manifest.content_root).toBe(manifest.content_root);
      expect(inspected.manifest.stats).toMatchObject({
        objects: 2,
        blob_bytes: artifact.length + journal.length,
      });
      expect(inspected.manifest.entries).toContainEqual({
        path: `blobs/${sha}`,
        bytes: artifact.length,
        sha256: sha,
      });
      expect(inspected.manifest.journal_archive_watermark).toBe(1);
      assertUnlocked();
      const sessions = new Set(calls.map(({ sessionId }) => sessionId));
      expect(sessions.size).toBe(1);
      for (const { headers } of calls) {
        expect(headers.get("Authorization")).toBe("Bearer owner-token");
        expect(headers.get("X-Tila-Participant-Id")).toBe("export-participant");
      }
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("keeps its generated participant across renewals and cleanup", async () => {
    phase = "metadata";
    const result = startExport({ participantId: undefined });
    await Promise.race([reached.promise, result]);
    await vi.advanceTimersByTimeAsync(60_000);
    release.resolve();
    await result;
    const participants = new Set(
      calls.map(({ headers }) => headers.get("X-Tila-Participant-Id")),
    );
    expect(participants.size).toBe(1);
    expect([...participants][0]).toBeTruthy();
    assertUnlocked();
  });

  it.each(["reject", "transport", "timeout", "timeout-body"] as const)(
    "cancels an active blob after a renewal %s",
    async (failure) => {
      phase = "blob";
      renewal = failure;
      const result = startExport();
      const rejected = expect(result).rejects.toThrow(
        failure === "reject"
          ? "renewal refused"
          : failure === "transport"
            ? "renewal network failure"
            : "Backup transfer request timed out",
      );
      await Promise.race([reached.promise, result]);
      await vi.advanceTimersByTimeAsync(
        failure.startsWith("timeout") ? 90_000 : 60_000,
      );
      await rejected;
      expect(bodyAborted).toBe(true);
      expect(calls.at(-1)?.path).toMatch(/\/transfer\/complete-export$/);
      assertUnlocked();
      assertNoOutput();
    },
  );

  it.each<Phase>(["metadata", "journal", "verification"])(
    "cancels a pending %s operation after renewal failure",
    async (heldPhase) => {
      phase = heldPhase;
      renewal = "reject";
      const result = startExport();
      const rejected = expect(result).rejects.toThrow("renewal refused");
      await Promise.race([reached.promise, result]);
      await vi.advanceTimersByTimeAsync(60_000);
      await rejected;
      if (heldPhase === "journal") expect(bodyAborted).toBe(true);
      if (heldPhase === "verification")
        expect(verification.cancelled).toBe(true);
      assertUnlocked();
      assertNoOutput();
    },
  );

  it("waits for an in-flight renewal before releasing the lease", async () => {
    phase = "metadata";
    renewal = "slow";
    const verifying = deferred();
    verification.hold = async () => verifying.resolve();
    const result = startExport();
    await Promise.race([reached.promise, result]);
    await vi.advanceTimersByTimeAsync(60_000);
    await renewReached.promise;
    release.resolve();
    await Promise.race([verifying.promise, result]);
    expect(
      calls.some(({ path }) => path.endsWith("/transfer/complete-export")),
    ).toBe(false);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(
      calls.filter(({ path }) => path.endsWith("/transfer/renew")),
    ).toHaveLength(1);
    renewRelease.resolve();
    await result;
    assertUnlocked();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not release a lease when acquisition fails", async () => {
    projectTransferOps.beginTransfer(sql, {
      sessionId: "existing",
      mode: "export",
      owner: "token:fixture-owner",
    });
    await expect(startExport()).rejects.toThrow("409");
    expect(calls).toHaveLength(1);
    expect(projectTransferOps.getTransferState(sql)?.session_id).toBe(
      "existing",
    );
    assertNoOutput();
  });

  it("preserves a replacement session when renewal and cleanup conflict", async () => {
    phase = "blob";
    renewal = "replace";
    const result = startExport();
    const rejected = expect(result).rejects.toThrow("409");
    await Promise.race([reached.promise, result]);
    await vi.advanceTimersByTimeAsync(60_000);
    await rejected;
    expect(projectTransferOps.getTransferState(sql)?.session_id).toBe(
      "replacement",
    );
    assertNoOutput();
  });

  it.each(["reject", "timeout"] as const)(
    "preserves the export error when cleanup has a %s",
    async (failure) => {
      badMetadata = true;
      cleanup = failure;
      const result = startExport();
      const rejected = expect(result).rejects.toThrow(
        "Blob byte count mismatch",
      );
      await cleanupReached.promise;
      if (failure === "timeout") await vi.advanceTimersByTimeAsync(30_000);
      await rejected;
      assertNoOutput();
      expect(projectTransferOps.getTransferState(sql)?.mode).toBe("export");
      await vi.advanceTimersByTimeAsync(300_000);
      expect(projectTransferOps.getTransferState(sql)).toBeNull();
    },
  );

  it("releases its lease after an ordinary metadata error", async () => {
    badMetadata = true;
    await expect(startExport()).rejects.toThrow("Blob byte count mismatch");
    assertUnlocked();
    assertNoOutput();
  });

  it("releases its lease after a blob checksum error", async () => {
    badBlob = true;
    await expect(startExport()).rejects.toThrow("Blob checksum mismatch");
    assertUnlocked();
    assertNoOutput();
  });

  it("does not publish a verified archive if unlock fails", async () => {
    cleanup = "reject";
    await expect(startExport()).rejects.toThrow("cleanup refused");
    assertNoOutput();
  });

  it("refreshes a safety export and retains its session for promotion", async () => {
    await startExport();
    const archive = output;
    output = join(root, "not-published.tila-backup");
    calls = [];
    phase = "blob";
    stopAfterPromotion = true;
    const result = importProjectBackup({
      archive,
      destination: source,
      replace: true,
    });
    const rejected = expect(result).rejects.toThrow("stop after promotion");
    await Promise.race([reached.promise, result]);
    await vi.advanceTimersByTimeAsync(360_000);
    release.resolve();
    await rejected;
    expect(projectTransferOps.getTransferState(sql)).toMatchObject({
      mode: "import",
      session_id: promotedSession,
      expires_at: null,
    });
    expect(
      calls.some(({ path }) => path.endsWith("/transfer/complete-export")),
    ).toBe(false);
    const promotion = calls.findIndex(({ path }) =>
      path.endsWith("/transfer/promote"),
    );
    expect(calls[promotion - 1]?.path).toMatch(/\/transfer\/renew$/);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("releases a failed safety export without promoting its lease", async () => {
    await startExport();
    const archive = output;
    output = join(root, "not-published.tila-backup");
    calls = [];
    badBlob = true;
    await expect(
      importProjectBackup({ archive, destination: source, replace: true }),
    ).rejects.toThrow("Blob checksum mismatch");
    expect(calls.at(-1)?.path).toMatch(/\/transfer\/complete-export$/);
    expect(calls.some(({ path }) => path.endsWith("/transfer/promote"))).toBe(
      false,
    );
    expect(readdirSync(root)).toEqual(["project.tila-backup"]);
    assertUnlocked();
    expect(vi.getTimerCount()).toBe(0);
  });
});
