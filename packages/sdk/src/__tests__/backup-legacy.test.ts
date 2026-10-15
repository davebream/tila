import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { projectTransferOps } from "@tila/ops-sqlite";
import * as tar from "tar-stream";
import { afterEach, describe, expect, it } from "vitest";
import {
  exportProjectBackup,
  importProjectBackup,
  inspectProjectBackup,
} from "../backup";
import { createTilaLocal } from "../local";
import { legacyV070Archive } from "./fixtures/legacy-backup/v0.7.0-archive";

// Pins for the archive in fixtures/legacy-backup. The bytes were exported by
// the tag v0.7.0 itself (commit fa989a9ebd509525dd262d0d6133c5019c405251);
// regenerate with scripts/generate-legacy-backup-fixtures.mjs and re-pin.
const ARCHIVE_SHA256 =
  "1f8c912ffd969a5a642ba4134fb553eb0171b1d615c8fe7719b311179a8f742b";
const MANIFEST_DIGEST =
  "9e13d98b5275040b3397efb429b7a74cd6a7d9c88030470216069e643cff62a0";
const MISMATCH = "Restored SQLite semantic digest does not match the backup";

const roots: string[] = [];
afterEach(async () =>
  Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  ),
);

type Entry = { name: string; data: Buffer };
type Manifest = {
  source: { product_version: string; do_migration_version: number };
  semantic_digest: string;
  content_root: string;
  entries: { path: string; bytes: number; sha256: string }[];
};

const sha256 = (data: Uint8Array | string) =>
  createHash("sha256").update(data).digest("hex");

async function readEntries(path: string): Promise<Entry[]> {
  const extract = tar.extract();
  const entries: Entry[] = [];
  extract.on("entry", (header, stream, next) => {
    const chunks: Buffer[] = [];
    stream.on("data", (chunk: unknown) =>
      chunks.push(Buffer.from(chunk as Uint8Array)),
    );
    stream.on("end", () => {
      entries.push({ name: header.name, data: Buffer.concat(chunks) });
      next();
    });
  });
  await pipeline(createReadStream(path), extract);
  return entries;
}

async function writeEntries(path: string, entries: Entry[]): Promise<void> {
  const pack = tar.pack();
  const written = pipeline(pack, createWriteStream(path));
  for (const entry of entries) {
    await new Promise<void>((resolve, reject) =>
      pack.entry(
        { name: entry.name, size: entry.data.byteLength, mode: 0o600 },
        entry.data,
        (error) => (error ? reject(error) : resolve()),
      ),
    );
  }
  pack.finalize();
  await written;
}

/**
 * Rewrites the archive so every entry checksum and the content root stay
 * consistent with the edit, leaving the semantic digest as the only check
 * that can notice it.
 */
async function derive(
  source: string,
  target: string,
  edit: (files: Map<string, Buffer>, manifest: Manifest) => void,
): Promise<void> {
  const entries = await readEntries(source);
  const manifestEntry = entries.find((entry) => entry.name === "manifest.json");
  if (!manifestEntry) throw new Error("fixture has no manifest");
  const manifest = JSON.parse(manifestEntry.data.toString("utf8")) as Manifest;
  const files = new Map(
    entries
      .filter((entry) => entry.name !== "manifest.json")
      .map((entry) => [entry.name, entry.data]),
  );
  edit(files, manifest);
  for (const declared of manifest.entries) {
    const data = files.get(declared.path);
    if (!data) throw new Error(`missing entry ${declared.path}`);
    declared.bytes = data.byteLength;
    declared.sha256 = sha256(data);
  }
  manifest.content_root = sha256(
    `${[...manifest.entries]
      .sort((a, b) => a.path.localeCompare(b.path))
      .map((entry) => projectTransferOps.canonicalJson(entry))
      .join("\n")}\n`,
  );
  await writeEntries(target, [
    ...[...files].map(([name, data]) => ({ name, data })),
    {
      name: "manifest.json",
      data: Buffer.from(`${projectTransferOps.canonicalJson(manifest)}\n`),
    },
  ]);
}

async function workspace() {
  const root = await mkdtemp(join(tmpdir(), "tila-legacy-backup-"));
  roots.push(root);
  const archive = join(root, "v0.7.0.tila-backup");
  await writeFile(archive, legacyV070Archive());
  const destination = (name: string) => ({
    backend: "local" as const,
    projectId: "legacy-archive",
    dbPath: join(root, `${name}.db`),
    artifactsPath: join(root, `${name}-artifacts`),
  });
  return { root, archive, destination };
}

describe("project backup exported before 0.8 (v0.7.0 SDK)", () => {
  it("is the pinned v0.7.0 export with records and artifact rows", async () => {
    const { archive } = await workspace();
    expect(sha256(legacyV070Archive())).toBe(ARCHIVE_SHA256);
    const { manifest, entries } = await inspectProjectBackup(archive);
    expect(manifest.source).toMatchObject({
      product_version: "0.7.0",
      do_migration_version: 40,
    });
    expect(manifest.semantic_digest).toBe(MANIFEST_DIGEST);
    // The order only matters when these coexist; the fixture must exercise it.
    for (const table of [
      "entities",
      "records",
      "artifact_pointers",
      "artifact_reviews",
    ]) {
      const declared = manifest.entries.find(
        (entry) => entry.path === `do/${table}.jsonl`,
      );
      expect(declared?.rows, table).toBeGreaterThan(0);
      expect(entries).toContain(`do/${table}.jsonl`);
    }
  });

  it("restores into a local destination and serves its data", async () => {
    const { archive, destination } = await workspace();
    const target = destination("restored");
    const restored = await importProjectBackup({
      archive,
      destination: target,
    });
    expect(restored.manifest.semantic_digest).toBe(MANIFEST_DIGEST);
    const local = await createTilaLocal({
      dbPath: target.dbPath,
      artifactsPath: target.artifactsPath,
      project: target.projectId,
      org: "local",
      skipFilesystemCheck: true,
    });
    try {
      expect(await local.project.get("legacy-task")).toMatchObject({
        id: "legacy-task",
        data: { name: "Legacy task", status: "open" },
      });
      expect(await local.project.getRecord("config", "main")).toMatchObject({
        type: "config",
        key: "main",
        value: { region: "eu" },
      });
      const pointers = (await local.artifacts.listPointers?.({})) ?? [];
      expect(pointers).toHaveLength(1);
      expect(pointers[0]).toMatchObject({ kind: "report" });
    } finally {
      local.close();
    }
  });

  it("re-exports with the current order and restores that archive again", async () => {
    const { root, archive, destination } = await workspace();
    const first = destination("first");
    await importProjectBackup({ archive, destination: first });
    const upgraded = join(root, "upgraded.tila-backup");
    const exported = await exportProjectBackup({
      source: first,
      output: upgraded,
    });
    expect(exported.source.do_migration_version).toBeGreaterThanOrEqual(41);
    expect(exported.semantic_digest).not.toBe(MANIFEST_DIGEST);
    const second = destination("second");
    const restored = await importProjectBackup({
      archive: upgraded,
      destination: second,
    });
    expect(restored.manifest.semantic_digest).toBe(exported.semantic_digest);
  });

  it("restores an unmodified rewrite, so each rejection below is caused by its edit", async () => {
    const { root, archive, destination } = await workspace();
    const control = join(root, "control.tila-backup");
    await derive(archive, control, () => undefined);
    const restored = await importProjectBackup({
      archive: control,
      destination: destination("control"),
    });
    expect(restored.manifest.semantic_digest).toBe(MANIFEST_DIGEST);
  });

  it("rejects a changed row even when entry checksums and the content root agree", async () => {
    const { root, archive, destination } = await workspace();
    const tampered = join(root, "tampered.tila-backup");
    await derive(archive, tampered, (files) => {
      const original = files.get("do/records.jsonl")?.toString("utf8") ?? "";
      const changed = original.replace('\\"eu\\"', '\\"us\\"');
      expect(changed).not.toBe(original);
      files.set("do/records.jsonl", Buffer.from(changed));
    });
    // The rewritten archive is internally consistent; only the digest differs.
    await expect(inspectProjectBackup(tampered)).resolves.toBeDefined();
    const target = destination("tampered");
    await expect(
      importProjectBackup({ archive: tampered, destination: target }),
    ).rejects.toThrow(MISMATCH);
    expect(existsSync(target.dbPath)).toBe(false);
  });

  it("rejects a wrong manifest digest", async () => {
    const { root, archive, destination } = await workspace();
    const wrong = join(root, "wrong-digest.tila-backup");
    await derive(archive, wrong, (_files, manifest) => {
      manifest.semantic_digest = "0".repeat(64);
    });
    const target = destination("wrong-digest");
    await expect(
      importProjectBackup({ archive: wrong, destination: target }),
    ).rejects.toThrow(MISMATCH);
    expect(existsSync(target.dbPath)).toBe(false);
  });

  it.each([41, 42])(
    "rejects the legacy digest claimed at migration level %i",
    async (level) => {
      const { root, archive, destination } = await workspace();
      const relabelled = join(root, `level-${level}.tila-backup`);
      await derive(archive, relabelled, (_files, manifest) => {
        manifest.source.do_migration_version = level;
      });
      const target = destination(`level-${level}`);
      await expect(
        importProjectBackup({ archive: relabelled, destination: target }),
      ).rejects.toThrow(MISMATCH);
      expect(existsSync(target.dbPath)).toBe(false);
    },
  );
});
