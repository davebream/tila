import { runInDurableObject } from "cloudflare:test";
import { projectTransferOps } from "@tila/ops-sqlite";
import { describe, expect, it } from "vitest";
import { legacyV070Archive } from "../../sdk/src/__tests__/fixtures/legacy-backup/v0.7.0-archive";
import { post } from "./helpers";
import { bindings } from "./setup";

// A project backup exported by the v0.7.0 SDK (tag commit fa989a9e…, migration
// level 40) is the only source of rows and digest here. Its digest is the one
// v0.7.0 computed, so a restore that verifies it cannot be circular.
const MANIFEST_DIGEST =
  "9e13d98b5275040b3397efb429b7a74cd6a7d9c88030470216069e643cff62a0";

type Row = Record<string, unknown>;
const decoder = new TextDecoder();

/** Minimal ustar reader: the archive holds no long names or pax headers. */
function readTar(bytes: Uint8Array): Map<string, Uint8Array> {
  const field = (header: Uint8Array, start: number, length: number) =>
    decoder.decode(header.subarray(start, start + length)).split("\0")[0];
  const entries = new Map<string, Uint8Array>();
  let offset = 0;
  while (offset + 512 <= bytes.length) {
    const header = bytes.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const size = Number.parseInt(field(header, 124, 12).trim() || "0", 8);
    offset += 512;
    entries.set(field(header, 0, 100), bytes.subarray(offset, offset + size));
    offset += Math.ceil(size / 512) * 512;
  }
  return entries;
}

const archive = readTar(legacyV070Archive());
const manifest = JSON.parse(decoder.decode(archive.get("manifest.json"))) as {
  source: { do_migration_version: number };
  semantic_digest: string;
  journal_next_sequence: number;
};

function archiveRows(table: string): Row[] {
  const data = archive.get(`do/${table}.jsonl`);
  if (!data) return [];
  return decoder
    .decode(data)
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Row);
}

/** Runs the DO restore sequence the SDK drives, finalizing as requested. */
async function restore(
  overrides: {
    edit?: (rows: Map<string, Row[]>) => void;
    migrationVersion?: number;
    semanticDigest?: string;
  } = {},
) {
  const stub = bindings.PROJECT.get(bindings.PROJECT.newUniqueId());
  const sessionId = crypto.randomUUID();
  const send = async (path: string, body: Record<string, unknown>) =>
    post(stub, path, { sessionId, ...body });
  const begin = await send("/admin/transfer/begin", {
    mode: "import",
    owner: "fixture",
    archiveDigest: "legacy",
  });
  expect(begin.status, await begin.clone().text()).toBe(200);
  const prepared = await send("/admin/transfer/prepare", {});
  expect(prepared.status, await prepared.clone().text()).toBe(200);
  const rows = new Map<string, Row[]>(
    projectTransferOps.PROJECT_BACKUP_TABLES.map((table) => [
      table,
      archiveRows(table),
    ]),
  );
  overrides.edit?.(rows);
  for (const [table, tableRows] of rows) {
    const encoded =
      tableRows.map((row) => projectTransferOps.canonicalJson(row)).join("\n") +
      (tableRows.length ? "\n" : "");
    const accepted = await send(`/admin/transfer/rows/${table}`, {
      chunkIndex: 0,
      sha256: await projectTransferOps.sha256Hex(encoded),
      rows: tableRows,
    });
    expect(accepted.status, await accepted.clone().text()).toBe(200);
  }
  const finalize = await send("/admin/transfer/finalize", {
    journalNextSequence: manifest.journal_next_sequence,
    semanticDigest: overrides.semanticDigest ?? manifest.semantic_digest,
    migrationVersion:
      overrides.migrationVersion ?? manifest.source.do_migration_version,
  });
  return { stub, finalize };
}

describe("restoring a backup exported before 0.8", () => {
  it("is the pinned v0.7.0 export at migration level 40", () => {
    expect(manifest.semantic_digest).toBe(MANIFEST_DIGEST);
    expect(manifest.source.do_migration_version).toBe(40);
    for (const table of ["records", "artifact_pointers", "artifact_reviews"])
      expect(archiveRows(table).length, table).toBeGreaterThan(0);
  });

  it("finalizes through the real DO transfer protocol with the historical digest", async () => {
    const { stub, finalize } = await restore();
    expect(finalize.status, await finalize.clone().text()).toBe(200);
    expect(await finalize.json()).toMatchObject({
      ok: true,
      semanticDigest: MANIFEST_DIGEST,
    });
    await runInDurableObject(stub, async (_instance, state) => {
      const sql = state.storage.sql;
      expect(projectTransferOps.getTransferState(sql)).toBeNull();
      for (const table of [
        "entities",
        "records",
        "artifact_pointers",
        "artifact_reviews",
      ] as const) {
        expect(
          projectTransferOps.readSnapshotPage(sql, table, { limit: 10 }).rows,
          table,
        ).toHaveLength(archiveRows(table).length);
      }
    });
    // Export order is unchanged, and a project restored from a legacy archive
    // is digested in the current order from here on.
    const meta = await (
      await stub.fetch("https://project/admin/transfer/meta")
    ).json<{ digest: string; tables: string[] }>();
    expect(meta.tables.indexOf("records")).toBe(
      meta.tables.indexOf("entities") + 1,
    );
    expect(meta.tables.indexOf("records")).toBeLessThan(
      meta.tables.indexOf("artifact_pointers"),
    );
    expect(meta.digest).not.toBe(MANIFEST_DIGEST);
  });

  it.each([
    [
      "a changed row",
      {
        edit: (rows: Map<string, Row[]>) => {
          const [record] = rows.get("records") ?? [];
          if (!record) throw new Error("fixture has no record");
          record.value_json = '{"region":"us"}';
        },
      },
    ],
    ["a wrong migration level", { migrationVersion: 42 }],
    ["a wrong manifest digest", { semanticDigest: "0".repeat(64) }],
  ] as const)(
    "refuses %s without activating the restore",
    async (_label, overrides) => {
      const { stub, finalize } = await restore(overrides);
      expect(finalize.status).toBe(409);
      expect(await finalize.json()).toMatchObject({
        error: { code: "semantic-digest-mismatch" },
      });
      await runInDurableObject(stub, async (_instance, state) => {
        // The import lock stays: the project is not released after a mismatch.
        expect(
          projectTransferOps.getTransferState(state.storage.sql),
        ).not.toBeNull();
      });
    },
  );
});
