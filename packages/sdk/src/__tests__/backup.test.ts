import { createHash, randomUUID } from "node:crypto";
import {
  createWriteStream,
  existsSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { mkdtemp, readFile, rm, truncate } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import * as tar from "tar-stream";
import { afterEach, describe, expect, it } from "vitest";
import {
  exportProjectBackup,
  importProjectBackup,
  inspectProjectBackup,
} from "../backup";
import { createTilaLocal } from "../local";

const roots: string[] = [];
afterEach(async () =>
  Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  ),
);

async function fixture(withBlob = false) {
  const root = await mkdtemp(join(tmpdir(), "tila-backup-test-"));
  roots.push(root);
  const source = {
    backend: "local" as const,
    projectId: "backup-test",
    dbPath: join(root, "source.db"),
    artifactsPath: join(root, "source-artifacts"),
  };
  const local = await createTilaLocal({
    dbPath: source.dbPath,
    artifactsPath: source.artifactsPath,
    project: source.projectId,
    org: "local",
    skipFilesystemCheck: true,
  });
  await local.project.create({
    id: "parent",
    type: "task",
    data: { name: "Parent", status: "open" },
    created_by: "recovery-test",
    tags: ["backup"],
  });
  await local.project.create({
    id: "child",
    type: "task",
    data: { name: "Child", status: "open" },
    created_by: "recovery-test",
  });
  await local.project.addRelationship({
    from_id: "parent",
    to_id: "child",
    type: "parent-child",
  });
  const claim = await local.project.acquire("task:parent", "exclusive", 60_000);
  let expected:
    | { key: string; sha: string; bytes: number; fence: number }
    | undefined;
  if (withBlob) {
    const body = new Uint8Array(3 * 1024 * 1024).fill(97);
    const sha = createHash("sha256").update(body).digest("hex");
    const key = `local/${source.projectId}/${sha}.bin`;
    await local.artifacts.put({
      key,
      sha256: sha,
      body: body.buffer,
      contentType: "application/octet-stream",
      metadata: {},
    });
    expected = { key, sha, bytes: body.byteLength, fence: claim.fence };
  }
  local.close();
  return { root, source, expected };
}

describe("project backup archive", () => {
  it("streams a large blob and completes a semantic recovery drill", async () => {
    const { root, source, expected } = await fixture(true);
    const archive = join(root, "project.tila-backup");
    const manifest = await exportProjectBackup({ source, output: archive });
    await rm(source.dbPath, { force: true });
    await rm(source.artifactsPath, { recursive: true, force: true });
    const destination = {
      backend: "local" as const,
      projectId: source.projectId,
      dbPath: join(root, "restored.db"),
      artifactsPath: join(root, "restored-artifacts"),
    };
    const restored = await importProjectBackup({ archive, destination });
    const blob = readFileSync(
      join(destination.artifactsPath, expected?.key ?? ""),
    );
    expect(blob.byteLength).toBe(expected?.bytes);
    expect(createHash("sha256").update(blob).digest("hex")).toBe(expected?.sha);
    expect(restored.manifest.semantic_digest).toBe(manifest.semantic_digest);
    const recovered = await createTilaLocal({
      dbPath: destination.dbPath,
      artifactsPath: destination.artifactsPath,
      project: destination.projectId,
      org: "local",
      skipFilesystemCheck: true,
    });
    const updated = await recovered.project.updateWithFence(
      "parent",
      { status: "done" },
      expected?.fence ?? 0,
    );
    expect(updated.data.status).toBe("done");
    recovered.close();
  });

  it("rejects truncation and corruption", async () => {
    const { root, source } = await fixture();
    const archive = join(root, "project.tila-backup");
    await exportProjectBackup({ source, output: archive });
    const truncated = join(root, "truncated.tila-backup");
    writeFileSync(truncated, await readFile(archive));
    await truncate(
      truncated,
      Math.max(1, Math.floor((await readFile(truncated)).byteLength / 2)),
    );
    await expect(inspectProjectBackup(truncated)).rejects.toThrow();

    const corrupted = join(root, "corrupted.tila-backup");
    const bytes = Buffer.from(await readFile(archive));
    bytes[600] ^= 0xff;
    writeFileSync(corrupted, bytes);
    await expect(inspectProjectBackup(corrupted)).rejects.toThrow();
  });

  it("rejects duplicate and traversal entry paths", async () => {
    const root = await mkdtemp(join(tmpdir(), "tila-backup-unsafe-"));
    roots.push(root);
    for (const names of [["header.json", "header.json"], ["../header.json"]]) {
      const archive = join(root, `${randomUUID()}.tila-backup`);
      const pack = tar.pack();
      const writing = pipeline(pack, createWriteStream(archive));
      for (const name of names) pack.entry({ name }, "{}\n");
      pack.finalize();
      await writing;
      await expect(inspectProjectBackup(archive)).rejects.toThrow();
    }
  });

  it("refuses to overwrite an export", async () => {
    const { root, source } = await fixture();
    const archive = join(root, "project.tila-backup");
    writeFileSync(archive, "occupied");
    await expect(
      exportProjectBackup({ source, output: archive }),
    ).rejects.toThrow("Refusing to overwrite");
    expect(existsSync(archive)).toBe(true);
  });
});
