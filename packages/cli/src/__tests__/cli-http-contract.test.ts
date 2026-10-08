import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import {
  type IncomingMessage,
  type ServerResponse,
  createServer,
} from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";

const home = mkdtempSync(join(tmpdir(), "tila-http-contract-"));
const entry = resolve(import.meta.dirname, "../index.ts");
let respond: (req: IncomingMessage, res: ServerResponse) => void;
const requests: { url: string; participant: string | undefined }[] = [];
const server = createServer((req, res) => {
  requests.push({
    url: req.url ?? "",
    participant: req.headers["x-tila-participant-id"] as string | undefined,
  });
  respond(req, res);
});
const json = (res: ServerResponse, value: unknown, status = 200) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(value));
};
beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Missing test server");
  mkdirSync(join(home, ".tila"));
  writeFileSync(
    join(home, ".tila/config.toml"),
    `project_id = "test"\nworker_url = "http://127.0.0.1:${address.port}"\nschema_version = 1\ntila_version = "0.2.7"\ncreated_at = "2026-10-07T00:00:00Z"\n`,
  );
});
beforeEach(() => {
  requests.length = 0;
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(home, { recursive: true, force: true });
});
async function invoke(args: string[]) {
  const child = spawn(
    "bun",
    [
      entry,
      "--token",
      "fixture-token",
      "--participant-id",
      "explicit-session",
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
        TILA_TOKEN: "",
        TILA_API_TOKEN: "",
        NO_COLOR: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout.on("data", (data) => stdout.push(data));
  child.stderr.on("data", (data) => stderr.push(data));
  const status = await new Promise<number | null>((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", resolve);
  });
  return {
    status,
    stdout: Buffer.concat(stdout),
    stderr: Buffer.concat(stderr).toString(),
  };
}
it("forwards task pagination and participant override, normalizes empty results", async () => {
  respond = (_req, res) =>
    json(res, {
      ok: true,
      entities: [],
      total: 0,
      limit: 2,
      offset: 3,
      has_more: false,
    });
  const result = await invoke([
    "--json",
    "task",
    "list",
    "--limit",
    "2",
    "--offset",
    "3",
  ]);
  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout.toString())).toMatchObject({
    ok: true,
    result: { items: [] },
    meta: { count: 0, limit: 2, offset: 3 },
  });
  expect(requests[0].url).toContain("limit=2");
  expect(requests[0].url).toContain("offset=3");
  expect(requests[0].participant).toBe("explicit-session");
});
it("preserves revision pagination and reviewer identity", async () => {
  respond = (_req, res) =>
    json(res, {
      ok: true,
      items: [
        {
          artifact_key: "file",
          review_revision: 7,
          principal_id: "reviewer",
          participant_id: "review-session",
          created_at: 1,
          decision: "rejected",
          reason: "unsafe",
        },
      ],
      next_revision: 7,
    });
  const result = await invoke([
    "artifact",
    "reviews",
    "file",
    "--before-revision",
    "8",
    "--limit",
    "1",
    "--json",
  ]);
  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout.toString())).toMatchObject({
    result: { items: [{ decision: "rejected", principal_id: "reviewer" }] },
    meta: { limit: 1, next_revision: 7, truncated: true },
  });
  expect(requests[0].url).toContain("before_revision=8");
});
it("keeps raw bytes unchanged and retains trust metadata in JSON and stderr", async () => {
  const bytes = Buffer.from([0, 27, 255, 10, 65]);
  const provenance = {
    principal_id: "uploader",
    participant_id: "upload-session",
    created_at: 1,
    client_name: "cli",
    client_version: null,
    environment: {},
  };
  const pointer = {
    r2_key: "file",
    resource: null,
    kind: "test",
    sha256: createHash("sha256").update(bytes).digest("hex"),
    bytes: 5,
    fence: null,
    mime_type: "application/octet-stream",
    produced_at: 1,
    produced_by: "uploader",
    expires_at: null,
    tags: [],
    lineage_id: null,
    revision: null,
    restored_from: null,
    provenance,
    revision_creation: provenance,
    review: { state: "rejected", review_revision: 1, latest: null },
  };
  respond = (req, res) =>
    req.url?.endsWith("/meta")
      ? json(res, { ok: true, pointer })
      : res.end(bytes);
  const raw = await invoke(["artifact", "get", "file"]);
  expect(raw.status, raw.stderr).toBe(0);
  expect(raw.stdout).toEqual(bytes);
  expect(JSON.parse(raw.stderr.split("\n")[0]).artifact_metadata).toMatchObject(
    {
      provenance,
      revision_creation: provenance,
      review: { state: "rejected" },
    },
  );
  requests.length = 0;
  const destination = join(home, "download.bin");
  const structured = await invoke([
    "--json",
    "artifact",
    "get",
    "file",
    "--output",
    destination,
  ]);
  expect(structured.status, structured.stderr).toBe(0);
  expect(readFileSync(destination)).toEqual(bytes);
  expect(JSON.parse(structured.stdout.toString()).result.pointer).toMatchObject(
    { provenance, review: { state: "rejected" } },
  );
  expect(requests.filter((req) => req.url.endsWith("/meta"))).toHaveLength(1);
});
it.each(["stale-fence", "internal"])(
  "reports %s failures on stderr with conservative retryability",
  async (kind) => {
    respond = (_req, res) =>
      json(
        res,
        {
          ok: false,
          error: {
            code: kind,
            message: "backend fixture failure",
            retryable: true,
          },
        },
        kind === "internal" ? 500 : 409,
      );
    const result = await invoke(["task", "list", "--json"]);
    expect(result.status).toBe(kind === "internal" ? 2 : 1);
    expect(result.stdout.length).toBe(0);
    expect(JSON.parse(result.stderr)).toMatchObject({
      ok: false,
      error: { kind, retryable: kind === "internal" },
    });
  },
);
it("keeps lifecycle administration normalized and an obsolete worker silent", async () => {
  const status = await invoke(["--json", "lifecycle", "status"]);
  expect(status.status, status.stderr).toBe(0);
  expect(JSON.parse(status.stdout.toString())).toMatchObject({
    ok: true,
    result: { items: [] },
  });
  const worker = await invoke([
    "--json",
    "lifecycle",
    "worker",
    "a".repeat(64),
    "old-generation",
  ]);
  expect(worker.status, worker.stderr).toBe(0);
  expect(worker.stdout.length).toBe(0);
  expect(worker.stderr).toBe("");
  expect(requests).toHaveLength(0);
});
it.each(["--data", "--json"])(
  "separates patch input %s from global JSON output",
  async (inputFlag) => {
    respond = (_req, res) =>
      json(res, {
        ok: true,
        fence: 2,
        revision: 2,
        record: {
          type: "service",
          key: "api",
          schema_version: 1,
          value: { owner: "infra" },
          value_sha256: "hash",
          revision: 2,
          archived: 0,
          created_at: 1,
          updated_at: 2,
          updated_by: "user",
          tags: [],
          fence: 2,
        },
      });
    const result = await invoke([
      "--json",
      "record",
      "patch",
      "service",
      "api",
      inputFlag,
      '{"owner":"infra"}',
      "--fence",
      "1",
    ]);
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout.toString())).toMatchObject({ ok: true });
    expect(requests.length).toBeGreaterThan(0);
  },
);

it("never marks a failed mutation automatically retryable", async () => {
  respond = (_req, res) =>
    json(
      res,
      {
        ok: false,
        error: { code: "internal", message: "backend failed", retryable: true },
      },
      500,
    );
  const result = await invoke([
    "artifact",
    "review",
    "file",
    "--decision",
    "trusted",
    "--expected-review-revision",
    "0",
    "--json",
  ]);
  expect(result.status).toBe(2);
  expect(result.stdout.length).toBe(0);
  expect(JSON.parse(result.stderr).error).toMatchObject({
    kind: "internal",
    retryable: false,
  });
});
it("reports a created task when the following parent-link write fails", async () => {
  respond = (req, res) =>
    req.url?.endsWith("/relationships")
      ? json(
          res,
          {
            ok: false,
            error: {
              code: "internal",
              message: "link failed",
              retryable: true,
            },
          },
          500,
        )
      : json(res, {
          ok: true,
          entity: {
            id: "T-created",
            type: "task",
            schema_version: 1,
            data: { title: "Created" },
            archived: 0,
            created_at: 1,
            updated_at: 1,
            created_by: "cli",
            tags: [],
          },
        });
  const result = await invoke([
    "--json",
    "task",
    "new",
    "Created",
    "--id",
    "T-created",
    "--parent",
    "T-parent",
    "--link-parent",
  ]);
  expect(result.status).toBe(1);
  expect(result.stdout.length).toBe(0);
  expect(JSON.parse(result.stderr), result.stderr).toMatchObject({
    ok: false,
    error: {
      retryable: false,
      details: {
        partial_result: { id: "T-created", parent: "T-parent", linked: false },
      },
    },
  });
  expect(requests).toHaveLength(2);
});

it("reports invalid review inputs with their field name before sending a request", async () => {
  const result = await invoke([
    "artifact",
    "review",
    "file",
    "--decision",
    "invalid",
    "--expected-review-revision",
    "0",
    "--json",
  ]);
  expect(result.status).toBe(1);
  expect(JSON.parse(result.stderr)).toMatchObject({
    ok: false,
    error: {
      kind: "invalid-argument",
      message: expect.stringContaining("decision"),
      hint: expect.any(String),
    },
  });
  expect(result.stdout.length).toBe(0);
  expect(requests).toHaveLength(0);
});
