/**
 * Cross-runtime local-store interop — the capstone integration test.
 *
 * This file runs under STANDARD Vitest/Node (the integration-tests package uses
 * a plain `environment: "node"` vitest config — there is no `vitest-pool-workers`
 * here). From Node it spawns `bun` children via `node:child_process`'s
 * `spawnSync` so a single SQLite file is written by the BUN embedded path
 * (`@tila/backend-local` → `bun:sqlite`) and read by the NODE path
 * (`tila-sdk/local` → `better-sqlite3`), and vice-versa.
 *
 * Covered:
 *  1. Bun-write / Node-read / Node-write / Bun-read round-trips on ONE DB file.
 *  2. Schema identity across the two drivers: normalized `sqlite_master` DDL +
 *     identical `_migrations` rows (NOT `user_version`, which both leave at 0).
 *  3. SDK-local-only round-trip (task / claim+fence / record / artifact / journal).
 *  4. MCP-local round-trip: the BUILT `dist/index.js` under plain `node`, driven
 *     over stdio JSON-RPC.
 *  5. Concurrent-writer: two `better-sqlite3` handles contend on one file; the
 *     injected `sleepSync` (the `withBusyRetry` second-layer retry) is PROVEN to
 *     fire, no `SQLITE_BUSY` escapes, and both writes land.
 *  6. Cross-runtime grep parity: a multi-chunk text artifact grepped from BOTH
 *     runtimes yields identical line matches.
 */

import { type SpawnSyncReturns, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  type EmbeddedDb,
  EmbeddedProject,
  type MigrationStorage,
  runEmbeddedMigrations,
} from "@tila/backend-embedded";
import { EMBEDDED_PRAGMAS } from "@tila/backend-embedded";
import { schema } from "@tila/ops-sqlite";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { createTilaLocal } from "tila-sdk/local";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = resolve(HERE, "..");
const BUN_FIXTURE = join(HERE, "fixtures", "bun-cross-runtime.ts");
const MCP_DIST = resolve(PKG_ROOT, "..", "mcp-server", "dist", "index.js");

const ORG = "x-org";
const PROJECT = "x-proj";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const tmpDirs: string[] = [];
function makeTmp(): string {
  const dir = mkdtempSync(join(tmpdir(), "tila-xrt-"));
  tmpDirs.push(dir);
  return dir;
}
afterEach(() => {
  while (tmpDirs.length > 0) {
    const dir = tmpDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

interface BunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  json: Record<string, unknown>;
}

/** Spawn the bun fixture for one OP and parse its single JSON output line. */
function runBun(op: string, env: Record<string, string>): BunResult {
  const res: SpawnSyncReturns<string> = spawnSync("bun", ["run", BUN_FIXTURE], {
    cwd: PKG_ROOT,
    env: { ...process.env, OP: op, ...env },
    encoding: "utf-8",
  });
  const stdout = (res.stdout ?? "").trim();
  const stderr = (res.stderr ?? "").trim();
  if (res.status !== 0) {
    throw new Error(
      `bun fixture OP=${op} failed (exit ${res.status}):\n${stderr || stdout}`,
    );
  }
  const lastLine = stdout.split("\n").filter(Boolean).at(-1) ?? "{}";
  return {
    exitCode: res.status ?? -1,
    stdout,
    stderr,
    json: JSON.parse(lastLine) as Record<string, unknown>,
  };
}

interface MasterRow {
  type: string;
  name: string;
  sql: string | null;
}

/**
 * Normalize a stored DDL `sql` string so cosmetic, driver-specific differences
 * (whitespace runs, newlines, and optional double-quoting of identifiers) do not
 * false-fail an otherwise identical schema. Collapses all whitespace to single
 * spaces, trims, and strips double quotes around bare identifiers.
 */
function normalizeDDL(sql: string | null): string {
  if (sql === null) return "";
  return sql.replace(/\s+/g, " ").replace(/"/g, "").trim();
}

/** Stable, normalized fingerprint of a sqlite_master dump for comparison. */
function fingerprint(master: MasterRow[]): string {
  return master
    .map((r) => `${r.type}\t${r.name}\t${normalizeDDL(r.sql)}`)
    .sort()
    .join("\n");
}

/** A better-sqlite3-backed MigrationStorage shim (mirrors the node connection). */
function nodeMigrationStorage(raw: Database.Database): MigrationStorage {
  return {
    sql: {
      exec<T>(statement: string, ...bindings: unknown[]) {
        const trimmed = statement.trim();
        if (/^(SELECT|PRAGMA)\b/i.test(trimmed)) {
          return {
            toArray: () => raw.prepare(statement).all(...bindings) as T[],
          };
        }
        if (bindings.length > 0) {
          raw.prepare(statement).run(...bindings);
        } else {
          raw.exec(statement);
        }
        return { toArray: () => [] as T[] };
      },
    },
  };
}

// ---------------------------------------------------------------------------
// 1 + 2. Bun-write / Node-read interop + schema identity
// ---------------------------------------------------------------------------

describe("cross-runtime local store interop (bun <-> node, one DB file)", () => {
  it("bun writes a task, node reads it, node writes a record, bun reads it back", async () => {
    const tmp = makeTmp();
    const dbPath = join(tmp, "state.db");
    const artifactsPath = join(tmp, "artifacts");

    // (a) BUN writes T-1
    const wrote = runBun("write-task", { DB: dbPath, ORG, PROJECT });
    expect(wrote.json.created).toBe("T-1");

    // (b) NODE opens the SAME file, reads T-1, then writes a record
    const node = await createTilaLocal({
      dbPath,
      artifactsPath,
      org: ORG,
      project: PROJECT,
      skipFilesystemCheck: true,
    });
    try {
      const task = await node.project.get("T-1");
      expect(task?.id).toBe("T-1");
      expect((task?.data as { title?: string })?.title).toBe("from bun");

      const rec = await node.project.createRecord({
        type: "note",
        key: "from-node",
        value: { body: "written under node" },
      });
      expect(rec.key).toBe("from-node");
    } finally {
      node.close();
    }

    // (c) BUN re-opens and sees the node-written record
    const readBack = runBun("read-record", {
      DB: dbPath,
      ORG,
      PROJECT,
      KEY: "from-node",
    });
    const record = readBack.json.record as {
      key: string;
      value: { body: string };
    } | null;
    expect(record?.key).toBe("from-node");
    expect(record?.value.body).toBe("written under node");
  });

  it("schema identity: normalized sqlite_master DDL + _migrations match across drivers", async () => {
    const tmp = makeTmp();
    const dbPath = join(tmp, "state.db");
    const artifactsPath = join(tmp, "artifacts");

    // Seed + migrate the file via the BUN path, then dump its schema from bun.
    const bunDump = runBun("dump-schema", { DB: dbPath, ORG, PROJECT });
    const bunMaster = bunDump.json.master as MasterRow[];
    const bunMigrations = bunDump.json.migrations as number[];

    // Open the SAME file via the NODE path; dump its schema from node.
    const node = await createTilaLocal({
      dbPath,
      artifactsPath,
      org: ORG,
      project: PROJECT,
      skipFilesystemCheck: true,
    });
    // Read sqlite_master + _migrations through a fresh better-sqlite3 handle on
    // the same file (the embedded backend exposes no raw query surface).
    const rawNode = new Database(dbPath);
    let nodeMaster: MasterRow[];
    let nodeMigrations: number[];
    try {
      nodeMaster = rawNode
        .prepare(
          "SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name",
        )
        .all() as MasterRow[];
      nodeMigrations = (
        rawNode
          .prepare("SELECT version FROM _migrations ORDER BY version")
          .all() as Array<{ version: number }>
      ).map((m) => m.version);
    } finally {
      rawNode.close();
      node.close();
    }

    // Schema-identity assertion: compare the NORMALIZED sqlite_master DDL
    // fingerprints (NOT PRAGMA user_version, which both paths leave at 0 — the
    // embedded path tracks versions in the `_migrations` table) and the
    // _migrations rows.
    expect(bunMaster.length).toBeGreaterThan(0);
    expect(fingerprint(nodeMaster)).toBe(fingerprint(bunMaster));
    expect(nodeMigrations).toEqual(bunMigrations);
    expect(nodeMigrations.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// 3. SDK-local-only round-trip (Node)
// ---------------------------------------------------------------------------

describe("SDK-local round-trip (tila-sdk/local under node)", () => {
  it("task / claim+fence / record / artifact / journal all work end-to-end", async () => {
    const tmp = makeTmp();
    const { project, artifacts, close } = await createTilaLocal({
      dbPath: join(tmp, "sdk.db"),
      artifactsPath: join(tmp, "artifacts"),
      org: ORG,
      project: PROJECT,
      skipFilesystemCheck: true,
    });

    try {
      // task
      const task = await project.create({
        id: "T-sdk",
        type: "task",
        data: { title: "sdk-local", status: "open" },
        created_by: "node",
      });
      expect(task.id).toBe("T-sdk");

      // claim returns a monotonic fence
      const acquired = await project.acquire(
        "task:T-sdk",
        "machine-1",
        "user-1",
        "exclusive",
        60_000,
      );
      expect(acquired.fence).toBeGreaterThan(0);

      // fenced update with the acquired fence succeeds
      const updated = await project.updateWithFence(
        "T-sdk",
        { status: "in_progress" },
        acquired.fence,
      );
      expect((updated.data as { status?: string }).status).toBe("in_progress");

      // record set (create first, fenceless)
      const rec = await project.createRecord({
        type: "note",
        key: "k1",
        value: { body: "hello" },
      });
      expect(rec.key).toBe("k1");
      const readRec = await project.getRecord("note", "k1");
      expect((readRec?.value as { body?: string })?.body).toBe("hello");

      // artifact write + read. `resource` FK-references entities(id), so it is
      // the bare entity id ("T-sdk"), not the fence-style "task:T-sdk".
      const { key } = await artifacts.writeText("artifact body line\n", {
        kind: "log",
        resource: "T-sdk",
      });
      const readArtifact = await artifacts.readText(key);
      expect(readArtifact?.content).toContain("artifact body line");

      // journal lists the events produced by the above writes
      const journal = await project.listJournal({ limit: 50 });
      expect(journal.length).toBeGreaterThan(0);
      const kinds = journal.map((e) => e.kind);
      expect(kinds).toContain("entity.created");
    } finally {
      close();
    }
  });
});

// ---------------------------------------------------------------------------
// 4. MCP-local round-trip: BUILT dist/index.js under plain node, over stdio
// ---------------------------------------------------------------------------

describe("MCP-local round-trip (built server under node, stdio JSON-RPC)", () => {
  beforeAll(() => {
    // The built server is required. turbo `^build` builds tila-mcp-server
    // (now a devDependency of this package); guard anyway in case the test is
    // run in isolation without a prior build.
    if (!existsSync(MCP_DIST)) {
      const built = spawnSync(
        "pnpm",
        ["--filter", "tila-mcp-server", "build"],
        {
          cwd: resolve(PKG_ROOT, "..", ".."),
          encoding: "utf-8",
        },
      );
      if (built.status !== 0) {
        throw new Error(
          `failed to build tila-mcp-server: ${built.stderr ?? ""}\n${built.stdout ?? ""}`,
        );
      }
    }
    expect(existsSync(MCP_DIST)).toBe(true);
  });

  it("initialize + tila_task_create + tila_task_list over stdio against a local config", async () => {
    const tmp = makeTmp();
    const dbPath = join(tmp, "mcp.db");
    const artifactsPath = join(tmp, "artifacts");

    // The built server resolves "local" backend from a .tila/config.toml whose
    // `backend = "local"`. Env-only (TILA_DB_PATH) keeps backend=cloudflare, so
    // we materialize a config file and run the server with cwd = tmp.
    const { writeFileSync, mkdirSync } = await import("node:fs");
    mkdirSync(join(tmp, ".tila"), { recursive: true });
    writeFileSync(
      join(tmp, ".tila", "config.toml"),
      [
        'project_id = "mcp-local-proj"',
        'backend = "local"',
        "schema_version = 0",
        'tila_version = "0.0.0"',
        'created_at = "1970-01-01T00:00:00.000Z"',
        "",
        "[local]",
        `db_path = "${dbPath}"`,
        `artifacts_path = "${artifactsPath}"`,
        `org = "${ORG}"`,
        "",
      ].join("\n"),
    );

    const result = await runMcpRoundtrip(tmp);
    expect(result.initialized).toBe(true);
    expect(result.created).toBe("M-1");
    expect(result.listedIds).toContain("M-1");
  });
});

/**
 * Spawn `node dist/index.js` with cwd at a directory containing
 * `.tila/config.toml` (backend = local), perform an MCP stdio JSON-RPC
 * handshake, create a task, and list tasks. Returns the parsed outcomes.
 */
async function runMcpRoundtrip(cwd: string): Promise<{
  initialized: boolean;
  created: string | null;
  listedIds: string[];
}> {
  const { spawn } = await import("node:child_process");
  const child = spawn("node", [MCP_DIST], {
    cwd,
    env: { ...process.env },
    stdio: ["pipe", "pipe", "pipe"],
  });

  let buffer = "";
  const pending = new Map<number, (msg: Record<string, unknown>) => void>();
  let stderr = "";

  child.stderr.on("data", (d: Buffer) => {
    stderr += d.toString();
  });

  child.stdout.on("data", (d: Buffer) => {
    buffer += d.toString();
    // Messages are newline-delimited JSON (stdio transport).
    let idx = buffer.indexOf("\n");
    while (idx !== -1) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (line.length > 0) {
        try {
          const msg = JSON.parse(line) as Record<string, unknown>;
          const id = msg.id as number | undefined;
          if (typeof id === "number" && pending.has(id)) {
            const fn = pending.get(id);
            pending.delete(id);
            fn?.(msg);
          }
        } catch {
          // ignore non-JSON lines
        }
      }
      idx = buffer.indexOf("\n");
    }
  });

  function send(msg: Record<string, unknown>): void {
    child.stdin.write(`${JSON.stringify(msg)}\n`);
  }

  function request(
    id: number,
    method: string,
    params: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return new Promise((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => {
        rejectPromise(
          new Error(
            `MCP request ${method} (id ${id}) timed out. stderr:\n${stderr}`,
          ),
        );
      }, 15_000);
      pending.set(id, (msg) => {
        clearTimeout(timer);
        resolvePromise(msg);
      });
      send({ jsonrpc: "2.0", id, method, params });
    });
  }

  try {
    // 1. initialize
    const initResp = await request(1, "initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "xrt-test", version: "0.0.0" },
    });
    const initialized =
      (initResp.result as Record<string, unknown>) !== undefined;
    // notifications/initialized (no id, no response expected)
    send({ jsonrpc: "2.0", method: "notifications/initialized" });

    // 2. tila_task_create
    const createResp = await request(2, "tools/call", {
      name: "tila_task_create",
      arguments: { id: "M-1", type: "task", data: { title: "mcp-local" } },
    });
    const createText = extractToolText(createResp);
    const created = createText
      ? (JSON.parse(createText).entity?.id ?? null)
      : null;

    // 3. tila_task_list
    const listResp = await request(3, "tools/call", {
      name: "tila_task_list",
      arguments: {},
    });
    const listText = extractToolText(listResp);
    const listedIds: string[] = listText
      ? (JSON.parse(listText).entities ?? []).map((e: { id: string }) => e.id)
      : [];

    return {
      initialized: initialized && typeof initResp.result === "object",
      created,
      listedIds,
    };
  } finally {
    child.stdin.end();
    child.kill();
  }
}

/** Pull the first text-content block out of an MCP tools/call response. */
function extractToolText(resp: Record<string, unknown>): string | null {
  const result = resp.result as
    | { content?: Array<{ type: string; text?: string }> }
    | undefined;
  const block = result?.content?.find((c) => c.type === "text");
  return block?.text ?? null;
}

// ---------------------------------------------------------------------------
// 5. Concurrent-writer: prove withBusyRetry's injected sleepSync fires
// ---------------------------------------------------------------------------

describe("concurrent writers on one file (withBusyRetry second-layer retry)", () => {
  it("induces SQLITE_BUSY contention; the injected sleepSync fires and both writes land", async () => {
    const tmp = makeTmp();
    const dbPath = join(tmp, "concur.db");

    // --- Handle A: the EmbeddedProject-under-test, with an INSTRUMENTED sleepSync.
    // We build it from a raw better-sqlite3 handle we keep, so we can lower its
    // busy_timeout to 1ms — forcing SQLITE_BUSY to surface PAST the driver's own
    // wait and into the second-layer withBusyRetry (the layer this test exists
    // to exercise). With the default 5000ms busy_timeout the driver would absorb
    // all contention and the retry would never fire (the trap the task warns of).
    const rawA = new Database(dbPath);
    for (const pragma of EMBEDDED_PRAGMAS) rawA.exec(pragma);
    runEmbeddedMigrations(nodeMigrationStorage(rawA));
    rawA.exec("PRAGMA busy_timeout=1;"); // override AFTER migrations: force retries

    // --- Handle B: a second better-sqlite3 writer that HOLDS a write lock open
    // across a BEGIN IMMEDIATE transaction, deterministically blocking A.
    const rawB = new Database(dbPath);
    rawB.exec("PRAGMA busy_timeout=1;");
    rawB.exec("BEGIN IMMEDIATE;");
    rawB
      .prepare(
        "INSERT INTO entities (id, type, data, created_at, updated_at, archived, schema_version, created_by) VALUES (?,?,?,?,?,?,?,?)",
      )
      .run("T-LOCK", "task", "{}", Date.now(), Date.now(), 0, 1, "B");

    // The instrumented sleep is the OBSERVABLE PROOF that the second-layer retry
    // fired. Because our sleeps are synchronous and effectively instant, A would
    // otherwise spin through all its retries before B ever releases the lock. So
    // we make the FIRST retry-sleep ALSO release B's lock (commit its txn): this
    // makes the contention deterministic — the retry path MUST execute for the
    // write to ever succeed, and the very act of retrying is what unblocks it.
    const sleepCalls: number[] = [];
    let released = false;
    const instrumentedSleep = (ms: number): void => {
      sleepCalls.push(ms);
      if (!released) {
        released = true;
        // First retry observed → release the competing writer's lock so the
        // NEXT attempt can acquire it. Proves: no retry ⇒ no success.
        try {
          rawB.exec("COMMIT;");
        } catch {
          // ignore — already committed/closed
        }
      }
    };
    // The better-sqlite3 adapter types the result-generic as RunResult, while
    // EmbeddedDb pins it to void; the generic is unused by any delegation, so we
    // narrow through `as unknown` exactly as the bun/node host harnesses do.
    const dbA = drizzle(rawA, { schema }) as unknown as EmbeddedDb;
    const projectA = new EmbeddedProject({
      db: dbA,
      org: ORG,
      project: PROJECT,
      sleepSync: instrumentedSleep,
      close: () => rawA.close(),
    });

    let aWriteError: unknown = null;
    try {
      // A's create() runs entityOps under withBusyRetry. The first attempt hits
      // SQLITE_BUSY (B holds the lock, A's busy_timeout=1ms), the injected
      // sleepSync fires (recording the call AND releasing B's lock), and the
      // next attempt succeeds. No SQLITE_BUSY escapes as an unhandled error.
      await projectA.create({
        id: "T-A",
        type: "task",
        data: { title: "a" },
        created_by: "A",
      });
    } catch (err) {
      aWriteError = err;
    }

    // (a) No SQLITE_BUSY surfaced as an unhandled error.
    expect(aWriteError).toBeNull();

    // (b) The retry actually fired — the instrumented sleepSync was called at
    //     least once (the whole point: the second-layer retry path executed).
    expect(sleepCalls.length).toBeGreaterThan(0);

    // (c) BOTH writes ultimately landed (B's T-LOCK committed; A's T-A succeeded).
    const got = await projectA.get("T-A");
    expect(got?.id).toBe("T-A");
    const lock = await projectA.get("T-LOCK");
    expect(lock?.id).toBe("T-LOCK");

    projectA.close();
    rawB.close();
  });
});

// ---------------------------------------------------------------------------
// 6. Cross-runtime grep parity
// ---------------------------------------------------------------------------

describe("cross-runtime grep parity (multi-chunk streaming + UTF-8 boundary flush)", () => {
  it("a >inline-threshold blob greps identically from bun and node via the streaming path", async () => {
    const tmp = makeTmp();
    const dbPath = join(tmp, "grep.db");
    const artifactsPath = join(tmp, "artifacts");

    // --- Build a blob that GENUINELY exercises the streaming/multi-chunk grep
    // path on BOTH runtimes:
    //
    //  * The embedded `put` never sets `content_inline` (it always stores blobs
    //    on disk and leaves the column NULL), so `grepArtifacts` ALWAYS takes
    //    the streaming branch (`blobs.readStream` → chunked `reader.read()` →
    //    `TextDecoder({ stream })` flush) — never the inline single-string
    //    branch. We assert that NULL below to make the path explicit.
    //  * The blob is ~512 KiB — comfortably above the ≤64 KiB inline fast-path
    //    threshold AND large enough to span MANY native read chunks (node's
    //    fs.createReadStream and bun's Bun.file().stream() both chunk at
    //    ~64 KiB), so the cross-chunk TextDecoder flush is repeatedly stressed.
    //  * A 4-byte UTF-8 emoji ("🧪") sits on a NEEDLE line engineered so its
    //    bytes STRADDLE the first 64 KiB chunk boundary (offset 65536). If the
    //    two drivers chunked the read differently and the decoder failed to
    //    reassemble the split code point, that line would decode/match
    //    differently — the parity assertion would catch it.
    const CHUNK = 65536;
    const EMOJI = "🧪"; // 4 UTF-8 bytes (U+1F9EA)
    // A filler line of EXACTLY 64 bytes including its trailing "\n" (so byte
    // offsets are predictable). 63 visible chars + "\n".
    const fillerBody = `filler ${"z".repeat(56)}`; // 7 + 56 = 63 bytes
    const fillerLine = `${fillerBody}\n`; // 64 bytes
    expect(Buffer.byteLength(fillerLine, "utf8")).toBe(64);

    // Compose the body byte-accurately so the emoji on a NEEDLE line crosses the
    // 65536-byte boundary. Strategy: emit filler lines until we are a few bytes
    // short of the boundary, then emit a NEEDLE line whose emoji begins 2 bytes
    // before the boundary (so 2 of its 4 bytes are in chunk 0 and 2 in chunk 1).
    let bytes = 0;
    const parts: string[] = [];
    const targetEmojiStart = CHUNK - 2; // emoji's first byte at 65534
    // Prefix that places the emoji's first byte exactly at targetEmojiStart.
    // We'll pad the boundary NEEDLE line's prefix to hit it precisely.
    while (bytes + 64 <= targetEmojiStart - 40) {
      parts.push(fillerLine);
      bytes += 64;
    }
    // Now top up with ASCII bytes so the next emitted emoji starts at
    // targetEmojiStart. The boundary line looks like:
    //   "<pad>BOUNDARY NEEDLE <EMOJI> tail...\n"
    // Compute the pad so the EMOJI's first byte lands at targetEmojiStart.
    const boundaryPrefix = "BOUNDARY NEEDLE ";
    const padLen = targetEmojiStart - bytes - boundaryPrefix.length;
    expect(padLen).toBeGreaterThanOrEqual(0);
    const boundaryLine = `${"p".repeat(padLen)}${boundaryPrefix}${EMOJI} tail-after-emoji\n`;
    parts.push(boundaryLine);
    bytes += Buffer.byteLength(boundaryLine, "utf8");

    // Sanity: the emoji's first byte is at the boundary-1..boundary span.
    const preEmojiBytes =
      bytes -
      Buffer.byteLength(" tail-after-emoji\n", "utf8") -
      Buffer.byteLength(EMOJI, "utf8");
    expect(preEmojiBytes).toBe(targetEmojiStart);

    // Fill out to ~512 KiB total with a mix of NEEDLE and ordinary lines so the
    // stream spans ~8 native chunks and many lines straddle chunk boundaries.
    let n = 0;
    while (bytes < 512 * 1024) {
      const line =
        n % 9 === 0
          ? `line ${n} contains NEEDLE with accent café ${"x".repeat(30)}\n`
          : `line ${n} ordinary content ${"y".repeat(40)}\n`;
      parts.push(line);
      bytes += Buffer.byteLength(line, "utf8");
      n++;
    }
    const content = parts.join("");
    const totalBytes = Buffer.byteLength(content, "utf8");
    expect(totalBytes).toBeGreaterThan(8 * CHUNK); // spans many read chunks

    // Write via the BUN path so the on-disk blob is produced by the bun runtime.
    // The ~512 KiB body is passed through a temp FILE (not an env var, which
    // would overflow) read by the bun fixture.
    const { writeFileSync } = await import("node:fs");
    const contentFile = join(tmp, "grep-content.txt");
    writeFileSync(contentFile, content, "utf-8");
    const wrote = runBun("write-artifact", {
      DB: dbPath,
      ARTIFACTS: artifactsPath,
      ORG,
      PROJECT,
      KIND: "log",
      RESOURCE: "", // resource-less source artifact (no entity FK)
      CONTENT_FILE: contentFile,
    });
    const artifactKey = wrote.json.key as string;
    expect(typeof artifactKey).toBe("string");

    // Grep from the BUN path.
    const bunGrep = runBun("grep-artifact", {
      DB: dbPath,
      ARTIFACTS: artifactsPath,
      ORG,
      PROJECT,
      PATTERN: "NEEDLE",
    });
    const bunLines = bunGrep.json.lines as Array<{
      key: string;
      line: number;
      text: string;
    }>;

    // Grep from the NODE path over the SAME blob, and confirm via a raw query
    // that `content_inline` is NULL (i.e. grep MUST use the streaming branch).
    const node = await createTilaLocal({
      dbPath,
      artifactsPath,
      org: ORG,
      project: PROJECT,
      skipFilesystemCheck: true,
    });
    let nodeLines: Array<{ key: string; line: number; text: string }>;
    let inlineIsNull: boolean;
    let storedBytes: number;
    const rawCheck = new Database(dbPath, { readonly: true });
    try {
      const row = rawCheck
        .prepare(
          "SELECT content_inline AS inline, bytes FROM artifact_pointers WHERE r2_key = ?",
        )
        .get(artifactKey) as { inline: string | null; bytes: number };
      inlineIsNull = row.inline === null;
      storedBytes = row.bytes;

      const res = await node.artifacts.grepArtifacts({ pattern: "NEEDLE" });
      nodeLines = res.results.flatMap((r) =>
        r.lines.map((l) => ({ key: r.key, line: l.line, text: l.text })),
      );
    } finally {
      rawCheck.close();
      node.close();
    }

    // The streaming path is genuinely taken: content_inline is NULL and the blob
    // is well above the inline threshold.
    expect(inlineIsNull).toBe(true);
    expect(storedBytes).toBe(totalBytes);
    expect(storedBytes).toBeGreaterThan(64 * 1024);

    // The boundary-straddling emoji line was matched (and decoded intact).
    const boundaryMatch = bunLines.find((l) => l.text.includes("BOUNDARY"));
    expect(boundaryMatch).toBeDefined();
    expect(boundaryMatch?.text).toContain(EMOJI);
    expect(boundaryMatch?.text).toContain("tail-after-emoji");

    // Identical matches (same keys, line numbers, and full text — including the
    // boundary emoji and the accented "café" lines) across BOTH runtimes.
    expect(bunLines.length).toBeGreaterThan(0);
    const norm = (
      arr: Array<{ key: string; line: number; text: string }>,
    ): string =>
      arr
        .map((m) => `${m.key}#${m.line}#${m.text}`)
        .sort()
        .join("\n");
    expect(norm(nodeLines)).toBe(norm(bunLines));
  });
});
